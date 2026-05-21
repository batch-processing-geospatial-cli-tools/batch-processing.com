const fs = require("fs");

module.exports = {
  eleventyComputed: {
    // Strip /content prefix so URLs become /{section}/{subsection}/{article}/
    permalink: (data) => {
      const stem = data.page.filePathStem; // e.g. /content/cli-arch.../index
      const withoutContent = stem.replace(/^\/content/, "");
      const withoutIndex = withoutContent.replace(/\/index$/, "");
      return withoutIndex + "/index.html";
    },

    // Assign layout based on path depth
    layout: (data) => {
      const stem = data.page.filePathStem;
      const inner = stem
        .replace(/^\/content\//, "")
        .replace(/\/index$/, "");
      const depth = inner.split("/").filter(Boolean).length;
      if (depth === 1) return "layouts/section";
      if (depth === 2) return "layouts/subsection";
      return "layouts/article";
    },

    // Extract the # H1 from the markdown file as the page title
    title: (data) => {
      try {
        const raw = fs.readFileSync(data.page.inputPath, "utf8");
        const match = raw.match(/^#\s+(.+)$/m);
        return match ? match[1].trim() : undefined;
      } catch {
        return undefined;
      }
    },

    // Auto-generate a meta description from the first paragraph after the H1.
    // Strips markdown formatting and truncates to ≤ 160 characters.
    description: (data) => {
      if (data.description) return data.description; // honour explicit frontmatter
      try {
        const raw = fs.readFileSync(data.page.inputPath, "utf8");
        const lines = raw.split("\n");
        let afterH1 = false;
        let paragraphLines = [];
        let collecting = false;

        for (const line of lines) {
          if (!afterH1) {
            if (line.startsWith("#")) afterH1 = true;
            continue;
          }
          if (line.trim() === "") {
            if (collecting) break; // first paragraph ends at blank line
            continue;
          }
          if (line.startsWith("#")) break; // hit the next heading
          collecting = true;
          paragraphLines.push(line.trim());
        }

        const text = paragraphLines
          .join(" ")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // strip links
          .replace(/\*\*([^*]+)\*\*/g, "$1")        // strip bold
          .replace(/\*([^*]+)\*/g, "$1")             // strip italic
          .replace(/`([^`]+)`/g, "$1")               // strip inline code
          .replace(/\s+/g, " ")
          .trim();

        return text.length > 160 ? text.slice(0, 157) + "..." : text;
      } catch {
        return undefined;
      }
    },

    // Compute pageType for JSON-LD / Open Graph selection in base.njk.
    // This is computed here (page-data level) so it flows through the full
    // layout chain — layout frontmatter values don't propagate upward in 11ty.
    pageType: (data) => {
      const stem = data.page.filePathStem;
      const inner = stem
        .replace(/^\/content\//, "")
        .replace(/\/index$/, "");
      const depth = inner.split("/").filter(Boolean).length;
      if (depth === 1) return "section";
      if (depth === 2) return "subsection";
      return "article";
    },
  },
};
