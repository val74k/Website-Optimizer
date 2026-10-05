import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from './utils.mjs';

export const CACHE_DIR = '.optimizer-cache';

export class BuildCache {
  constructor(dir, enabled = true) {
    this.dir = dir;
    this.enabled = enabled;
    this.hits = 0;
    this.misses = 0;
  }

  file(key) { return path.join(this.dir, `${key}.bin`); }

  async get(key) {
    if (!this.enabled) return null;
    try {
      const buffer = await readFile(this.file(key));
      this.hits++;
      return buffer;
    } catch {
      this.misses++;
      return null;
    }
  }

  async set(key, buffer) {
    if (!this.enabled) return;
    try { await atomicWrite(this.file(key), buffer); } catch { }
  }
}
