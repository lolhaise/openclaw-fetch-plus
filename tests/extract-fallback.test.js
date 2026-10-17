// The same pipeline with no OpenClaw install reachable: OPENCLAW_ROOT points at an
// empty folder before the modules load, so linkedom and Readability are missing and
// extraction falls back to the regex path. This is what CI runs everywhere; here it
// pins the fallback even on a machine that has OpenClaw installed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, tempDir } from "./helpers.js";

process.env.OPENCLAW_ROOT = tempDir("fetch-plus-no-openclaw-");
const util = await import("../lib/util.js");
const { extractHtml } = await import("../lib/extract.js");
const { judgePage } = await import("../lib/detect.js");

let bareLinkedom = false;
try {
  await import("linkedom");
  bareLinkedom = true;
} catch {
  // Expected: the repo ships no dependencies.
}

test("OPENCLAW_ROOT from the environment wins", () => {
  assert.equal(util.OPENCLAW_ROOT_SOURCE, "env");
  assert.equal(util.OPENCLAW_ROOT, process.env.OPENCLAW_ROOT);
});

test("without linkedom the regex extractor still reads a full page", { skip: bareLinkedom && "linkedom is resolvable from this checkout" }, async () => {
  const ex = await extractHtml(fixture("article.html"), { url: "https://example.org/a" });
  assert.equal(ex.extractor, "regex");
  assert.match(ex.content, /Hydration is the weight of water/);
  assert.doesNotMatch(ex.content, /tracking-code-should-not-appear/);
});

test("without linkedom the verdicts are unchanged", async () => {
  const cases = [
    ["cloudflare-just-a-moment.html", 403, "challenge"],
    ["akamai-short-block.html", 200, "blocked"],
    ["enable-javascript-shell.html", 200, "thin"],
    ["article-about-captchas.html", 200, "ok"],
  ];
  for (const [name, status, verdict] of cases) {
    const html = fixture(name);
    const ex = await extractHtml(html, { url: "https://example.org/a" });
    assert.equal(judgePage({ status, html, finalUrl: "https://example.org/a", ex, minVisibleChars: 500, hardFloor: 200 }).verdict, verdict, name);
  }
});
