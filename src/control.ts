import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseDocument } from 'yaml';

export function ghConfigDir(): string { return process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh'); }
async function readOptional(path: string): Promise<string> { try { return await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; } }
async function atomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await rename(temp, path);
}
function document(text: string) { const doc = parseDocument(text || '{}\n'); if (doc.errors.length || !doc.toJSON() || typeof doc.toJSON() !== 'object' || Array.isArray(doc.toJSON())) throw new Error('gh configuration is not a YAML mapping'); return doc; }
export async function getStatus(socketPath: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/_githubproxyapi/status', headers: { host: 'githubproxyapi.local' }, timeout: timeoutMs }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; if (body.length > 1024 * 1024) req.destroy(new Error('Status response too large')); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error(); resolve(JSON.parse(body)); } catch { reject(new Error('Proxy status unavailable')); } });
    }); req.on('timeout', () => req.destroy(new Error('Proxy status timed out'))); req.on('error', () => reject(new Error('Proxy is unavailable; start serve first'))); req.end();
  });
}
interface Backup { version: 1; socketPath: string; present: boolean; value?: unknown; configPath: string }
export async function enableGh(socketPath: string, backupPath: string, dir = ghConfigDir()): Promise<void> {
  await getStatus(socketPath);
  const path = join(dir, 'config.yml'); const doc = document(await readOptional(path)); const existing = await readOptional(backupPath);
  if (existing) { const backup = JSON.parse(existing) as Backup; if (backup.configPath !== path || backup.socketPath !== socketPath || doc.get('http_unix_socket') !== socketPath) throw new Error('gh socket configuration changed; refusing to overwrite'); return; }
  const backup: Backup = { version: 1, socketPath, configPath: path, present: doc.has('http_unix_socket'), value: doc.get('http_unix_socket') };
  await atomic(backupPath, JSON.stringify(backup)); doc.set('http_unix_socket', socketPath); await atomic(path, doc.toString());
}
export async function disableGh(backupPath: string, dir = ghConfigDir()): Promise<void> {
  const raw = await readOptional(backupPath); if (!raw) return;
  const backup = JSON.parse(raw) as Backup; const path = join(dir, 'config.yml'); const doc = document(await readOptional(path));
  if (backup.version !== 1 || backup.configPath !== path || doc.get('http_unix_socket') !== backup.socketPath) throw new Error('gh socket configuration changed; refusing to overwrite');
  if (backup.present) doc.set('http_unix_socket', backup.value); else doc.delete('http_unix_socket');
  await atomic(path, doc.toString()); await rm(backupPath);
}
export async function scopedGh(socketPath: string, args: string[], dir = ghConfigDir()): Promise<number> {
  await getStatus(socketPath); const temp = await mkdtemp(join(tmpdir(), 'githubproxyapi-gh-')); await chmod(temp, 0o700);
  try {
    const doc = document(await readOptional(join(dir, 'config.yml'))); doc.set('http_unix_socket', socketPath); await atomic(join(temp, 'config.yml'), doc.toString());
    try { await copyFile(join(dir, 'hosts.yml'), join(temp, 'hosts.yml')); await chmod(join(temp, 'hosts.yml'), 0o600); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return await new Promise<number>((resolve, reject) => {
      const child = spawn('gh', args, { stdio: 'inherit', env: { ...process.env, GH_CONFIG_DIR: temp } });
      const onInterrupt = () => { child.kill('SIGINT'); };
      const onTerminate = () => { child.kill('SIGTERM'); };
      const cleanup = () => { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); };
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
      child.on('error', () => { cleanup(); reject(new Error('Could not launch gh')); });
      child.on('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)); });
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function stopProxy(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, method: 'POST', path: '/_githubproxyapi/stop', headers: { host: 'githubproxyapi.local' }, timeout: 3000 }, res => {
      res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Proxy refused shutdown')));
    });
    req.on('timeout', () => req.destroy(new Error('Proxy shutdown timed out')));
    req.on('error', () => reject(new Error('Proxy is unavailable; no process was killed'))); req.end();
  });
}
