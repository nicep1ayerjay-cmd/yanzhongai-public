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
const force = process.argv.includes("--force");
const concurrency = Math.max(1, Math.min(4, Number(process.env.SYNC_CONCURRENCY || 3)));
const maxPageCount = 10_000;
const maxSitemapBytes = 5 * 1024 * 1024;
const maxPageBytes = 2 * 1024 * 1024;

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

async function fetchText(url, options = {}) {
  const {
    attempts = 3,
    maxBytes = maxPageBytes,
    acceptedTypes = [],
    validateFinalUrl = () => true
  } = options;
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
      const finalUrl = new URL(response.url);
      if (!validateFinalUrl(finalUrl)) throw new Error(`拒绝重定向后的地址：${finalUrl.href}`);
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (acceptedTypes.length && !acceptedTypes.some((type) => contentType.includes(type))) {
        throw new Error(`拒绝响应类型：${contentType || "missing"}`);
      }
      const declaredBytes = Number(response.headers.get("content-length") || 0);
      if (declaredBytes > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节`);
      return text;
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
  if (url.origin !== origin || url.search || url.hash) return false;
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

function publicSitemap(entries) {
  const escapeXml = (value = "") => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  const urls = entries.map((entry) => {
    const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : "";
    return `  <url>\n    <loc>${escapeXml(entry.url)}</loc>${lastmod}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
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
  const canonicalCandidate = new URL($('link[rel="canonical"]').attr("href") || entry.url, origin).href;
  const canonical = isIncluded(canonicalCandidate) ? canonicalCandidate : entry.url;
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

  const compactTitle = (title = "") => {
    const characters = Array.from(String(title));
    return characters.length > 12 ? `${characters.slice(0, 12).join("")}…` : characters.join("");
  };

  const readmeLines = [
    "# 言中 AI 公开内容镜像",
    "",
    `本仓库自动同步 [言中 AI](${origin}/) 已正式发布的博客、图灵可信与图灵优选客户档案、公开文案页和站点地图。`,
    "",
    `当前共 ${entries.length} 个公开页面 Markdown 镜像；下方直接列出全部 GitHub 文案入口，便于公开查阅、核验、引用和搜索引擎发现。每篇的正式网页链接可在文案内或 [独立目录页](CATALOG.md) 查看。`,
    "",
    `- 正式网页与最终版本以 [${origin}](${origin}/) 为准`,
    "- 镜像范围仅限原站 sitemap 白名单内已经公开发布的正文，不包含原站私有数据、工程文件或访问凭证",
    "- 新增、修改或下架的公开正文会由受限同步流程更新",
    "- 使用与转载边界详见 [内容声明](CONTENT-NOTICE.md)；另有 [独立目录页](CATALOG.md)",
    "",
    "## 全部公开链接",
    ""
  ];
  for (const [type, items] of groups) {
    readmeLines.push(`### ${labels[type] || type}`, "");
    for (const entry of items) readmeLines.push(`- [${compactTitle(entry.title)}](${entry.path})`);
    readmeLines.push("");
  }
  fs.writeFileSync(path.join(root, "README.md"), `${readmeLines.join("\n").trim()}\n`, "utf8");
}

async function main() {
  const sitemapXml = await fetchText(sitemapUrl, {
    maxBytes: maxSitemapBytes,
    acceptedTypes: ["application/xml", "text/xml"],
    validateFinalUrl: (url) => url.origin === origin && url.pathname === "/sitemap.xml" && !url.search && !url.hash
  });
  const selected = [...new Map(
    parseSitemap(sitemapXml)
      .filter((entry) => isIncluded(entry.url))
      .map((entry) => [entry.url, entry])
  ).values()];
  if (selected.length > maxPageCount) throw new Error(`公开页面数量 ${selected.length} 超过安全上限 ${maxPageCount}`);
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
      const html = await fetchText(entry.url, {
        acceptedTypes: ["text/html", "application/xhtml+xml"],
        validateFinalUrl: (url) => isIncluded(url.href)
      });
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
  fs.writeFileSync(path.join(sitemapRoot, "sitemap.xml"), publicSitemap(selected), "utf8");
  buildCatalog(results);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      siteOrigin: origin,
      fileCount: results.length,
      entries: results
    }, null, 2)}\n`,
    "utf8"
  );
  console.log(`Synchronized ${results.length} public pages from ${sitemapUrl}`);
}

await main();
