# Website-Optimizer

> High-performance static site optimizer and asset pipeline tailored for handcrafted Vanilla HTML, CSS, and JavaScript architectures.

`website-optimizer` bridges the gap between clean local development and uncompromising production delivery. It automates minification, asset hashing, WebP conversion, DOM rewriting, and SEO artifact generation without requiring heavy bundling frameworks.

---

## Command Line Help

To see all available options and commands, you can run the help command:

```bash
builder --help
```

**Output:**

```text
Usage: builder [options] <target>

Compile and optimize an HTML/CSS/Vanilla JS folder for production.

Arguments:
  target                      mandatory source folder

Options:
  -V, --version               output the version number
  -o, --out <path>            destination named dist or ending with _dist
  -i, --images                convert JPG/JPEG/PNG to WebP (and optimize SVG with svgo)
  -c, --compression <number>  default WebP/AVIF compression percentage
                              (default: "75")
  -s, --stats                 display file sizes and reduction stats
  -l, --lazy                  automatically inject loading="lazy" and decoding="async"
  --inline                    inline small CSS and JS assets (< 3KB) into HTML head
  -w, --watch                 recompile on every save; ignores --hash
  --responsive                generate 600w, 1000w, 1600w image variants and inject srcset
  --purge                     remove unused CSS via PurgeCSS
  --avif                      generate AVIF instead of WebP
  -O, --optimize              enable all recommended optimizations (avif, lazy, inline, responsive, purge, hash)
  -k, --keep                  do not empty the destination folder before building
  --exclude <paths>           comma-separated list of directories to ignore
  --hash                      add a deterministic fingerprint to JS/CSS filenames
  --sitemap <url>             create sitemap.xml and robots.txt for this base URL
  --favicon <image>           generate favicons + site.webmanifest from this image
  --name <text>               site name used in the generated web manifest
  --theme-color <color>       override theme color (auto-detected from favicon otherwise)
  --no-seo                    disable missing <title>/description/og:image warnings
  --no-cache                  do not reuse the image cache (.optimizer-cache)
  --config <path>             config file to use (default: ./.optimizerrc.json)
  -h, --help                  display help for command

Examples:
  builder ./myproject
  builder ./myproject -o ./dist -s -O
  builder ./myproject --sitemap https://example.com/ -O
  builder ./myproject --exclude vendor,temp
```

---

## Features

- **Blazing-Fast Engines:** Powered by `esbuild` for JavaScript, `lightningcss` for CSS, and `html-minifier-terser` for markup.
- **Image Pipeline:** Automated JPEG/PNG conversion to WebP or AVIF (`--avif`) via `sharp` (default 75% compression quality). Automatically optimizes SVGs (`svgo`) when `-i` is used.
- **Responsive Images:** (`--responsive`) Automatically generates `600w`, `1000w`, and `1600w` variants and injects `srcset` attributes directly into your HTML `<img>` tags.
- **Automatic Image Attributes:** Automatically injects actual `width` and `height` dimensions on HTML `<img>` tags to prevent layout shifts.
- **Automatic Lazy Loading:** (`--lazy`) Injects `loading="lazy"` and `decoding="async"` into your HTML `<img>` tags (excluding the first image of the page to preserve LCP).
- **Inline Small Assets:** (`--inline`) Automatically injects small CSS and JS files (< 3KB) directly into the HTML to remove render-blocking network requests.
- **Smart Font Preloading:** Automatically detects used `.woff2` font files in your CSS and injects `<link rel="preload">` into your `<head>` to prevent FOIT/FOUT.
- **CSS Purging:** (`--purge`) Integrates *PurgeCSS* to analyze your HTML and strip out any unused CSS classes, drastically reducing stylesheet size.
- **Safe DOM & Asset Rewriting:** Robust HTML parsing (via DOM manipulation, no fragile Regex) to update references when hashing or converting images.
- **Cache Busting:** Optional deterministic content hashing (`--hash`) for rock-solid browser caching.
- **SEO Automation:** Recursive discovery to generate both `sitemap.xml` and `robots.txt` dynamically (`--sitemap`).
- **Flexible Exclusions:** Ignore specific directories via `--exclude folder1,folder2` or by dropping a `.optimizerignore` file (works just like `.gitignore`) in your source root.
- **Developer Experience:** Native ANSI terminal colors, real-time compression reports (`--stats`), and an incremental rebuild watcher (`--watch`).
- **Favicons & Manifest:** (`--favicon icon.png`) Generates `favicon.ico` (16/32/48), `favicon-32x32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` and `site.webmanifest` from a single image (PNG ≥ 512×512 or SVG recommended). The theme and background colors are **automatically extracted** from the image's dominant color (or can be overridden with `--theme-color`). Matches and injects `<link>` and `<meta name="theme-color">` tags into every HTML page. Existing tags and files in your source are never overwritten.
- **SEO Warnings:** Each HTML page is checked for a missing `<title>`, meta description and `og:image`; warnings are printed during the build (`--no-seo` to silence).
- **Build Cache:** Encoded images are stored by content hash in `.optimizer-cache/` (in the directory where you run the command). Repeated full builds — even after the output folder is wiped — reuse them instead of re-encoding. The cache key includes the image bytes, format, quality and size, so changing any of them re-encodes automatically. Use `--no-cache` to bypass it, or delete the folder to reset it.

---

## Configuration File

To avoid retyping options, create a `.optimizerrc.json` in the directory where you run `builder` (or pass `--config <path>`). Command-line flags always take priority over the file.

```json
{
  "out": "./dist",
  "optimize": true,
  "compression": 80,
  "stats": true,
  "exclude": ["vendor", "temp"],
  "sitemap": "https://example.com/",
  "favicon": "assets/logo.png",
  "name": "My Site",
  "themeColor": "#0b1020"
}
```

Supported keys: `out`, `images`, `compression`, `stats`, `lazy`, `inline`, `exclude`, `responsive`, `purge`, `avif`, `hash`, `optimize`, `keep`, `sitemap`, `favicon`, `name`, `themeColor`, `seo`, `cache`. Unknown keys produce a warning; wrongly typed values abort the build. Relative paths (`out`) are resolved from the current directory, `favicon` from the source folder. `.optimizerrc.json` and `.optimizer-cache/` are never copied to the output.

---

## What `-O` Enables

`-O` / `--optimize` is a shortcut for:

| Flag | Effect |
| --- | --- |
| `--images` | Convert JPG/PNG to a modern format, optimize SVG |
| `--avif` | Use AVIF instead of WebP |
| `--lazy` | `loading="lazy"` + `decoding="async"` (except the first image) |
| `--inline` | Inline CSS/JS smaller than 3 KB |
| `--responsive` | Generate 600w/1000w/1600w variants and inject `srcset` |
| `--purge` | Remove unused CSS |
| `--hash` | Fingerprint JS/CSS filenames (disabled with `--watch`) |

It does **not** enable `--sitemap`, `--favicon`, `--keep` or `--exclude`.

---

## Known Limitations

- **PurgeCSS and dynamic classes:** the optimizer scans your HTML and JS sources for class names. Classes written literally (`classList.add('open')`) are kept, but classes built at runtime (`'btn-' + type`, template strings, classes loaded from JSON) cannot be detected and will be removed. Prefix such classes with `js-`, `is-` or `has-` (always preserved), or avoid `--purge` for that project.
- **Inlining:** scripts with `type="module"`, `defer` or `async` are never inlined, because inlining would change their execution order or break relative imports.
- **Hashing:** `--hash` cannot resolve `import(expression)`; use literal paths for dynamic imports.
- **Responsive images:** `srcset` is only injected on `<img>` tags without an existing `srcset`; `sizes` defaults to `100vw` — set your own `sizes` attribute for narrower layouts.
- **Favicons:** pages with a `<base href>` are skipped for link injection. The generated `.ico` embeds PNG images (supported by all modern browsers).
- **Cache scope:** only image encoding is cached; JS, CSS and HTML are always rebuilt (they are fast). The cache is not pruned automatically.

---

## Installation

Clone the repository and link it globally on your machine:

```bash
git clone https://github.com/val74k/Website-Optimizer.git
cd Website-Optimizer
npm install
npm link
```

---

## Usage

Once installed globally, you can use the `builder` command:

```bash
# Basic usage
builder ./src -o ./dist

# Convert images to WebP with custom 80% compression, add hashes and stats
builder ./src -o ./dist -i -c 80 --hash -s

# Watch mode for development
builder ./src --watch
```
