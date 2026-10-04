import path from 'node:path';

export const origin = 'https://website-optimizer.invalid';
export const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
export const documentURL = file => new URL(encodePath(file), `${origin}/`);


export function rewriteURL(value, from, mapping, base = documentURL(from), { module = false } = {}) {
  if (!value || value.startsWith('#') || value.startsWith('?') || value.startsWith('//')) return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  if (module && !value.startsWith('.') && !value.startsWith('/')) return value;
  let url;
  try { url = new URL(value, base); } catch { return value; }
  if (url.origin !== origin) return value;
  let source;
  try { source = decodeURIComponent(url.pathname.slice(1)); } catch { return value; }
  const output = mapping.get(source);
  if (!output || output === source) return value;
  const suffix = url.search + url.hash;
  if (value.startsWith('/')) return `/${encodePath(output)}${suffix}`;
  let directory;
  try { directory = decodeURIComponent(new URL('.', base).pathname.slice(1)); }
  catch { return value; }
  let relative = path.posix.relative(directory, output);
  if (!relative.startsWith('.') && (module || value.startsWith('./'))) relative = `./${relative}`;
  return encodePath(relative) + suffix;
}

export function mappedSource(value, base, mapping) {
  try {
    const url = new URL(value, base);
    if (url.origin !== origin) return undefined;
    const source = decodeURIComponent(url.pathname.slice(1));
    return mapping.has(source) ? source : undefined;
  } catch { return undefined; }
}
