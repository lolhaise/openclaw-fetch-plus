import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import {
  DEFAULTS,
  expandHome,
  flushPending,
  hostOf,
  importSpecifier,
  isPrivateHost,
  pluginConfigOf,
  recordUsage,
  resolveCredentials,
  resolveOpenclawRoot,
  resolveSettings,
  usageFile,
} from "../lib/util.js";
import { tempDir } from "./helpers.js";

const cfg = (config) => ({ plugins: { entries: { "fetch-plus": { config } } } });

describe("resolveSettings", () => {
  test("defaults match DEFAULTS, with the state dir expanded", () => {
    const s = resolveSettings({});
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (k === "stateDir") continue;
      assert.deepEqual(s[k], v, k);
    }
    assert.equal(DEFAULTS.stateDir, "~/.cache/openclaw-fetch-plus");
    assert.equal(s.stateDir, path.join(os.homedir(), ".cache", "openclaw-fetch-plus"));
  });

  test("integers are floored and clamped, junk falls back", () => {
    const s = resolveSettings(cfg({ l1TimeoutMs: 1, l2TimeoutMs: 999999, l3MaxSeconds: 42.9, totalMaxSeconds: "200" }));
    assert.equal(s.l1TimeoutMs, 2000);
    assert.equal(s.l2TimeoutMs, 60000);
    assert.equal(s.l3MaxSeconds, 42);
    assert.equal(s.totalMaxSeconds, DEFAULTS.totalMaxSeconds);
  });

  test("oneOf guards reject unknown values", () => {
    const s = resolveSettings(cfg({ fetchFormat: "pdf", l3Driver: "selenium", contextStrategy: "global", failureMode: "explode", l3Region: "mars-1" }));
    assert.equal(s.fetchFormat, "raw");
    assert.equal(s.l3Driver, "auto");
    assert.equal(s.contextStrategy, "site");
    assert.equal(s.failureMode, "auto");
    assert.equal(s.l3Region, "");
  });

  test("oneOf guards accept every documented value", () => {
    const s = resolveSettings(cfg({ fetchFormat: "markdown", l3Driver: "cdp", contextStrategy: "none", failureMode: "throw", l3Region: "eu-central-1" }));
    assert.deepEqual([s.fetchFormat, s.l3Driver, s.contextStrategy, s.failureMode, s.l3Region], ["markdown", "cdp", "none", "throw", "eu-central-1"]);
  });

  test("booleans must be real booleans", () => {
    const s = resolveSettings(cfg({ l3Enabled: "false", l2Proxies: 0, allowInsecureSsl: true }));
    assert.equal(s.l3Enabled, true);
    assert.equal(s.l2Proxies, true);
    assert.equal(s.allowInsecureSsl, true);
  });

  test("apiBaseUrl must be http(s) and loses trailing slashes", () => {
    assert.equal(resolveSettings(cfg({ apiBaseUrl: "ftp://x" })).apiBaseUrl, DEFAULTS.apiBaseUrl);
    assert.equal(resolveSettings(cfg({ apiBaseUrl: " http://127.0.0.1:9999/// " })).apiBaseUrl, "http://127.0.0.1:9999");
  });

  test("host lists and context groups are normalized", () => {
    const s = resolveSettings(cfg({ l3FirstHosts: ["*.Shop.Example.COM ", "", 7, ".example.net"], contextGroups: { work: [" Example.ORG", 3, ""], bad: "nope" } }));
    assert.deepEqual(s.l3FirstHosts, ["shop.example.com", "example.net"]);
    assert.deepEqual(s.contextGroups, { work: ["example.org"] });
  });

  test("overrides win over plugin config; stateDir expands ~", () => {
    const s = resolveSettings(cfg({ minVisibleChars: 900, stateDir: "~/elsewhere" }), { minVisibleChars: 100 });
    assert.equal(s.minVisibleChars, 100);
    assert.equal(s.stateDir, path.join(os.homedir(), "elsewhere"));
  });

  test("pluginConfigOf ignores arrays and missing entries", () => {
    assert.deepEqual(pluginConfigOf(undefined), {});
    assert.deepEqual(pluginConfigOf({ plugins: { entries: { "fetch-plus": { config: [1, 2] } } } }), {});
  });
});

describe("small helpers", () => {
  test("expandHome", () => {
    assert.equal(expandHome("~"), os.homedir());
    assert.equal(expandHome("~/a/b"), path.join(os.homedir(), "a", "b"));
    assert.equal(expandHome("/abs/path"), "/abs/path");
    assert.equal(expandHome(""), "");
    assert.equal(expandHome(undefined), undefined);
  });

  test("isPrivateHost refuses loopback, private ranges and local names", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "fd00::1", "fe80::1", "printer.local", "db.internal", "nas.lan", "box.home.arpa", ""]) {
      assert.equal(isPrivateHost(h), true, h);
    }
  });

  test("isPrivateHost lets public hosts through", () => {
    for (const h of ["example.org", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "crates.io"]) {
      assert.equal(isPrivateHost(h), false, h);
    }
  });

  test("hostOf returns a lowercase hostname or empty", () => {
    assert.equal(hostOf("https://WWW.Example.ORG:8443/a?b=c"), "www.example.org");
    assert.equal(hostOf("not a url"), "");
  });

  test("importSpecifier turns absolute paths into file URLs and leaves bare names alone", () => {
    const abs = path.resolve("/opt/openclaw/node_modules/linkedom/esm/index.js");
    assert.equal(importSpecifier(abs), pathToFileURL(abs).href);
    assert.equal(importSpecifier("playwright-core"), "playwright-core");
  });
});

describe("resolveOpenclawRoot", () => {
  // A fake install: <tmp>/prefix/lib/node_modules/openclaw with dist/index.js and bin/node.
  const tmp = tempDir("fetch-plus-root-");
  const fakeRoot = path.join(tmp, "prefix", "lib", "node_modules", "openclaw");
  fs.mkdirSync(path.join(fakeRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "package.json"), JSON.stringify({ name: "openclaw", version: "0.0.0-test" }));
  fs.writeFileSync(path.join(fakeRoot, "dist", "index.js"), "");
  fs.mkdirSync(path.join(tmp, "prefix", "bin"), { recursive: true });
  const fakeNode = path.join(tmp, "prefix", "bin", "node");
  fs.writeFileSync(fakeNode, "");
  // A plugin folder with a node_modules/openclaw link target, for the require step.
  const plugin = path.join(tmp, "plugin");
  fs.mkdirSync(path.join(plugin, "node_modules", "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "node_modules", "openclaw", "package.json"), JSON.stringify({ name: "openclaw" }));
  fs.writeFileSync(path.join(plugin, "index.js"), "");
  const nowhere = path.join(tmp, "nowhere", "index.js");
  const noNode = path.join(tmp, "nowhere", "bin", "node");
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("1. OPENCLAW_ROOT wins and expands ~", () => {
    assert.deepEqual(resolveOpenclawRoot({ env: { OPENCLAW_ROOT: "~/oc" }, argv1: path.join(fakeRoot, "dist", "index.js") }), { root: path.join(os.homedir(), "oc"), source: "env" });
  });

  test("2. Node resolution from the plugin folder", () => {
    const r = resolveOpenclawRoot({ env: {}, from: pathToFileURL(path.join(plugin, "index.js")).href, argv1: nowhere, execPath: noNode });
    assert.deepEqual(r, { root: path.join(plugin, "node_modules", "openclaw"), source: "require" });
  });

  test("3. walking up from the gateway's argv[1]", () => {
    const r = resolveOpenclawRoot({ env: {}, from: pathToFileURL(nowhere).href, argv1: path.join(fakeRoot, "dist", "index.js"), execPath: noNode });
    // argv[1] is followed through symlinks, so compare with the real path (macOS /tmp).
    assert.deepEqual(r, { root: fs.realpathSync(fakeRoot), source: "argv" });
  });

  test("4. the global prefix next to the node binary", () => {
    const r = resolveOpenclawRoot({ env: {}, from: pathToFileURL(nowhere).href, argv1: nowhere, execPath: fakeNode });
    assert.deepEqual(r, { root: fakeRoot, source: "execPath" });
  });

  test("5. the Linux default when nothing else answers", () => {
    const r = resolveOpenclawRoot({ env: {}, from: pathToFileURL(nowhere).href, argv1: nowhere, execPath: noNode });
    assert.deepEqual(r, { root: "/usr/lib/node_modules/openclaw", source: "fallback" });
  });
});

describe("credentials and usage", () => {
  const saved = { key: process.env.BROWSERBASE_API_KEY, project: process.env.BROWSERBASE_PROJECT_ID };
  after(() => {
    for (const [name, value] of [["BROWSERBASE_API_KEY", saved.key], ["BROWSERBASE_PROJECT_ID", saved.project]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("a plain config string beats the environment", async () => {
    process.env.BROWSERBASE_API_KEY = "bb_from_env";
    const c = await resolveCredentials(cfg({ browserbaseApiKey: "  bb_from_config  " }));
    assert.equal(c.apiKey, "bb_from_config");
    assert.equal(c.apiKeySource, "config");
  });

  test("the environment is the fallback, and nothing is 'missing'", async () => {
    process.env.BROWSERBASE_API_KEY = "bb_from_env";
    delete process.env.BROWSERBASE_PROJECT_ID;
    const c = await resolveCredentials({});
    assert.deepEqual([c.apiKey, c.apiKeySource, c.projectId, c.projectIdSource], ["bb_from_env", "env", undefined, "missing"]);
  });

  test("usage counters add up and a budget alert fires once", async () => {
    const stateDir = tempDir();
    const settings = resolveSettings({}, { stateDir, alertFetchCalls: 1 });
    recordUsage(settings, { fetchCalls: 1 });
    recordUsage(settings, { fetchCalls: 1, fetchProxiedCalls: 1 });
    recordUsage(settings, { fetchCalls: 1 });
    await flushPending();
    const u = JSON.parse(fs.readFileSync(usageFile(settings), "utf8"));
    assert.equal(u.fetchCalls, 3);
    assert.equal(u.fetchProxiedCalls, 1);
    assert.equal(u.alerts.fetchCalls, true);
    const alerts = fs.readFileSync(path.join(stateDir, "alerts.log"), "utf8").trim().split("\n");
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /fetchCalls passed 1/);
  });
});
