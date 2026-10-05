import path from 'node:path';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { atomicWrite, inside } from './utils.mjs';
import { noSymlink } from './safety.mjs';

const ICO_SIZES = [16, 32, 48];

function buildIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header.writeUInt8(size, at);
    header.writeUInt8(size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(entry => entry.png)]);
}

export async function generateFavicons(config, sourceFiles) {
  const sourcePath = path.resolve(config.source, config.favicon);
  if (!inside(config.source, sourcePath)) throw new Error('--favicon must point to a file inside the source folder.');
  await noSymlink(sourcePath);

  let input;
  try { input = await readFile(sourcePath); }
  catch (error) { throw new Error(`Cannot read favicon source ${config.favicon}: ${error.message}`); }

  const meta = await sharp(input).metadata();
  const vector = meta.format === 'svg';
  if (!vector && Math.max(meta.width ?? 0, meta.height ?? 0) < 512) {
    config.warn?.(`Favicon source ${config.favicon} is ${meta.width}x${meta.height}; 512x512 or larger (or an SVG) is recommended.`);
  }

  const render = size => sharp(input, vector ? { density: 384 } : {})
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const existing = new Set(sourceFiles.map(file => file.toLowerCase()));
  const written = [];
  const emit = async (name, contents) => {
    if (existing.has(name.toLowerCase())) return false;
    const destination = path.join(config.out, name);
    await noSymlink(destination);
    await atomicWrite(destination, contents);
    written.push(name);
    return true;
  };

  const links = [];
  const icoEntries = [];
  for (const size of ICO_SIZES) icoEntries.push({ size, png: await render(size) });
  if (await emit('favicon.ico', buildIco(icoEntries))) links.push({ tag: 'link', rel: 'icon', href: 'favicon.ico', sizes: '48x48' });
  if (await emit('favicon-32x32.png', await render(32))) links.push({ tag: 'link', rel: 'icon', type: 'image/png', sizes: '32x32', href: 'favicon-32x32.png' });
  if (await emit('apple-touch-icon.png', await render(180))) links.push({ tag: 'link', rel: 'apple-touch-icon', href: 'apple-touch-icon.png' });
  const has192 = await emit('icon-192.png', await render(192));
  const has512 = await emit('icon-512.png', await render(512));

  let themeColor = config.themeColor;
  if (!themeColor) {
    try {
      const { dominant } = await sharp(input).stats();
      if (dominant) {
        const hex = (v) => v.toString(16).padStart(2, '0');
        themeColor = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
      }
    } catch {}
  }

  const icons = [];
  if (has192 || existing.has('icon-192.png')) icons.push({ src: 'icon-192.png', sizes: '192x192', type: 'image/png' });
  if (has512 || existing.has('icon-512.png')) icons.push({ src: 'icon-512.png', sizes: '512x512', type: 'image/png' });
  const name = config.name || path.basename(config.source);
  const manifest = {
    name, short_name: name.slice(0, 12), start_url: '.', display: 'standalone', icons,
    ...(themeColor && { theme_color: themeColor, background_color: themeColor }),
  };
  if (await emit('site.webmanifest', JSON.stringify(manifest, null, 2) + '\n')) {
    links.push({ tag: 'link', rel: 'manifest', href: 'site.webmanifest' });
  }
  if (themeColor) links.push({ tag: 'meta', name: 'theme-color', content: themeColor });

  return { links, written };
}
