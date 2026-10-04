# Website-Optimizer

> High-performance static site optimizer and asset pipeline tailored for handcrafted Vanilla HTML, CSS, and JavaScript architectures.

`website-optimizer` bridges the gap between clean local development and uncompromising production delivery. It automates minification, asset hashing, WebP conversion, DOM rewriting, and SEO artifact generation without requiring heavy bundling frameworks.

---

## Features

- **Blazing-Fast Engines:** Powered by `esbuild` for JavaScript, `lightningcss` for CSS, and `html-minifier-terser` for markup.
- **Image Pipeline:** Automated JPEG/PNG conversion to WebP via `sharp` with concurrency limits to prevent memory spikes.
- **Safe DOM & Asset Rewriting:** Robust HTML parsing (via DOM manipulation, no fragile Regex) to update references when hashing or converting images.
- **Cache Busting:** Optional deterministic content hashing (`--hash`) for rock-solid browser caching.
- **SEO Automation:** Recursive discovery to generate both `sitemap.xml` and `robots.txt` dynamically (`--sitemap`).
- **Developer Experience:** Native ANSI terminal colors, real-time compression reports (`--stats`), and an incremental rebuild watcher (`--watch`).

---

## Installation

Clone the repository and link it globally on your machine:

```bash
git clone https://github.com/val74k/Website-Optimizer.git
cd Website-Optimizer
npm install
npm link
