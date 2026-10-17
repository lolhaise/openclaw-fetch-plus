// fetch-plus extraction: raw HTML -> { title, markdown, text } with Readability
// (the same extractor family the core's own web_fetch uses), a DOM fallback
// with nav/header/footer/aside stripped, and a small HTML -> markdown walker.
// Libraries come from the OpenClaw install; both load lazily and fail soft.
import { createRequire } from "node:module";
import path from "node:path";
import { OPENCLAW_NM, importSpecifier } from "./util.js";

const require = createRequire(import.meta.url);
let libs;

async function loadLibs() {
  if (libs) return libs;
  let parseHTML;
  let Readability;
  try {
    ({ parseHTML } = await import(importSpecifier(path.join(OPENCLAW_NM, "linkedom", "esm", "index.js"))));
  } catch {
    try {
      ({ parseHTML } = await import("linkedom"));
    } catch {
      parseHTML = undefined;
    }
  }
  try {
    ({ Readability } = require(path.join(OPENCLAW_NM, "@mozilla", "readability", "index.js")));
  } catch {
    try {
      ({ Readability } = require("@mozilla/readability"));
    } catch {
      Readability = undefined;
    }
  }
  libs = { parseHTML, Readability };
  return libs;
}

const DROP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "head", "link", "meta"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form", "button", "dialog"]);

export function collapse(s) {
  return String(s ?? "").replace(/[ \t\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function absUrl(href, base) {
  if (!href) return "";
  try {
    const u = new URL(href, base || undefined);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : "";
  } catch {
    return "";
  }
}

// ---- HTML -> markdown (block-aware DOM walk) --------------------------------
function mdInline(node, base) {
  let out = "";
  for (const child of node.childNodes || []) {
    if (child.nodeType === 3) {
      out += child.textContent.replace(/\s+/g, " ");
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;
    if (tag === "br") out += "\n";
    else if (tag === "a") {
      const text = mdInline(child, base).trim();
      const href = absUrl(child.getAttribute("href"), base);
      out += text ? (href ? `[${text}](${href})` : text) : "";
    } else if (tag === "strong" || tag === "b") {
      const t = mdInline(child, base).trim();
      out += t ? `**${t}**` : "";
    } else if (tag === "em" || tag === "i") {
      const t = mdInline(child, base).trim();
      out += t ? `_${t}_` : "";
    } else if (tag === "code") out += "`" + child.textContent.replace(/`/g, "'") + "`";
    else if (tag === "img") {
      const src = absUrl(child.getAttribute("src"), base);
      const alt = (child.getAttribute("alt") || "").trim();
      if (src && alt) out += `![${alt}](${src})`;
    } else out += mdInline(child, base);
  }
  return out;
}

function mdBlocks(node, base, depth = 0) {
  const blocks = [];
  let inlineBuf = "";
  const flush = () => {
    const t = inlineBuf.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
    if (t) blocks.push(t);
    inlineBuf = "";
  };
  for (const child of node.childNodes || []) {
    if (child.nodeType === 3) {
      inlineBuf += child.textContent.replace(/\s+/g, " ");
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;
    const h = /^h([1-6])$/.exec(tag);
    if (h) {
      flush();
      const t = mdInline(child, base).trim();
      if (t) blocks.push(`${"#".repeat(Number(h[1]))} ${t}`);
    } else if (tag === "p") {
      flush();
      const t = mdInline(child, base).trim();
      if (t) blocks.push(t);
    } else if (tag === "pre") {
      flush();
      const t = child.textContent.replace(/\n+$/, "");
      if (t.trim()) blocks.push("```\n" + t + "\n```");
    } else if (tag === "ul" || tag === "ol") {
      flush();
      const items = [];
      let n = 1;
      for (const li of child.children || []) {
        if (li.tagName?.toLowerCase() !== "li") continue;
        const inner = mdBlocks(li, base, depth + 1).split("\n").filter(Boolean);
        if (!inner.length) continue;
        const bullet = tag === "ol" ? `${n++}.` : "-";
        items.push(`${"  ".repeat(depth)}${bullet} ${inner[0]}`);
        for (const rest of inner.slice(1)) items.push(`${"  ".repeat(depth + 1)}${rest}`);
      }
      if (items.length) blocks.push(items.join("\n"));
    } else if (tag === "blockquote") {
      flush();
      const t = mdBlocks(child, base, depth);
      if (t) blocks.push(t.split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (tag === "hr") {
      flush();
      blocks.push("---");
    } else if (tag === "table") {
      flush();
      const rows = [];
      for (const tr of child.querySelectorAll("tr")) {
        const cells = [...tr.children].filter((c) => /^(td|th)$/i.test(c.tagName)).map((c) => mdInline(c, base).replace(/\|/g, "/").replace(/\s+/g, " ").trim());
        if (cells.some(Boolean)) rows.push(`| ${cells.join(" | ")} |`);
      }
      if (rows.length) {
        const cols = (rows[0].match(/\|/g) || []).length - 1;
        rows.splice(1, 0, `|${" --- |".repeat(Math.max(1, cols))}`);
        blocks.push(rows.join("\n"));
      }
    } else if (tag === "img") {
      flush();
      const t = mdInline({ childNodes: [child] }, base);
      if (t) blocks.push(t);
    } else if (/^(div|section|article|main|figure|figcaption|details|summary|dl|dd|dt|li|body|html|center|span|font|label|header|footer|nav|aside)$/.test(tag)) {
      // Containers: recurse as blocks when they hold blocks, else treat as inline.
      const hasBlock = child.querySelector?.("p,div,h1,h2,h3,h4,h5,h6,ul,ol,pre,table,blockquote,section,article,br");
      if (hasBlock) {
        flush();
        const t = mdBlocks(child, base, depth);
        if (t) blocks.push(t);
      } else if (/^(span|font|label|a|b|strong|em|i|code)$/.test(tag)) {
        inlineBuf += mdInline({ childNodes: [child] }, base);
      } else {
        flush();
        const t = mdInline(child, base).trim();
        if (t) blocks.push(t);
      }
    } else {
      inlineBuf += mdInline({ childNodes: [child] }, base);
    }
  }
  flush();
  return blocks.join("\n\n");
}

export function markdownToText(md) {
  return collapse(
    String(md ?? "")
      .replace(/```[a-z]*\n?/gi, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\|?\s*-{3,}.*$/gm, "")
      .replace(/\|/g, " ")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|\W)[_*]([^_*\n]+)[_*](?=\W|$)/g, "$1$2")
      .replace(/`([^`]*)`/g, "$1"),
  );
}

export function titleFromMarkdown(md) {
  const m = /^#\s+(.+)$/m.exec(String(md ?? ""));
  return m ? m[1].trim().slice(0, 300) : undefined;
}

// Visible text of a whole document, used for block detection. Chrome stripped.
function bodyVisibleText(document) {
  const body = document.body || document.documentElement;
  if (!body) return "";
  const clone = body.cloneNode(true);
  for (const el of clone.querySelectorAll("script,style,noscript,template,svg")) el.remove();
  return collapse(clone.textContent || "");
}

function stripChrome(document) {
  const body = document.body || document.documentElement;
  if (!body) return null;
  const clone = body.cloneNode(true);
  for (const el of clone.querySelectorAll([...DROP_TAGS, ...CHROME_TAGS].join(","))) el.remove();
  for (const el of clone.querySelectorAll('[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]')) el.remove();
  return clone;
}

// Main entry. Returns everything the ladder needs to judge and to answer.
const EMPTY_EXTRACT = Object.freeze({ title: undefined, content: "", visibleText: "", articleChars: 0, extractor: "empty", htmlLength: 0, scriptCount: 0, hasPasswordInput: false, noscriptText: "" });

export async function extractHtml(html, opts = {}) {
  const htmlStr = String(html ?? "");
  // An empty body gives linkedom a document with no documentElement, and its
  // body getter throws (seen on a 0-byte answer).
  if (!htmlStr.trim()) return { ...EMPTY_EXTRACT };
  try {
    return await extractHtmlDom(htmlStr, opts);
  } catch {
    return extractHtmlRegex(htmlStr, opts.extractMode);
  }
}

function extractHtmlRegex(htmlStr, extractMode) {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(htmlStr);
  const text = collapse(htmlStr.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  return { title: titleM ? collapse(titleM[1]) : undefined, content: extractMode === "text" ? text : text, visibleText: text, articleChars: text.length, extractor: "regex", htmlLength: htmlStr.length, scriptCount: (htmlStr.match(/<script\b/gi) || []).length, hasPasswordInput: /<input[^>]+type=["']?password/i.test(htmlStr), noscriptText: "" };
}

async function extractHtmlDom(rawHtml, { url, extractMode = "markdown" } = {}) {
  const { parseHTML, Readability } = await loadLibs();
  // A bare fragment ("<p>hi</p>") has no <html>/<body>; wrap it so linkedom keeps the text.
  const htmlStr = /<(html|body)[\s>]/i.test(rawHtml) ? rawHtml : `<html><body>${rawHtml}</body></html>`;
  const scriptCount = (htmlStr.match(/<script\b/gi) || []).length;
  if (!parseHTML) {
    // Last-ditch: regex strip. Keeps the ladder working if linkedom vanished.
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(htmlStr);
    const text = collapse(htmlStr.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    return { title: titleM ? collapse(titleM[1]) : undefined, content: text, visibleText: text, articleChars: text.length, extractor: "regex", htmlLength: htmlStr.length, scriptCount, hasPasswordInput: /<input[^>]+type=["']?password/i.test(htmlStr) };
  }
  const { document } = parseHTML(htmlStr);
  const docTitle = collapse(document.querySelector("title")?.textContent || "") || undefined;
  const visibleText = bodyVisibleText(document);
  const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
  const noscriptText = collapse([...document.querySelectorAll("noscript")].map((n) => n.textContent || "").join(" ")).slice(0, 500);

  let article = null;
  if (Readability) {
    try {
      const { document: rdoc } = parseHTML(htmlStr);
      article = new Readability(rdoc, { charThreshold: 250, keepClasses: false }).parse();
    } catch {
      article = null;
    }
  }
  let markdown = "";
  let extractor = "readability";
  if (article?.content && collapse(article.textContent || "").length >= 200) {
    const { document: adoc } = parseHTML(`<html><body>${article.content}</body></html>`);
    markdown = mdBlocks(adoc.body, url);
  }
  if (!markdown) {
    const stripped = stripChrome(document);
    extractor = "dom";
    markdown = stripped ? mdBlocks(stripped, url) : "";
  }
  const title = collapse(article?.title || "") || docTitle;
  const content = extractMode === "text" ? markdownToText(markdown) : markdown;
  return {
    title,
    content,
    visibleText,
    articleChars: markdownToText(markdown).length,
    extractor,
    htmlLength: htmlStr.length,
    scriptCount,
    hasPasswordInput,
    noscriptText,
  };
}

// For markdown handed back by Browserbase Fetch Extract.
export function extractMarkdown(md, { extractMode = "markdown" } = {}) {
  const text = markdownToText(md);
  return {
    title: titleFromMarkdown(md),
    content: extractMode === "text" ? text : String(md ?? "").trim(),
    visibleText: text,
    articleChars: text.length,
    extractor: "bb-markdown",
    htmlLength: String(md ?? "").length,
    scriptCount: 0,
    hasPasswordInput: false,
    noscriptText: "",
  };
}
