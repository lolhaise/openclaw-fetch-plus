// L3: a real Browserbase browser session (proxies, captcha solving, a persistent
// context per site group), driven over CDP, hard-capped at l3MaxSeconds.
//
// Driver: playwright-core's chromium.connectOverCDP when it loads (it ships
// inside the OpenClaw install), else a minimal CDP client on Node's global
// WebSocket. Browserbase emits console "browserbase-solving-started" and
// "browserbase-solving-finished" around a captcha solve (captcha-solving.md).
import { acquireContext } from "./contexts.js";
import { bbCreateSession, bbGetSession, bbReleaseSession } from "./browserbase.js";
import { detectChallenge } from "./detect.js";
import path from "node:path";
import { OPENCLAW_NM, importSpecifier, recordUsage, sleep, trackPending } from "./util.js";

let pwModule;
let pwLoadError;

export async function loadPlaywright(settings) {
  if (pwModule) return pwModule;
  const candidates = [settings.playwrightCorePath, path.join(OPENCLAW_NM, "playwright-core", "index.mjs"), "playwright-core"].filter(Boolean);
  for (const c of candidates) {
    try {
      const m = await import(importSpecifier(c));
      if (typeof m?.chromium?.connectOverCDP === "function") {
        pwModule = m;
        return m;
      }
    } catch (err) {
      pwLoadError = err;
    }
  }
  return null;
}

const EXTRACT_JS = `(() => {
  const b = document.body;
  let text = "";
  if (b) {
    const c = b.cloneNode(true);
    c.querySelectorAll("script,style,noscript,template,svg,nav,header,footer,aside,[role=navigation],[aria-hidden=true]").forEach((e) => e.remove());
    text = c.innerText || c.textContent || "";
  }
  return { html: document.documentElement ? document.documentElement.outerHTML : "", title: document.title || "", url: location.href, text };
})()`;

const PROBE_JS = `(() => ({ title: document.title || "", head: document.documentElement ? document.documentElement.outerHTML.slice(0, 200000) : "", textLen: (document.body && (document.body.innerText || "").length) || 0, text: document.body ? (document.body.innerText || "").slice(0, 3000) : "" }))()`;

// Wait while a captcha is being solved or a JS challenge page is still up.
async function waitOutChallenge({ probe, captcha, settings, deadline, signal, waitIdle }) {
  const until = Math.min(deadline - 2000, Date.now() + settings.l3CaptchaWaitMs);
  let sawChallenge = false;
  while (Date.now() < until) {
    let p;
    try {
      p = await probe();
    } catch {
      return { sawChallenge };
    }
    const challenge = detectChallenge({ html: p.head, title: p.title, visibleText: p.text });
    const solving = captcha.started && !captcha.finished;
    if (!challenge && !solving) {
      if (sawChallenge || captcha.finished) await waitIdle(Math.min(8000, Math.max(0, deadline - Date.now() - 2000)));
      return { sawChallenge };
    }
    sawChallenge = true;
    await sleep(1000, signal);
  }
  return { sawChallenge, timedOut: true };
}

async function driveWithPlaywright({ pw, connectUrl, url, settings, deadline, signal }) {
  const remaining = () => Math.max(1000, deadline - Date.now());
  const browser = await pw.chromium.connectOverCDP(connectUrl, { timeout: Math.min(20000, remaining()) });
  const captcha = { started: false, finished: false };
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("console", (m) => {
      const t = m.text();
      if (t === "browserbase-solving-started") captcha.started = true;
      else if (t === "browserbase-solving-finished") captcha.finished = true;
    });
    let lastNavStatus;
    page.on("response", (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastNavStatus = r.status();
      } catch {}
    });
    let navError;
    let resp;
    try {
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });
    } catch (err) {
      navError = String(err?.message || err).split("\n")[0].slice(0, 200);
    }
    const waitIdle = (ms) => page.waitForLoadState("networkidle", { timeout: Math.max(1, ms) }).catch(() => {});
    let challengeWait = {};
    if (!navError) {
      await waitIdle(Math.min(settings.l3NetworkIdleMs, remaining() - 2000));
      challengeWait = await waitOutChallenge({ probe: () => page.evaluate(PROBE_JS), captcha, settings, deadline, signal, waitIdle });
    }
    const snap = await page.evaluate(EXTRACT_JS).catch(() => ({ html: "", title: "", url: page.url(), text: "" }));
    return { driver: "playwright", status: lastNavStatus ?? resp?.status(), finalUrl: snap.url || page.url(), title: snap.title, html: snap.html, innerText: snap.text, captcha, navError, challengeWait };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- minimal CDP client (fallback driver) ----------------------------------
class MiniCdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.waiting = new Map();
    this.listeners = new Set();
  }
  open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const t = setTimeout(() => reject(new Error("CDP connect timeout")), timeoutMs);
      ws.onopen = () => {
        clearTimeout(t);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("CDP connect failed"));
      };
      ws.onclose = () => {
        for (const { reject: rj } of this.waiting.values()) rj(new Error("CDP closed"));
        this.waiting.clear();
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
        } catch {
          return;
        }
        if (msg.id && this.waiting.has(msg.id)) {
          const w = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          if (msg.error) w.reject(new Error(msg.error.message || "CDP error"));
          else w.resolve(msg.result || {});
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      };
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(fn) {
    this.listeners.add(fn);
  }
  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

async function driveWithCdp({ connectUrl, url, settings, deadline, signal }) {
  const remaining = () => Math.max(1000, deadline - Date.now());
  const cdp = new MiniCdp(connectUrl);
  await cdp.open(Math.min(20000, remaining()));
  const captcha = { started: false, finished: false };
  try {
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    let target = targetInfos.find((t) => t.type === "page");
    if (!target) target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const s = (m, p, ms) => cdp.send(m, p, sessionId, ms);
    await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Network.enable")]);
    await s("Page.setLifecycleEventsEnabled", { enabled: true });
    const { frameTree } = await s("Page.getFrameTree");
    const mainFrameId = frameTree?.frame?.id;
    let lastNavStatus;
    const life = new Set();
    let inflight = 0;
    let lastNetChange = Date.now();
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      const p = msg.params || {};
      if (msg.method === "Runtime.consoleAPICalled") {
        const t = p.args?.[0]?.value;
        if (t === "browserbase-solving-started") captcha.started = true;
        else if (t === "browserbase-solving-finished") captcha.finished = true;
      } else if (msg.method === "Network.responseReceived" && p.type === "Document" && p.frameId === mainFrameId) {
        lastNavStatus = p.response?.status;
      } else if (msg.method === "Page.lifecycleEvent" && p.frameId === mainFrameId) {
        if (p.name === "init") life.clear();
        life.add(p.name);
      } else if (msg.method === "Network.requestWillBeSent") {
        inflight++;
        lastNetChange = Date.now();
      } else if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") {
        inflight = Math.max(0, inflight - 1);
        lastNetChange = Date.now();
      }
    });
    const waitFor = async (pred, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (pred()) return true;
        await sleep(100, signal);
      }
      return pred();
    };
    let navError;
    const nav = await s("Page.navigate", { url }, remaining()).catch((e) => ({ errorText: String(e.message) }));
    if (nav.errorText) navError = `net::${nav.errorText}`;
    const waitIdle = (ms) => waitFor(() => life.has("networkIdle") || (inflight === 0 && Date.now() - lastNetChange > 500 && life.has("load")), Math.max(1, ms));
    let challengeWait = {};
    if (!navError) {
      await waitFor(() => life.has("DOMContentLoaded"), remaining() - 2000);
      await waitIdle(Math.min(settings.l3NetworkIdleMs, remaining() - 2000));
      const probe = async () => (await s("Runtime.evaluate", { expression: PROBE_JS, returnByValue: true }, 10000)).result?.value || {};
      challengeWait = await waitOutChallenge({ probe, captcha, settings, deadline, signal, waitIdle });
    }
    const snapRes = await s("Runtime.evaluate", { expression: EXTRACT_JS, returnByValue: true }, 15000).catch(() => ({}));
    const snap = snapRes.result?.value || { html: "", title: "", url, text: "" };
    return { driver: "cdp", status: lastNavStatus, finalUrl: snap.url, title: snap.title, html: snap.html, innerText: snap.text, captcha, navError, challengeWait };
  } finally {
    cdp.close();
  }
}

export function wallFromNavError(msg) {
  const m = String(msg || "");
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_PROXY/i.test(m)) return "proxy_restricted";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(m)) return "dns_error";
  if (/ERR_CERT|SSL|certificate/i.test(m)) return "tls_error";
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/i.test(m)) return "connection_failed";
  if (/Timeout|timed out|ERR_TIMED_OUT/i.test(m)) return "timeout";
  if (/ERR_ABORTED|ERR_BLOCKED_BY/i.test(m)) return "nav_aborted";
  return "nav_error";
}

async function openAndDrive({ base, apiKey, projectId, url, settings, ctx, proxies, deadline, signal, fetchImpl }) {
  const t0 = Date.now();
  const session = await bbCreateSession({
    base, apiKey, projectId, proxies, settings, signal, fetchImpl,
    contextId: ctx?.id || undefined,
    persist: ctx?.persist,
    timeoutSeconds: Math.ceil((deadline - Date.now()) / 1000) + 30,
  });
  let page;
  let driveError;
  try {
    const drv = settings.l3Driver;
    const pw = drv === "cdp" ? null : await loadPlaywright(settings);
    if (drv === "playwright" && !pw) throw new Error("playwright-core not loadable");
    page = pw
      ? await driveWithPlaywright({ pw, connectUrl: session.connectUrl, url, settings, deadline, signal })
      : await driveWithCdp({ connectUrl: session.connectUrl, url, settings, deadline, signal });
  } catch (err) {
    driveError = String(err?.message || err).split("\n")[0].slice(0, 200);
  } finally {
    const released = await bbReleaseSession({ base, apiKey, id: session.id, fetchImpl });
    const seconds = (Date.now() - t0) / 1000;
    const measured = Number.isFinite(released?.proxyBytes) ? released.proxyBytes : undefined;
    recordUsage(settings, {
      browserSessions: 1,
      browserSeconds: seconds,
      ...(proxies ? { proxyBytesEst: Math.max(1048576, (page?.html?.length || 0) * 4) } : {}),
      ...(measured ? { proxyBytesMeasured: measured } : {}),
    });
    if (proxies && measured === undefined) {
      // proxyBytes settles after release; read it once in the background.
      trackPending(
        sleep(3000).then(() => bbGetSession({ base, apiKey, id: session.id, fetchImpl })).then((s) => {
          if (Number.isFinite(s?.proxyBytes) && s.proxyBytes > 0) return recordUsage(settings, { proxyBytesMeasured: s.proxyBytes });
        }).catch(() => {}),
      );
    }
  }
  return { page, driveError, sessionSeconds: (Date.now() - t0) / 1000 };
}

// Returns { page, driveError, ctxNote, proxies, error? } for the ladder to judge.
export async function runSessionRung({ base, apiKey, projectId, url, hostname, settings, budgetMs, signal, fetchImpl }) {
  const deadline = Date.now() + Math.max(5000, budgetMs);
  let ctx = null;
  if (settings.contextStrategy !== "none") {
    ctx = await acquireContext({ hostname, settings, base, apiKey, projectId, signal, fetchImpl });
  }
  const ctxNote = ctx?.note;
  let proxies = settings.l3Proxies;
  try {
    let run;
    try {
      run = await openAndDrive({ base, apiKey, projectId, url, settings, ctx: ctx?.id ? ctx : null, proxies, deadline, signal, fetchImpl });
    } catch (err) {
      if (err?.kind === "context" && ctx?.id) {
        // Stale or foreign context id: forget it, make a fresh one, retry once.
        ctx.done({ used: false, invalid: true });
        ctx = await acquireContext({ hostname, settings, base, apiKey, projectId, signal, fetchImpl, forceNew: true });
        run = await openAndDrive({ base, apiKey, projectId, url, settings, ctx: ctx?.id ? ctx : null, proxies, deadline, signal, fetchImpl });
      } else {
        throw err;
      }
    }
    // Proxy providers refuse some site categories; the docs' first fix is "try without proxies".
    if (proxies && run.page?.navError && wallFromNavError(run.page.navError) === "proxy_restricted" && deadline - Date.now() > 12000) {
      proxies = false;
      const retry = await openAndDrive({ base, apiKey, projectId, url, settings, ctx: ctx?.id ? ctx : null, proxies, deadline, signal, fetchImpl });
      return { ...retry, ctxNote, proxies, proxyRetry: true };
    }
    return { ...run, ctxNote, proxies };
  } catch (err) {
    return { page: null, error: err, ctxNote, proxies };
  } finally {
    ctx?.done?.({ used: true });
  }
}

export function playwrightStatus() {
  return pwModule ? "loaded" : pwLoadError ? `unavailable: ${String(pwLoadError?.message || pwLoadError).slice(0, 120)}` : "not tried";
}
