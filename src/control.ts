import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { atomic, locked } from './files.js';
import { spawn } from 'node:child_process';
import { parseDocument } from 'yaml';

export function ghConfigDir(): string { return process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh'); }
async function readOptional(path: string): Promise<string> { try { return await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; } }
function document(text: string) { const doc = parseDocument(text || '{}\n'); if (doc.errors.length || !doc.toJSON() || typeof doc.toJSON() !== 'object' || Array.isArray(doc.toJSON())) throw new Error('gh configuration is not a YAML mapping'); return doc; }
export async function getStatus(socketPath: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/_githubproxyapi/status', headers: { host: 'githubproxyapi.local' }, timeout: timeoutMs }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; if (body.length > 1024 * 1024) req.destroy(new Error('Status response too large')); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error(); resolve(JSON.parse(body)); } catch { reject(new Error('Proxy status unavailable')); } });
    }); const deadline = setTimeout(() => req.destroy(new Error('Proxy status timed out')), timeoutMs);
    req.on('close', () => clearTimeout(deadline)); req.on('timeout', () => req.destroy(new Error('Proxy status timed out'))); req.on('error', () => reject(new Error('Proxy is unavailable (local transport, not a GitHub authentication result); run ghpa service status, ghpa enable-gh, or ghpa disable-gh for direct access'))); req.end();
  });
}
interface Backup { version: 1; socketPath: string; previousSocket?: string; present: boolean; value?: unknown; configPath: string }
export async function ghSocket(dir = ghConfigDir()): Promise<unknown> {
  return document(await readOptional(join(dir, 'config.yml'))).get('http_unix_socket');
}
export async function enableGh(socketPath: string, backupPath: string, dir = ghConfigDir(), previousSocket?: string): Promise<void> {
  await getStatus(socketPath);
  await locked(join(dir, '.ghpa-lock'), async () => {
    const path = join(dir, 'config.yml'); const doc = document(await readOptional(path)); const existing = await readOptional(backupPath);
    let backup: Backup;
    if (existing) {
      backup = JSON.parse(existing) as Backup;
      const current = doc.get('http_unix_socket');
      const original = backup.present ? current === backup.value : !doc.has('http_unix_socket');
      if (backup.version !== 1 || backup.configPath !== path ||
          (backup.socketPath !== socketPath && backup.socketPath !== previousSocket) ||
          (current !== backup.socketPath && (backup.previousSocket === undefined || current !== backup.previousSocket) && !original)) {
        throw new Error('gh socket configuration changed; refusing to overwrite');
      }
      if (current === socketPath && backup.socketPath === socketPath) return;
      backup = { ...backup, previousSocket: typeof current === 'string' ? current : undefined, socketPath };
    } else {
      backup = { version: 1, socketPath, configPath: path, present: doc.has('http_unix_socket'), value: doc.get('http_unix_socket') };
    }
    await atomic(backupPath, JSON.stringify(backup));
    try { doc.set('http_unix_socket', socketPath); await atomic(path, doc.toString()); }
    catch (error) {
      if (existing) await atomic(backupPath, existing); else await rm(backupPath, { force: true });
      throw error;
    }
  });
}
export async function disableGh(backupPath: string, dir = ghConfigDir()): Promise<void> {
  await locked(join(dir, '.ghpa-lock'), async () => {
    const raw = await readOptional(backupPath); if (!raw) return;
    const backup = JSON.parse(raw) as Backup; const path = join(dir, 'config.yml'); const doc = document(await readOptional(path));
    const current = doc.get('http_unix_socket');
    const original = backup.present ? current === backup.value : !doc.has('http_unix_socket');
    if (backup.version !== 1 || backup.configPath !== path || (!original && current !== backup.socketPath && (backup.previousSocket === undefined || current !== backup.previousSocket))) throw new Error('gh socket configuration changed; refusing to overwrite');
    if (!original) {
      if (backup.present) doc.set('http_unix_socket', backup.value); else doc.delete('http_unix_socket');
      await atomic(path, doc.toString());
    }
    await rm(backupPath);
  });
}
/** Recover a crash after backup write but before the atomic gh config switch. */
export async function rollbackGhBackup(socketPath: string, backupPath: string, before: string, dir: string): Promise<void> {
  await locked(join(dir, '.ghpa-lock'), async () => {
    const raw = await readOptional(backupPath);
    if (!raw || (JSON.parse(raw) as Backup).socketPath !== socketPath || await ghSocket(dir) === socketPath) return;
    if (before) await atomic(backupPath, before); else await rm(backupPath, { force: true });
  });
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
