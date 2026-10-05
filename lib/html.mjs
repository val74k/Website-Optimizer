import { load } from 'cheerio';
import { minify } from 'html-minifier-terser';
import parseSrcset from 'parse-srcset';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileJS, compileCSS, rewriteImports, assertHashableJS } from './compilers.mjs';
import { documentURL, rewriteURL, mappedSource, RESPONSIVE_SIZES } from './urls.mjs';

function stringifySrcset(items) {
  return items.map(item => `${item.url}${item.w ? ` ${item.w}w` : ''}${item.h ? ` ${item.h}h` : ''}${item.d ? ` ${item.d}x` : ''}`).join(', ');
}

export async function compileHTML(code, file, config, mapping, defines, dimensions) {
  const $ = load(code);
  const baseHref = $('base[href]').first().attr('href');
  const base = baseHref ? new URL(baseHref, documentURL(file)) : documentURL(file);
  let imgCount = 0;
  const preloads = new Set();
  const htmlDir = path.posix.dirname(file);
  const isDocument = /<(html|head)[\s>]/i.test(code);

  if (config.seo !== false && isDocument) {
    const missing = [];
    if (!$('title').first().text().trim()) missing.push('<title>');
    if (!$('meta[name="description"]').first().attr('content')?.trim()) missing.push('meta description');
    if (!$('meta[property="og:image"]').first().attr('content')?.trim()) missing.push('og:image');
    if (missing.length) (config.warnOnce ?? config.warn)?.(`${file}: missing ${missing.join(', ')}`);
  }

  for (const element of $('*').toArray()) {
    const node = $(element);
    if (element.tagName === 'base') continue;
    const oldLink = node.attr('src') ?? node.attr('href');
    const localSource = oldLink ? mappedSource(oldLink, base, mapping) : undefined;
    if (element.tagName === 'link' && node.attr('rel') === 'stylesheet' && localSource && mapping.has(localSource)) {
      const outputPath = mapping.get(localSource);
      const cssPath = path.join(config.out, outputPath);
      let cssContent;
      try { cssContent = await readFile(cssPath, 'utf8'); } catch {}

      if (cssContent) {
        const cssDir = path.posix.dirname(outputPath);
        const fontMatches = cssContent.matchAll(/url\((['"]?)([^'"()]+?\.woff2)\1\)/g);
        for (const match of fontMatches) {
          let fontUrl = match[2];
          if (!fontUrl.startsWith('data:') && !fontUrl.startsWith('http')) {
            const absoluteFont = path.posix.join(cssDir, fontUrl);
            let relFont = path.posix.relative(htmlDir, absoluteFont);
            if (!relFont.startsWith('.') && !relFont.startsWith('/')) relFont = './' + relFont;
            preloads.add(relFont);
          } else if (fontUrl.startsWith('/')) {
            preloads.add(fontUrl);
          } else if (fontUrl.startsWith('http')) {
            preloads.add(fontUrl);
          }
        }
        if (config.inline && Buffer.byteLength(cssContent) <= 3072) {
          cssContent = cssContent.replace(/url\((['"]?)([^'"()]+?)\1\)/g, (match, quote, url) => {
            if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) return match;
            const absoluteOut = path.posix.join(cssDir, url);
            let newRel = path.posix.relative(htmlDir, absoluteOut);
            if (!newRel.startsWith('.') && !newRel.startsWith('/')) newRel = './' + newRel;
            return `url(${quote}${newRel}${quote})`;
          });
          node.replaceWith(`<style data-inlined="true">${cssContent}</style>`);
          continue;
        }
      }
    }

    if (element.tagName === 'script' && node.attr('src') && localSource && mapping.has(localSource)) {
      const outputPath = mapping.get(localSource);
      const jsPath = path.join(config.out, outputPath);
      let jsContent;
      try { jsContent = await readFile(jsPath, 'utf8'); } catch {}

      const scriptType = (node.attr('type') ?? '').toLowerCase().trim();
      const inlineSafe = scriptType !== 'module' && !node.attr('defer') && !node.attr('async');
      if (jsContent && inlineSafe && config.inline && Buffer.byteLength(jsContent) <= 3072) {
        const originalPath = path.join(config.source, localSource);
        let jsCode;
        try { jsCode = await readFile(originalPath, 'utf8'); } catch {}
        if (jsCode && !/<\/script/i.test(jsCode)) {
          node.removeAttr('src');
          node.text(jsCode);
        }
      }
    }

    for (const attribute of ['src', 'href', 'poster', 'xlink:href']) {
      const value = node.attr(attribute);
      if (value) node.attr(attribute, rewriteURL(value, file, mapping, base));
    }
    for (const attribute of ['srcset', 'imagesrcset']) {
      const value = node.attr(attribute);
      if (!value) continue;
      const candidates = parseSrcset(value);
      const converted = candidates.length > 0 && candidates.every(item => {
        const source = mappedSource(item.url, base, mapping);
        return source && mapping.get(source) !== source && (mapping.get(source).endsWith('.webp') || mapping.get(source).endsWith('.avif'));
      });
      for (const item of candidates) item.url = rewriteURL(item.url, file, mapping, base);
      node.attr(attribute, stringifySrcset(candidates));
      if (converted && node.attr('type')?.startsWith('image/')) node.attr('type', config.avif ? 'image/avif' : 'image/webp');
    }
    if (localSource && (mapping.get(localSource).endsWith('.webp') || mapping.get(localSource).endsWith('.avif')) && node.attr('type')?.startsWith('image/')) {
      node.attr('type', config.avif ? 'image/avif' : 'image/webp');
    }

    if (element.tagName === 'img') {
      if (localSource && dimensions && dimensions.has(localSource)) {
        const dims = dimensions.get(localSource);
        if (!node.attr('width')) node.attr('width', String(dims.width));
        if (!node.attr('height')) node.attr('height', String(dims.height));
      }

      if (config.lazy) {
        imgCount++;
        if (!node.attr('decoding')) node.attr('decoding', 'async');
        if (imgCount > 1 && !node.attr('loading')) {
          node.attr('loading', 'lazy');
        }
      }
    }

    if (config.responsive && element.tagName === 'img' && localSource && mapping.has(localSource)) {
      const originalPath = localSource;
      const srcsetParts = [];
      for (const w of RESPONSIVE_SIZES) {
        if (mapping.has(`${originalPath}-${w}w`)) {
          srcsetParts.push(`${rewriteURL(`${originalPath}-${w}w`, file, mapping, base)} ${w}w`);
        }
      }
      const fullWidth = dimensions?.get(originalPath)?.width;
      if (srcsetParts.length > 0 && fullWidth && !node.attr('srcset')) {
        srcsetParts.push(`${rewriteURL(originalPath, file, mapping, base)} ${fullWidth}w`);
        node.attr('srcset', srcsetParts.join(', '));
        if (!node.attr('sizes')) node.attr('sizes', '100vw');
      }
    }

    if (localSource && node.attr('integrity')) {
      const bytes = await readFile(path.join(config.out, mapping.get(localSource)));
      const algorithms = node.attr('integrity').trim().split(/\s+/).map(token => token.split('-')[0]);
      if (algorithms.some(algorithm => !['sha256', 'sha384', 'sha512'].includes(algorithm))) {
        throw new Error(`Unsupported SRI algorithm in ${file}`);
      }
      node.attr('integrity', algorithms.map(algorithm => `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`).join(' '));
    }
    if (node.attr('style')) node.attr('style', compileCSS(node.attr('style'), file, mapping, base, true));
  }
  for (const element of $('style').toArray()) {
    const node = $(element);
    if (node.attr('type') && node.attr('type') !== 'text/css') continue;
    if (node.attr('data-inlined')) {
      node.removeAttr('data-inlined');
      continue;
    }
    const compiled = compileCSS(node.text(), file, mapping, base);
    node.text(compiled);
    const fontMatches = compiled.matchAll(/url\((['"]?)([^'"()]+?\.woff2)\1\)/g);
    for (const match of fontMatches) {
      let fontUrl = match[2];
      if (!fontUrl.startsWith('data:') && !fontUrl.startsWith('http')) {
        preloads.add(fontUrl);
      }
    }
  }
  for (const element of $('script:not([src])').toArray()) {
    const node = $(element);
    const type = (node.attr('type') ?? '').toLowerCase().trim();
    if (type === 'importmap') {
      const map = JSON.parse(node.text());
      const rewriteEntries = entries => {
        for (const [key, value] of Object.entries(entries ?? {})) {
          if (typeof value === 'string') entries[key] = rewriteURL(value, file, mapping, base, { module: true });
        }
      };
      rewriteEntries(map.imports);
      for (const scope of Object.values(map.scopes ?? {})) rewriteEntries(scope);
      node.text(JSON.stringify(map).replaceAll('<', '\\u003c'));
    } else if (['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) {
      const js = await compileJS(node.text(), file, defines);
      if (config.hash) await assertHashableJS(js, file);
      node.text(await rewriteImports(js, file, mapping, base));
    }
  }

  const head = $('head');
  if (config.faviconLinks?.length && head.length && isDocument && !baseHref) {
    const has = {
      icon: $('link[rel~="icon"]').length > 0,
      'apple-touch-icon': $('link[rel="apple-touch-icon"]').length > 0,
      manifest: $('link[rel="manifest"]').length > 0,
      'theme-color': $('meta[name="theme-color"]').length > 0,
    };
    for (const item of config.faviconLinks) {
      if (has[item.rel ?? item.name]) continue;
      const attrs = Object.entries(item).filter(([key]) => key !== 'tag')
        .map(([key, value]) => `${key}="${key === 'href' ? path.posix.relative(htmlDir, value) : value}"`).join(' ');
      head.append(`\n  <${item.tag} ${attrs}>`);
    }
  }
  if (head.length > 0 && preloads.size > 0) {
    for (const font of preloads) {
      head.append(`\n  <link rel="preload" href="${font}" as="font" type="font/woff2" crossorigin>`);
    }
  }

  return minify($.html(), {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    minifyJS: true,
    minifyCSS: true,
    removeAttributeQuotes: false,
    removeOptionalTags: false,
    removeEmptyAttributes: false,
    caseSensitive: true,
  });
}
