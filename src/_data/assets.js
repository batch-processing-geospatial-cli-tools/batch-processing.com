// Content-hash for cache-busting local CSS/JS references.
// Produces { v: <first 10 hex of sha1 over concatenated referenced asset files> }
// so that any change to a referenced CSS/JS file forces browsers to fetch fresh.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

// Project-root-relative paths to the CSS/JS files referenced by the base template.
// main.css @imports the other stylesheets, so all CSS sources are included to
// ensure a change in any of them bumps the version.
const ROOT = path.resolve(__dirname, "..", "..");
const FILES = [
  "src/css/tokens.css",
  "src/css/base.css",
  "src/css/typography.css",
  "src/css/layout.css",
  "src/css/header.css",
  "src/css/footer.css",
  "src/css/content.css",
  "src/css/home.css",
  "src/css/main.css",
  "src/js/nav.js",
  "src/js/copy-code.js",
  "src/js/checkbox.js",
  "src/js/accordion.js",
  "src/js/main.js",
];

let v = "dev";
try {
  const hash = crypto.createHash("sha1");
  for (const rel of FILES) {
    hash.update(fs.readFileSync(path.join(ROOT, rel)));
  }
  v = hash.digest("hex").slice(0, 10);
} catch (err) {
  v = "dev";
}

module.exports = { v };
