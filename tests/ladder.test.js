// The ladder's decisions, end to end through runFetchPlus, with Browserbase faked
// (deps.fetchImpl) and the L3 browser session stubbed (deps.runSessionRung).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { BrowserbaseError } from "../lib/browserbase.js";
import { FetchPlusWallError, runFetchPlus } from "../lib/ladder.js";
import { browserPage, deps, fakeBrowserbase, fixture, page, stubSession, tempDir } from "./helpers.js";

const URL_ = "https://example.org/articles/sourdough";
const run = (d, args = {}) => runFetchPlus({ url: URL_, ...args }, { config: {} }, {}, d);

const ARTICLE = fixture("article.html");
const BLOCKED = fixture("blocked-403.html");
const HCAPTCHA = fixture("hcaptcha.html");

describe("success shapes", () => {
  test("L1 ok returns extractor fetch-plus:L1 and no warning", async () => {
    const bb = fakeBrowserbase(() => page(ARTICLE));
    const r = await run(deps({ fetchImpl: bb.fetchImpl }));
    assert.equal(r.extractor, "fetch-plus:L1");
    assert.equal(r.status, 200);
    assert.equal(r.url, URL_);
    assert.equal(r.contentType, "text/html");
    assert.match(r.title, /^Field notes on sourdough hydration/);
    assert.match(r.text, /Hydration is the weight of water/);
    assert.equal(r.warning, undefined);
    assert.equal(bb.fetchCalls().length, 1);
    assert.equal(bb.fetchCalls()[0].body.proxies, false);
    assert.equal(bb.fetchCalls()[0].apiKey, "bb_test_key");
  });

  test("L1 403 then L2 ok returns fetch-plus:L2 with the climb warning", async () => {
    const bb = fakeBrowserbase(({ proxies }) => (proxies ? page(ARTICLE) : page(BLOCKED, { status: 403 })));
    const r = await run(deps({ fetchImpl: bb.fetchImpl }));
    assert.equal(r.extractor, "fetch-plus:L2");
    assert.match(r.warning, /^fetch-plus read this at L2 after L1:blocked:/);
    assert.deepEqual(bb.fetchCalls().map((c) => c.body.proxies), [false, true]);
  });

  test("L1 and L2 blocked route to L3, which reads the page", async () => {
    const bb = fakeBrowserbase(() => page(BLOCKED, { status: 403 }));
    const l3 = stubSession(browserPage(ARTICLE, { title: "Field notes on sourdough hydration" }));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung }));
    assert.equal(r.extractor, "fetch-plus:L3");
    assert.match(r.warning, /^fetch-plus read this at L3 after L1:blocked:\S+,L2:blocked:\S+$/);
    assert.equal(l3.calls.length, 1);
    assert.equal(l3.calls[0].url, URL_);
    assert.equal(l3.calls[0].hostname, "example.org");
    assert.equal(l3.calls[0].apiKey, "bb_test_key");
  });

  test("text mode returns plain text", async () => {
    const bb = fakeBrowserbase(() => page(ARTICLE));
    const r = await run(deps({ fetchImpl: bb.fetchImpl }), { extractMode: "text" });
    assert.equal(r.extractMode, "text");
    assert.doesNotMatch(r.text, /\]\(|\*\*/);
  });

  test("a short but real L3 page is still an answer, flagged as partial", async () => {
    const bb = fakeBrowserbase(() => page(BLOCKED, { status: 403 }));
    const l3 = stubSession(browserPage("<html><head><title>Short note</title></head><body><p>Opening hours are nine to five on weekdays.</p></body></html>"));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung }));
    assert.equal(r.extractor, "fetch-plus:L3");
    assert.match(r.warning, /the rendered page is short; it may be partial/);
  });
});

describe("routing", () => {
  test("l3FirstHosts start at L3 and never call Fetch", async () => {
    const bb = fakeBrowserbase(() => page(ARTICLE));
    const l3 = stubSession(browserPage(ARTICLE));
    const r = await runFetchPlus({ url: "https://shop.example.net/p/1" }, { config: {} }, {}, deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung, settings: { l3FirstHosts: ["example.net"] } }));
    assert.equal(r.extractor, "fetch-plus:L3");
    assert.equal(r.warning, undefined);
    assert.equal(bb.fetchCalls().length, 0);
  });

  test("skipL2ForJsShell sends a JavaScript shell from L1 straight to L3", async () => {
    const bb = fakeBrowserbase(() => page(fixture("enable-javascript-shell.html")));
    const l3 = stubSession(browserPage(ARTICLE));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung, settings: { skipL2ForJsShell: true } }));
    assert.equal(r.extractor, "fetch-plus:L3");
    assert.deepEqual(bb.fetchCalls().map((c) => c.body.proxies), [false]);
    assert.match(r.warning, /after L1:thin:js_shell$/);
  });

  test("l2Proxies false skips L2", async () => {
    const bb = fakeBrowserbase(() => page(BLOCKED, { status: 403 }));
    const l3 = stubSession(browserPage(ARTICLE));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung, settings: { l2Proxies: false } }));
    assert.equal(r.extractor, "fetch-plus:L3");
    assert.equal(bb.fetchCalls().length, 1);
  });

  test("a site 404 stops the ladder at L1", async () => {
    const bb = fakeBrowserbase(() => page(fixture("not-found-404.html"), { status: 404 }));
    const r = await run(deps({ fetchImpl: bb.fetchImpl }));
    assert.equal(r.extractor, "fetch-plus:failed:http_404");
    assert.match(r.text, /HTTP 404: the page does not exist/);
    assert.equal(r.status, 404);
    assert.equal(bb.fetchCalls().length, 1);
  });

  test("a binary answer stops with binary_content", async () => {
    const bb = fakeBrowserbase(() => page("JVBERi0xLjQK", { contentType: "application/pdf", encoding: "base64" }));
    const r = await run(deps({ fetchImpl: bb.fetchImpl }));
    assert.equal(r.extractor, "fetch-plus:failed:binary_content");
    assert.match(r.text, /rungs=L1:binary:application\/pdf/);
  });
});

describe("failure shapes", () => {
  test("L3 failure names the wall and every rung tried", async () => {
    const bb = fakeBrowserbase(() => page(BLOCKED, { status: 403 }));
    const l3 = stubSession(browserPage(HCAPTCHA, { captcha: { started: true, finished: false } }));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung }));
    assert.equal(r.extractor, "fetch-plus:failed:captcha_unsolved");
    assert.equal(r.title, "fetch-plus: captcha_unsolved");
    assert.equal(r.contentType, "text/plain");
    const lines = r.text.split("\n");
    assert.match(lines[0], /^fetch-plus could not read this page\. wall=captcha_unsolved host=example\.org rungs=L1:blocked:\S+,L2:blocked:\S+,L3:challenge:hcaptcha retry=later$/);
    assert.match(r.text, /What stopped it: A captcha or bot challenge was still up/);
    assert.match(r.text, /Rungs tried: L1 Browserbase Fetch -> blocked:\S+ \(HTTP 403\), \d+ ms; L2 Browserbase Fetch \+ proxies -> blocked:\S+ \(HTTP 403\), \d+ ms; L3 browser session \+ proxies \+ captcha solver \(context_reused\) -> challenge:hcaptcha \(HTTP 200\), \d+ ms\./);
    assert.match(r.text, /Next move: Retry later, or open the page in a browser you are logged into\./);
    assert.equal(r.warning, `fetch-plus wall=captcha_unsolved rungs=${lines[0].match(/rungs=(\S+)/)[1]}`);
  });

  test("L3 disabled: two blocked Fetch rungs end on the HTTP status", async () => {
    const bb = fakeBrowserbase(() => page(BLOCKED, { status: 403 }));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, settings: { l3Enabled: false } }));
    assert.equal(r.extractor, "fetch-plus:failed:http_403");
    assert.match(r.text, /The site answered HTTP 403 on every rung\./);
  });

  test("a thin page's text rides along as partial text", async () => {
    const thin = "<html><head><title>Stub</title></head><body><p>Price list loading.</p><script></script><script></script><script></script></body></html>";
    const bb = fakeBrowserbase(() => page(thin));
    const l3 = stubSession({ page: null, driveError: "connect failed", ctxNote: "context_reused", proxies: true });
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung }));
    assert.equal(r.extractor, "fetch-plus:failed:nav_error");
    assert.match(r.text, /Partial text from the best rung/);
    assert.match(r.text, /Price list loading\./);
  });

  test("an L3 render with an 'undefined | Store' title is empty, not a read", async () => {
    const bb = fakeBrowserbase(() => page(BLOCKED, { status: 403 }));
    const boilerplate = `<html><head><title>undefined | Example Store</title></head><body><footer>${"<p>Terms of use and privacy policy for every customer of the store.</p>".repeat(20)}</footer></body></html>`;
    const l3 = stubSession(browserPage(boilerplate, { title: "undefined | Example Store" }));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung }));
    assert.equal(r.extractor, "fetch-plus:failed:empty");
  });

  test("a Browserbase quota error at L3 is named instead of the site's wall", async () => {
    const bb = fakeBrowserbase(() => page(BLOCKED, { status: 403 }));
    const l3 = stubSession({ page: null, error: new BrowserbaseError("quota", 402, "plan quota exceeded"), ctxNote: undefined, proxies: true });
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung }));
    assert.equal(r.extractor, "fetch-plus:failed:bb_quota");
    assert.match(r.text, /plan quota is used up/);
  });

  test("a rejected API key stops at L1 with bb_auth", async () => {
    const bb = fakeBrowserbase(() => ({ bbStatus: 401, body: { message: "Unauthorized" } }));
    const r = await run(deps({ fetchImpl: bb.fetchImpl }));
    assert.equal(r.extractor, "fetch-plus:failed:bb_auth");
    assert.equal(bb.fetchCalls().length, 1);
  });

  test("Browserbase unreachable is transient: auto mode throws so the core can retry", async () => {
    const d = deps({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(run(d), (err) => err instanceof FetchPlusWallError && err.wall === "bb_unreachable" && err.payload.extractor === "fetch-plus:failed:bb_unreachable");
  });

  test("failureMode throw turns any wall into a FetchPlusWallError", async () => {
    const d = deps({ apiKey: undefined, settings: { failureMode: "throw" } });
    await assert.rejects(run(d), (err) => err instanceof FetchPlusWallError && err.wall === "no_key");
  });
});

describe("guards before any rung", () => {
  test("no_key short-circuits with the no_key text and no calls", async () => {
    const bb = fakeBrowserbase(() => page(ARTICLE));
    const l3 = stubSession(browserPage(ARTICLE));
    const r = await run(deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung, apiKey: undefined }));
    assert.equal(r.extractor, "fetch-plus:failed:no_key");
    assert.match(r.text, /No Browserbase API key is configured, so no rung could run\./);
    assert.match(r.text, /rungs=none/);
    assert.equal(bb.calls.length, 0);
    assert.equal(l3.calls.length, 0);
  });

  test("private hostnames are refused before any rung", async () => {
    for (const url of ["http://192.168.1.10/admin", "http://localhost:8080/", "http://[::1]/", "http://printer.local/status", "http://169.254.169.254/latest/meta-data/"]) {
      const bb = fakeBrowserbase(() => page(ARTICLE));
      const l3 = stubSession(browserPage(ARTICLE));
      const r = await runFetchPlus({ url }, { config: {} }, {}, deps({ fetchImpl: bb.fetchImpl, runSessionRung: l3.runSessionRung }));
      assert.equal(r.extractor, "fetch-plus:failed:invalid_url", url);
      assert.equal(bb.calls.length + l3.calls.length, 0, url);
    }
  });

  test("blockPrivateHosts false lets a private host through to L1", async () => {
    const bb = fakeBrowserbase(() => page(ARTICLE));
    const r = await runFetchPlus({ url: "http://192.168.1.10/notes" }, { config: {} }, {}, deps({ fetchImpl: bb.fetchImpl, settings: { blockPrivateHosts: false } }));
    assert.equal(r.extractor, "fetch-plus:L1");
  });

  test("non-http(s) and malformed URLs are invalid_url", async () => {
    for (const url of ["ftp://example.org/file", "not a url", ""]) {
      const r = await runFetchPlus({ url }, { config: {} }, {}, deps({}));
      assert.equal(r.extractor, "fetch-plus:failed:invalid_url", url);
    }
  });
});

describe("call log privacy", () => {
  test("calls.jsonl records the hostname only, never the URL or page text", async () => {
    const stateDir = tempDir();
    const bb = fakeBrowserbase(() => page(ARTICLE));
    const d = deps({ fetchImpl: bb.fetchImpl, settings: { stateDir, noLog: false } });
    await runFetchPlus({ url: "https://example.org/private/path?token=abc123" }, { config: {} }, {}, d);
    const log = fs.readFileSync(path.join(stateDir, "calls.jsonl"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    const entry = JSON.parse(log[0]);
    assert.equal(entry.host, "example.org");
    assert.equal(entry.rung, "L1");
    assert.equal(entry.outcome, "ok");
    assert.doesNotMatch(log[0], /private\/path|token|abc123|Hydration|bb_test_key/);
  });
});
