import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const RC_NAME = '.optimizerrc.json';

const SCHEMA = {
  out: 'string',
  images: 'boolean',
  compression: 'number',
  stats: 'boolean',
  lazy: 'boolean',
  inline: 'boolean',
  exclude: 'array',
  responsive: 'boolean',
  purge: 'boolean',
  avif: 'boolean',
  hash: 'boolean',
  optimize: 'boolean',
  keep: 'boolean',
  sitemap: 'string',
  favicon: 'string',
  name: 'string',
  themeColor: 'string',
  seo: 'boolean',
  cache: 'boolean',
};

export async function loadRc(explicit, cwd = process.cwd()) {
  const file = path.resolve(cwd, explicit ?? RC_NAME);
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && !explicit) return { file, values: {} };
    throw new Error(`Cannot read config file ${file}: ${error.message}`);
  }
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Invalid JSON in ${file}: ${error.message}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} must contain a JSON object.`);
  }

  const values = {};
  const warnings = [];
  for (const [key, value] of Object.entries(data)) {
    const type = SCHEMA[key];
    if (!type) { warnings.push(`Unknown key "${key}" in ${path.basename(file)} (ignored).`); continue; }
    if (type === 'array') {
      const list = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) {
        throw new Error(`"${key}" in ${path.basename(file)} must be a string or an array of strings.`);
      }
      values[key] = list;
    } else if (typeof value !== type) {
      throw new Error(`"${key}" in ${path.basename(file)} must be a ${type}.`);
    } else {
      values[key] = value;
    }
  }
  return { file, values, warnings };
}

export function applyRc(command, options, values) {
  for (const [key, value] of Object.entries(values)) {
    const source = command.getOptionValueSource(key);
    if (source && source !== 'default') continue;
    options[key] = key === 'compression' ? String(value) : value;
  }
}
