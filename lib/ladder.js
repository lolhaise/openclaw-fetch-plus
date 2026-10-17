// The ladder. Runs in code on every call the core hands to fetch-plus:
//   L1  Browserbase Fetch, no proxies           (block signature -> L2)
//   L2  Browserbase Fetch, proxies on           (still walled    -> L3)
//   L3  Browserbase browser session: proxies, captcha solving, persistent context
// Success returns the core's provider shape with extractor "fetch-plus:<rung>".
// Failure names the wall and every rung tried, as text the core passes through.
import { BrowserbaseError, bbFetch } from "./browserbase.js";
import { judgePage } from "./detect.js";
import { collapse, extractHtml, extractMarkdown, markdownToText } from "./extract.js";
import { runSessionRung, wallFromNavError } from "./l3.js";
import { appendCallLog, hostOf, isPrivateHost, recordUsage, resolveCredentials, resolveSettings } from "./util.js";

const TRANSIENT_WALLS = new Set(["timeout", "bb_unreachable", "bb_unavailable", "bb_concurrency", "bb_timeout", "connection_failed"]);

const WALL_TEXT = {
  no_key: ["No Browserbase API key is configured, so no rung could run.", "no", "Configure plugins.entries.fetch-plus.config.browserbaseApiKey (SecretRef) or BROWSERBASE_API_KEY, or switch tools.web.fetch.provider back to firecrawl."],
  bb_auth: ["Browserbase rejected the API key.", "no", "Check the stored BROWSERBASE_API_KEY and that the Browserbase account is active."],
  bb_quota: ["Browserbase says the plan quota is used up.", "no", "Check the Browserbase billing page; overage may be switched off."],
  bb_unreachable: ["Browserbase's API could not be reached from this machine.", "yes", "Retry in a minute; if it persists this machine's network or Browserbase is down."],
  bb_unavailable: ["Browserbase's service answered 503 (temporarily unavailable).", "yes", "Retry shortly."],
  bb_concurrency: ["Browserbase's concurrent browser or fetch limit was hit.", "yes", "Retry shortly; another job is using the browsers."],
  bb_timeout: ["Browserbase did not answer in time.", "yes", "Retry."],
  login_required: ["The site wants a login before it shows this page.", "after login", "Log in once inside this site's fetch-plus context (see contexts.json for its id) and every later read reuses that login."],
  captcha_unsolved: ["A captcha or bot challenge was still up after the browser and captcha solver ran.", "later", "Retry later, or open the page in a browser you are logged into."],
  geo_blocked: ["The site says this content is not available in the proxy's region.", "maybe", "Retry with a geolocated proxy, or read it from a browser you are logged into."],
  proxy_restricted: ["Browserbase's residential proxy provider refuses this site category, and the no-proxy browser also failed.", "no", "Open it in a browser you are logged into."],
  timeout: ["The page did not finish loading inside the time cap.", "yes", "Retry; the site may be slow right now."],
  tls_error: ["The site's TLS certificate failed verification.", "no", "Only if the site is trusted: set allowInsecureSsl true in fetch-plus config."],
  dns_error: ["The hostname does not resolve.", "no", "Check the URL spelling."],
  connection_failed: ["The site refused or dropped the connection.", "yes", "Retry; the site may be down."],
  too_large: ["The page is over Browserbase Fetch's 5 MB limit and the browser rung could not read it either.", "no", "Fetch a smaller page or a specific section."],
  binary_content: ["The URL returns a binary file, not a web page.", "no", "Download it directly instead of reading it as a page."],
  invalid_url: ["The URL is not a public http(s) address.", "no", "Use a public http or https URL."],
  empty: ["Every rung loaded the page but found no readable text.", "maybe", "The content may be inside an image, a canvas or an app that needs interaction."],
};

function wallFromBbError(err) {
  if (!(err instanceof BrowserbaseError)) return "bb_unreachable";
  switch (err.kind) {
    case "auth": return "bb_auth";
    case "quota": return "bb_quota";
    case "concurrency": return "bb_concurrency";
    case "unavailable": return "bb_unavailable";
    case "timeout": return "bb_timeout";
    case "unreachable": return "bb_unreachable";
    case "too_large": return "too_large";
    case "tls": return "tls_error";
    case "target_timeout": return "timeout";
    default: return `bb_${err.kind}${err.httpStatus ? `_${err.httpStatus}` : ""}`;
  }
}

function wallFromVerdict(verdict, why, status) {
  switch (verdict) {
    case "challenge": return "captcha_unsolved";
    case "login": return "login_required";
    case "geo": return "geo_blocked";
    case "not_found": return `http_${status || 404}`;
    case "blocked": return typeof status === "number" && status >= 400 ? `http_${status}` : "blocked";
    case "http_error": return `http_${status}`;
    case "thin": return why === "empty" ? "empty" : "thin";
    default: return verdict;
  }
}

function describeWall(wall) {
  if (WALL_TEXT[wall]) return WALL_TEXT[wall];
  const http = /^http_(\d{3})$/.exec(wall);
  if (http) {
    const code = Number(http[1]);
    if (code === 404 || code === 410) return [`The site answered HTTP ${code}: the page does not exist.`, "no", "Check the URL."];
    return [`The site answered HTTP ${code} on every rung.`, code === 429 || code >= 500 ? "later" : "maybe", "Retry later, or open it in a browser you are logged into."];
  }
  return [`The ladder ended on "${wall}".`, "maybe", "Retry, or open it in a browser you are logged into."];
}

// ---- one Fetch rung (L1 or L2) ----------------------------------------------
async function fetchRung({ rung, url, proxies, timeoutMs, settings, apiKey, extractMode, signal, fetchImpl }) {
  const t0 = Date.now();
  let format = settings.fetchFormat;
  let res;
  let tries = 0;
  for (;;) {
    tries++;
    try {
      recordUsage(settings, { fetchCalls: 1, ...(proxies ? { fetchProxiedCalls: 1 } : {}) });
      res = await bbFetch({ base: settings.apiBaseUrl, apiKey, url, proxies, format, allowInsecureSsl: settings.allowInsecureSsl, timeoutMs, signal, fetchImpl });
      break;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err?.kind === "format" && format === "markdown") {
        format = "raw"; // markdown not enabled for this project, or not convertible: fall back to raw
        continue;
      }
      if (err?.kind === "concurrency" && tries < 2) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      const wall = wallFromBbError(err);
      const fatal = ["bb_auth", "bb_quota", "bb_unreachable"].includes(wall);
      const toL3 = ["too_large", "timeout", "bb_timeout", "bb_unavailable", "bb_concurrency"].includes(wall);
      return { rung, ok: false, wall, outcome: wall, ms: Date.now() - t0, fatal, next: fatal ? "stop" : toL3 ? "L3" : wall === "tls_error" ? "stop" : "L3" };
    }
  }
  if (proxies) recordUsage(settings, { proxyBytesEst: res.responseBytes + 1024 });
  const status = res.statusCode;
  const ctype = String(res.contentType || res.headers?.["content-type"] || res.headers?.["Content-Type"] || "").toLowerCase();
  // The Fetch API does not report the post-redirect URL, so finalUrl stays the requested one.
  const finalUrl = url;
  if (res.encoding === "base64") {
    return { rung, ok: false, wall: "binary_content", outcome: `binary:${ctype.split(";")[0] || "unknown"}`, status, ms: Date.now() - t0, next: "stop" };
  }
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content ?? "", null, 2);
  const isHtml = /html|xml/.test(ctype) || (!ctype && /^\s*</.test(content));
  let ex;
  if (format === "markdown" && !/^\s*</.test(content)) ex = extractMarkdown(content, { extractMode });
  else if (isHtml) ex = await extractHtml(content, { url: finalUrl, extractMode });
  else {
    // JSON, plain text, markdown served by the site: pass through as-is.
    const text = collapse(content);
    ex = { title: undefined, content: /json/.test(ctype) ? content : text, visibleText: text, articleChars: text.length, extractor: /json/.test(ctype) ? "json" : "raw", htmlLength: content.length, scriptCount: 0, hasPasswordInput: false, noscriptText: "" };
  }
  const judged = judgePage({ status, html: isHtml ? content : "", finalUrl, ex, minVisibleChars: isHtml || format === "markdown" ? settings.minVisibleChars : 0, hardFloor: isHtml ? settings.minVisibleCharsHard : 0 });
  const ms = Date.now() - t0;
  if (judged.verdict === "ok") return { rung, ok: true, status, finalUrl, ctype, ex, ms, outcome: "ok" };
  const wall = wallFromVerdict(judged.verdict, judged.why, status);
  let next;
  if (judged.verdict === "not_found") next = "stop";
  else if (judged.verdict === "blocked" || judged.verdict === "challenge" || judged.verdict === "geo") next = rung === "L1" ? "L2" : "L3";
  else if (judged.verdict === "thin") next = rung === "L1" && !(settings.skipL2ForJsShell && judged.why === "js_shell") ? "L2" : "L3";
  else next = "L3"; // login, http_error
  const partial = ex?.content && String(ex.content).trim() && judged.verdict === "thin" ? { status, finalUrl, ctype, ex } : undefined;
  return { rung, ok: false, wall, outcome: `${judged.verdict}${judged.why ? `:${judged.why}` : ""}`, status, ms, next, partial };
}

// ---- L3 ---------------------------------------------------------------------
async function sessionRung({ url, hostname, settings, apiKey, projectId, extractMode, budgetMs, signal, fetchImpl, runSession = runSessionRung }) {
  const t0 = Date.now();
  const run = await runSession({ base: settings.apiBaseUrl, apiKey, projectId, url, hostname, settings, budgetMs, signal, fetchImpl });
  const ms = Date.now() - t0;
  const extra = { ctxNote: run.ctxNote, proxies: run.proxies, proxyRetry: run.proxyRetry, driver: run.page?.driver };
  if (run.error) {
    const wall = run.error instanceof BrowserbaseError ? wallFromBbError(run.error) : "nav_error";
    return { rung: "L3", ok: false, wall, outcome: `session:${wall}`, ms, ...extra };
  }
  if (!run.page) return { rung: "L3", ok: false, wall: "nav_error", outcome: `driver:${(run.driveError || "failed").slice(0, 80)}`, ms, ...extra };
  const p = run.page;
  if (p.navError && !p.html) {
    const wall = wallFromNavError(p.navError);
    return { rung: "L3", ok: false, wall, outcome: `nav:${wall}`, status: p.status, ms, ...extra };
  }
  let ex = await extractHtml(p.html || "", { url: p.finalUrl || url, extractMode });
  // Rendered innerText beats a weak Readability pass on app-like pages.
  const inner = collapse(p.innerText || "");
  if (inner.length > (ex.articleChars || 0) * 1.5 && inner.length > 200) {
    ex = { ...ex, content: extractMode === "text" ? inner : inner.split("\n").filter(Boolean).join("\n\n"), articleChars: inner.length, extractor: "innertext" };
  }
  const judged = judgePage({ status: p.status, html: p.html || "", finalUrl: p.finalUrl || url, ex, minVisibleChars: settings.minVisibleChars, hardFloor: settings.minVisibleCharsHard });
  let verdict = judged.verdict;
  // render_empty: a client-side app that rendered WITHOUT its data leaves a title such as
  // "undefined | Store" and only footer/legal boilerplate as text (a 70 KB product page with
  // zero product words). Boilerplate clears every char floor, so the title is the tell; not a read.
  // Test EVERY title candidate, not the first truthy one: the live document.title can be the
  // template's name ("General PDP Template | Store") while the extracted <title>/og:title reads
  // "undefined | Store", and `p.title || ex.title` would pick the former and call it a read.
  const titleCandidates = [p.title, ex.title, ...Array.from(String(p.html || "").matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi), (m) => m[1]), ...Array.from(String(p.html || "").matchAll(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']*)["']/gi), (m) => m[1])];
  if (titleCandidates.some((t) => /^\s*(undefined|null|\[object Object\])\b/i.test(String(t || "")) || /^\s*General PDP Template\b/i.test(String(t || "")))) {
    return { rung: "L3", ok: false, wall: "empty", outcome: "thin:render_empty", status: p.status, ms, ...extra };
  }
  if (p.captcha?.started && !p.captcha?.finished) verdict = "challenge";
  if (p.challengeWait?.timedOut && verdict !== "ok") verdict = verdict === "thin" ? "challenge" : verdict;
  // Last rung: a short but real page is still an answer.
  if (verdict === "ok" || (verdict === "thin" && ex.content && String(ex.content).trim())) {
    return { rung: "L3", ok: true, status: p.status, finalUrl: p.finalUrl || url, ctype: "text/html", ex, ms, outcome: verdict === "ok" ? "ok" : "ok:short", short: verdict !== "ok", ...extra };
  }
  const wall = wallFromVerdict(verdict, judged.why, p.status);
  return { rung: "L3", ok: false, wall: wall === "thin" ? "empty" : wall, outcome: `${verdict}${judged.why ? `:${judged.why}` : ""}`, status: p.status, ms, ...extra };
}

// ---- result shapes ------------------------------------------------------------
function trail(attempts) {
  return attempts.map((a) => `${a.rung}:${a.outcome}`).join(",");
}

function rungLabel(a) {
  if (a.rung === "L1") return "L1 Browserbase Fetch";
  if (a.rung === "L2") return "L2 Browserbase Fetch + proxies";
  return `L3 browser session${a.proxies ? " + proxies" : ""} + captcha solver${a.ctxNote ? ` (${a.ctxNote})` : ""}${a.proxyRetry ? ", retried without proxies" : ""}`;
}

function successPayload({ url, win, attempts, extractMode, startedAt }) {
  const text = String(win.ex.content ?? "");
  const climbed = attempts.length > 1;
  const warnings = [];
  if (climbed) warnings.push(`fetch-plus read this at ${win.rung} after ${trail(attempts.slice(0, -1))}`);
  if (win.short) warnings.push("fetch-plus: the rendered page is short; it may be partial");
  return {
    url,
    finalUrl: win.finalUrl || url,
    status: typeof win.status === "number" ? win.status : 200,
    ...(win.ctype ? { contentType: win.ctype.split(";")[0].trim() } : {}),
    ...(win.ex.title ? { title: win.ex.title } : {}),
    extractor: `fetch-plus:${win.rung}`,
    extractMode,
    text,
    rawLength: text.length,
    tookMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  };
}

export class FetchPlusWallError extends Error {
  constructor(message, wall, payload) {
    super(message);
    this.name = "FetchPlusWallError";
    this.wall = wall;
    this.payload = payload;
  }
}

function failurePayload({ url, wall, attempts, extractMode, startedAt, host, partial, cacheNoteMinutes }) {
  const [what, retry, next] = describeWall(wall);
  const lastStatus = [...attempts].reverse().find((a) => typeof a.status === "number")?.status;
  const lines = [
    `fetch-plus could not read this page. wall=${wall} host=${host} rungs=${trail(attempts) || "none"} retry=${retry}`,
    "",
    `What stopped it: ${what}`,
    `Rungs tried: ${attempts.length ? attempts.map((a) => `${rungLabel(a)} -> ${a.outcome}${typeof a.status === "number" ? ` (HTTP ${a.status})` : ""}, ${a.ms} ms`).join("; ") : "none"}.`,
    `Next move: ${next}`,
  ];
  if (cacheNoteMinutes > 0) {
    lines.push(`Cache: web_fetch keeps this answer for ${cacheNoteMinutes} minutes for the same URL, extractMode and maxChars; to retry sooner, pass a different maxChars.`);
  }
  if (partial?.ex?.content) {
    lines.push("", "Partial text from the best rung (short, may be a stub):", "", String(partial.ex.content).slice(0, 4000));
  }
  const text = lines.join("\n");
  return {
    url,
    finalUrl: partial?.finalUrl || url,
    status: typeof lastStatus === "number" ? lastStatus : 0,
    contentType: "text/plain",
    title: `fetch-plus: ${wall}`,
    extractor: `fetch-plus:failed:${wall}`,
    extractMode,
    text: extractMode === "text" ? markdownToText(text) : text,
    rawLength: text.length,
    tookMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
    warning: `fetch-plus wall=${wall} rungs=${trail(attempts) || "none"}`,
  };
}

// The core caches a returned payload for tools.web.fetch.cacheTtlMinutes (default 15,
// the core's resolveCacheTtlMs).
function cacheTtlMinutesOf(ctx) {
  const v = ctx?.fetchConfig?.cacheTtlMinutes ?? ctx?.config?.tools?.web?.fetch?.cacheTtlMinutes;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 15;
}

function pickWall(attempts) {
  const last = attempts[attempts.length - 1];
  const l3 = attempts.find((a) => a.rung === "L3");
  // The ladder stopped because Browserbase refused (auth, quota, unreachable): name that,
  // not the site's wall from an earlier rung, so a billing or key problem is never hidden.
  if (last?.fatal && /^bb_/.test(last.wall)) return last.wall;
  // L3 reached the site: its finding is the most informed one.
  if (l3 && !/^bb_|^nav_error$/.test(l3.wall)) return l3.wall;
  // L3 never started because Browserbase itself failed or refused (outage, concurrency,
  // quota, auth): that is what stopped the ladder. Naming the earlier rung's captcha here
  // would say a solver ran when none did, and would hide a quota or billing problem.
  if (l3 && /^bb_/.test(l3.wall)) return l3.wall;
  const order = ["login_required", "captcha_unsolved", "geo_blocked", "proxy_restricted", "tls_error", "dns_error", "too_large", "binary_content"];
  for (const w of order) if (attempts.some((a) => a.wall === w)) return w;
  const http = [...attempts].reverse().find((a) => /^http_\d{3}$/.test(a.wall));
  if (http) return http.wall;
  const blocked = [...attempts].reverse().find((a) => a.wall === "blocked");
  if (blocked) return typeof blocked.status === "number" ? `http_${blocked.status}` : "blocked";
  return last?.wall === "thin" ? "empty" : last?.wall || "empty";
}

// ---- entry -----------------------------------------------------------------------
// deps (tests only): fetchImpl replaces global fetch for every Browserbase call,
// credentials skips key resolution, settingsOverrides wins over plugin config, and
// runSessionRung replaces the L3 browser session.
export async function runFetchPlus(args, ctx, executionContext = {}, deps = {}) {
  const startedAt = Date.now();
  const signal = executionContext?.signal;
  signal?.throwIfAborted?.();
  const settings = resolveSettings(ctx?.config, deps.settingsOverrides);
  const fetchImpl = deps.fetchImpl || fetch;
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  const extractMode = args?.extractMode === "text" ? "text" : "markdown";
  const host = hostOf(url) || "invalid";
  const attempts = [];
  let partial;

  const finish = (result, wall) => {
    appendCallLog(settings, {
      host,
      rung: result.ok ? result.rung : "none",
      outcome: result.ok ? "ok" : "fail",
      ...(wall ? { wall } : {}),
      status: typeof result.status === "number" ? result.status : null,
      ms: Date.now() - startedAt,
      rungs: trail(attempts),
    });
  };
  const fail = (wall) => {
    finish({ ok: false, status: attempts.at(-1)?.status }, wall);
    // A throw only reaches the model when the core surfaces provider errors: after its own
    // network error or non-2xx, or with readability off. After a 2xx HTML page whose
    // Readability came back empty the core SWALLOWS the throw and returns, and caches, its
    // basic cleanup of that page instead: on a Reddit challenge page that was the word
    // "Reddit", 6 chars. A 2xx on any rung here means the site serves 2xx pages, so that is
    // the likely call point: return the named wall instead.
    const saw2xx = attempts.some((a) => typeof a.status === "number" && a.status >= 200 && a.status < 300);
    const throwIt = settings.failureMode === "throw" || (settings.failureMode === "auto" && TRANSIENT_WALLS.has(wall) && !saw2xx);
    const cacheNoteMinutes = !throwIt && TRANSIENT_WALLS.has(wall) ? cacheTtlMinutesOf(ctx) : 0;
    const payload = failurePayload({ url, wall, attempts, extractMode, startedAt, host, partial, cacheNoteMinutes });
    if (throwIt) throw new FetchPlusWallError(payload.text, wall, payload);
    return payload;
  };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail("invalid_url");
  }
  if (!/^https?:$/.test(parsed.protocol) || (settings.blockPrivateHosts && isPrivateHost(parsed.hostname))) return fail("invalid_url");

  const creds = deps.credentials || (await resolveCredentials(ctx?.config));
  if (!creds.apiKey) return fail("no_key");

  const total = settings.totalMaxSeconds * 1000;
  const left = () => total - (Date.now() - startedAt);
  const common = { url, settings, apiKey: creds.apiKey, extractMode, signal, fetchImpl };

  // l3FirstHosts: sites that serve a JavaScript shell with enough boilerplate to pass every text
  // check (a 70 KB product page template whose only text is the footer and the mega-menu) start
  // at the real browser; L1 and L2 cannot render them.
  const hostLc = parsed.hostname.toLowerCase();
  const l3First = settings.l3FirstHosts.some((h) => hostLc === h || hostLc.endsWith("." + h));
  let next = "L3";
  if (!l3First) {
  // L1
  const r1 = await fetchRung({ ...common, rung: "L1", proxies: false, timeoutMs: Math.min(settings.l1TimeoutMs, left()) });
  attempts.push(r1);
  if (r1.ok) {
    finish(r1);
    return successPayload({ url, win: r1, attempts, extractMode, startedAt });
  }
  partial = r1.partial || partial;
  if (r1.next === "stop") return fail(pickWall(attempts));
  next = r1.next;

  // L2
  if (next === "L2" && settings.l2Proxies && left() > 5000) {
    const r2 = await fetchRung({ ...common, rung: "L2", proxies: true, timeoutMs: Math.min(settings.l2TimeoutMs, left() - 2000) });
    attempts.push(r2);
    if (r2.ok) {
      finish(r2);
      return successPayload({ url, win: r2, attempts, extractMode, startedAt });
    }
    partial = r2.partial || partial;
    if (r2.next === "stop" || r2.fatal) return fail(pickWall(attempts));
    next = "L3";
  } else if (next === "L2") {
    next = "L3";
  }
  }

  // L3
  if (next === "L3" && settings.l3Enabled && left() > 8000) {
    const budgetMs = Math.min(settings.l3MaxSeconds * 1000, left() - 1000);
    const r3 = await sessionRung({ url, hostname: parsed.hostname, settings, apiKey: creds.apiKey, projectId: creds.projectId, extractMode, budgetMs, signal, fetchImpl, runSession: deps.runSessionRung });
    attempts.push(r3);
    if (r3.ok) {
      finish(r3);
      return successPayload({ url, win: r3, attempts, extractMode, startedAt });
    }
  }
  if (signal?.aborted) signal.throwIfAborted();
  const wall = attempts.length ? pickWall(attempts) : "timeout";
  if (left() <= 8000 && attempts.every((a) => a.rung !== "L3") && settings.l3Enabled && next === "L3") {
    return fail("timeout");
  }
  return fail(wall);
}
