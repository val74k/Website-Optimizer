#!/usr/bin/env node
import { Command } from 'commander';
import { createConfig, acquireLock } from '../lib/safety.mjs';
import { sitemapBase } from '../lib/sitemap.mjs';
import { Builder } from '../lib/builder.mjs';
import { watch } from '../lib/watch.mjs';
import { log } from '../lib/utils.mjs';

const cli = new Command();
cli.name('builder')
  .description('Compile and optimize an HTML/CSS/Vanilla JS folder for production.')
  .version('1.0.0')
  .argument('<target>', 'mandatory source folder')
  .option('-o, --out <path>', 'destination named dist or ending with _dist')
  .option('-i, --images', 'convert JPG/JPEG/PNG to WebP')
  .option('-c, --compression <number>', 'default WebP compression percentage', '75')
  .option('-s, --stats', 'display file sizes and reduction stats')
  .option('-w, --watch', 'recompile on every save; ignores --hash')
  .option('--hash', 'add a deterministic fingerprint to JS/CSS filenames')
  .option('--sitemap <url>', 'create sitemap.xml and robots.txt for this base URL')
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
`)
  .action(async (target, options) => {
    let release;
    try {
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
