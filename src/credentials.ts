import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import type { AppConfig, TokenInfo, TokenProvider } from './types.js';

export interface CredentialOptions {
  apiBaseUrl?: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function baseUrl(options: CredentialOptions): string {
  const url = new URL(options.apiBaseUrl ?? 'https://api.github.com');
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('GitHub API URL must use HTTPS (HTTP is allowed only for loopback tests)');
  }
  return url.href.replace(/\/$/, '');
}

async function jwt(appId: string, keyPath: string, now: number): Promise<string> {
  try {
    const key = createPrivateKey(await readFile(keyPath));
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Invalid key');
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const seconds = Math.floor(now / 1_000);
    const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
    return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`;
  } catch {
    throw new Error('Unable to sign GitHub App authentication; check the configured RSA private key');
  }
}

async function request(options: CredentialOptions, path: string, bearer: string, body?: unknown): Promise<unknown> {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl(options)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${bearer}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'GitHubProxyAPI',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 15_000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub App API request failed (HTTP ${response.status})`);
    }
    return await response.json();
  } catch (error) {
    // Neither GitHub response bodies nor network errors are safe to log: they may contain tokens.
    if (error instanceof Error && /^GitHub App API request failed \(HTTP \d{3}\)$/.test(error.message)) throw error;
    throw new Error('GitHub App API request failed or timed out');
  }
}

function scopeKey(app: AppConfig): string {
  return JSON.stringify([app.appId, app.installationId, app.privateKeyPath,
    app.repositories.map(repo => repo.id).sort((a, b) => a - b),
    Object.entries(app.permissions).sort(([a], [b]) => a.localeCompare(b))]);
}

function parseToken(value: unknown, app: AppConfig, now: number): TokenInfo {
  const invalid = () => new Error('GitHub returned an invalid or unexpectedly scoped installation token');
  if (!object(value) || typeof value.token !== 'string' || !value.token.trim() ||
      typeof value.expires_at !== 'string' || !object(value.permissions) || !Array.isArray(value.repositories)) throw invalid();
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 60_000) throw invalid();
  const permissions: Record<string, string> = {};
  for (const [name, level] of Object.entries(value.permissions)) {
    if (level !== 'read' || (name !== 'metadata' && app.permissions[name as keyof typeof app.permissions] !== 'read')) throw invalid();
    permissions[name] = level;
  }
  for (const [name, level] of Object.entries(app.permissions)) {
    if (permissions[name] !== level) throw invalid();
  }
  const repositoryIds = value.repositories.map(repo => {
    if (!object(repo) || !Number.isSafeInteger(repo.id) || Number(repo.id) <= 0) throw invalid();
    return Number(repo.id);
  });
  const expected = new Set(app.repositories.map(repo => repo.id));
  if (new Set(repositoryIds).size !== repositoryIds.length || repositoryIds.length !== expected.size ||
      repositoryIds.some(id => !expected.has(id))) throw invalid();
  return { token: value.token, expiresAt, permissions, repositoryIds };
}

/**
 * Inspired by bored-engineer/github-api-proxy's installation-token transport:
 * https://github.com/bored-engineer/github-api-proxy
 * This independent TypeScript implementation narrows every token to enrolled repositories/read permissions.
 */
export class AppTokenProvider implements TokenProvider {
  private readonly cache = new Map<string, TokenInfo>();
  private readonly pending = new Map<string, Promise<TokenInfo>>();
  constructor(private readonly options: CredentialOptions = {}) { baseUrl(options); }

  async getToken(app: AppConfig): Promise<TokenInfo> {
    if (!app.repositories.length || !Object.keys(app.permissions).length ||
        Object.values(app.permissions).some(level => level !== 'read')) {
      throw new Error('App installation tokens require explicit repositories and read permissions');
    }
    const key = scopeKey(app);
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now + 60_000) return structuredClone(cached);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.mint(app).then(token => {
        if (this.pending.get(key) === pending) this.cache.set(key, token);
        return token;
      }).finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
      this.pending.set(key, pending);
    }
    return structuredClone(await pending);
  }

  invalidate(app: AppConfig): void {
    const key = scopeKey(app);
    this.cache.delete(key);
    this.pending.delete(key);
  }

  private async mint(app: AppConfig): Promise<TokenInfo> {
    const clock = this.options.now ?? Date.now;
    const bearer = await jwt(app.appId, app.privateKeyPath, clock());
    const response = await request(this.options, `/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`, bearer, {
      repository_ids: app.repositories.map(repo => repo.id), permissions: app.permissions,
    });
    return parseToken(response, app, clock());
  }
}

export interface DiscoveredInstallation {
  id: number;
  account: { login: string; type: string };
  repositorySelection: string;
  permissions: Record<string, string>;
}

export async function discoverInstallations(appId: string, privateKeyPath: string, options: CredentialOptions = {}): Promise<DiscoveredInstallation[]> {
  const installations: DiscoveredInstallation[] = [];
  for (let page = 1; page <= 1_000; page++) {
    const bearer = await jwt(appId, privateKeyPath, (options.now ?? Date.now)());
    const response = await request(options, `/app/installations?per_page=100&page=${page}`, bearer);
    if (!Array.isArray(response)) throw new Error('GitHub returned invalid installation metadata');
    for (const entry of response) {
      if (!object(entry) || !Number.isSafeInteger(entry.id) || Number(entry.id) <= 0 || !object(entry.account) ||
          typeof entry.account.login !== 'string' || typeof entry.account.type !== 'string' ||
          typeof entry.repository_selection !== 'string' || !object(entry.permissions) ||
          Object.values(entry.permissions).some(level => typeof level !== 'string')) {
        throw new Error('GitHub returned invalid installation metadata');
      }
      installations.push({ id: Number(entry.id), account: { login: entry.account.login, type: entry.account.type },
        repositorySelection: entry.repository_selection, permissions: entry.permissions as Record<string, string> });
    }
    if (response.length < 100) return installations;
  }
  throw new Error('GitHub installation discovery exceeded its pagination limit');
}
