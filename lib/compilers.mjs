import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { transform as transformJS } from 'esbuild';
import { transform as transformCSS, transformStyleAttribute } from 'lightningcss';
import { init, parse } from 'es-module-lexer';
import dotenv from 'dotenv';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { rewriteURL } from './urls.mjs';

export async function loadDefines(project) {
  const values = {};
  const loaded = dotenv.config({ path: path.join(project, '.env'), processEnv: values, quiet: true });
  if (loaded.error && loaded.error.code !== 'ENOENT') throw loaded.error;
  const defines = {};
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) throw new Error(`.env variable name incompatible with esbuild: ${key}`);
    defines[`process.env.${key}`] = JSON.stringify(value);
  }
  return defines;
}

export async function compileJS(code, file, defines) {

  return (await transformJS(code, {
    loader: 'js', sourcefile: file, minify: true, define: defines,
    target: 'es2022', charset: 'utf8', legalComments: 'inline',
  })).code;
}

export async function rewriteImports(code, file, mapping, base) {
  await init;
  const [imports] = parse(code, file);
  let output = code;

  for (const item of [...imports].reverse()) {
    if (typeof item.specifier !== 'string' || item.glob) continue;
    const rewritten = rewriteURL(item.specifier, file, mapping, base, { module: true });
    if (rewritten === item.specifier) continue;
    const quoted = JSON.stringify(rewritten);
    const start = item.type === 'static' ? item.start - 1 : item.start;
    const end = item.type === 'static' ? item.end + 1 : item.end;
    output = output.slice(0, start) + quoted + output.slice(end);
  }
  return output;
}

export async function assertHashableJS(code, file) {
  await init;
  if (parse(code, file)[0].some(item => item.type === 'dynamic' &&
    (typeof item.specifier !== 'string' || item.glob))) {
    throw new Error('--hash cannot resolve import(expression). Use a literal path or disable --hash.');
  }
}

export function compileCSS(code, file, mapping, base, styleAttribute = false) {
  const rewrite = url => rewriteURL(url, file, mapping, base);
  const rewriteImageSet = image => {
    if (image.type === 'url') return { ...image, value: { ...image.value, url: rewrite(image.value.url) } };
    if (image.type !== 'image-set') return image;
    return { ...image, value: { ...image.value, options: image.value.options.map(option => {
      const result = { ...option, image: rewriteImageSet(option.image) };
      if (result.fileType === null) delete result.fileType;
      if (option.image.type === 'url' && result.image.value.url !== option.image.value.url &&
        /\.webp(?:[?#]|$)/i.test(result.image.value.url) && result.fileType?.startsWith('image/')) result.fileType = 'image/webp';
      return result;
    }) } };
  };

  let source = code.toString();
  if (!styleAttribute) {
    const ast = postcss.parse(source, { from: file });
    ast.walkAtRules('import', rule => {
      const params = valueParser(rule.params);
      const first = params.nodes.find(node => !['space', 'comment'].includes(node.type));
      if (first?.type === 'string') first.value = rewrite(first.value);
      else if (first?.type === 'function' && first.value.toLowerCase() === 'url') {
        const url = first.nodes.find(node => ['string', 'word'].includes(node.type));
        if (url) url.value = rewrite(url.value);
      }
      rule.params = params.toString();
    });
    source = ast.toString();
  }
  const options = {
    code: Buffer.from(source), minify: true,

    visitor: {
      Url: value => ({ ...value, url: rewrite(value.url) }),
      Image: image => image.type === 'image-set' ? rewriteImageSet(image) : undefined,
    },
  };
  return (styleAttribute ? transformStyleAttribute(options) : transformCSS({ ...options, filename: file })).code.toString();
}

export async function readSource(config, relative) {
  return readFile(path.join(config.source, relative));
}
