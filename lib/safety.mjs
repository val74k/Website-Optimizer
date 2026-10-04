import path from 'node:path';
import os from 'node:os';
import { lstat, realpath, readdir, mkdir, rm, open } from 'node:fs/promises';
import { inside, posix } from './utils.mjs';

export const buildName = name => name === 'dist' || name.endsWith('_dist');
const excluded = new Set(['node_modules', '.git', '.svn', '.hg']);
export const secretName = name => name === '.env' || name.startsWith('.env.');


export async function noSymlink(file) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic link forbidden: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

export async function validateDestination({ source, out, project }) {
  const destination = path.resolve(out);
  await noSymlink(destination);
  if (!buildName(path.basename(destination))) {
    throw new Error('Destination rejected: its name must be exactly dist or end with _dist.');
  }
  const protectedPaths = [path.parse(destination).root, project, source, os.homedir()];
  for (const protectedPath of protectedPaths) {
    if (inside(destination, path.resolve(protectedPath))) {
      throw new Error(`Destination rejected: it contains or is a protected folder (${protectedPath}).`);
    }
  }
  const parts = destination.toLowerCase().split(path.sep);
  if (parts.some(p => excluded.has(p) || ['windows', 'program files', 'programdata', '.ssh', '.aws', '.config'].includes(p))) {
    throw new Error(`Sensitive destination rejected: ${destination}`);
  }
  if (process.platform !== 'win32') {
    for (const sensitive of ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/var', '/System', '/Applications', '/Library']) {
      if (inside(sensitive, destination)) throw new Error(`System destination rejected: ${destination}`);
    }
  }
  try {
    if (!(await lstat(destination)).isDirectory()) throw new Error('Destination exists but is not a directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return destination;
}

export async function clean(config) {
  await validateDestination(config);
  await rm(config.out, { recursive: true, force: true });
  await mkdir(config.out, { recursive: true });
}


export async function acquireLock(config) {
  await validateDestination(config);
  await mkdir(path.dirname(config.out), { recursive: true });
  const lockFile = `${config.out}.website-optimizer-lock`;
  let handle;
  try { handle = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Build already locked: ${lockFile}. If no build is running, remove this lock manually.`);
    throw error;
  }
  await handle.writeFile(String(process.pid));
  return async () => { await handle.close(); await rm(lockFile, { force: true }); };
}

export function ignored(config, file) {
  const absolute = path.resolve(file);
  if (inside(config.out, absolute) || absolute === `${config.out}.website-optimizer-lock`) return true;
  if (!inside(config.source, absolute)) return false;
  const parts = path.relative(config.source, absolute).split(path.sep);
  return parts.some(part => excluded.has(part) || secretName(part));
}

export async function inventory(config) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (ignored(config, file)) continue;
      if (entry.isSymbolicLink()) { config.warn?.(`Lien source ignoré : ${file}`); continue; }
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(posix(path.relative(config.source, file)));
    }
  }
  await visit(config.source);
  return files.sort();
}

export async function createConfig(target, options, cwd = process.cwd()) {
  const project = await realpath(cwd);
  const source = await realpath(path.resolve(project, target));
  if (!(await lstat(source)).isDirectory()) throw new Error('Source must be a directory.');
  const out = options.out ? path.resolve(project, options.out)
    : source === project ? path.join(project, 'dist') : `${source}_dist`;
  const config = { ...options, source, out, project, hash: Boolean(options.hash && !options.watch) };
  await validateDestination(config);
  return config;
}
