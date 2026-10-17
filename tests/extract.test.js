// Runs with whatever extraction libraries are reachable: linkedom and Readability
// from an OpenClaw install when there is one, the regex fallback when there is not.
// Every assertion here holds for both.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collapse, extractHtml, extractMarkdown, markdownToText, titleFromMarkdown } from "../lib/extract.js";
import { fixture } from "./helpers.js";

const EXTRACTORS = ["readability", "dom", "regex"];

describe("extractHtml", () => {
  test("full page: title, article text, no script or style, counts", async () => {
    const ex = await extractHtml(fixture("article.html"), { url: "https://example.org/notes/sourdough" });
    assert.ok(EXTRACTORS.includes(ex.extractor), ex.extractor);
    assert.match(ex.title, /^Field notes on sourdough hydration/);
    assert.match(ex.content, /Hydration is the weight of water in a dough/);
    assert.match(ex.content, /flour notes/);
    assert.doesNotMatch(ex.content, /tracking-code-should-not-appear|font-family/);
    assert.ok(ex.articleChars > 1000, `articleChars ${ex.articleChars}`);
    assert.equal(ex.scriptCount, 1);
    assert.equal(ex.hasPasswordInput, false);
  });

  test("text mode returns plain text without markdown links or emphasis", async () => {
    const ex = await extractHtml(fixture("article.html"), { url: "https://example.org/notes/sourdough", extractMode: "text" });
    assert.doesNotMatch(ex.content, /\]\(|\*\*/);
    assert.match(ex.content, /flour notes/);
  });

  test("a bare fragment keeps its text", async () => {
    const ex = await extractHtml("<p>Hello <b>fragment</b> world</p>", { extractMode: "text" });
    assert.equal(ex.content, "Hello fragment world");
  });

  test("an empty body returns the empty extract instead of throwing", async () => {
    for (const body of ["", "   \n\t  ", null, undefined]) {
      const ex = await extractHtml(body);
      assert.equal(ex.extractor, "empty");
      assert.equal(ex.content, "");
      assert.equal(ex.articleChars, 0);
    }
  });

  test("a password input is reported", async () => {
    const ex = await extractHtml('<html><body><form><input type="password" name="p"></form></body></html>');
    assert.equal(ex.hasPasswordInput, true);
  });
});

describe("markdown helpers", () => {
  test("markdownToText strips headings, links, emphasis, lists and code", () => {
    const md = "# Title\n\nSee [the docs](https://example.org/docs) for **bold** and _italic_.\n\n- one\n- two\n\n`code`";
    assert.equal(markdownToText(md), "Title\nSee the docs for bold and italic.\none\ntwo\ncode");
  });

  test("titleFromMarkdown reads the first level-one heading", () => {
    assert.equal(titleFromMarkdown("intro\n# The Title\n## Sub"), "The Title");
    assert.equal(titleFromMarkdown("no heading here"), undefined);
  });

  test("extractMarkdown shapes a Browserbase markdown answer", () => {
    const ex = extractMarkdown("# Hello\n\nSome [link](https://example.org) text.", { extractMode: "text" });
    assert.equal(ex.extractor, "bb-markdown");
    assert.equal(ex.title, "Hello");
    assert.equal(ex.content, "Hello\nSome link text.");
  });

  test("collapse squeezes runs of spaces and of newlines", () => {
    assert.equal(collapse("  a \t b\n\n\n\n c  "), "a b\nc");
  });
});
