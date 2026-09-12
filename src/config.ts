import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Config } from './types.js';

export const configPath = (): string => process.env.GITHUBPROXYAPI_CONFIG || join(homedir(), '.config/githubproxyapi/config.json');
export function defaultConfig(path = configPath()): Config {
  return { version: 1, socketPath: join(dirname(path), 'proxy.sock'), statePath: join(dirname(path), 'state.json'), maxConcurrency: 8, requestTimeoutMs: 30000, accessTtlMs: 60000, callerFingerprints: [], apps: [] };
}
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0;
export function validateConfig(input: unknown, path = configPath()): Config {
  requireValue(record(input), 'Configuration must be an object');
  requireValue(isAbsolute(path), 'Configuration path must be absolute');
  requireValue(Object.keys(input).every(k => ['version','socketPath','statePath','maxConcurrency','requestTimeoutMs','accessTtlMs','callerFingerprints','apps'].includes(k)), 'Unknown configuration field');
  const c = { ...defaultConfig(path), ...input };
  requireValue(c.version === 1, 'Configuration version must be 1');
  for (const key of ['socketPath', 'statePath'] as const) requireValue(typeof c[key] === 'string' && isAbsolute(c[key]), `${key} must be an absolute path`);
  requireValue(c.socketPath !== c.statePath, 'Socket and state paths must differ');
  requireValue(positive(c.maxConcurrency) && c.maxConcurrency <= 128, 'maxConcurrency must be 1–128');
  requireValue(positive(c.requestTimeoutMs) && c.requestTimeoutMs <= 300000, 'requestTimeoutMs must be 1–300000');
  requireValue(positive(c.accessTtlMs) && c.accessTtlMs <= 60000, 'accessTtlMs must be 1–60000');
  requireValue(Array.isArray(c.callerFingerprints) && c.callerFingerprints.every((v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)), 'callerFingerprints must contain SHA-256 hex hashes');
  requireValue(Array.isArray(c.apps), 'apps must be an array');
  const ids = new Set<number>(); const names = new Set<string>();
  for (const app of c.apps) {
    requireValue(record(app), 'Each app must be an object');
    requireValue(Object.keys(app).every(k => ['name','appId','installationId','privateKeyPath','repositories','permissions'].includes(k)), 'Unknown app configuration field');
    requireValue(typeof app.name === 'string' && /^[a-zA-Z0-9_-]+$/.test(app.name), 'App name must contain letters, digits, underscores or hyphens');
    requireValue(!names.has(app.name), 'App names must be unique'); names.add(app.name);
    requireValue(typeof app.appId === 'string' && /^[1-9][0-9]*$/.test(app.appId) && positive(Number(app.appId)), 'appId must be a positive integer string');
    requireValue(positive(app.installationId), 'installationId must be a positive safe integer');
    requireValue(!ids.has(app.installationId), 'Duplicate installation'); ids.add(app.installationId);
    requireValue(typeof app.privateKeyPath === 'string' && isAbsolute(app.privateKeyPath), 'privateKeyPath must be absolute');
    requireValue(Array.isArray(app.repositories) && app.repositories.length > 0, 'Apps require at least one repository');
    const repos = new Set<string>(); const repoIds = new Set<number>();
    for (const repo of app.repositories) {
      requireValue(record(repo) && typeof repo.name === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo.name) && positive(repo.id), 'Repository must have owner/name and positive numeric id');
      requireValue(!repos.has(repo.name.toLowerCase()) && !repoIds.has(repo.id), 'Duplicate app repository'); repos.add(repo.name.toLowerCase()); repoIds.add(repo.id);
    }
    requireValue(record(app.permissions) && Object.keys(app.permissions).length > 0 && Object.entries(app.permissions).every(([k,v]) => ['contents','issues','pull_requests','actions'].includes(k) && v === 'read'), 'Permissions must be explicit supported read permissions');
  }
  return c as Config;
}
export async function loadConfig(path = configPath()): Promise<Config> {
  let data: unknown;
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Cannot read configuration; run init or check the config file'); }
  return validateConfig(data, path);
}
export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  validateConfig(config, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
