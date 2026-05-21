const syntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const markdownIt = require("markdown-it");
const markdownItAnchor = require("markdown-it-anchor");
const markdownItCheckbox = require("markdown-it-checkbox");
const path = require("path");

module.exports = function (eleventyConfig) {
  // ── Plugins ──────────────────────────────────────────────────────────────
  eleventyConfig.addPlugin(syntaxHighlight);

  // ── Ignore non-content markdown docs ─────────────────────────────────────
  eleventyConfig.ignores.add("README.md");
  eleventyConfig.ignores.add("AGENTS.md");
  eleventyConfig.ignores.add("BUILD_CHECKLIST.md");
  eleventyConfig.ignores.add("site_description_and_requirements.md");
  eleventyConfig.ignores.add("node_modules/**");
  eleventyConfig.ignores.add("_site/**");
  eleventyConfig.ignores.add("src/css/**");
  eleventyConfig.ignores.add("src/js/**");
  eleventyConfig.ignores.add("src/icons/**");
  eleventyConfig.ignores.add("src/_data/**");
  eleventyConfig.ignores.add("src/scripts/**");

  // ── Passthrough copies ────────────────────────────────────────────────────
  eleventyConfig.addPassthroughCopy({ "src/css": "css" });
  eleventyConfig.addPassthroughCopy({ "src/js": "js" });
  eleventyConfig.addPassthroughCopy({ "src/icons": "icons" });
  eleventyConfig.addPassthroughCopy({ "src/manifest.json": "manifest.json" });
  eleventyConfig.addPassthroughCopy({ "src/service-worker.js": "service-worker.js" });
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });
  eleventyConfig.addPassthroughCopy({ "src/favicon.ico": "favicon.ico" });
  eleventyConfig.addPassthroughCopy({ "src/favicon.svg": "favicon.svg" });

  // ── Markdown-it configuration ─────────────────────────────────────────────
  const md = markdownIt({
    html: true,
    linkify: true,
    typographer: true,
  })
    .use(markdownItAnchor, {
      permalink: markdownItAnchor.permalink.headerLink(),
      level: [2, 3, 4],
      slugify: (s) =>
        s
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-"),
    })
    .use(markdownItCheckbox, {
      divWrap: false,
      divClass: "checkbox-item",
      idPrefix: "cb-",
    });

  // Custom fence renderer — wrap code blocks and convert ```mermaid
  const defaultFence = md.renderer.rules.fence || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const lang = token.info.trim();
    if (lang === "mermaid") {
      return `<div class="mermaid">${md.utils.escapeHtml(token.content)}</div>\n`;
    }
    const rendered = defaultFence(tokens, idx, options, env, self);
    // Wrap in a div for the copy button
    const langClass = lang ? ` data-lang="${lang}"` : "";
    return `<div class="code-block-wrapper"${langClass}>${rendered}</div>`;
  };

  // Wrap tables for horizontal scroll
  md.renderer.rules.table_open = function () {
    return '<div class="table-scroll"><table>';
  };
  md.renderer.rules.table_close = function () {
    return "</table></div>";
  };

  eleventyConfig.setLibrary("md", md);

  // ── Collections ───────────────────────────────────────────────────────────
  eleventyConfig.addCollection("sections", (api) =>
    api.getFilteredByGlob("content/*/index.md")
      .sort((a, b) => a.fileSlug.localeCompare(b.fileSlug))
  );
  eleventyConfig.addCollection("subsections", (api) =>
    api.getFilteredByGlob("content/*/*/index.md")
      .sort((a, b) => a.fileSlug.localeCompare(b.fileSlug))
  );
  eleventyConfig.addCollection("articles", (api) =>
    api.getFilteredByGlob("content/*/*/*/index.md")
      .sort((a, b) => a.fileSlug.localeCompare(b.fileSlug))
  );

  // ── Filters ───────────────────────────────────────────────────────────────
  // Return subsections belonging to a given section URL prefix
  eleventyConfig.addFilter("subsectionsFor", function (subsections, sectionUrl) {
    return subsections.filter((s) => {
      const parts = s.url.replace(/^\/|\/$/g, "").split("/");
      return parts.length === 2 && s.url.startsWith(sectionUrl);
    });
  });

  // Return articles belonging to a given subsection URL prefix
  eleventyConfig.addFilter("articlesFor", function (articles, subsectionUrl) {
    return articles.filter((a) => a.url.startsWith(subsectionUrl) && a.url !== subsectionUrl);
  });

  // Remove the first H1 from rendered HTML (used in layouts that render title separately)
  eleventyConfig.addFilter("removeH1", function (htmlContent) {
    return htmlContent.replace(/^[\s]*<h1\b[^>]*>.*?<\/h1>/is, "").trimStart();
  });

  // Derive parent URL by stripping the last path segment
  eleventyConfig.addFilter("parentUrl", function (url) {
    const parts = url.replace(/\/$/, "").split("/");
    parts.pop();
    return parts.join("/") + "/";
  });

  // Depth of a URL path (number of real segments, e.g. "/" = 0, "/a/" = 1, "/a/b/" = 2)
  eleventyConfig.addFilter("urlDepth", (url) =>
    url.replace(/^\/|\/$/g, "").split("/").filter(Boolean).length
  );

  // Safe JSON serialisation for use inside <script type="application/ld+json">
  // Escapes <, >, & so the JSON string is safe inside an HTML document.
  eleventyConfig.addFilter("json", (val) =>
    JSON.stringify(val)
      .replace(/&/g, "\\u0026")
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
  );

  // Slugify a title for use in IDs
  eleventyConfig.addFilter("slugify", (str) =>
    str
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
  );
  eleventyConfig.addFilter("slugify", (str) =>
    str
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
  );

  // Extract breadcrumb segments from a URL
  eleventyConfig.addFilter("breadcrumbs", function (url) {
    const parts = url.replace(/^\/|\/$/g, "").split("/").filter(Boolean);
    const crumbs = [{ label: "Home", url: "/" }];
    let built = "";
    for (const part of parts) {
      built += "/" + part;
      // Convert slug to title
      const label = part
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      crumbs.push({ label, url: built + "/" });
    }
    return crumbs;
  });

  // Return sitemap-ready page list
  eleventyConfig.addCollection("sitemap", (api) =>
    api.getAll().filter((p) => p.url && !p.url.includes("404") && !p.url.includes("/offline/"))
  );

  // ── Shortcodes ────────────────────────────────────────────────────────────
  eleventyConfig.addShortcode("year", () => String(new Date().getFullYear()));

  eleventyConfig.addFilter("htmlDateString", (date) => {
    if (!date) return "";
    return new Date(date).toISOString().split("T")[0];
  });

  // ── Directory config ──────────────────────────────────────────────────────
  return {
    dir: {
      input: ".",
      output: "_site",
      includes: "src/_includes",
      data: "src/_data",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "html"],
  };
};

