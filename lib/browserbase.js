// Browserbase REST client, per https://docs.browserbase.com/reference/api/ :
//   POST {base}/v1/fetch            Fetch a Page (fetch-a-page.md)
//   POST {base}/v1/sessions         Create a Session (create-a-session.md), 201 + connectUrl
//   POST {base}/v1/sessions/{id}    Update a Session, {status:"REQUEST_RELEASE"} (update-a-session.md)
//   GET  {base}/v1/sessions/{id}    Get a Session (proxyBytes lives on the Session object)
//   POST {base}/v1/contexts         Create a Context (create-a-context.md), 201 + id
// Auth on every call: header X-BB-API-Key (securitySchemes.BrowserbaseAuth).
// The key is never logged, never put in an error message, never returned.
import { withTimeout } from "./util.js";

export class BrowserbaseError extends Error {
  constructor(kind, httpStatus, detail) {
    super(`browserbase ${kind}${httpStatus ? ` (${httpStatus})` : ""}${detail ? `: ${detail}` : ""}`);
    this.kind = kind; // auth | quota | format | concurrency | too_large | tls | unavailable | target_timeout | bad_request | context | unreachable | timeout | aborted | http
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

function safeDetail(body) {
  const msg = body && typeof body === "object" ? body.message || body.error : typeof body === "string" ? body : "";
  return String(msg || "").replace(/\s+/g, " ").slice(0, 200);
}

function classifyHttp(status, body, where) {
  const detail = safeDetail(body);
  const low = detail.toLowerCase();
  if (status === 401) return new BrowserbaseError("auth", status, "API key rejected");
  if (status === 403 && /not enabled for the requested format|only `?raw`? is available/.test(low)) return new BrowserbaseError("format", status, detail);
  if (status === 403) return new BrowserbaseError("auth", status, detail || "forbidden");
  if (status === 402) return new BrowserbaseError("quota", status, detail || "plan quota exceeded");
  if (status === 429) return new BrowserbaseError("concurrency", status, detail || "concurrent limit");
  if (status === 400 && /format|content type/.test(low)) return new BrowserbaseError("format", status, detail);
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    if (where === "session" && /context/.test(low)) return new BrowserbaseError("context", status, detail);
    if (where === "context" && /name|exists|unique|conflict/.test(low)) return new BrowserbaseError("context", status, detail);
    return new BrowserbaseError("bad_request", status, detail);
  }
  if (status === 502 && /maximum allowed size|5mb|too large/.test(low)) return new BrowserbaseError("too_large", status, detail);
  if (status === 502 && /tls|certificate|ssl/.test(low)) return new BrowserbaseError("tls", status, detail);
  if (status === 503) return new BrowserbaseError("unavailable", status, detail);
  if (status === 504) return new BrowserbaseError("target_timeout", status, detail);
  return new BrowserbaseError("http", status, detail);
}

async function call({ base, apiKey, method, path, body, timeoutMs, signal, where, fetchImpl = fetch }) {
  const sig = withTimeout(signal, timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey, Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: sig,
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new BrowserbaseError("aborted", 0, "");
    if (sig.aborted) throw new BrowserbaseError("timeout", 0, `no answer from Browserbase in ${Math.round(timeoutMs / 1000)} s`);
    throw new BrowserbaseError("unreachable", 0, String(err?.cause?.code || err?.code || err?.name || "network error"));
  }
  const text = await res.text().catch(() => "");
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  if (!res.ok) throw classifyHttp(res.status, json ?? text, where);
  if (json === undefined) throw new BrowserbaseError("http", res.status, "non-JSON response");
  return { json, bytes: text.length };
}

// Fetch a page. proxies: boolean. format: "raw" | "markdown".
export async function bbFetch({ base, apiKey, url, proxies, format, allowInsecureSsl, timeoutMs, signal, fetchImpl }) {
  const body = { url, allowRedirects: true, proxies: Boolean(proxies) };
  if (format === "markdown") body.format = "markdown";
  if (allowInsecureSsl) body.allowInsecureSsl = true;
  const { json, bytes } = await call({ base, apiKey, method: "POST", path: "/v1/fetch", body, timeoutMs, signal, where: "fetch", fetchImpl });
  return {
    statusCode: Number.isFinite(json.statusCode) ? json.statusCode : undefined,
    headers: json.headers && typeof json.headers === "object" ? json.headers : {},
    content: json.content,
    contentType: typeof json.contentType === "string" ? json.contentType : "",
    encoding: typeof json.encoding === "string" ? json.encoding : "utf-8",
    responseBytes: bytes,
  };
}

export async function bbCreateSession({ base, apiKey, projectId, proxies, contextId, persist, settings, timeoutSeconds, signal, fetchImpl }) {
  const browserSettings = {
    solveCaptchas: settings.l3SolveCaptchas,
    blockAds: settings.l3BlockAds,
    recordSession: settings.l3RecordSession,
    logSession: settings.l3LogSession,
  };
  if (settings.l3Verified) browserSettings.verified = true;
  if (contextId) browserSettings.context = { id: contextId, persist: Boolean(persist) };
  const body = {
    browserSettings,
    proxies: Boolean(proxies),
    timeout: Math.max(60, Math.min(21600, Math.ceil(timeoutSeconds))),
    userMetadata: { app: "fetch-plus" },
  };
  if (projectId) body.projectId = projectId;
  if (settings.l3Region) body.region = settings.l3Region;
  const { json } = await call({ base, apiKey, method: "POST", path: "/v1/sessions", body, timeoutMs: 20000, signal, where: "session", fetchImpl });
  if (typeof json.id !== "string" || typeof json.connectUrl !== "string") throw new BrowserbaseError("http", 201, "session response missing id or connectUrl");
  return { id: json.id, connectUrl: json.connectUrl };
}

// Best effort; never throws. Returns the Session object or undefined.
export async function bbReleaseSession({ base, apiKey, id, fetchImpl }) {
  try {
    const { json } = await call({ base, apiKey, method: "POST", path: `/v1/sessions/${encodeURIComponent(id)}`, body: { status: "REQUEST_RELEASE" }, timeoutMs: 8000, where: "release", fetchImpl });
    return json;
  } catch {
    return undefined;
  }
}

export async function bbGetSession({ base, apiKey, id, fetchImpl }) {
  try {
    const { json } = await call({ base, apiKey, method: "GET", path: `/v1/sessions/${encodeURIComponent(id)}`, timeoutMs: 8000, where: "get", fetchImpl });
    return json;
  } catch {
    return undefined;
  }
}

export async function bbCreateContext({ base, apiKey, projectId, name, signal, fetchImpl }) {
  const body = {};
  if (projectId) body.projectId = projectId;
  if (name) body.name = name.slice(0, 128);
  const { json } = await call({ base, apiKey, method: "POST", path: "/v1/contexts", body, timeoutMs: 15000, signal, where: "context", fetchImpl });
  if (typeof json.id !== "string") throw new BrowserbaseError("http", 201, "context response missing id");
  return { id: json.id };
}
