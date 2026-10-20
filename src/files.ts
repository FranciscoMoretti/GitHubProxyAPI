import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function optional(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
export async function atomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) {
    throw new Error(`Expected an owned private directory (chmod 700): ${path}`);
  }
}
/** Serialize mutations. Stale locks require explicit inspection, avoiding PID-reuse races. */
export async function locked<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10000;
  while (true) {
    try { await mkdir(path, { mode: 0o700 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Another setup may be running. Inspect ${path}; remove this lock only if its owner has exited.`);
      await delay(100);
    }
  }
  try { await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); return await action(); }
  finally { await rm(path, { recursive: true, force: true }); }
}
