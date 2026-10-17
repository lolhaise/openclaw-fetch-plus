// fetch-plus shared helpers: settings, key resolution, private state files,
// monthly usage counters, budget alerts and the per-call log.
//
// Privacy rules for everything written here: hostnames only, never a URL, never
// page text, never a key. State dir is 0700, files are 0600.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROVIDER_ID = "fetch-plus";
export const DEFAULTS = Object.freeze({
  apiBaseUrl: "https://api.browserbase.com",
  fetchFormat: "raw", // raw = normal Fetch (cheapest, no project enablement); markdown = Fetch Extract
  l1TimeoutMs: 20000,
  l2TimeoutMs: 25000,
  l2Proxies: true,
  skipL2ForJsShell: false,
  l3Enabled: true,
  l3Proxies: true,
  l3MaxSeconds: 60,
  l3SolveCaptchas: true,
  l3Verified: false, // Verified browser mode is a Scale-plan feature
  l3BlockAds: true,
  l3RecordSession: false,
  l3LogSession: false,
  l3Region: "",
  l3NetworkIdleMs: 15000,
  l3CaptchaWaitMs: 30000,
  l3Driver: "auto", // auto | playwright | cdp
  contextStrategy: "site", // site | host | none
  contextGroups: {},
  contextPersist: true,
  contextWaitMs: 8000,
  contextSettleMs: 3000,
  minVisibleChars: 500,
  minVisibleCharsHard: 200,
  l3FirstHosts: [],
  totalMaxSeconds: 110,
  failureMode: "auto", // auto | payload | throw
  blockPrivateHosts: true,
  allowInsecureSsl: false,
  alertFetchCalls: 5000,
  alertProxyBytes: 2 * 1024 * 1024 * 1024,
  alertBrowserHours: 150,
  stateDir: "~/.cache/openclaw-fetch-plus",
  playwrightCorePath: "",
});

const HOME = os.homedir();

export function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  return p === "~" ? HOME : p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

// ---- OpenClaw install root ---------------------------------------------------
// The plugin borrows the plugin SDK, linkedom, @mozilla/readability and
// playwright-core from the OpenClaw install instead of shipping copies. Where that
// install lives, first answer wins:
//   1. OPENCLAW_ROOT in the environment
//   2. Node resolution from this file (a plugin-local node_modules/openclaw link)
//   3. walking up from process.argv[1], the gateway's own entry script
//   4. the global prefix next to the node binary (bin/../lib/node_modules, or
//      node_modules beside node.exe on Windows)
//   5. /usr/lib/node_modules/openclaw, the default global prefix on Linux
const LEGACY_OPENCLAW_ROOT = "/usr/lib/node_modules/openclaw";

function isOpenclawRoot(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))?.name === "openclaw";
  } catch {
    return false;
  }
}

function findOpenclawAbove(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (isOpenclawRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Returns { root, source } with source "env" | "require" | "argv" | "execPath" | "fallback".
// Every input is injectable so the order can be tested without a real install.
export function resolveOpenclawRoot({ env = process.env, argv1 = process.argv[1], execPath = process.execPath, from = import.meta.url } = {}) {
  const fromEnv = typeof env?.OPENCLAW_ROOT === "string" ? env.OPENCLAW_ROOT.trim() : "";
  if (fromEnv) return { root: path.resolve(expandHome(fromEnv)), source: "env" };
  const req = createRequire(from);
  // openclaw does not export ./package.json, so an exported SDK subpath is the
  // fallback probe; either way the root is the nearest package named "openclaw".
  for (const spec of ["openclaw/package.json", "openclaw/plugin-sdk/plugin-entry"]) {
    try {
      const hit = findOpenclawAbove(path.dirname(req.resolve(spec)));
      if (hit) return { root: hit, source: "require" };
    } catch {
      // Not resolvable from here; try the next probe.
    }
  }
  if (typeof argv1 === "string" && argv1) {
    const hit = findOpenclawAbove(path.dirname(realpathOr(argv1)));
    if (hit) return { root: hit, source: "argv" };
  }
  if (typeof execPath === "string" && execPath) {
    for (const bin of new Set([path.dirname(execPath), path.dirname(realpathOr(execPath))])) {
      for (const dir of [path.join(bin, "..", "lib", "node_modules", "openclaw"), path.join(bin, "node_modules", "openclaw")]) {
        if (isOpenclawRoot(dir)) return { root: path.resolve(dir), source: "execPath" };
      }
    }
  }
  return { root: LEGACY_OPENCLAW_ROOT, source: "fallback" };
}

const openclawRoot = resolveOpenclawRoot();
export const OPENCLAW_ROOT = openclawRoot.root;
export const OPENCLAW_ROOT_SOURCE = openclawRoot.source;
export const OPENCLAW_NM = path.join(OPENCLAW_ROOT, "node_modules");

// import() needs a file URL for an absolute path on Windows; bare specifiers pass through.
export function importSpecifier(p) {
  return path.isAbsolute(p) ? pathToFileURL(p).href : p;
}

function intIn(value, min, max, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

export function pluginConfigOf(config) {
  const raw = config?.plugins?.entries?.[PROVIDER_ID]?.config;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

// Settings are read on every call from the config the core hands createTool, so
// config edits hot-apply without a restart.
export function resolveSettings(config, overrides = {}) {
  const m = { ...pluginConfigOf(config), ...overrides };
  const groups = {};
  if (m.contextGroups && typeof m.contextGroups === "object" && !Array.isArray(m.contextGroups)) {
    for (const [name, list] of Object.entries(m.contextGroups)) {
      if (Array.isArray(list)) groups[name] = list.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim().toLowerCase());
    }
  }
  const base = typeof m.apiBaseUrl === "string" && /^https?:\/\//.test(m.apiBaseUrl.trim()) ? m.apiBaseUrl.trim().replace(/\/+$/, "") : DEFAULTS.apiBaseUrl;
  return {
    apiBaseUrl: base,
    fetchFormat: oneOf(m.fetchFormat, ["raw", "markdown"], DEFAULTS.fetchFormat),
    l1TimeoutMs: intIn(m.l1TimeoutMs, 2000, 60000, DEFAULTS.l1TimeoutMs),
    l2TimeoutMs: intIn(m.l2TimeoutMs, 2000, 60000, DEFAULTS.l2TimeoutMs),
    l2Proxies: bool(m.l2Proxies, DEFAULTS.l2Proxies),
    skipL2ForJsShell: bool(m.skipL2ForJsShell, DEFAULTS.skipL2ForJsShell),
    l3Enabled: bool(m.l3Enabled, DEFAULTS.l3Enabled),
    l3Proxies: bool(m.l3Proxies, DEFAULTS.l3Proxies),
    l3MaxSeconds: intIn(m.l3MaxSeconds, 10, 300, DEFAULTS.l3MaxSeconds),
    l3SolveCaptchas: bool(m.l3SolveCaptchas, DEFAULTS.l3SolveCaptchas),
    l3Verified: bool(m.l3Verified, DEFAULTS.l3Verified),
    l3BlockAds: bool(m.l3BlockAds, DEFAULTS.l3BlockAds),
    l3RecordSession: bool(m.l3RecordSession, DEFAULTS.l3RecordSession),
    l3LogSession: bool(m.l3LogSession, DEFAULTS.l3LogSession),
    l3Region: oneOf(m.l3Region, ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"], ""),
    l3NetworkIdleMs: intIn(m.l3NetworkIdleMs, 1000, 60000, DEFAULTS.l3NetworkIdleMs),
    l3CaptchaWaitMs: intIn(m.l3CaptchaWaitMs, 0, 120000, DEFAULTS.l3CaptchaWaitMs),
    l3Driver: oneOf(m.l3Driver, ["auto", "playwright", "cdp"], DEFAULTS.l3Driver),
    contextStrategy: oneOf(m.contextStrategy, ["site", "host", "none"], DEFAULTS.contextStrategy),
    contextGroups: groups,
    l3FirstHosts: Array.isArray(m.l3FirstHosts) ? m.l3FirstHosts.filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim().toLowerCase().replace(/^\*?\./, "")) : DEFAULTS.l3FirstHosts,
    contextPersist: bool(m.contextPersist, DEFAULTS.contextPersist),
    contextWaitMs: intIn(m.contextWaitMs, 0, 60000, DEFAULTS.contextWaitMs),
    contextSettleMs: intIn(m.contextSettleMs, 0, 30000, DEFAULTS.contextSettleMs),
    minVisibleChars: intIn(m.minVisibleChars, 0, 20000, DEFAULTS.minVisibleChars),
    minVisibleCharsHard: intIn(m.minVisibleCharsHard, 0, 5000, DEFAULTS.minVisibleCharsHard),
    totalMaxSeconds: intIn(m.totalMaxSeconds, 20, 600, DEFAULTS.totalMaxSeconds),
    failureMode: oneOf(m.failureMode, ["auto", "payload", "throw"], DEFAULTS.failureMode),
    blockPrivateHosts: bool(m.blockPrivateHosts, DEFAULTS.blockPrivateHosts),
    allowInsecureSsl: bool(m.allowInsecureSsl, DEFAULTS.allowInsecureSsl),
    alertFetchCalls: intIn(m.alertFetchCalls, 1, 1e9, DEFAULTS.alertFetchCalls),
    alertProxyBytes: intIn(m.alertProxyBytes, 1, Number.MAX_SAFE_INTEGER, DEFAULTS.alertProxyBytes),
    alertBrowserHours: intIn(m.alertBrowserHours, 1, 1e6, DEFAULTS.alertBrowserHours),
    stateDir: expandHome(typeof m.stateDir === "string" && m.stateDir.trim() ? m.stateDir.trim() : DEFAULTS.stateDir),
    playwrightCorePath: typeof m.playwrightCorePath === "string" ? expandHome(m.playwrightCorePath.trim()) : "",
    noLog: m.noLog === true,
    // Test seam only: lets the harness point the rungs at a mock without env games.
    _now: typeof overrides._now === "function" ? overrides._now : undefined,
  };
}

// ---- credentials -----------------------------------------------------------
// The core resolves browserbaseApiKey (provider credentialPath) and
// browserbaseProjectId (manifest configContracts.secretInputs) at gateway
// activation and hands createTool a runtime config holding plain strings. If a
// value still arrives as a SecretRef object (a path the core did not
// materialize), resolve it once through the SDK helper and keep it in memory.
const refCache = new Map();

function isRefShaped(v) {
  return v && typeof v === "object" && !Array.isArray(v) && typeof v.source === "string" && typeof v.id === "string";
}

async function resolveOne({ config, field, envVar }) {
  const raw = pluginConfigOf(config)[field];
  if (typeof raw === "string" && raw.trim()) return { value: raw.trim(), source: "config" };
  if (isRefShaped(raw)) {
    const cacheKey = `${field}:${raw.source}:${raw.provider ?? ""}:${raw.id}`;
    if (refCache.has(cacheKey)) return refCache.get(cacheKey);
    let out = { value: undefined, source: "secretRef-unresolved" };
    try {
      let sdk;
      try {
        sdk = await import("openclaw/plugin-sdk/secret-input-runtime");
      } catch {
        sdk = await import(importSpecifier(path.join(OPENCLAW_ROOT, "dist", "plugin-sdk", "secret-input-runtime.js")));
      }
      const res = await sdk.resolveConfiguredSecretInputWithFallback({
        config,
        env: process.env,
        value: raw,
        path: `plugins.entries.${PROVIDER_ID}.config.${field}`,
        readFallback: () => process.env[envVar],
      });
      if (res?.value) out = { value: String(res.value).trim(), source: res.source ?? "secretRef" };
    } catch {
      // Unresolvable here; fall through to env below. Never log the ref or value.
    }
    if (out.value) {
      refCache.set(cacheKey, out);
      return out;
    }
  }
  const env = typeof process.env[envVar] === "string" ? process.env[envVar].trim() : "";
  if (env) return { value: env, source: "env" };
  return { value: undefined, source: isRefShaped(raw) ? "secretRef-unresolved" : "missing" };
}

export async function resolveCredentials(config) {
  const [key, project] = await Promise.all([
    resolveOne({ config, field: "browserbaseApiKey", envVar: "BROWSERBASE_API_KEY" }),
    resolveOne({ config, field: "browserbaseProjectId", envVar: "BROWSERBASE_PROJECT_ID" }),
  ]);
  return { apiKey: key.value, apiKeySource: key.source, projectId: project.value, projectIdSource: project.source };
}

// ---- private state files ---------------------------------------------------
export function ensureStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeJsonAtomic(file, value) {
  ensureStateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function appendLine(file, line) {
  ensureStateDir(path.dirname(file));
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, line.endsWith("\n") ? line : line + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

export function monthStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

// One line per ladder run. Hostname only; no URL, no page text, no key.
export function appendCallLog(settings, entry) {
  if (settings.noLog) return;
  try {
    appendLine(path.join(settings.stateDir, "calls.jsonl"), JSON.stringify({ ts: isoLocal(), ...entry }));
  } catch {
    // Telemetry never breaks a fetch.
  }
}

// ---- monthly usage + budget alerts -----------------------------------------
// Updates are serialized in-process so parallel fetches do not lose counts.
let usageChain = Promise.resolve();
const pending = new Set();

export function usageFile(settings, month = monthStamp()) {
  return path.join(settings.stateDir, `usage-${month}.json`);
}

function emptyUsage(month) {
  return {
    month,
    fetchCalls: 0,
    fetchProxiedCalls: 0,
    proxyBytesEst: 0,
    proxyBytesMeasured: 0,
    browserSessions: 0,
    browserSeconds: 0,
    alerts: { fetchCalls: false, proxyBytes: false, browserHours: false },
    updatedAt: null,
  };
}

// delta: { fetchCalls, fetchProxiedCalls, proxyBytesEst, proxyBytesMeasured, browserSessions, browserSeconds }
export function recordUsage(settings, delta) {
  const job = usageChain.then(() => {
    try {
      const month = monthStamp();
      const file = usageFile(settings, month);
      const u = { ...emptyUsage(month), ...readJson(file, {}) };
      u.alerts = { ...emptyUsage(month).alerts, ...(u.alerts || {}) };
      for (const [k, v] of Object.entries(delta)) {
        if (typeof v === "number" && Number.isFinite(v)) u[k] = Math.round(((u[k] || 0) + v) * 1000) / 1000;
      }
      u.updatedAt = isoLocal();
      const alerts = [];
      const proxyTotal = Math.max(u.proxyBytesEst, u.proxyBytesMeasured);
      if (!u.alerts.fetchCalls && u.fetchCalls > settings.alertFetchCalls) {
        u.alerts.fetchCalls = true;
        alerts.push(`fetchCalls passed ${settings.alertFetchCalls} (now ${u.fetchCalls}, of which proxied ${u.fetchProxiedCalls})`);
      }
      if (!u.alerts.proxyBytes && proxyTotal > settings.alertProxyBytes) {
        u.alerts.proxyBytes = true;
        alerts.push(`proxy traffic passed ${(settings.alertProxyBytes / 1073741824).toFixed(2)} GB (now ${(proxyTotal / 1073741824).toFixed(3)} GB)`);
      }
      if (!u.alerts.browserHours && u.browserSeconds / 3600 > settings.alertBrowserHours) {
        u.alerts.browserHours = true;
        alerts.push(`browser time passed ${settings.alertBrowserHours} h (now ${(u.browserSeconds / 3600).toFixed(2)} h over ${u.browserSessions} sessions)`);
      }
      writeJsonAtomic(file, u);
      for (const a of alerts) appendLine(path.join(settings.stateDir, "alerts.log"), `${isoLocal()} fetch-plus month=${month} ${a}. Nothing was refused; this is a budget heads-up only.`);
    } catch {
      // Usage accounting never breaks a fetch.
    }
  });
  usageChain = job;
  pending.add(job);
  job.finally(() => pending.delete(job));
  return job;
}

// Test seam: wait for queued usage writes and fire-and-forget session reads.
export async function flushPending() {
  while (pending.size) await Promise.allSettled([...pending]);
}

export function trackPending(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}

// ---- misc ------------------------------------------------------------------
export function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(Math.max(1, ms));
  return signal ? AbortSignal.any([signal, t]) : t;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const PRIVATE_HOST_RE = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.local$|\.internal$|\.lan$|\.home\.arpa$/i;

export function isPrivateHost(hostname) {
  const h = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return true;
  if (PRIVATE_HOST_RE.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h === "::";
  return false;
}
