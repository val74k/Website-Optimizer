import { load } from 'cheerio';
import { minify } from 'html-minifier-terser';
import parseSrcset from 'parse-srcset';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileJS, compileCSS, rewriteImports, assertHashableJS } from './compilers.mjs';
import { documentURL, rewriteURL, mappedSource } from './urls.mjs';

function stringifySrcset(items) {
  return items.map(item => `${item.url}${item.w ? ` ${item.w}w` : ''}${item.h ? ` ${item.h}h` : ''}${item.d ? ` ${item.d}x` : ''}`).join(', ');
}

export async function compileHTML(code, file, config, mapping, defines) {
  const $ = load(code);
  const baseHref = $('base[href]').first().attr('href');
  const base = baseHref ? new URL(baseHref, documentURL(file)) : documentURL(file);
  for (const element of $('*').toArray()) {
    const node = $(element);
    if (element.tagName === 'base') continue;
    const oldLink = node.attr('src') ?? node.attr('href');
    const localSource = oldLink ? mappedSource(oldLink, base, mapping) : undefined;
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
        return source && mapping.get(source) !== source && mapping.get(source).endsWith('.webp');
      });
      for (const item of candidates) item.url = rewriteURL(item.url, file, mapping, base);
      node.attr(attribute, stringifySrcset(candidates));
      if (converted && node.attr('type')?.startsWith('image/')) node.attr('type', 'image/webp');
    }
    if (localSource && mapping.get(localSource).endsWith('.webp') && node.attr('type')?.startsWith('image/')) {
      node.attr('type', 'image/webp');
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
    node.text(compileCSS(node.text(), file, mapping, base));
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
