import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { startProxy } from '../src/proxy.js';
import type { Config } from '../src/types.js';

async function fixture(t: test.TestContext, serve: http.RequestListener, timeout = 2000) {
  const directory = await mkdtemp(join(tmpdir(), 'ghpr-'));
  const upstream = http.createServer(serve);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const config: Config = { version: 1, socketPath: join(directory, 'p.sock'), statePath: join(directory, 'state.json'), maxConcurrency: 2, requestTimeoutMs: timeout, accessTtlMs: 1000, callerFingerprints: [], apps: [] };
  const proxy = await startProxy(config, { upstreams: { 'api.github.com': `http://127.0.0.1:${address.port}` } });
  t.after(async () => {
    await proxy.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return config;
}

function request(config: Config, path: string, body?: string) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = http.request({ socketPath: config.socketPath, path, method: body ? 'POST' : 'GET', headers: { host: 'api.github.com', authorization: 'token fixture', ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

test('gzip GraphQL rate limit pauses the pool and preserves original bytes', async t => {
  const compressed = gzipSync('{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}');
  let calls = 0;
  const config = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(compressed);
  });
  const first = await request(config, '/graphql', '{"query":"query { viewer { login } }"}');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, compressed);
  assert.equal((await request(config, '/user')).status, 429);
  assert.equal(calls, 1);
});

test('incomplete GraphQL upload obeys configured request timeout', { timeout: 3000 }, async t => {
  const config = await fixture(t, (_req, res) => { res.end('{}'); }, 80);
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ socketPath: config.socketPath, path: '/graphql', method: 'POST', headers: { host: 'api.github.com', authorization: 'token fixture', 'content-length': '100' } }, res => {
      clearTimeout(guard);
      res.resume();
      assert.equal(res.statusCode, 504);
      resolve();
    });
    const guard = setTimeout(() => { req.destroy(); reject(new Error('incomplete body exceeded request timeout')); }, 800);
    req.on('error', error => {
      clearTimeout(guard);
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' && Date.now() - started < 700) resolve();
      else reject(error);
    });
    req.write('{'); // Deliberately leave the remaining body unsent.
  });
  assert.ok(Date.now() - started < 700);
});
