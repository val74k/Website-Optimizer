import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { load } from 'cheerio';
import { init, parse } from 'es-module-lexer';
import sharp from 'sharp';
import { createConfig, validateDestination } from '../lib/safety.mjs';
import { compileCSS } from '../lib/compilers.mjs';

const cli = fileURLToPath(new URL('../bin/builder.mjs', import.meta.url));
async function fixture(t) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'website-optimizer-test-'));
  const source = path.join(project, 'site');
  await mkdir(source);
  t.after(() => rm(project, { recursive: true, force: true }));
  const put = async (file, contents) => {
    const target = path.join(source, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  return { project, source, out: path.join(project, 'dist'), put };
}
function launch(project, args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, NO_COLOR: '1' } });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, done, output: () => output };
}
async function run(project, ...args) { return launch(project, args).done; }
const exists = async file => access(file).then(() => true, () => false);
async function until(predicate, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timeout: ${message}`);
}
const read = file => readFile(file, 'utf8');

test('full pipeline: hash, cyclic imports, images, DOM, SRI, env, sitemap and clean', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, '.env'), 'API_KEY="public-demo"\n');
  await f.put('.env', 'NEVER_COPY=secret');
  await f.put('.git/config', 'secret');
  await f.put('node_modules/pkg/file.txt', 'ignored');
  await f.put('img/photo.png', await sharp({ create: { width: 8, height: 8, channels: 4, background: '#f80' } }).png().toBuffer());
  await f.put('fonts/demo.woff2', Buffer.from([0, 1, 2, 3, 255]));
  await f.put('css/base.css', 'body { color: red; }');
  await f.put('css/app.css', '@import "./base.css" layer; .hero { background: url("../img/photo.png?v=1#x"); } @font-face { font-family: Demo; src:url(../fonts/demo.woff2); }');
  await f.put('js/app.js', 'import { value } from "./dep.js"; export const other = 1; console.log(value, process.env.API_KEY); import("./dep.js");');
  await f.put('js/dep.js', 'import { other } from "./app.js"; export const value = () => other;');
  await f.put('js/classic.js', 'function greeting() { return "hello"; }');
  await f.put('index.html', '<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head><body><!-- gone --><img src="img/photo.png?v=2#z" srcset="img/photo.png 1x, img/photo.png 2x"><picture><source type="image/png" srcset="img/photo.png 1x"></picture><div style="background:url(img/photo.png)">Hello <span>world</span></div><script type="module" src="js/app.js" integrity="sha384-old"></script><script>console.log(process.env.API_KEY)</script></body></html>');
  await f.put('pages/été & nous.html', '<!doctype html><img src="../img/photo.png"><link href="../css/app.css?x=1#y" rel="stylesheet">');
  const args = ['site', '-o', 'dist', '-i', '--hash', '--stats', '--sitemap', 'https://example.com/docs'];
  const result = await run(f.project, ...args);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Reduction/);
  assert.equal(await exists(path.join(f.out, 'img/photo.png')), false);
  assert.equal((await sharp(path.join(f.out, 'img/photo.webp')).metadata()).format, 'webp');
  assert.equal(await exists(path.join(f.out, '.env')), false);
  assert.equal(await exists(path.join(f.out, '.git')), false);
  assert.equal(await exists(path.join(f.out, 'node_modules')), false);
  assert.deepEqual(await readFile(path.join(f.out, 'fonts/demo.woff2')), Buffer.from([0, 1, 2, 3, 255]));
  const html = await read(path.join(f.out, 'index.html'));
  const $ = load(html);
  assert.equal($('img').attr('src'), 'img/photo.webp?v=2#z');
  assert.match($('img').attr('srcset'), /photo.webp 2x/);
  assert.equal($('source').attr('type'), 'image/webp');
  assert.match($('div').attr('style'), /photo.webp/);
  assert.ok(!html.includes('gone'));
  assert.ok(html.includes('public-demo'));
  assert.match($('script[src]').attr('integrity'), /^sha384-[A-Za-z0-9+/=]+$/);
  assert.ok(!$('script[src]').attr('integrity').includes('old'));
  const appName = $('script[src]').attr('src');
  assert.match(appName, /app\.[a-f0-9]{12}\.js$/);
  const js = await read(path.join(f.out, appName));
  assert.ok(js.includes('public-demo'));
  assert.ok(!js.includes('process.env.API_KEY'));
  await init;
  assert.equal(parse(js)[0].length, 2);
  for (const item of parse(js)[0]) {
    assert.match(item.specifier, /dep\.[a-f0-9]{12}\.js$/);
    assert.ok(await exists(path.resolve(f.out, 'js', item.specifier)), item.specifier);
  }
  const depCode = await read(path.resolve(f.out, 'js', parse(js)[0][0].specifier));
  assert.ok(await exists(path.resolve(f.out, 'js', parse(depCode)[0][0].specifier)));
  const css = await read(path.join(f.out, $('link').attr('href')));
  assert.match(css, /photo.webp\?v=1#x/);
  assert.match(css, /base\.[a-f0-9]{12}\.css/);
  assert.match(css, /layer/);
  const classic = (await readdir(path.join(f.out, 'js'))).find(name => name.startsWith('classic.'));
  assert.match(await read(path.join(f.out, 'js', classic)), /function greeting\(/);
  const sitemap = await read(path.join(f.out, 'sitemap.xml'));
  assert.match(sitemap, /https:\/\/example.com\/docs\//);
  assert.match(sitemap, /%C3%A9t%C3%A9%20%26%20nous.html/);
  assert.match(await read(path.join(f.out, 'robots.txt')), /Sitemap: https:\/\/example.com\/docs\/sitemap.xml/);
  await writeFile(path.join(f.out, 'orphan.txt'), 'remove me');
  const result2 = await run(f.project, ...args);
  if (result2.code !== 0) console.error(result2.output);
  assert.equal(result2.code, 0);
  assert.equal(await exists(path.join(f.out, 'orphan.txt')), false);
  assert.equal(load(await read(path.join(f.out, 'index.html')))('script[src]').attr('src'), appName);
  await f.put('js/dep.js', 'export const value = 42;');
  assert.equal((await run(f.project, ...args)).code, 0);
  assert.notEqual(load(await read(path.join(f.out, 'index.html')))('script[src]').attr('src'), appName);
});

test('no flags: unchanged images, tree preserved, suffixed output', async t => {
  const f = await fixture(t);
  await f.put('photo.jpg', 'not even an image');
  await f.put('app.js', 'console.log(1 + 2);');
  const result = await run(f.project, 'site');
  assert.equal(result.code, 0, result.output);
  assert.equal(await read(path.join(f.project, 'site_dist/photo.jpg')), 'not even an image');
  assert.ok(await exists(path.join(f.project, 'site_dist/app.js')));
});

test('JS/CSS errors are isolated and exit code indicates failure', async t => {
  const f = await fixture(t);
  await f.put('broken.js', 'const = ;');
  await f.put('broken.css', 'body { color:');
  await f.put('valid.js', 'console.log("ok");');
  const result = await run(f.project, 'site', '-o', 'dist');
  assert.equal(result.code, 1);
  assert.match(result.output, /broken.js/);
  assert.match(result.output, /broken.css/);
  assert.ok(await exists(path.join(f.out, 'valid.js')));
});

test('WebP collision and invalid sitemap URL: reject before any purge', async t => {
  const f = await fixture(t);
  await mkdir(f.out);
  await writeFile(path.join(f.out, 'keep.txt'), 'precious');
  await f.put('same.jpg', 'x');
  await f.put('same.png', 'x');
  const collision = await run(f.project, 'site', '-o', 'dist', '-i');
  assert.equal(collision.code, 1);
  assert.match(collision.output, /collision/i);
  assert.equal(await read(path.join(f.out, 'keep.txt')), 'precious');
  assert.equal((await run(f.project, 'site', '-o', 'dist', '--sitemap', 'file:///tmp')).code, 1);
  assert.equal(await read(path.join(f.out, 'keep.txt')), 'precious');
});

test('protections: roots, ancestors, sensitive folders, symlinks and lock', async t => {
  const f = await fixture(t);
  for (const out of ['/', f.project, f.source, path.join(f.project, 'build'), '/etc/dist', path.join(f.project, 'node_modules/dist')]) {
    await assert.rejects(validateDestination({ source: f.source, project: f.project, out }));
  }
  const protectedRoot = path.join(f.project, 'protected_dist');
  await mkdir(path.join(protectedRoot, 'nested'), { recursive: true });
  await assert.rejects(validateDestination({ source: path.join(protectedRoot, 'nested'), project: f.project, out: protectedRoot }));
  await assert.rejects(validateDestination({ source: f.source, project: protectedRoot, out: protectedRoot }));
  if (process.platform !== 'win32') {
    await symlink(f.source, path.join(f.project, 'alias_dist'));
    await assert.rejects(createConfig('site', { out: 'alias_dist' }, f.project), /Symbolic link/);
    await symlink(f.source, path.join(f.project, 'alias'));
    await assert.rejects(createConfig('site', { out: 'alias/dist' }, f.project), /Symbolic link/);
  }
  await writeFile(`${f.out}.website-optimizer-lock`, '123');
  const result = await run(f.project, 'site', '-o', 'dist');
  assert.equal(result.code, 1);
  assert.match(result.output, /locked/);
});

test('nested destination: no recursion in dist and no .env copy', async t => {
  const f = await fixture(t);
  await f.put('index.html', '<p>hello</p>');
  await f.put('dist/stale.html', '<p>old</p>');
  const result = await run(f.source, '.', '-o', 'dist');
  assert.equal(result.code, 0, result.output);
  assert.ok(await exists(path.join(f.source, 'dist/index.html')));
  assert.equal(await exists(path.join(f.source, 'dist/dist')), false);
  assert.equal(await exists(path.join(f.source, 'dist/stale.html')), false);
});

test('CSS: @import media/layer, escaped URLs and image-set', () => {
  const result = compileCSS('@import "base.css" layer(foo) supports(display: grid) screen; a { background-image:image-set("photo.png" 1x, url(photo.png) 2x); }', 'app.css', new Map([['base.css', 'base.123.css'], ['photo.png', 'photo.webp']]));
  assert.match(result, /base.123.css/);
  assert.match(result, /supports/);
  assert.match(result, /layer\(foo\)/);
  assert.match(result, /screen/);
  assert.ok(!result.includes('photo.png'), result);
});

test('DOM: base href, external URLs, importmap, inline modules and names with apostrophes', async t => {
  const f = await fixture(t);
  await f.put("assets/it's.js", 'export const name = 1;');
  await f.put('assets/main.js', `import {name} from "./it's.js";console.log(name);`);
  await f.put('index.html', `<base href="/assets/"><script type="importmap">{"imports":{"demo":"./it's.js"}}</script><script type="module">import {name} from "./it's.js"; console.log(name)</script><script type="module" src="main.js"></script><img src="https://cdn.example.com/photo.jpg">`);
  const result = await run(f.project, 'site', '-o', 'dist', '--hash');
  assert.equal(result.code, 0, result.output);
  const $ = load(await read(path.join(f.out, 'index.html')));
  assert.equal($('img').attr('src'), 'https://cdn.example.com/photo.jpg');
  assert.match($('script[type=importmap]').text(), /it's\.[a-f0-9]+\.js/);
  await init;
  const inline = $('script[type=module]:not([src])').text();
  const imported = parse(inline)[0][0].specifier;
  assert.ok(await exists(path.join(f.out, 'assets', decodeURIComponent(imported))));
  const main = await read(path.join(f.out, 'assets', $('script[src]').attr('src')));
  assert.ok(await exists(path.join(f.out, 'assets', decodeURIComponent(parse(main)[0][0].specifier))));
});

test('watch: ignored hash, targeted updates, regenerated HTML, recoverable errors, env and deletion', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, '.env'), 'API_KEY=first');
  await f.put('app.js', 'console.log(process.env.API_KEY);');
  await f.put('untouched.js', 'console.log("keep");');
  await f.put('style.css', 'body {color:red}');
  await f.put('index.html', '<link rel="stylesheet" href="style.css" integrity="sha256-old"><script src="app.js"></script>');
  await f.put('extra.txt', 'remove');
  const processState = launch(f.project, ['site', '-o', 'dist', '--watch', '--hash']);
  t.after(async () => { processState.child.kill('SIGTERM'); await processState.done; });
  await until(() => processState.output().includes('Watch mode active'), 'watch ready');
  assert.match(processState.output(), /ignored/);
  assert.ok(await exists(path.join(f.out, 'app.js')));
  const firstHTML = await read(path.join(f.out, 'index.html'));

  await writeFile(path.join(f.out, 'untouched.js'), 'untouched sentinel');
  await f.put('style.css', 'body {color:blue}');
  await until(async () => (await read(path.join(f.out, 'style.css'))).includes('#00f'), 'CSS update');
  await until(async () => (await read(path.join(f.out, 'index.html'))) !== firstHTML, 'HTML/SRI regenerated');
  assert.equal(await read(path.join(f.out, 'untouched.js')), 'untouched sentinel');
  const previous = await read(path.join(f.out, 'app.js'));
  await f.put('app.js', 'const = ;');
  await until(() => processState.output().includes('app.js :'), 'syntax error logged');
  assert.equal(await read(path.join(f.out, 'app.js')), previous);
  await f.put('app.js', 'console.log("fixed", process.env.API_KEY)');
  await until(async () => (await read(path.join(f.out, 'app.js'))).includes('fixed'), 'syntax recovery');
  await writeFile(path.join(f.project, '.env'), 'API_KEY=second');
  await until(async () => (await read(path.join(f.out, 'app.js'))).includes('second'), 'env reloaded');
  await f.put('new.txt', 'added');
  await until(() => exists(path.join(f.out, 'new.txt')), 'file added');
  await rm(path.join(f.source, 'extra.txt'));
  await until(async () => !(await exists(path.join(f.out, 'extra.txt'))), 'file removed');
  processState.child.kill('SIGTERM');
  const result = await processState.done;
  assert.equal(result.code, 0, result.output);
  assert.equal(await exists(`${f.out}.website-optimizer-lock`), false);
});
