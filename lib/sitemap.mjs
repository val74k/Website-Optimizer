import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, posix } from './utils.mjs';
import { encodePath } from './urls.mjs';

export function sitemapBase(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('--sitemap requires an HTTP(S) URL without credentials, parameters, or fragments.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export async function writeSitemap(config) {
  const base = sitemapBase(config.sitemap);
  const pages = [];
  async function scan(directory) {
    await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) pages.push(posix(path.relative(config.out, file)));
    }));
  }
  await scan(config.out);
  const urls = pages.sort().map(file => {

    const route = file.endsWith('index.html') && path.posix.basename(file) === 'index.html' ? file.slice(0, -10) : file;
    return new URL(encodePath(route), base).href;
  });
  if (urls.length > 50000) throw new Error('Over 50,000 pages: a sitemap index is required.');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...new Set(urls)].map(url => `  <url><loc>${xml(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
  if (Buffer.byteLength(sitemap) > 50 * 1024 * 1024) throw new Error('Sitemap exceeds 50MB: a sitemap index is required.');
  await atomicWrite(path.join(config.out, 'sitemap.xml'), sitemap);
  await atomicWrite(path.join(config.out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${new URL('sitemap.xml', base).href}\n`);
}
