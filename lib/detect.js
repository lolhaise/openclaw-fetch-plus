// fetch-plus page verdicts: is this a real page, or a wall? Pure functions so
// the tests can run them on fixtures (tests/fixtures/).
//
// Structural markers (script/iframe hosts, element ids) count on any page.
// Phrase markers only count on SHORT pages, so an article ABOUT captchas is
// not mistaken for one.
const STRUCTURAL_CHALLENGE = [
  ["cloudflare", /cf_chl_opt|cf-browser-verification|challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\//i],
  ["turnstile", /class=["'][^"']*\bcf-turnstile\b/i],
  ["recaptcha", /class=["'][^"']*\bg-recaptcha\b|www\.google\.com\/recaptcha\/(api|enterprise)/i],
  ["hcaptcha", /class=["'][^"']*\bh-captcha\b|hcaptcha\.com\/1\/api\.js/i],
  ["perimeterx", /id=["']px-captcha["']|captcha\.px-cdn\.net|perimeterx/i],
  ["datadome", /captcha-delivery\.com|geo\.captcha-delivery/i],
  ["arkose", /arkoselabs\.com|funcaptcha/i],
  ["aws_waf", /awswaf|aws-waf-token|token\.awswaf\.com/i],
  // Reddit's JS proof-of-work interstitial (HTTP 200; shape in tests/fixtures/js-challenge-shell.html)
  ["reddit_js_challenge", /js_challenge|namedItem\(["']solution["']\)/i],
];

const CHALLENGE_TITLE = /^(just a moment\.{0,3}|attention required! \| cloudflare|please wait\.{0,3}|verifying you are human.*|access denied|security check|are you a robot\??|human verification|one more step)$/i;

const CHALLENGE_PHRASES = [
  /verify (that )?you('| a)?re (a )?human/i,
  /verify you are human/i,
  /checking (if the site connection is secure|your browser before accessing)/i,
  /enable javascript and cookies to continue/i,
  /are you a robot|i'?m not a robot/i,
  /press (&|and) hold/i,
  /complete the security check/i,
  /solve (this|the) (captcha|puzzle)/i,
];

const BLOCK_PHRASES = [
  /you('ve| have) been blocked( by network security)?/i,
  /whoa there,? pardner/i,
  /our systems have detected unusual traffic/i,
  /access (to this page )?(has been )?denied/i,
  /request (was )?blocked/i,
  /sorry, you have been blocked/i,
  /reference #\s*[\d.]+[a-f0-9.]*/i,
  /too many requests/i,
  // Akamai's interstitial (HTTP 200, about 139 chars): the only words on it.
  /powered and protected by/i,
];

const LOGIN_URL = /\/(login|log-in|signin|sign-in|sign_in|auth\/login|accounts\/login|session\/new|sessions\/new|checkpoint|authwall|uas\/login)(\/|\?|$)|^https?:\/\/(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|www\.linkedin\.com\/authwall|x\.com\/i\/flow\/login)/i;
const LOGIN_PHRASES = /(log ?in|sign ?in) to (continue|view|see|read|access)|you must be (logged|signed) in|please (log|sign) in|join (now )?to (see|view)|create an account or (log|sign) in|members only|subscribe to (continue|keep) reading|this content is for subscribers/i;

const GEO_PHRASES = /(not|isn'?t) available in your (country|region|location)|unavailable in your (country|region|location)|not available in your area|geo(graphic(al)?)?[- ]?(restrict|block)|this (content|video|service) is not available (in|from) your/i;

const JS_SHELL_PHRASES = /(need|needs|necessary|required|have|has|must|please)\s+(to\s+)?enable javascript|enable javascript (to|and) |javascript is (required|disabled|not available|not enabled)|javascript (must|needs to) be enabled|this (app|site|page) (requires|needs) javascript|enable js to|doesn'?t work properly without javascript/i;

export function detectChallenge({ html = "", title = "", visibleText = "" }) {
  const t = String(title || "").trim();
  if (CHALLENGE_TITLE.test(t)) return { kind: "challenge", why: "challenge_title" };
  const head = String(html).slice(0, 400000);
  for (const [name, re] of STRUCTURAL_CHALLENGE) {
    if (re.test(head) && visibleText.length < 4000) return { kind: "challenge", why: name };
  }
  if (visibleText.length < 3000) {
    for (const re of CHALLENGE_PHRASES) if (re.test(visibleText)) return { kind: "challenge", why: "challenge_text" };
    for (const re of BLOCK_PHRASES) if (re.test(visibleText) || re.test(t)) return { kind: "blocked", why: "block_text" };
  }
  return null;
}

export function detectLoginWall({ finalUrl = "", visibleText = "", hasPasswordInput = false, articleChars = 0 }) {
  if (LOGIN_URL.test(finalUrl)) return { kind: "login", why: "url" };
  if (articleChars < 1500 && LOGIN_PHRASES.test(visibleText)) return { kind: "login", why: "phrase" };
  if (hasPasswordInput && articleChars < 800 && /(log ?in|sign ?in|password)/i.test(visibleText)) return { kind: "login", why: "password-form" };
  return null;
}

export function detectGeo({ status, visibleText = "" }) {
  if (status === 451) return { kind: "geo", why: "http_451" };
  if (visibleText.length < 5000 && GEO_PHRASES.test(visibleText)) return { kind: "geo", why: "phrase" };
  return null;
}

export function looksLikeJsShell({ visibleText = "", noscriptText = "", scriptCount = 0, htmlLength = 0, html = "" }) {
  if (JS_SHELL_PHRASES.test(visibleText) || JS_SHELL_PHRASES.test(noscriptText)) return true;
  if (visibleText.length < 200 && scriptCount >= 3) return true;
  if (/<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html) && visibleText.length < 500) return true;
  return htmlLength > 50000 && visibleText.length < 300;
}

// "A body under N characters of visible text on a page that should have more."
export function isThin({ articleChars = 0, visibleText = "", htmlLength = 0, scriptCount = 0, noscriptText = "", html = "" }, minVisibleChars, hardFloor = 0) {
  const chars = Math.max(articleChars, 0);
  // Hard floor (2026-09-27): an HTML page with under `hardFloor` chars of article text is a wall or a
  // shell whatever its size; the Akamai interstitial was 139 chars in a small document and passed.
  if (hardFloor > 0 && chars < hardFloor && (htmlLength > 0 || scriptCount > 0)) return true;
  if (chars >= minVisibleChars) return false;
  const shouldHaveMore = htmlLength >= 10000 || scriptCount >= 5 || looksLikeJsShell({ visibleText, noscriptText, scriptCount, htmlLength, html });
  return shouldHaveMore;
}

const BLOCK_STATUSES = new Set([401, 403, 407, 429, 503, 520, 521, 522, 523, 524, 525, 526, 530]);

// Verdict for one page read. `status` is the TARGET's HTTP status.
// Returns { verdict: "ok" | "blocked" | "challenge" | "login" | "geo" | "thin" | "not_found" | "http_error", why }
export function judgePage({ status, html = "", finalUrl = "", ex, minVisibleChars, hardFloor = 0 }) {
  const title = ex?.title || "";
  const visibleText = ex?.visibleText || "";
  const geo = detectGeo({ status, visibleText });
  if (geo) return { verdict: "geo", why: geo.why };
  const challenge = detectChallenge({ html, title, visibleText });
  if (challenge) return { verdict: challenge.kind === "challenge" ? "challenge" : "blocked", why: challenge.why };
  const login = detectLoginWall({ finalUrl, visibleText, hasPasswordInput: ex?.hasPasswordInput, articleChars: ex?.articleChars || 0 });
  if (login && (status === 401 || status === 403 || (ex?.articleChars || 0) < 1500)) return { verdict: "login", why: login.why };
  if (typeof status === "number" && BLOCK_STATUSES.has(status)) return { verdict: "blocked", why: `http_${status}` };
  if (status === 404 || status === 410) return { verdict: "not_found", why: `http_${status}` };
  if (typeof status === "number" && (status < 200 || status >= 300)) return { verdict: "http_error", why: `http_${status}` };
  const jsShell = looksLikeJsShell({ visibleText, noscriptText: ex?.noscriptText, scriptCount: ex?.scriptCount, htmlLength: ex?.htmlLength, html });
  if (isThin({ ...ex, html }, minVisibleChars, hardFloor)) return { verdict: "thin", why: jsShell ? "js_shell" : `visible_chars_${ex?.articleChars ?? 0}` };
  if (!ex?.content || !String(ex.content).trim()) return { verdict: "thin", why: jsShell ? "js_shell" : "empty" };
  return { verdict: "ok", why: "" };
}
