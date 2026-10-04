import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';

const color = (n, s) => process.stdout.isTTY && !process.env.NO_COLOR
  ? `\x1b[${n}m${s}\x1b[0m` : s;
let currentProgress = null;

export const log = {
  ok: s => { if (currentProgress) currentProgress.clear(); console.log(color(32, `✓ ${s}`)); },
  warn: s => { if (currentProgress) currentProgress.clear(); console.warn(color(33, `⚠ ${s}`)); },
  error: s => { if (currentProgress) currentProgress.clear(); console.error(color(31, `✗ ${s}`)); },
};

export class ProgressBar {
  constructor(total) {
    this.total = total;
    this.current = 0;
    currentProgress = this;
  }
  draw(file) {
    if (!process.stdout.isTTY || process.env.NO_COLOR) return;
    const percentage = this.total === 0 ? 100 : Math.min(100, Math.round((this.current / this.total) * 100));
    const filled = Math.floor(percentage / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const line = `[${bar}] ${percentage}% | ${file}`;
    process.stdout.write(`\r\x1b[2K${color(36, line.slice(0, (process.stdout.columns || 80) - 1))}`);
  }
  update(file) {
    this.current++;
    this.draw(file);
  }
  clear() {
    if (!process.stdout.isTTY || process.env.NO_COLOR) return;
    process.stdout.write('\r\x1b[2K');
  }
  finish() {
    this.clear();
    currentProgress = null;
  }
}
export const posix = p => p.split(path.sep).join('/');
export const digest = input => createHash('sha256').update(input).digest('hex');
export const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};


export async function pool(items, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }));
}


export async function atomicWrite(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.website-optimizer-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function atomicCopy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.website-optimizer-${process.pid}.tmp`;
  try { await copyFile(source, temporary); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

export function showStats(rows) {
  console.table([...rows.values()].sort((a, b) => a.file.localeCompare(b.file)).map(row => ({
    Source: row.file,
    Output: row.output ?? '—',
    'Initial (bytes)': row.before ?? '—',
    'Final (bytes)': row.after ?? '—',
    Reduction: row.before > 0 && row.after !== undefined
      ? `${((1 - row.after / row.before) * 100).toFixed(1)} %` : '—',
    Status: row.error ? 'ERROR' : 'OK',
  })));
}

export function globalStats(rows) {
  let totalBefore = 0;
  let totalAfter = 0;
  for (const row of rows.values()) {
    if (row.before !== undefined && row.after !== undefined && !row.error) {
      totalBefore += row.before;
      totalAfter += row.after;
    }
  }
  if (totalBefore > 0) {
    const saved = totalBefore - totalAfter;
    const percentage = ((saved / totalBefore) * 100).toFixed(1);
    const savedMB = (saved / (1024 * 1024)).toFixed(2);
    log.ok(`Global saving: ${percentage}% (${savedMB} MB saved)`);
  }
}
