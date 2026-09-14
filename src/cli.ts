#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { access, readFile, stat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { configPath, defaultConfig, loadConfig, saveConfig, validateConfig } from './config.js';
import { disableGh, enableGh, getStatus, scopedGh, stopProxy } from './control.js';
import { discoverInstallations } from './credentials.js';
import { startProxy } from './proxy.js';
import { formatQuotas, quotaRows, withPersonalRateLimit } from './quotas.js';
import type { AppConfig, Permission } from './types.js';
const help = `GHPA (GitHubProxyAPI) — keep gh, pool eligible GitHub App reads

  init                         Create a private configuration
  config validate              Check configuration
  apps add --name NAME --app-id ID --installation-id ID --key-file PATH
           --repo OWNER/REPO:ID [--repo ...] --permission contents [--permission ...]
  apps list                    List configured installations
  apps discover --app-id ID --key-file PATH
                               List installations available to an App
  enroll-caller [--token-stdin] Enroll your gh credential by SHA-256 fingerprint
  start                        Start proxy in the background
  stop                         Stop proxy through its private socket
  serve                        Run local Unix-socket proxy in foreground
  status                       Show proxy health and budgets
  rate-limit [--json]          Show personal and App quotas with access modes
  quotas [--json]              Alias for rate-limit
  doctor                       Check config, key files, and daemon
  exec -- gh <arguments>        Run gh with scoped proxy settings
  enable-gh                    Persist proxy socket in gh config
  disable-gh                   Restore the previous gh socket setting

Configuration: GITHUBPROXYAPI_CONFIG or ~/.config/githubproxyapi/config.json
`;
function options(args: string[], allowed: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) { const name = args[i]; const value = args[i + 1]; if (!name || !allowed.includes(name) || !value || value.startsWith('--')) throw new Error('Invalid command options; use --help'); result.set(name, [...(result.get(name) || []), value]); }
  return result;
}
async function main(args: string[]): Promise<void> {
  const command = args.shift(); const path = configPath(); const backupPath = join(dirname(path), 'gh-backup.json');
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (command === 'init') { if (args.length) throw new Error('init does not accept arguments'); try { await access(path); } catch { await saveConfig(defaultConfig(path), path); console.log(`Created ${path}`); return; } throw new Error('Configuration already exists'); }
  if (command === 'disable-gh') { if (args.length) throw new Error('disable-gh does not accept arguments'); await disableGh(backupPath); console.log('Restored gh socket setting'); return; }
  if (command === 'apps' && args[0] === 'discover') {
    const opts = options(args.slice(1), ['--app-id', '--key-file']);
    const id = opts.get('--app-id'), key = opts.get('--key-file');
    if (id?.length !== 1 || !/^[1-9][0-9]*$/.test(id[0]!) || !Number.isSafeInteger(Number(id[0])) || key?.length !== 1) throw new Error('Use apps discover --app-id ID --key-file PATH');
    console.log(JSON.stringify(await discoverInstallations(id[0]!, resolve(key[0]!)), null, 2)); return;
  }
  const config = await loadConfig(path);
  if (command === 'config' && args.join(' ') === 'validate') { console.log('Configuration valid'); return; }
  if (command === 'apps' && args[0] === 'add') {
    args.shift();
    const opts = options(args, ['--name','--app-id','--installation-id','--key-file','--repo','--permission']);
    const one = (name: string): string => { const values = opts.get(name); if (values?.length !== 1) throw new Error(`Provide exactly one ${name}`); return values[0]!; };
    const app: AppConfig = { name: one('--name'), appId: one('--app-id'), installationId: Number(one('--installation-id')), privateKeyPath: resolve(one('--key-file')), repositories: (opts.get('--repo') || []).map(value => { const split = value.lastIndexOf(':'); return { name: value.slice(0, split), id: Number(value.slice(split + 1)) }; }), permissions: Object.fromEntries((opts.get('--permission') || []).map(permission => [permission as Permission, 'read'])) };
    config.apps.push(app); validateConfig(config, path); await saveConfig(config, path); console.log(`Added ${app.name}`); return;
  }
  if (command === 'apps' && args.join(' ') === 'list') { console.log(JSON.stringify(config.apps.map(({ name, appId, installationId, repositories, permissions }) => ({ name, appId, installationId, repositories, permissions })), null, 2)); return; }
  if (command === 'enroll-caller') {
    if (args.length && args.join(' ') !== '--token-stdin') throw new Error('Use enroll-caller [--token-stdin]');
    let token: string;
    if (args[0] === '--token-stdin') { let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 16384) throw new Error('Credential input too large'); } token = raw.trim(); }
    else { try { token = (await promisify(execFile)('gh', ['auth', 'token', '--hostname', 'github.com'], { maxBuffer: 16384 })).stdout.trim(); } catch { throw new Error('Could not read gh credential; authenticate gh or use --token-stdin'); } }
    if (!token || /\s/.test(token)) throw new Error('Expected one nonempty token');
    const hash = createHash('sha256').update(token).digest('hex'); if (!config.callerFingerprints.includes(hash)) config.callerFingerprints.push(hash); await saveConfig(config, path); console.log('Caller enrolled. Restart the proxy to apply.'); return;
  }
  if (command === 'rate-limit' || command === 'quotas') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) throw new Error(`Use ${command} [--json]`);
    let rows = quotaRows(await getStatus(config.socketPath), config.apps);
    try {
      const { stdout } = await promisify(execFile)('gh', ['api', 'rate_limit'], { maxBuffer: 1024 * 1024 });
      rows = withPersonalRateLimit(rows, JSON.parse(stdout));
    } catch { /* Retain the last observed personal quotas if the live query fails. */ }
    if (args[0] === '--json') console.log(JSON.stringify({ generatedAt: new Date().toISOString(), quotas: rows }, null, 2));
    else console.log(formatQuotas(rows));
    return;
  }
  if (command === 'exec') { if (args[0] === '--') args.shift(); if (args.shift() !== 'gh') throw new Error('Use exec -- gh <arguments>'); process.exitCode = await scopedGh(config.socketPath, args); return; }
  if (args.length) throw new Error('Unexpected arguments; use --help');
  if (command === 'start') {
    try { await getStatus(config.socketPath, 300); console.log('Proxy already running'); return; } catch { /* Start when no healthy daemon exists. */ }
    const logPath = join(dirname(path), 'proxy.log');
    const log = await open(logPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await log.chmod(0o600);
    let failure = false;
    try {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'serve'], {
        detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, GITHUBPROXYAPI_CONFIG: path },
      });
      child.once('error', () => { failure = true; }); child.once('exit', () => { failure = true; }); child.unref();
    } finally { await log.close(); }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !failure) {
      try { await getStatus(config.socketPath, 300); console.log(`Proxy started. Log: ${logPath}`); return; } catch { await delay(100); }
    }
    throw new Error(`Proxy did not start; inspect ${logPath}`);
  }
  if (command === 'stop') { await stopProxy(config.socketPath); console.log('Proxy shutdown requested'); return; }
  if (command === 'serve') { const proxy = await startProxy(config); console.log(`Listening on ${config.socketPath}`); let closing = false; const close = () => { if (!closing) { closing = true; void proxy.close().catch(() => { process.exitCode = 1; }); } }; process.once('SIGINT', close); process.once('SIGTERM', close); return; }
  if (command === 'status') { console.log(JSON.stringify(await getStatus(config.socketPath), null, 2)); return; }
  if (command === 'enable-gh') { await enableGh(config.socketPath, backupPath); console.log('Enabled gh proxy socket'); return; }
  if (command === 'doctor') { for (const app of config.apps) { let key; try { key = await stat(app.privateKeyPath); await readFile(app.privateKeyPath); } catch { throw new Error(`Cannot read key for app ${app.name}`); } if (!key.isFile() || (key.mode & 0o077)) throw new Error(`Key for app ${app.name} must be a private file (chmod 600)`); } await getStatus(config.socketPath); console.log(`Healthy: ${config.apps.length} apps, ${config.callerFingerprints.length} enrolled callers`); return; }
  throw new Error('Unknown command; use --help');
}
main(process.argv.slice(2)).catch(error => { console.error(`githubproxyapi: ${error instanceof Error ? error.message : 'Command failed'}`); process.exitCode = 1; });
