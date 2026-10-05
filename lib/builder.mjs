import path from 'node:path';
import { stat, rm, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { PurgeCSS } from 'purgecss';
import { optimize as optimizeSvg } from 'svgo';
import { clean, inventory, validateDestination, noSymlink } from './safety.mjs';
import { loadDefines, compileJS, compileCSS, rewriteImports, assertHashableJS, readSource } from './compilers.mjs';
import { compileHTML } from './html.mjs';
import { writeSitemap } from './sitemap.mjs';
import { RESPONSIVE_SIZES } from './urls.mjs';
import { atomicWrite, atomicCopy, digest, log, pool, showStats, globalStats, ProgressBar } from './utils.mjs';
import { BuildCache } from './cache.mjs';
import { generateFavicons } from './favicon.mjs';

sharp.cache(false);
sharp.concurrency(1);
const extension = file => path.posix.extname(file).toLowerCase();
export const kind = (file, config) => {
  const ext = extension(file);
  if (['.js', '.mjs'].includes(ext)) return 'js';
  if (ext === '.css') return 'css';
  if (ext === '.html') return 'html';
  if (config.images) {
    if (['.jpg', '.jpeg', '.png', '.webp', '.avif'].includes(ext)) return 'image';
    if (ext === '.svg') return 'svg';
  }
  return 'copy';
};
const imageName = (file, config) => file.slice(0, -path.posix.extname(file).length) + (config.avif ? '.avif' : '.webp');

export class Builder {
  constructor(config) {
    this.config = config;
    this.mapping = new Map();
    this.stats = new Map();
    this.errors = new Map();
    this.dimensions = new Map();
    this.config.warn = log.warn;
    const warned = new Set();
    this.config.warnOnce = message => { if (!warned.has(message)) { warned.add(message); log.warn(message); } };
    this.cache = new BuildCache(config.cacheDir, config.cache !== false);
  }

  preflight(files) {
    const outputs = new Map();
    for (const file of files) {
      const output = kind(file, this.config) === 'image' ? imageName(file, this.config) : file;

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
      const sourceStat = await stat(source);
      const before = sourceStat.size;
      const fileKind = kind(file, this.config);

      if (fileKind === 'svg') {
        const svgContent = await readFile(source, 'utf8');
        const result = optimizeSvg(svgContent, { path: source, multipass: true });
        await this.emit(file, file, result.data, before);
        return;
      }

      if (fileKind !== 'image') {
        const destination = path.join(this.config.out, file);
        await noSymlink(destination);
        await atomicCopy(source, destination);
        this.mapping.set(file, file);
        this.stats.set(file, { file, output: file, before, after: before });
        return;
      }

      const sourceBytes = await readFile(source);
      const sourceKey = digest(sourceBytes);
      const pipeline = sharp(sourceBytes, { animated: true }).rotate();
      const metadata = await pipeline.metadata();
      if (metadata.width && metadata.height) {
        this.dimensions.set(file, { width: metadata.width, height: metadata.height });
      }

      const mainName = imageName(file, this.config);
      const mainDestination = path.join(this.config.out, mainName);

      let allUpToDate = true;
      let mainAfter = 0;

      try {
        const destStat = await stat(mainDestination);
        if (destStat.mtimeMs < sourceStat.mtimeMs) allUpToDate = false;
        else mainAfter = destStat.size;
      } catch {
        allUpToDate = false;
      }

      const responsiveOutputs = [];
      if (this.config.responsive) {
        for (const width of RESPONSIVE_SIZES) {
          if (metadata.width && width < metadata.width) {
            const ext = path.posix.extname(file);
            const responsiveName = `${file.slice(0, -ext.length)}-${width}w${this.config.avif ? '.avif' : '.webp'}`;
            const responsiveDest = path.join(this.config.out, responsiveName);
            try {
              const destStat = await stat(responsiveDest);
              if (destStat.mtimeMs < sourceStat.mtimeMs) allUpToDate = false;
              responsiveOutputs.push({ width, responsiveName, after: destStat.size });
            } catch {
              allUpToDate = false;
            }
          }
        }
      }

      if (allUpToDate) {
        this.mapping.set(file, mainName);
        this.stats.set(file, { file, output: mainName, before, after: mainAfter });
        for (const ro of responsiveOutputs) {
          this.mapping.set(`${file}-${ro.width}w`, ro.responsiveName);
          this.stats.set(`${file}-${ro.width}w`, { file: `${file} (${ro.width}w)`, output: ro.responsiveName, before: 0, after: ro.after, isResponsive: true });
        }
        return;
      }

      const applyFormat = p => this.config.avif 
        ? p.avif({ quality: Number(this.config.compression) || 75, effort: 4 })
        : p.webp({ quality: Number(this.config.compression) || 75, effort: 4 });

      const quality = Number(this.config.compression) || 75;
      const format = this.config.avif ? 'avif' : 'webp';
      const encode = async (label, make) => {
        const key = digest(`${sourceKey}|${label}|${format}|${quality}|${sharp.versions?.sharp ?? ''}`);
        const hit = await this.cache.get(key);
        if (hit) return hit;
        const buffer = await make();
        await this.cache.set(key, buffer);
        return buffer;
      };

      if (this.config.responsive) {
        const mainBuffer = await encode('main', () => applyFormat(pipeline.clone()).toBuffer());
        await this.emit(file, mainName, mainBuffer, before);

        for (const width of RESPONSIVE_SIZES) {
          if (metadata.width && width < metadata.width) {
            const resizedBuffer = await encode(`w${width}`, () => applyFormat(pipeline.clone().resize({ width, withoutEnlargement: true })).toBuffer());
            const ext = path.posix.extname(file);
            const responsiveName = `${file.slice(0, -ext.length)}-${width}w${this.config.avif ? '.avif' : '.webp'}`;

            const destination = path.join(this.config.out, responsiveName);
            await noSymlink(destination);
            await atomicWrite(destination, resizedBuffer);
            this.mapping.set(`${file}-${width}w`, responsiveName);
            this.stats.set(`${file}-${width}w`, { file: `${file} (${width}w)`, output: responsiveName, before: 0, after: Buffer.byteLength(resizedBuffer), isResponsive: true });
          }
        }
      } else {
        const output = await encode('main', () => applyFormat(pipeline).toBuffer());
        await this.emit(file, mainName, output, before);
      }
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
      await this.emit(file, file, await compileHTML(input.toString(), file, this.config, this.mapping, this.defines, this.dimensions), input.length);
    });
  }

  async full() {
    this.progress = new ProgressBar(0);
    this.progress.draw('Preparing files...');
    this.files = await inventory(this.config);
    this.preflight(this.files);
    this.defines = await loadDefines(this.config.project);
    await clean(this.config);
    this.mapping.clear(); this.stats.clear(); this.errors.clear();
    const copyFiles = this.files.filter(f => kind(f, this.config) === 'copy');
    const imageFiles = this.files.filter(f => ['image', 'svg'].includes(kind(f, this.config)));
    const codeFiles = this.files.filter(f => ['css', 'js'].includes(kind(f, this.config)));
    const htmlFiles = this.files.filter(f => kind(f, this.config) === 'html');

    const totalOperations = this.files.length + (this.config.hash ? codeFiles.length : 0) + (this.config.sitemap ? 1 : 0) + (this.config.favicon ? 1 : 0);
    this.progress.total = totalOperations;
    this.progress.draw('Building...');

    await pool(copyFiles, 8, f => this.staticFile(f));
    await pool(imageFiles, 2, f => this.staticFile(f));
    if (this.config.hash) await this.hashedCode(codeFiles);
    else await pool(codeFiles, 4, f => this.codeFile(f));

    if (this.config.purge) await this.purgeCSS(htmlFiles, codeFiles);

    await this.favicons();
    await pool(htmlFiles, 4, f => this.htmlFile(f));
    await this.finish();
  }

  async favicons(events) {
    if (!this.config.favicon) return;
    const changed = events?.has(path.posix.normalize(this.config.favicon.replaceAll('\\', '/')));
    if (events && this.config.faviconLinks && !changed) return;
    await this.attempt('@favicon', async () => {
      const { links } = await generateFavicons(this.config, this.files);
      this.config.faviconLinks = links;
    });
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
    if (!this.progress) {
      this.progress = new ProgressBar(0);
    }
    this.progress.draw('Preparing files...');
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
    const images = changed.filter(f => ['image', 'svg'].includes(kind(f, this.config)));
    refreshCSS ||= images.length > 0;
    const codeFiles = files.filter(f => ['css', 'js'].includes(kind(f, this.config)) &&
      (events.has(f) || (envChanged && kind(f, this.config) === 'js') || (refreshCSS && kind(f, this.config) === 'css')));
    const htmlFiles = files.filter(f => kind(f, this.config) === 'html');
    const totalOperations = copyFiles.length + images.length + codeFiles.length + htmlFiles.length + (this.config.sitemap ? 1 : 0);
    if (totalOperations > 0) {
      this.progress.total = totalOperations;
      this.progress.current = 0;
      this.progress.draw('Building...');
    }

    await pool(copyFiles, 8, f => this.staticFile(f));
    await pool(images, 2, f => this.staticFile(f));
    await pool(codeFiles, 4, f => this.codeFile(f));
    if (this.config.purge) await this.purgeCSS(htmlFiles, codeFiles);
    await this.favicons(events);
    await pool(htmlFiles, 4, f => this.htmlFile(f));
    await this.finish();
  }

  async purgeCSS(htmlFiles, codeFiles) {
    const cssFiles = codeFiles.filter(f => kind(f, this.config) === 'css');
    if (cssFiles.length === 0 || htmlFiles.length === 0) return;
    if (this.progress) this.progress.draw('Purging CSS...');

    const jsFiles = (this.files ?? []).filter(f => kind(f, this.config) === 'js');
    const htmlContents = await Promise.all([
      ...htmlFiles.map(async f => ({ raw: (await readSource(this.config, f)).toString(), extension: 'html' })),
      ...jsFiles.map(async f => ({ raw: (await readSource(this.config, f)).toString(), extension: 'js' })),
    ]);

    await pool(cssFiles, 4, file => this.attempt(file, async () => {
      const outputName = this.mapping.get(file);
      if (!outputName) return;
      const destination = path.join(this.config.out, outputName);
      const cssContent = await readFile(destination, 'utf8');

      const purge = new PurgeCSS();
      const result = await purge.purge({
        content: htmlContents,
        css: [{ raw: cssContent }],
        safelist: [/^(?:js|is|has)-/]
      });

      const purgedCSS = result[0].css;
      await atomicWrite(destination, purgedCSS);
      const stat = this.stats.get(file);
      if (stat) stat.after = Buffer.byteLength(purgedCSS);
    }));
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
    if (this.cache.hits > 0) log.ok(`Image cache: ${this.cache.hits} reused, ${this.cache.misses} encoded`);
    globalStats(this.stats);
    if (this.errors.size) log.warn(`${this.errors.size} error(s). Incomplete output; do not deploy.`);
    else log.ok(`Build completed: ${this.config.out}`);
  }
}
