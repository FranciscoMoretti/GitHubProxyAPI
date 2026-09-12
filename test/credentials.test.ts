import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppTokenProvider, discoverInstallations } from '../src/credentials.js';
import type { AppConfig } from '../src/types.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
let directory: string;
let app: AppConfig;
const initialNow = Date.parse('2026-09-12T12:00:00Z');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'githubproxyapi-credentials-'));
  const keyPath = join(directory, 'private.pem');
  await writeFile(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  app = { name: 'test', appId: '123', installationId: 456, privateKeyPath: keyPath,
    repositories: [{ name: 'owner/repo', id: 10 }], permissions: { contents: 'read' } };
});
after(async () => { await rm(directory, { recursive: true, force: true }); });
const token = (now: number, overrides = {}) => ({ token: 'secret-installation-token',
  expires_at: new Date(now + 3_600_000).toISOString(), permissions: { contents: 'read', metadata: 'read' },
  repositories: [{ id: 10 }], ...overrides });

test('signs valid RS256 JWT, scopes token, single-flights mint, and refreshes before expiry', async () => {
  let now = initialNow;
  let calls = 0;
  const provider = new AppTokenProvider({ now: () => now, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.github.com/app/installations/456/access_tokens');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), { repository_ids: [10], permissions: { contents: 'read' } });
    const bearer = new Headers(init?.headers).get('authorization')!.slice(7);
    const [header, payload, signature] = bearer.split('.') as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), {
      iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: '123',
    });
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url')));
    return Response.json(token(now));
  } });
  const values = await Promise.all(Array.from({ length: 12 }, () => provider.getToken(app)));
  assert.equal(calls, 1);
  values[0]!.permissions.contents = 'write';
  assert.equal((await provider.getToken(app)).permissions.contents, 'read');
  now += 3_540_000;
  await provider.getToken(app);
  assert.equal(calls, 2);
  provider.invalidate(app);
  await provider.getToken(app);
  assert.equal(calls, 3);
});

test('cache separates installations and repository scopes', async () => {
  let calls = 0;
  const provider = new AppTokenProvider({ now: () => initialNow, fetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    return Response.json(token(initialNow, { repositories: body.repository_ids.map((id: number) => ({ id })) }));
  } });
  await provider.getToken(app);
  await provider.getToken({ ...app, installationId: 457 });
  await provider.getToken({ ...app, repositories: [{ name: 'owner/other', id: 11 }] });
  assert.equal(calls, 3);
});

test('invalidating an in-flight mint prevents its stale token from entering cache', async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const delayed = new Promise<void>(resolve => { releaseFirst = resolve; });
  const provider = new AppTokenProvider({ now: () => initialNow, fetch: async () => {
    const call = ++calls;
    if (call === 1) { markStarted(); await delayed; }
    return Response.json(token(initialNow, { token: `token-${call}` }));
  } });
  const first = provider.getToken(app);
  await started;
  provider.invalidate(app);
  assert.equal((await provider.getToken(app)).token, 'token-2');
  releaseFirst();
  assert.equal((await first).token, 'token-1');
  assert.equal((await provider.getToken(app)).token, 'token-2');
  assert.equal(calls, 2);
});

test('failed mint can be retried instead of caching a rejected promise', async () => {
  let calls = 0;
  const provider = new AppTokenProvider({ now: () => initialNow, fetch: async () => {
    if (++calls === 1) return new Response('unavailable', { status: 503 });
    return Response.json(token(initialNow));
  } });
  await assert.rejects(provider.getToken(app), /HTTP 503/);
  assert.equal((await provider.getToken(app)).token, 'secret-installation-token');
  assert.equal(calls, 2);
});

test('rejects invalid or overbroad token responses and never exposes response secrets', async () => {
  const bad = [
    { token: '' }, { expires_at: 'bad' }, { expires_at: new Date(initialNow).toISOString() },
    { permissions: { contents: 'write' } }, { permissions: {} },
    { permissions: { contents: 'read', administration: 'read' } },
    { repositories: [{ id: 10 }, { id: 11 }] }, { repositories: [] },
    { repositories: [{ id: 10 }, { id: 10 }] },
  ];
  for (const overrides of bad) {
    const provider = new AppTokenProvider({ now: () => initialNow, fetch: async () => Response.json(token(initialNow, overrides)) });
    await assert.rejects(provider.getToken(app), error => error instanceof Error &&
      error.message.includes('invalid or unexpectedly scoped') && !error.message.includes('secret'));
  }
  for (const mock of [
    async () => new Response('secret-sensitive-upstream-body', { status: 403 }),
    async () => { throw new Error('secret-sensitive-network-error'); },
    async () => new Response('secret-not-json'),
  ]) {
    const provider = new AppTokenProvider({ fetch: mock });
    await assert.rejects(provider.getToken(app), error => error instanceof Error && !error.message.includes('secret'));
  }
});

test('rejects unscoped requests and invalid private keys before network calls', async () => {
  const provider = new AppTokenProvider({ fetch: async () => { assert.fail('unexpected request'); } });
  await assert.rejects(provider.getToken({ ...app, repositories: [] }), /explicit repositories/);
  await assert.rejects(provider.getToken({ ...app, permissions: {} }), /read permissions/);
  await assert.rejects(provider.getToken({ ...app, privateKeyPath: '/nonexistent-secret-key' }), error =>
    error instanceof Error && !error.message.includes('nonexistent-secret'));
});

test('discovers paginated installations and returns only public metadata', async () => {
  let calls = 0;
  const results = await discoverInstallations(app.appId, app.privateKeyPath, { fetch: async url => {
    calls++;
    assert.equal(new URL(String(url)).searchParams.get('page'), String(calls));
    const entries = Array.from({ length: calls === 1 ? 100 : 1 }, (_, i) => ({
      id: (calls - 1) * 100 + i + 1, account: { login: 'owner', type: 'User' },
      repository_selection: 'selected', permissions: { contents: 'read' }, access_token: 'secret',
    }));
    return Response.json(entries);
  } });
  assert.equal(results.length, 101);
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(results).includes('secret'));
});

test('refuses insecure remote API base URLs', () => {
  assert.throws(() => new AppTokenProvider({ apiBaseUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => new AppTokenProvider({ apiBaseUrl: 'https://user:secret@example.com' }), /HTTPS/);
});
