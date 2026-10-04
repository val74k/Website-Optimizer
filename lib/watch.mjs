import chokidar from 'chokidar';
import path from 'node:path';
import { ignored } from './safety.mjs';
import { log, posix } from './utils.mjs';

export async function watch(builder) {
  const config = builder.config;
  const envFile = path.join(config.project, '.env');
  const pending = new Map();
  let ready = false;
  let closing = false;
  let timer;
  let running;
  let fatal;
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const watcher = chokidar.watch([config.source, envFile], {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: file => path.resolve(file) !== envFile && ignored(config, file),
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
    atomic: true,
  });

  const schedule = () => {
    if (!ready || closing) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void drain(); }, 100);
  };
  async function drain() {
    if (running || closing) return;
    running = (async () => {
      while (pending.size && !closing) {
        const events = new Map(pending);
        pending.clear();
        try { builder.errors.delete('@watch'); await builder.incremental(events); }
        catch (error) { builder.errors.set('@watch', error.message); log.error(error.message); }
      }
    })();
    await running;
    running = undefined;
  }
  watcher.on('all', (event, file) => {
    if (closing || !['add', 'change', 'unlink', 'unlinkDir'].includes(event)) return;
    const absolute = path.resolve(file);
    pending.set(absolute === envFile ? '@env' : posix(path.relative(config.source, absolute)), event);
    schedule();
  });
  watcher.on('error', error => { fatal = error; stop(); });
  const signal = () => { closing = true; stop(); };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    await Promise.race([
      new Promise(resolve => watcher.once('ready', resolve)),
      stopped.then(() => { if (fatal) throw fatal; }),
    ]);
    if (closing) return;

    await builder.full();
    ready = true;
    if (pending.size) schedule();
    log.ok('Watch mode active. Press Ctrl+C to stop.');
    await stopped;
    if (fatal) throw fatal;
  } finally {
    closing = true;
    clearTimeout(timer);
    await watcher.close();
    if (running) await running;
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
  }
}
