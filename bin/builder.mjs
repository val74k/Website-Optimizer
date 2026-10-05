#!/usr/bin/env node
import { Command } from 'commander';
import { createConfig, acquireLock } from '../lib/safety.mjs';
import { sitemapBase } from '../lib/sitemap.mjs';
import { Builder } from '../lib/builder.mjs';
import { watch } from '../lib/watch.mjs';
import { log } from '../lib/utils.mjs';
import { loadRc, applyRc } from '../lib/rc.mjs';

const cli = new Command();
cli.name('builder')
  .description('Compile and optimize an HTML/CSS/Vanilla JS folder for production.')
  .version('1.0.0')
  .argument('<target>', 'mandatory source folder')
  .option('-o, --out <path>', 'destination named dist or ending with _dist')
  .option('-i, --images', 'convert JPG/JPEG/PNG to WebP')
  .option('-c, --compression <number>', 'default WebP/AVIF compression percentage', '75')
  .option('-s, --stats', 'display file sizes and reduction stats')
  .option('-l, --lazy', 'automatically inject loading="lazy" and decoding="async"')
  .option('--inline', 'inline small CSS and JS assets (< 3KB) into HTML head')
  .option('-w, --watch', 'recompile on every save; ignores --hash')
  .option('-x, --exclude <folders...>', 'folders to exclude (comma separated or multiple flags)')
  .option('--responsive', 'generate responsive images (srcset) and update HTML')
  .option('--purge', 'purge unused CSS (PurgeCSS)')
  .option('--avif', 'generate AVIF instead of WebP')
  .option('--hash', 'add a deterministic fingerprint to JS/CSS filenames')
  .option('-O, --optimize', 'enable all recommended optimizations (avif, lazy, inline, responsive, purge, hash)')
  .option('-k, --keep', 'do not empty the destination folder before building')
  .option('--sitemap <url>', 'create sitemap.xml and robots.txt for this base URL')
  .option('--favicon <image>', 'generate favicons + site.webmanifest from this image (path inside the source folder)')
  .option('--name <text>', 'site name used in the generated web manifest')
  .option('--theme-color <color>', 'theme color override for the web manifest and <meta name="theme-color">')
  .option('--no-seo', 'disable warnings about missing <title>, meta description and og:image')
  .option('--no-cache', 'do not reuse the image cache (.optimizer-cache)')
  .option('--config <path>', 'config file to use (default: ./.optimizerrc.json if present)')
  .addHelpText('after', `
Examples:
  builder ./myproject
  builder ./backups/myproject -o ./dist -i --hash -s
  builder ./myproject --sitemap https://example.com/ --hash
  builder ./myproject --watch

.env is read from the directory where the command is launched.
All variables injected into JavaScript are public.
Without -o: source = current directory → ./dist; otherwise → <source>_dist.
The destination is fully purged on the first build, after validation.
In watch mode, subsequent updates are incremental and remove deleted files.
Options can be stored in ./.optimizerrc.json; command-line flags take priority.
`)
  .action(async (target, options, command) => {
    let release;
    try {
      const rc = await loadRc(options.config);
      for (const warning of rc.warnings ?? []) log.warn(warning);
      applyRc(command, options, rc.values);

      if (options.optimize) {
        options.images = true;
        options.avif = true;
        options.lazy = true;
        options.inline = true;
        options.responsive = true;
        options.purge = true;
        if (!options.watch) options.hash = true;
      }

      if (options.sitemap) sitemapBase(options.sitemap);
      if (options.watch && options.hash) log.warn('--hash is ignored in --watch mode.');
      const config = await createConfig(target, options);
      release = await acquireLock(config);
      const builder = new Builder(config);
      if (options.watch) await watch(builder);
      else await builder.full();
      if (builder.errors.size) process.exitCode = 1;
    } catch (error) {
      log.error(error.message);
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });

if (process.argv.length === 2) cli.help();

try { await cli.parseAsync(process.argv); }
catch (error) { log.error(error.message); process.exitCode = 1; }
