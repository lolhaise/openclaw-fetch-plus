// fetch-plus: a web_fetch provider for OpenClaw that climbs a Browserbase ladder when a page is walled.
//
// A web_fetch PROVIDER. The core's own web_fetch still does the direct fetch and
// Readability first; it hands a URL to fetch-plus when that direct path hits a
// network error, a non-2xx status, or an empty Readability result (and on every
// HTML page when tools.web.fetch.readability is false). fetch-plus then climbs:
//   L1 Browserbase Fetch -> L2 Browserbase Fetch with proxies -> L3 a Browserbase
//   browser session (proxies, captcha solving, persistent per-site context).
// If every rung fails it returns text naming the wall and the rungs tried.
//
import { createRequire } from "node:module";
import path from "node:path";
import { runFetchPlus } from "./lib/ladder.js";
import { OPENCLAW_ROOT, PROVIDER_ID } from "./lib/util.js";

// The plugin SDK under the same specifier the bundled plugins use. The gateway
// loads plugin entries with a synchronous require, so this stays synchronous too
// (a top-level await would push the load onto the slower transform path). A
// plugin installed from a local folder has no node_modules/openclaw link, so the
// resolved install root is the fallback.
function loadPluginEntrySdk() {
  const require = createRequire(import.meta.url);
  try {
    return require("openclaw/plugin-sdk/plugin-entry");
  } catch (err) {
    try {
      return require(path.join(OPENCLAW_ROOT, "dist", "plugin-sdk", "plugin-entry.js"));
    } catch {
      throw err;
    }
  }
}

const { definePluginEntry } = loadPluginEntrySdk();

const KEY_PATH = `plugins.entries.${PROVIDER_ID}.config.browserbaseApiKey`;

function ensureRecord(target, key) {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) return current;
  const next = {};
  target[key] = next;
  return next;
}

export function createFetchPlusProvider() {
  return {
    id: PROVIDER_ID,
    label: "fetch-plus (Browserbase ladder)",
    hint: "Browserbase Fetch, then Fetch with proxies, then a real browser with captcha solving and saved logins.",
    requiresCredential: true,
    credentialLabel: "Browserbase API key",
    envVars: ["BROWSERBASE_API_KEY"],
    placeholder: "bb_live_...",
    signupUrl: "https://www.browserbase.com/",
    docsUrl: "https://docs.browserbase.com/platform/fetch/overview",
    autoDetectOrder: 40,
    // Same wiring as the bundled Firecrawl plugin's webFetch.apiKey:
    // the core resolves the SecretRef (or BROWSERBASE_API_KEY) at activation and
    // writes the plain value into the runtime config through setConfiguredCredentialValue.
    credentialPath: KEY_PATH,
    inactiveSecretPaths: [KEY_PATH],
    getCredentialValue: () => undefined,
    setCredentialValue: (fetchConfigTarget, value) => {
      ensureRecord(fetchConfigTarget, PROVIDER_ID).apiKey = value;
    },
    getConfiguredCredentialValue: (config) => config?.plugins?.entries?.[PROVIDER_ID]?.config?.browserbaseApiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = (configTarget.plugins ??= {});
      const entries = (plugins.entries ??= {});
      const entry = (entries[PROVIDER_ID] ??= {});
      ensureRecord(entry, "config").browserbaseApiKey = value;
    },
    createTool: (ctx) => ({
      description: "Fetch a page through the fetch-plus Browserbase ladder (Fetch, Fetch with proxies, browser session).",
      parameters: {},
      execute: async (args, executionContext) => runFetchPlus(args, ctx, executionContext),
    }),
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "fetch-plus",
  description: "web_fetch provider: a Browserbase ladder that climbs past blocks and names the wall when it cannot",
  register(api) {
    api.registerWebFetchProvider(createFetchPlusProvider());
  },
});
