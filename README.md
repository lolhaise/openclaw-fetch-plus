# openclaw-fetch-plus

[![tests](https://github.com/lolhaise/openclaw-fetch-plus/actions/workflows/tests.yml/badge.svg)](https://github.com/lolhaise/openclaw-fetch-plus/actions/workflows/tests.yml)

A `web_fetch` provider for OpenClaw that reads the pages its built-in fetch cannot, through Browserbase, and names the wall when it cannot read them either.

## What it changes

OpenClaw's `web_fetch` does a direct fetch and runs Readability on the page. When that direct read fails (a network error, a non-2xx status, or no readable text), it hands the URL to the configured fetch provider.

Without a fetch provider, a page that answers HTTP 403 ends the call with an error, and a challenge page served with HTTP 200 comes back as its few visible words.

With fetch-plus, the same call climbs a ladder and returns the page text. The result says which rung read it (`extractor: "fetch-plus:L2"`) and, when it had to climb, adds a warning line such as `fetch-plus read this at L2 after L1:blocked:http_403`. When every rung fails, the result is a short report that names the wall, every rung tried and the next move.

## The ladder

- **L1**: Browserbase Fetch, no proxies, 20 s.
- **L2**: the same Fetch through residential proxies, 25 s.
- **L3**: a real Browserbase browser session with proxies, captcha solving and one persistent context per site group, 60 s cap.

Each rung runs only when the one before it hit a block signature. A site 404, a binary file or a rejected Browserbase key stops the ladder early.

## Numbers

From the plugin's own call log on one OpenClaw gateway, from 2026-09-27 22:37 to 2026-10-17 14:01. A fallback call is a page the gateway's own fetch could not read; pages the plain fetch reads never reach the plugin.

```
fallback calls                2,241   across 723 distinct hosts
read                          1,919   (86%)
  L1 Fetch                    1,243   median 1.0 s, p90 2.0 s
  L2 Fetch + proxies            108   median 2.9 s, p90 5.3 s
  L3 browser session            568   median 22.0 s, p90 44.2 s
named wall on every rung        322   (14%)
```

Browserbase meter, October 1 to 17: 2,640 Fetch calls (713 through proxies), 683 browser sessions, 4.3 browser hours.

## One real example

The first page it read on a live gateway, on 2026-09-27 at 22:37:

```
web_fetch https://crates.io/crates/serde
extractor: fetch-plus:L3
took:      11.7 s
```

## Install

```sh
openclaw plugins install git:github.com/lolhaise/openclaw-fetch-plus
openclaw secrets store set BROWSERBASE_API_KEY
```

Store the key before anything references it: a key reference that does not resolve breaks every `web_fetch` (see Limits). Then add the reference and select the provider:

```json5
{
  plugins: {
    entries: {
      "fetch-plus": {
        enabled: true,
        config: {
          browserbaseApiKey: { source: "store", provider: "default", id: "BROWSERBASE_API_KEY" },
        },
      },
    },
  },
  tools: {
    web: {
      fetch: { provider: "fetch-plus" },
    },
  },
}
```

Without a key in config, the plugin reads `BROWSERBASE_API_KEY` from the gateway's environment. `browserbaseProjectId` is optional and works the same way, with `BROWSERBASE_PROJECT_ID` as its fallback.

It has no dependencies of its own. It borrows linkedom, @mozilla/readability and playwright-core from the OpenClaw install, and degrades without them: a regex extractor instead of Readability, and a built-in CDP client instead of Playwright for the browser rung. The install folder is found from `OPENCLAW_ROOT`, then Node resolution, then the running gateway, then the global prefix next to the node binary, then `/usr/lib/node_modules/openclaw`.

Check it: `npm test` runs 90 offline cases with no network and no key. Without an OpenClaw install on the machine, the one case that loads the real plugin SDK is skipped.

## How it decides

A rung climbs when the page it got matches a block signature:

- **Status**: HTTP 401, 403, 407, 429 and 503, plus Cloudflare's 520 to 526 and 530.
- **Challenge pages**: script and element markers for Cloudflare, Turnstile, reCAPTCHA, hCaptcha, PerimeterX, DataDome, Arkose, AWS WAF and Reddit's JavaScript proof of work, on pages under 4,000 characters of text; challenge titles such as "Just a moment..."; challenge and block wording on pages under 3,000 characters, so an article about captchas is not mistaken for one.
- **Geo pages**: HTTP 451, or "not available in your country" wording on a short page.
- **Login walls**: login URLs, "sign in to continue" wording or a password form on a page with little article text.
- **Thin or JavaScript-only bodies**: under `minVisibleChars` of readable text on a page that should have more, under `minVisibleCharsHard` on any HTML page, or an empty app shell.

A read returns the normal `web_fetch` result with `extractor` set to `fetch-plus:L1`, `fetch-plus:L2` or `fetch-plus:L3`, plus a `warning` line when it climbed. The last rung also accepts a short but real page, and says so in the warning.

When every rung fails, `extractor` is `fetch-plus:failed:<wall>` and the text reads:

```
fetch-plus could not read this page. wall=captcha_unsolved host=example.org rungs=L1:blocked:http_403,L2:blocked:http_403,L3:challenge:hcaptcha retry=later

What stopped it: A captcha or bot challenge was still up after the browser and captcha solver ran.
Rungs tried: L1 Browserbase Fetch -> blocked:http_403 (HTTP 403), <ms> ms; L2 Browserbase Fetch + proxies -> blocked:http_403 (HTTP 403), <ms> ms; L3 browser session + proxies + captcha solver (context_reused) -> challenge:hcaptcha (HTTP 200), <ms> ms.
Next move: Retry later, or open the page in a browser you are logged into.
```

The walls a site can put up are `login_required`, `captcha_unsolved`, `geo_blocked`, `proxy_restricted`, `dns_error`, `too_large` and `empty`, plus `http_<status>` when a status code is all there is. Problems on the Browserbase side are named as such (`bb_auth`, `bb_quota`, `bb_unavailable` and others) so a billing or key problem is never reported as the site's fault. With `failureMode: "auto"`, a transient wall (a timeout, Browserbase busy or unreachable) is thrown instead of returned when no rung saw a 2xx page, so the core does not cache it.

Every call appends one line to `calls.jsonl` in `stateDir` (unless `noLog` is set): hostname, rung, outcome, wall, status, time and the rung trail. Never the URL, the page text or the key.

## Limits

- It needs a Browserbase account. The Developer plan is US$20 a month and includes 1,000 Fetch calls and 100 browser hours.
- OpenClaw's sandboxed `web_fetch` excludes third-party fetch providers, so fetch-plus runs for non-sandboxed fetches only (`docs/tools/web-fetch.md` in the OpenClaw install).
- PDFs and other binaries are not extracted; they end in `binary_content`.
- Hard bot walls such as PerimeterX can still end in `captcha_unsolved` on the Developer plan.
- A key reference that fails to resolve breaks every `web_fetch`, so select the provider only after the key resolves.
- Rollback is one line: `openclaw config set tools.web.fetch.provider firecrawl`.

## Configuration

All settings live under `plugins.entries.fetch-plus.config` and are read on every call, so edits apply without a restart.

| Setting | Default | What it does |
| --- | --- | --- |
| `browserbaseApiKey` | none | Browserbase API key: a SecretRef object or a string. Resolved by the core through the provider credentialPath; env BROWSERBASE_API_KEY is the fallback. |
| `browserbaseProjectId` | none | Browserbase project ID: a SecretRef object or a string. Optional. Env BROWSERBASE_PROJECT_ID is the fallback. |
| `apiBaseUrl` | `"https://api.browserbase.com"` | Browserbase API base URL (override only for testing). |
| `fetchFormat` | `"raw"` | raw = normal Fetch plus local Readability (cheapest, no project enablement needed); markdown = Browserbase Fetch Extract (priced higher, may need enablement; falls back to raw on a format error). |
| `l1TimeoutMs` | `20000` | L1 (Fetch, no proxies) timeout. |
| `l2TimeoutMs` | `25000` | L2 (Fetch with proxies) timeout. |
| `l2Proxies` | `true` | Run L2. Off skips straight from L1 to L3. |
| `skipL2ForJsShell` | `false` | When L1 got a thin JavaScript shell, go straight to L3 (proxies cannot run JavaScript). |
| `l3Enabled` | `true` | Run L3 (browser session). |
| `l3Proxies` | `true` | Residential proxies on the L3 session; retried once without them on a proxy-provider refusal. |
| `l3MaxSeconds` | `60` | Hard cap for L3, session create to release. |
| `l3SolveCaptchas` | `true` | Browserbase captcha solving on the L3 session. |
| `l3Verified` | `false` | Browserbase Verified browser (advanced stealth). Scale plan only; leave off on Developer. |
| `l3BlockAds` | `true` | Ad blocking in the L3 browser. |
| `l3RecordSession` | `false` | Browserbase session recording (off keeps your pages out of replays). |
| `l3LogSession` | `false` | Browserbase session logs. |
| `l3Region` | `""` | Session region; empty = Browserbase default. |
| `l3NetworkIdleMs` | `15000` | Wait for network idle, at most this long. |
| `l3CaptchaWaitMs` | `30000` | How long to wait out a captcha solve or a JS challenge page. |
| `l3Driver` | `"auto"` | auto = playwright-core from the OpenClaw install, else the built-in minimal CDP client. |
| `contextStrategy` | `"site"` | One persistent Browserbase context per site group (site), per hostname (host), or none. |
| `contextGroups` | `{}` | Extra site groups sharing one context, e.g. {"atlassian": ["atlassian.net", "atlassian.com"]}. |
| `contextPersist` | `true` | Save cookies and logins back into the context after each session. |
| `contextWaitMs` | `8000` | Wait this long for a busy context before running without it. |
| `contextSettleMs` | `3000` | Hold a context this long after a persisting session closes. |
| `minVisibleChars` | `500` | Below this much readable text, a page that should have more counts as blocked or thin. |
| `totalMaxSeconds` | `110` | Outer cap for one ladder run. |
| `failureMode` | `"auto"` | auto: durable walls come back as a text result, transient walls (timeout, Browserbase busy or down) are thrown so the core does not cache them. |
| `blockPrivateHosts` | `true` | Refuse loopback and private-network hosts. |
| `allowInsecureSsl` | `false` | Let Browserbase Fetch skip TLS verification. |
| `alertFetchCalls` | `5000` | Monthly Fetch API calls before an alerts.log line. |
| `alertProxyBytes` | `2147483648` | Monthly proxy bytes before an alerts.log line. |
| `alertBrowserHours` | `150` | Monthly browser hours before an alerts.log line. |
| `stateDir` | `"~/.cache/openclaw-fetch-plus"` | calls.jsonl, usage-YYYY-MM.json, alerts.log, contexts.json. |
| `playwrightCorePath` | none | Override path to playwright-core's index.mjs. |
| `noLog` | `false` | Skip calls.jsonl. |
| `l3FirstHosts` | `[]` | Host suffixes that skip L1/L2 and start at L3 (real browser): sites whose JavaScript shell carries enough boilerplate to pass every text check, e.g. ["shop.example.com"]. |
| `minVisibleCharsHard` | `200` | Hard floor: an HTML page with fewer article characters than this is thin whatever its size (a 139-character Akamai interstitial passes the soft check). |

## License

MIT, see [LICENSE](LICENSE).
