import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectChallenge, detectGeo, detectLoginWall, isThin, judgePage, looksLikeJsShell } from "../lib/detect.js";
import { extractHtml } from "../lib/extract.js";
import { fixture } from "./helpers.js";

const URL_ = "https://example.org/page";

async function verdictOf(name, status = 200, finalUrl = URL_) {
  const html = fixture(name);
  const ex = await extractHtml(html, { url: finalUrl });
  return judgePage({ status, html, finalUrl, ex, minVisibleChars: 500, hardFloor: 200 });
}

describe("judgePage on fixtures", () => {
  test("Cloudflare 'Just a moment...' page is a challenge", async () => {
    const v = await verdictOf("cloudflare-just-a-moment.html", 403);
    assert.equal(v.verdict, "challenge");
    assert.match(v.why, /^(challenge_title|cloudflare)$/);
  });

  test("Reddit-style JavaScript proof-of-work shell is a challenge, even on HTTP 200", async () => {
    const v = await verdictOf("js-challenge-shell.html", 200);
    assert.deepEqual(v, { verdict: "challenge", why: "reddit_js_challenge" });
  });

  test("hCaptcha page is a challenge", async () => {
    const v = await verdictOf("hcaptcha.html", 200);
    assert.deepEqual(v, { verdict: "challenge", why: "hcaptcha" });
  });

  test("Akamai-style short block page is blocked, even on HTTP 200", async () => {
    const v = await verdictOf("akamai-short-block.html", 200);
    assert.deepEqual(v, { verdict: "blocked", why: "block_text" });
  });

  test("HTTP 451 is geo", async () => {
    const v = await verdictOf("geo-451.html", 451);
    assert.deepEqual(v, { verdict: "geo", why: "http_451" });
  });

  test("a geo sentence on an HTTP 200 page is geo", async () => {
    const v = await verdictOf("geo-451.html", 200);
    assert.deepEqual(v, { verdict: "geo", why: "phrase" });
  });

  test("'please enable JavaScript' shell is thin with why js_shell", async () => {
    const v = await verdictOf("enable-javascript-shell.html", 200);
    assert.deepEqual(v, { verdict: "thin", why: "js_shell" });
  });

  test("an article ABOUT captchas does not trip any detector", async () => {
    const v = await verdictOf("article-about-captchas.html", 200);
    assert.deepEqual(v, { verdict: "ok", why: "" });
  });

  test("a normal article is ok", async () => {
    const v = await verdictOf("article.html", 200);
    assert.deepEqual(v, { verdict: "ok", why: "" });
  });

  test("a 403 page with block wording is blocked", async () => {
    const v = await verdictOf("blocked-403.html", 403);
    assert.equal(v.verdict, "blocked");
  });

  test("HTTP 404 is not_found", async () => {
    const v = await verdictOf("not-found-404.html", 404);
    assert.deepEqual(v, { verdict: "not_found", why: "http_404" });
  });

  test("a short page at a login URL is a login wall", async () => {
    const v = await verdictOf("not-found-404.html", 200, "https://example.org/login?next=/page");
    assert.deepEqual(v, { verdict: "login", why: "url" });
  });
});

describe("detectChallenge", () => {
  test("challenge titles match whole titles only", () => {
    assert.deepEqual(detectChallenge({ title: "Attention Required! | Cloudflare" }), { kind: "challenge", why: "challenge_title" });
    assert.equal(detectChallenge({ title: "Just a moment of your time: a review" }), null);
  });

  test("structural markers: Turnstile, reCAPTCHA, DataDome, PerimeterX, AWS WAF", () => {
    assert.equal(detectChallenge({ html: '<div class="cf-turnstile" data-sitekey="x"></div>' }).why, "turnstile");
    assert.equal(detectChallenge({ html: '<script src="https://www.google.com/recaptcha/api.js"></script>' }).why, "recaptcha");
    assert.equal(detectChallenge({ html: '<script src="https://geo.captcha-delivery.com/captcha/"></script>' }).why, "datadome");
    assert.equal(detectChallenge({ html: '<div id="px-captcha"></div>' }).why, "perimeterx");
    assert.equal(detectChallenge({ html: '<script src="https://abc.token.awswaf.com/x/challenge.js"></script>' }).why, "aws_waf");
  });

  test("a structural marker on a long page is ignored", () => {
    const longText = "word ".repeat(1000);
    assert.equal(detectChallenge({ html: '<div class="cf-turnstile"></div>', visibleText: longText }), null);
  });

  test("challenge phrases count on short pages only", () => {
    assert.deepEqual(detectChallenge({ visibleText: "Press and hold the button to confirm." }), { kind: "challenge", why: "challenge_text" });
    assert.equal(detectChallenge({ visibleText: "Press and hold the button to confirm. " + "More prose. ".repeat(300) }), null);
  });

  test("block phrases and Akamai reference numbers are blocks", () => {
    assert.deepEqual(detectChallenge({ visibleText: "Whoa there, pardner!" }), { kind: "blocked", why: "block_text" });
    assert.deepEqual(detectChallenge({ visibleText: "Access Denied. Reference #18.6f2a1702.1760710000.4c3b2a1" }), { kind: "blocked", why: "block_text" });
    assert.deepEqual(detectChallenge({ visibleText: "Too Many Requests" }), { kind: "blocked", why: "block_text" });
  });
});

describe("detectLoginWall, detectGeo, looksLikeJsShell, isThin", () => {
  test("login: URL, phrase on a short page, password form", () => {
    assert.deepEqual(detectLoginWall({ finalUrl: "https://www.linkedin.com/authwall?trk=x" }), { kind: "login", why: "url" });
    assert.deepEqual(detectLoginWall({ visibleText: "Sign in to continue reading", articleChars: 40 }), { kind: "login", why: "phrase" });
    assert.deepEqual(detectLoginWall({ visibleText: "Password", hasPasswordInput: true, articleChars: 30 }), { kind: "login", why: "password-form" });
  });

  test("login phrase inside a long article is not a wall", () => {
    assert.equal(detectLoginWall({ visibleText: "Members only events are listed below.", articleChars: 4000 }), null);
  });

  test("geo: 451 always, phrase only under 5000 characters", () => {
    assert.deepEqual(detectGeo({ status: 451 }), { kind: "geo", why: "http_451" });
    assert.deepEqual(detectGeo({ status: 200, visibleText: "This video is not available in your region." }), { kind: "geo", why: "phrase" });
    assert.equal(detectGeo({ status: 200, visibleText: "This video is not available in your region. " + "x".repeat(5000) }), null);
  });

  test("JavaScript shell signals", () => {
    assert.equal(looksLikeJsShell({ visibleText: "This app requires JavaScript." }), true);
    assert.equal(looksLikeJsShell({ html: '<div id="__next"></div>', visibleText: "" }), true);
    assert.equal(looksLikeJsShell({ visibleText: "hi", scriptCount: 3 }), true);
    assert.equal(looksLikeJsShell({ visibleText: "x".repeat(100), htmlLength: 60000 }), true);
    assert.equal(looksLikeJsShell({ visibleText: "x".repeat(2000), scriptCount: 2, htmlLength: 9000 }), false);
  });

  test("isThin: hard floor catches a tiny HTML page, soft floor needs a page that should have more", () => {
    assert.equal(isThin({ articleChars: 139, htmlLength: 900 }, 500, 200), true);
    assert.equal(isThin({ articleChars: 300, htmlLength: 2000 }, 500, 200), false);
    assert.equal(isThin({ articleChars: 300, htmlLength: 20000 }, 500, 200), true);
    assert.equal(isThin({ articleChars: 800, htmlLength: 90000 }, 500, 200), false);
  });
});

describe("judgePage status handling", () => {
  const ex = { title: "Fine", visibleText: "x".repeat(800), articleChars: 800, content: "x".repeat(800), htmlLength: 2000, scriptCount: 0 };
  test("block statuses", () => {
    assert.deepEqual(judgePage({ status: 429, ex, minVisibleChars: 500 }), { verdict: "blocked", why: "http_429" });
    assert.deepEqual(judgePage({ status: 503, ex, minVisibleChars: 500 }), { verdict: "blocked", why: "http_503" });
  });
  test("other non-2xx is http_error, 410 is not_found", () => {
    assert.deepEqual(judgePage({ status: 500, ex, minVisibleChars: 500 }), { verdict: "http_error", why: "http_500" });
    assert.deepEqual(judgePage({ status: 410, ex, minVisibleChars: 500 }), { verdict: "not_found", why: "http_410" });
  });
  test("a 2xx page with no content is thin:empty", () => {
    assert.deepEqual(judgePage({ status: 200, ex: { ...ex, content: "  " }, minVisibleChars: 500 }), { verdict: "thin", why: "empty" });
  });
});
