import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { DEFAULTS, OPENCLAW_ROOT } from "../lib/util.js";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

describe("manifest and package", () => {
  test("manifest declares the fetch-plus web fetch provider", () => {
    assert.equal(manifest.id, "fetch-plus");
    assert.deepEqual(manifest.contracts.webFetchProviders, ["fetch-plus"]);
    assert.equal(manifest.configSchema.additionalProperties, false);
  });

  test("every setting in the code is in the schema, with the same default", () => {
    const props = manifest.configSchema.properties;
    for (const [key, value] of Object.entries(DEFAULTS)) {
      assert.ok(props[key], `schema is missing ${key}`);
      if ("default" in props[key]) assert.deepEqual(props[key].default, value, key);
    }
  });

  test("package.json carries the fields OpenClaw and ClawHub read", () => {
    assert.equal(pkg.name, "openclaw-fetch-plus");
    assert.equal(pkg.type, "module");
    assert.deepEqual(pkg.openclaw.extensions, ["./index.js"]);
    assert.match(pkg.openclaw.compat.pluginApi, /^>=\d{4}\.\d+\.\d+/);
    assert.match(pkg.openclaw.build.openclawVersion, /^\d{4}\.\d+\.\d+/);
    assert.equal(pkg.dependencies, undefined, "the plugin borrows its libraries from the OpenClaw install");
  });
});

// Loading index.js needs the plugin SDK from an OpenClaw install (Node 22+ for a
// synchronous require of it). Skipped where there is none, such as CI.
const sdkPath = path.join(OPENCLAW_ROOT, "dist", "plugin-sdk", "plugin-entry.js");
const nodeMajor = Number(process.versions.node.split(".")[0]);
const noSdk = !fs.existsSync(sdkPath) ? "no OpenClaw install reachable" : nodeMajor < 22 ? "needs Node 22+ to load the SDK" : false;

describe("plugin entry", () => {
  test("registers one web fetch provider wired to the Browserbase key", { skip: noSdk }, async () => {
    const entry = (await import("../index.js")).default;
    assert.equal(entry.id, "fetch-plus");
    const providers = [];
    entry.register({ registerWebFetchProvider: (p) => providers.push(p) });
    assert.equal(providers.length, 1);
    const p = providers[0];
    assert.equal(p.id, "fetch-plus");
    assert.deepEqual(p.envVars, ["BROWSERBASE_API_KEY"]);
    assert.equal(p.credentialPath, "plugins.entries.fetch-plus.config.browserbaseApiKey");
    const config = {};
    p.setConfiguredCredentialValue(config, "bb_test_key");
    assert.equal(p.getConfiguredCredentialValue(config), "bb_test_key");
    const fetchConfig = {};
    p.setCredentialValue(fetchConfig, "bb_test_key");
    assert.deepEqual(fetchConfig, { "fetch-plus": { apiKey: "bb_test_key" } });
    assert.equal(typeof p.createTool({ config: {} }).execute, "function");
  });
});
