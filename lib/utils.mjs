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

const retryRename = async (src, dest, retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < retries - 1) {
        await new Promise(r => setTimeout(r, 50 * (i + 1)));
      } else {
        throw err;
      }
    }
  }
};

export async function atomicWrite(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.website-optimizer-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, contents);
    await retryRename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function atomicCopy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.website-optimizer-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  try { 
    await copyFile(source, temporary); 
    await retryRename(temporary, destination); 
  }
  finally { 
    await rm(temporary, { force: true }).catch(() => {}); 
  }
}

export function showStats(rows) {
  const allRows = [...rows.values()].sort((a, b) => a.file.localeCompare(b.file));
  const mainRows = allRows.filter(r => !r.isResponsive);
  const responsiveRows = allRows.filter(r => r.isResponsive);

  const formatRow = row => ({
    Source: row.file,
    Output: row.output ?? '—',
    'Initial (bytes)': row.before ?? '—',
    'Final (bytes)': row.after ?? '—',
    Reduction: row.before > 0 && row.after !== undefined
      ? `${((1 - row.after / row.before) * 100).toFixed(1)} %` : '—',
    Status: row.error ? 'ERROR' : 'OK',
  });

  if (mainRows.length > 0) {
    console.table(mainRows.map(formatRow));
  }

  if (responsiveRows.length > 0) {
    console.log('\nResponsive Variants (--responsive):');
    console.table(responsiveRows.map(formatRow));
  }
}

export function globalStats(rows) {
  let totalBefore = 0;
  let totalAfter = 0;
  let responsiveAdded = 0;

  for (const row of rows.values()) {
    if (row.before !== undefined && row.after !== undefined && !row.error) {
      totalBefore += row.before;
      if (row.isResponsive) {
        responsiveAdded += row.after;
      } else {
        totalAfter += row.after;
      }
    }
  }
  if (totalBefore > 0) {
    const saved = totalBefore - totalAfter;
    const percentage = ((saved / totalBefore) * 100).toFixed(1);
    const print = (msg) => {
      if (currentProgress) currentProgress.clear();
      console.log(`${color(32, '✓')} ${msg}`);
    };

    const savedMB = (saved / (1024 * 1024)).toFixed(2);
    print(`Global saving on original files: ${percentage}% (${color(32, `${savedMB} MB`)} saved)`);

    if (responsiveAdded > 0) {
      const addedMB = (responsiveAdded / (1024 * 1024)).toFixed(2);
      print(`Responsive variants generated: ${color(36, `+${addedMB} MB`)} added to output`);
      const netMB = ((saved - responsiveAdded) / (1024 * 1024)).toFixed(2);
      if (saved > responsiveAdded) print(`Net global saving (${color(32, `${savedMB} MB`)} - ${color(36, `${addedMB} MB`)}): ${color('1;33', `${netMB} MB saved`)}`);
    }
  }
}
