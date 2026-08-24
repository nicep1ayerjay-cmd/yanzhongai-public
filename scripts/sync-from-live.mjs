#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as cheerio from "cheerio";
import TurndownService from "turndown";

const root = process.cwd();
const origin = "https://www.yanzhongai.com";
const sitemapUrl = `${origin}/sitemap.xml`;
const contentRoot = path.join(root, "content");
const sitemapRoot = path.join(root, "sitemap");
const manifestPath = path.join(root, "manifest.json");
const sourceCommit = String(process.env.SOURCE_COMMIT || "").trim();
const force = process.argv.includes("--force");
const concurrency = Math.max(1, Math.min(4, Number(process.env.SYNC_CONCURRENCY || 3)));

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**"
});
turndown.remove(["script", "style", "noscript", "svg", "iframe", "form", "button"]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/html,application/xml;q=0.9,*/*;q=0.5",
          "user-agent": "YanzhongPublicContentMirror/1.0 (+https://github.com/nicep1ayerjay-cmd/yanzhongai-public)"
        },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 800);
    }
  }
  throw new Error(`无法读取 ${url}：${lastError?.message || lastError}`);
}

function parseSitemap(xml = "") {
  return [...String(xml).matchAll(/<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)].map((match) => ({
    url: match[1].replaceAll("&amp;", "&").trim(),
    lastmod: match[2].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() || ""
  }));
}

function isIncluded(urlString = "") {
  const url = new URL(urlString);
  if (url.origin !== origin) return false;
  const pathname = url.pathname;
  return (
    pathname === "/blog.html" ||
    pathname === "/sitemap.html" ||
    /^\/articles\/[a-z0-9-]+\.html$/.test(pathname) ||
    pathname === "/trusted-choice-certification.html" ||
    /^\/trusted-choice-[a-z0-9-]+\.html$/.test(pathname) ||
    /^\/trusted-choice-[a-z0-9-]+\/(?:article|document)-\d+\.html$/.test(pathname)
  );
}

function targetFor(urlString = "") {
  const pathname = new URL(urlString).pathname;
  if (pathname === "/blog.html") return "content/blog/index.md";
  if (pathname === "/sitemap.html") return "content/sitemap/index.md";
  const blog = pathname.match(/^\/articles\/([a-z0-9-]+)\.html$/);
  if (blog) return `content/blog/articles/${blog[1]}.md`;
  if (pathname === "/trusted-choice-certification.html") return "content/trusted-choice/certification.md";
  const leaf = pathname.match(/^\/(trusted-choice-[a-z0-9-]+)\/(article|document)-(\d+)\.html$/);
  if (leaf) return `content/trusted-choice/${leaf[1]}/${leaf[2]}s/${leaf[2]}-${leaf[3]}.md`;
  const profile = pathname.match(/^\/(trusted-choice-[a-z0-9-]+)\.html$/);
  if (profile) return `content/trusted-choice/${profile[1]}/profile.md`;
  throw new Error(`没有公开镜像路径：${urlString}`);
}

function yamlString(value = "") {
  return JSON.stringify(String(value).replace(/\s+/g, " ").trim());
}

function pageType(urlString = "") {
  const pathname = new URL(urlString).pathname;
  if (pathname === "/blog.html") return "blog-index";
  if (pathname === "/sitemap.html") return "sitemap-html";
  if (pathname.startsWith("/articles/")) return "blog-article";
  if (pathname === "/trusted-choice-certification.html") return "trusted-choice-certification";
  if (/\/(?:article|document)-\d+\.html$/.test(pathname)) return pathname.includes("/document-") ? "trusted-choice-document" : "trusted-choice-article";
  return "trusted-choice-profile";
}

function cleanMarkdown(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderPage(html, entry) {
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim() || $("title").text().replace(/\s+/g, " ").trim();
  const canonical = $('link[rel="canonical"]').attr("href") || entry.url;
  $("script, style, noscript, svg, iframe, form, button, nav, footer, aside").remove();
  $("[data-site-header], .site-header, .header, .footer, .mobile-nav, .tcc-footer, .article-footer, .article-rail").remove();
  const main = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body");
  let body = cleanMarkdown(turndown.turndown(main.html() || ""));
  if (!body) throw new Error(`正文为空：${entry.url}`);
  if (!/^#\s+/m.test(body) && title) body = `# ${title}\n\n${body}`;
  const sourceHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    `canonical_url: ${yamlString(canonical)}`,
    `source_type: ${yamlString(pageType(entry.url))}`,
    `lastmod: ${yamlString(entry.lastmod)}`,
    `source_hash: ${yamlString(sourceHash)}`,
    "---",
    ""
  ].join("\n");
  return { title, canonical, sourceHash, markdown: `${frontmatter}${body}\n` };
}

function readPreviousManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : entry.isFile() ? [absolute] : [];
  });
}

function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (directory !== contentRoot && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function buildCatalog(entries) {
  const labels = {
    "blog-index": "博客入口",
    "blog-article": "博客文章",
    "trusted-choice-certification": "图灵可信与图灵优选认证",
    "trusted-choice-profile": "客户中间页",
    "trusted-choice-article": "客户公开文案",
    "trusted-choice-document": "公开资料",
    "sitemap-html": "站点地图"
  };
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.type)) groups.set(entry.type, []);
    groups.get(entry.type).push(entry);
  }
  const lines = [
    "# 言中 AI 公开内容目录",
    "",
    `共 ${entries.length} 个公开页面 Markdown 镜像。正式网页与最终版本以 [${origin}](${origin}/) 为准。`,
    ""
  ];
  for (const [type, items] of groups) {
    lines.push(`## ${labels[type] || type}`, "");
    for (const entry of items) lines.push(`- [${entry.title}](${entry.path}) · [正式网页](${entry.url})`);
    lines.push("");
  }
  fs.writeFileSync(path.join(root, "CATALOG.md"), `${lines.join("\n").trim()}\n`, "utf8");
}

async function main() {
  const sitemapXml = await fetchText(sitemapUrl);
  const selected = parseSitemap(sitemapXml).filter((entry) => isIncluded(entry.url));
  const previous = readPreviousManifest();
  const previousByUrl = new Map((previous.entries || []).map((entry) => [entry.url, entry]));
  const results = new Array(selected.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= selected.length) return;
      const entry = selected[index];
      const relativePath = targetFor(entry.url);
      const absolutePath = path.join(root, relativePath);
      const old = previousByUrl.get(entry.url);
      if (!force && old?.lastmod === entry.lastmod && old?.path === relativePath && fs.existsSync(absolutePath)) {
        results[index] = old;
        continue;
      }
      const html = await fetchText(entry.url);
      const rendered = renderPage(html, entry);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, rendered.markdown, "utf8");
      results[index] = {
        url: entry.url,
        path: relativePath,
        type: pageType(entry.url),
        title: rendered.title,
        lastmod: entry.lastmod,
        sourceHash: rendered.sourceHash
      };
      await sleep(120);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const expectedPaths = new Set(results.map((entry) => path.join(root, entry.path)));
  for (const file of walk(contentRoot)) {
    if (file.endsWith(".md") && !expectedPaths.has(file)) fs.unlinkSync(file);
  }
  removeEmptyDirectories(contentRoot);
  fs.mkdirSync(sitemapRoot, { recursive: true });
  fs.writeFileSync(path.join(sitemapRoot, "sitemap.xml"), sitemapXml, "utf8");
  buildCatalog(results);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      siteOrigin: origin,
      sourceCommit: sourceCommit || previous.sourceCommit || "",
      fileCount: results.length,
      entries: results
    }, null, 2)}\n`,
    "utf8"
  );
  console.log(`Synchronized ${results.length} public pages from ${sitemapUrl}`);
}

await main();
