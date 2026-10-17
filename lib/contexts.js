// Persistent Browserbase contexts, one per site group, so a login you do once
// inside that context keeps working for every later L3 read of the same site.
// Map: <stateDir>/contexts.json  { version, scopes: { <p_sha256(projectId)[0:12]|default>: { <group>: { id, createdAt, lastUsedAt, uses } } } }
// Browserbase advises one session per context at a time (contexts.md, "Avoid
// simultaneous logins"), and a few seconds of settle time after a persist:true
// session closes (contexts.md note). Both are enforced here in-process.
import { createHash } from "node:crypto";
import path from "node:path";
import { bbCreateContext } from "./browserbase.js";
import { readJson, sleep, writeJsonAtomic } from "./util.js";

// Hand-kept multi-label public suffixes; enough for the sites that matter.
const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.hk", "org.hk", "gov.hk", "edu.hk", "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.nz", "org.nz", "co.za", "com.br", "com.mx", "com.sg", "com.tw", "co.kr", "co.in",
  "gc.ca", "on.ca", "qc.ca", "bc.ca", "ab.ca",
  "github.io", "gitlab.io", "pages.dev", "vercel.app", "netlify.app", "herokuapp.com", "blogspot.com", "substack.com", "medium.com", "wordpress.com", "fly.dev",
]);

// Built-in groups: sites that share one login across hostnames.
const BUILTIN_GROUPS = {
  reddit: ["reddit.com", "redd.it", "redditmedia.com", "redditstatic.com"],
  "x-twitter": ["x.com", "twitter.com", "t.co"],
  "google-youtube": ["google.com", "youtube.com", "youtu.be", "google.ca"],
  linkedin: ["linkedin.com", "lnkd.in"],
};

export function registrableDomain(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h;
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  if (MULTI_SUFFIX.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function siteGroupFor(hostname, settings) {
  const h = String(hostname || "").toLowerCase();
  if (settings.contextStrategy === "none" || !h) return null;
  for (const [name, list] of Object.entries(settings.contextGroups || {})) {
    if (list.some((d) => matchesDomain(h, d))) return name;
  }
  if (settings.contextStrategy === "host") return h;
  for (const [name, list] of Object.entries(BUILTIN_GROUPS)) {
    if (list.some((d) => matchesDomain(h, d))) return name;
  }
  return registrableDomain(h);
}

const locks = new Map(); // contextId -> Promise that resolves when free

function contextsFile(settings) {
  return path.join(settings.stateDir, "contexts.json");
}

function loadMap(settings) {
  const m = readJson(contextsFile(settings), null);
  return m && typeof m === "object" && m.scopes && typeof m.scopes === "object" ? m : { version: 1, scopes: {} };
}

function saveEntry(settings, scope, group, entry) {
  const m = loadMap(settings);
  m.scopes[scope] ??= {};
  if (entry) m.scopes[scope][group] = entry;
  else delete m.scopes[scope][group];
  writeJsonAtomic(contextsFile(settings), m);
}

// Returns { id, group, persist, created, note } or null (strategy none / could not create).
export async function acquireContext({ hostname, settings, base, apiKey, projectId, signal, fetchImpl, forceNew = false }) {
  const group = siteGroupFor(hostname, settings);
  if (!group) return null;
  // The project ID is secret-capable, so only a hash prefix of it touches disk.
  const scope = projectId ? `p_${createHash("sha256").update(projectId).digest("hex").slice(0, 12)}` : "default";
  let entry = forceNew ? null : loadMap(settings).scopes?.[scope]?.[group] ?? null;
  let created = false;
  if (!entry?.id) {
    try {
      let ctx;
      try {
        ctx = await bbCreateContext({ base, apiKey, projectId, name: `fetch-plus:${group}`, signal, fetchImpl });
      } catch (err) {
        // Names are unique per project; if a stale one exists, create unnamed.
        if (err?.kind !== "context" && err?.kind !== "bad_request") throw err;
        ctx = await bbCreateContext({ base, apiKey, projectId, signal, fetchImpl });
      }
      entry = { id: ctx.id, createdAt: new Date().toISOString(), lastUsedAt: null, uses: 0 };
      saveEntry(settings, scope, group, entry);
      created = true;
    } catch (err) {
      return { id: null, group, persist: false, created: false, note: `context_create_failed:${err?.kind || "error"}` };
    }
  }
  // One session per context at a time: wait briefly, else run without it.
  const deadline = Date.now() + settings.contextWaitMs;
  while (locks.has(entry.id)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { id: null, group, persist: false, created, note: "context_busy" };
    await Promise.race([locks.get(entry.id), sleep(Math.min(remaining, 500), signal)]).catch(() => {});
  }
  let release;
  locks.set(entry.id, new Promise((r) => (release = r)));
  return {
    id: entry.id,
    group,
    persist: settings.contextPersist,
    created,
    note: created ? "context_created" : "context_reused",
    // Call when the session is closed. Holds the lock for the settle window.
    done: ({ used = true, invalid = false } = {}) => {
      try {
        if (invalid) saveEntry(settings, scope, group, null);
        else if (used) saveEntry(settings, scope, group, { ...entry, lastUsedAt: new Date().toISOString(), uses: (entry.uses || 0) + 1 });
      } catch {
        // State file trouble never breaks a fetch.
      }
      const settle = settings.contextPersist && used ? settings.contextSettleMs : 0;
      setTimeout(() => {
        locks.delete(entry.id);
        release();
      }, settle).unref?.();
    },
  };
}

export const _test = { BUILTIN_GROUPS, locks };
