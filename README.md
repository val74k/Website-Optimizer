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
  -i, --images                convert JPG/JPEG/PNG to WebP
  -c, --compression <number>  default WebP compression percentage
                              (default: "75")
  -s, --stats                 display file sizes and reduction stats
  -w, --watch                 recompile on every save; ignores --hash
  --hash                      add a deterministic fingerprint to JS/CSS filenames
  --sitemap <url>             create sitemap.xml and robots.txt for this base URL
  -h, --help                  display help for command

Examples:
  builder ./myproject
  builder ./backups/myproject -o ./dist -i --hash -s
  builder ./myproject --sitemap https://example.com/ --hash
  builder ./myproject --watch
```

---

## Features

- **Blazing-Fast Engines:** Powered by `esbuild` for JavaScript, `lightningcss` for CSS, and `html-minifier-terser` for markup.
- **Image Pipeline:** Automated JPEG/PNG conversion to WebP via `sharp` (default 75% compression quality, customizable via `-c`) with concurrency limits to prevent memory spikes.
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
