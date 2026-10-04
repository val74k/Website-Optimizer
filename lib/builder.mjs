import path from 'node:path';
import { stat, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { clean, inventory, validateDestination, noSymlink } from './safety.mjs';
import { loadDefines, compileJS, compileCSS, rewriteImports, assertHashableJS, readSource } from './compilers.mjs';
import { compileHTML } from './html.mjs';
import { writeSitemap } from './sitemap.mjs';
import { atomicWrite, atomicCopy, digest, log, pool, showStats, globalStats, ProgressBar } from './utils.mjs';

sharp.cache(false);
sharp.concurrency(1);
const extension = file => path.posix.extname(file).toLowerCase();
export const kind = (file, config) => {
  const ext = extension(file);
  if (['.js', '.mjs'].includes(ext)) return 'js';
  if (ext === '.css') return 'css';
  if (ext === '.html') return 'html';
  if (config.images && ['.jpg', '.jpeg', '.png'].includes(ext)) return 'image';
  return 'copy';
};
const webpName = file => file.slice(0, -path.posix.extname(file).length) + '.webp';

export class Builder {
  constructor(config) {
    this.config = config;
    this.mapping = new Map();
    this.stats = new Map();
    this.errors = new Map();
    this.config.warn = log.warn;
  }

  preflight(files) {
    const outputs = new Map();
    for (const file of files) {
      const output = kind(file, this.config) === 'image' ? webpName(file) : file;

      const key = output.normalize('NFC').toLowerCase();
      if (outputs.has(key)) throw new Error(`Output collision: ${file} and ${outputs.get(key)} → ${output}`);
      outputs.set(key, file);
    }
  }

  async attempt(file, action) {
    try { await action(); this.errors.delete(file); return true; }
    catch (error) {
      const detail = error.errors?.map(e => `${e.location ? `${e.location.file}:${e.location.line}:${e.location.column} ` : ''}${e.text}`).join('\n') ?? error.message;
      this.errors.set(file, detail);
      this.stats.set(file, { file, error: detail });
      log.error(`${file} : ${detail}`);
      return false;
    } finally {
      if (this.progress) this.progress.update(file);
    }
  }

  async emit(file, output, contents, before) {
    const destination = path.join(this.config.out, output);
    await noSymlink(destination);
    await atomicWrite(destination, contents);
    this.mapping.set(file, output);
    this.stats.set(file, { file, output, before, after: Buffer.byteLength(contents) });
  }

  async staticFile(file) {
    await this.attempt(file, async () => {
      const source = path.join(this.config.source, file);
      const before = (await stat(source)).size;
      const image = kind(file, this.config) === 'image';
      if (!image) {
        const destination = path.join(this.config.out, file);
        await noSymlink(destination);
        await atomicCopy(source, destination);
        this.mapping.set(file, file);
        this.stats.set(file, { file, output: file, before, after: before });
        return;
      }

      const output = await sharp(source, { animated: true }).rotate().webp({ quality: Number(this.config.compression) || 75, effort: 4 }).toBuffer();
      await this.emit(file, webpName(file), output, before);
    });
  }

  async codeFile(file) {
    await this.attempt(file, async () => {
      const input = await readSource(this.config, file);
      const code = kind(file, this.config) === 'css'
        ? compileCSS(input, file, this.mapping)
        : await rewriteImports(await compileJS(input.toString(), file, this.defines), file, this.mapping);
      await this.emit(file, file, code, input.length);
    });
  }

  async htmlFile(file) {
    await this.attempt(file, async () => {
      const input = await readSource(this.config, file);
      await this.emit(file, file, await compileHTML(input.toString(), file, this.config, this.mapping, this.defines), input.length);
    });
  }

  async full() {
    if (process.stdout.isTTY && !process.env.NO_COLOR) {
      process.stdout.write('\r\x1b[2K\x1b[36mInitializing build...\x1b[0m');
    }
    this.files = await inventory(this.config);
    this.preflight(this.files);
    this.defines = await loadDefines(this.config.project);
    await clean(this.config);
    this.mapping.clear(); this.stats.clear(); this.errors.clear();
    const copyFiles = this.files.filter(f => kind(f, this.config) === 'copy');
    const imageFiles = this.files.filter(f => kind(f, this.config) === 'image');
    const codeFiles = this.files.filter(f => ['css', 'js'].includes(kind(f, this.config)));
    const htmlFiles = this.files.filter(f => kind(f, this.config) === 'html');
    
    const totalOperations = this.files.length + (this.config.hash ? codeFiles.length : 0) + (this.config.sitemap ? 1 : 0);
    this.progress = new ProgressBar(totalOperations);
    this.progress.draw('Preparing files...');

    await pool(copyFiles, 8, f => this.staticFile(f));
    await pool(imageFiles, 2, f => this.staticFile(f));
    if (this.config.hash) await this.hashedCode(codeFiles);
    else await pool(codeFiles, 4, f => this.codeFile(f));
    await pool(htmlFiles, 4, f => this.htmlFile(f));
    await this.finish();
  }

  async hashedCode(files) {
    const prepared = new Map();
    await pool(files, 4, file => this.attempt(file, async () => {
      const input = await readSource(this.config, file);
      const code = kind(file, this.config) === 'css' ? compileCSS(input, file, this.mapping)
        : await compileJS(input.toString(), file, this.defines);
      if (kind(file, this.config) === 'js') await assertHashableJS(code, file);
      prepared.set(file, { code, before: input.length });
    }));

    const revision = digest(JSON.stringify([...prepared].sort(([a], [b]) => a.localeCompare(b)).map(([f, p]) => [f, p.code])));
    const planned = new Map(this.mapping);
    const occupied = new Set(this.files.map(file => file.normalize('NFC').toLowerCase()));
    for (const [file, preparedFile] of prepared) {
      const ext = path.posix.extname(file);
      const hash = digest(`${revision}\0${file}\0${preparedFile.code}`).slice(0, 12);
      const output = `${file.slice(0, -ext.length)}.${hash}${ext}`;
      if (occupied.has(output.normalize('NFC').toLowerCase())) throw new Error(`Hashed name collision: ${output}`);
      occupied.add(output.normalize('NFC').toLowerCase());
      planned.set(file, output);
    }
    await pool([...prepared], 4, ([file, entry]) => this.attempt(file, async () => {
      const code = kind(file, this.config) === 'css' ? compileCSS(entry.code, file, planned)
        : await rewriteImports(entry.code, file, planned);
      await this.emit(file, planned.get(file), code, entry.before);
    }));
  }

  async incremental(events) {
    if (process.stdout.isTTY && !process.env.NO_COLOR) {
      process.stdout.write('\r\x1b[2K\x1b[36mInitializing incremental build...\x1b[0m');
    }
    await validateDestination(this.config);
    const files = await inventory(this.config);
    this.preflight(files);
    const exists = new Set(files);
    const changed = [...events.keys()].filter(file => exists.has(file));
    const removed = this.files.filter(file => !exists.has(file));
    let refreshCSS = false;
    for (const file of removed) {
      const output = this.mapping.get(file);
      if (output) {
        await noSymlink(path.join(this.config.out, output));
        await rm(path.join(this.config.out, output), { force: true });
      }
      refreshCSS ||= kind(file, this.config) === 'image';
      this.mapping.delete(file); this.stats.delete(file); this.errors.delete(file);
    }
    this.files = files;
    const envChanged = events.has('@env');
    if (envChanged) this.defines = await loadDefines(this.config.project);
    const copyFiles = changed.filter(f => kind(f, this.config) === 'copy');
    const images = changed.filter(f => kind(f, this.config) === 'image');
    refreshCSS ||= images.length > 0;
    const codeFiles = files.filter(f => ['css', 'js'].includes(kind(f, this.config)) &&
      (events.has(f) || (envChanged && kind(f, this.config) === 'js') || (refreshCSS && kind(f, this.config) === 'css')));
    const htmlFiles = files.filter(f => kind(f, this.config) === 'html');
    const totalOperations = copyFiles.length + images.length + codeFiles.length + htmlFiles.length + (this.config.sitemap ? 1 : 0);
    if (totalOperations > 0) {
      this.progress = new ProgressBar(totalOperations);
      this.progress.draw('Preparing files...');
    }

    await pool(copyFiles, 8, f => this.staticFile(f));
    await pool(images, 2, f => this.staticFile(f));
    await pool(codeFiles, 4, f => this.codeFile(f));
    await pool(htmlFiles, 4, f => this.htmlFile(f));
    await this.finish();
  }

  async finish() {
    if (this.config.sitemap) await this.attempt('@sitemap', async () => {
      await writeSitemap(this.config);
      for (const file of ['sitemap.xml', 'robots.txt']) {
        const before = await stat(path.join(this.config.source, file)).then(s => s.size, e => {
          if (e.code === 'ENOENT') return 0;
          throw e;
        });
        this.stats.set(file, { file, output: file, before, after: (await stat(path.join(this.config.out, file))).size });
      }
    });
    if (this.progress) this.progress.finish();
    if (this.config.stats) showStats(this.stats);
    globalStats(this.stats);
    if (this.errors.size) log.warn(`${this.errors.size} error(s). Incomplete output; do not deploy.`);
    else log.ok(`Build completed: ${this.config.out}`);
  }
}
