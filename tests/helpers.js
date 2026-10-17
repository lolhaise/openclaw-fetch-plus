// Shared test helpers: fixtures, a temp state dir, a fake Browserbase API and a
// stubbed L3 session rung. Nothing here touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name) {
  return fs.readFileSync(path.join(here, "fixtures", name), "utf8");
}

export function tempDir(prefix = "fetch-plus-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// One page as Browserbase Fetch reports it.
export function page(html, { status = 200, contentType = "text/html; charset=utf-8", encoding = "utf-8" } = {}) {
  return { statusCode: status, headers: { "content-type": contentType }, content: html, contentType, encoding };
}

// A fetch replacement for the Browserbase REST API. `onFetch({ url, proxies, body })`
// returns a page() for POST /v1/fetch, or { bbStatus, body } to make Browserbase itself
// answer with an error. Every call is recorded in `calls`.
export function fakeBrowserbase(onFetch) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method, body, apiKey: init.headers?.["X-BB-API-Key"] });
    if (!String(url).endsWith("/v1/fetch")) {
      return new Response(JSON.stringify({ message: "unexpected call in test" }), { status: 400 });
    }
    const out = await onFetch({ url: body.url, proxies: body.proxies, body });
    if (out && out.bbStatus) return new Response(JSON.stringify(out.body ?? {}), { status: out.bbStatus });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls, fetchCalls: () => calls.filter((c) => c.url.endsWith("/v1/fetch")) };
}

// A stand-in for lib/l3.js runSessionRung. `result` is what the browser saw.
export function stubSession(result) {
  const calls = [];
  const runSessionRung = async (args) => {
    calls.push(args);
    return typeof result === "function" ? result(args) : result;
  };
  return { runSessionRung, calls };
}

export function browserPage(html, { status = 200, title, innerText = "", captcha = { started: false, finished: false }, finalUrl } = {}) {
  return { page: { driver: "stub", status, finalUrl, title, html, innerText, captcha, challengeWait: {} }, ctxNote: "context_reused", proxies: true };
}

// deps for runFetchPlus with a private state dir and no call log. Without a stub
// the L3 rung throws, so a test can never open a real browser session by accident.
// Pass apiKey: undefined to run with no key at all.
export function deps(opts = {}) {
  const { fetchImpl, runSessionRung, settings = {} } = opts;
  const apiKey = "apiKey" in opts ? opts.apiKey : "bb_test_key";
  return {
    fetchImpl: fetchImpl ?? (async () => {
      throw new Error("network call in a test that did not fake Browserbase");
    }),
    runSessionRung: runSessionRung ?? (async () => {
      throw new Error("L3 was reached in a test that did not stub it");
    }),
    credentials: { apiKey, projectId: undefined },
    settingsOverrides: { stateDir: tempDir(), noLog: true, ...settings },
  };
}
