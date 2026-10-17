import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { acquireContext, registrableDomain, siteGroupFor } from "../lib/contexts.js";
import { resolveSettings } from "../lib/util.js";
import { tempDir } from "./helpers.js";

describe("site groups", () => {
  test("registrableDomain handles multi-label suffixes and IPs", () => {
    assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
    assert.equal(registrableDomain("www.example.org"), "example.org");
    assert.equal(registrableDomain("user.github.io"), "user.github.io");
    assert.equal(registrableDomain("203.0.113.7"), "203.0.113.7");
  });

  test("built-in groups share one context across a site's hostnames", () => {
    const s = resolveSettings({});
    assert.equal(siteGroupFor("old.reddit.com", s), "reddit");
    assert.equal(siteGroupFor("redd.it", s), "reddit");
    assert.equal(siteGroupFor("x.com", s), "x-twitter");
    assert.equal(siteGroupFor("docs.example.org", s), "example.org");
  });

  test("custom groups win, 'host' keys by hostname, 'none' turns contexts off", () => {
    assert.equal(siteGroupFor("wiki.example.net", resolveSettings({}, { contextGroups: { work: ["example.net", "example.com"] } })), "work");
    assert.equal(siteGroupFor("docs.example.org", resolveSettings({}, { contextStrategy: "host" })), "docs.example.org");
    assert.equal(siteGroupFor("docs.example.org", resolveSettings({}, { contextStrategy: "none" })), null);
  });
});

describe("acquireContext", () => {
  test("creates one context per group, reuses it, and keeps only a hash of the project id on disk", async () => {
    const stateDir = tempDir();
    const settings = resolveSettings({}, { stateDir, contextSettleMs: 0 });
    const posts = [];
    const fetchImpl = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "ctx_test_1" }), { status: 201 });
    };
    const common = { hostname: "www.example.org", settings, base: "https://bb.test", apiKey: "bb_test_key", projectId: "proj-secret-123", fetchImpl };
    const first = await acquireContext(common);
    assert.deepEqual([first.id, first.group, first.created, first.note], ["ctx_test_1", "example.org", true, "context_created"]);
    first.done({ used: true });
    await new Promise((r) => setTimeout(r, 5));
    const second = await acquireContext(common);
    assert.deepEqual([second.id, second.created, second.note], ["ctx_test_1", false, "context_reused"]);
    second.done({ used: true });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://bb.test/v1/contexts");
    assert.equal(posts[0].body.name, "fetch-plus:example.org");
    const onDisk = fs.readFileSync(path.join(stateDir, "contexts.json"), "utf8");
    assert.doesNotMatch(onDisk, /proj-secret-123/);
    assert.match(onDisk, /"p_[0-9a-f]{12}"/);
  });
});
