import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/types.js';

const hasGh = spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;

test('official gh runs through the socket without duplicating CLI behavior', { skip: !hasGh, timeout: 30_000 }, async t => {
  const { startProxy } = await import('../src/proxy.js');
  const directory = await mkdtemp(join(tmpdir(), 'ghp-'));
  let stopProxy: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stopProxy?.();
    if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const socketPath = join(directory, 'p.sock');
  const ghDirectory = join(directory, 'gh');
  await mkdir(ghDirectory);
  await writeFile(join(ghDirectory, 'config.yml'), `http_unix_socket: ${JSON.stringify(socketPath)}\nprompt: disabled\n`);
  const seen: { url: string; auth?: string; body: string }[] = [];
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255, 10]);
  const upstream = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url!, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    const requestUrl = new URL(req.url!, 'http://fixture');
    const route = requestUrl.pathname === '/items' && requestUrl.searchParams.get('page') === '2' ? '/items?page=2' : requestUrl.pathname;
    switch (route) {
      case '/user': res.end(JSON.stringify({ login: 'socket-user' })); break;
      case '/graphql': res.end(JSON.stringify({ data: { viewer: { login: 'socket-user' } } })); break;
      case '/items':
        res.setHeader('link', '<https://api.github.com/items?page=2>; rel="next"');
        res.end('[{"id":1}]'); break;
      case '/items?page=2': res.end('[{"id":2}]'); break;
      case '/binary': res.setHeader('content-type', 'application/octet-stream'); res.end(bytes); break;
      case '/missing': res.statusCode = 404; res.end('{"message":"Fixture missing"}'); break;
      default: res.statusCode = 500; res.end('{"message":"Unexpected fixture request"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const config: Config = {
    version: 1, socketPath, statePath: join(directory, 'state.json'),
    maxConcurrency: 8, requestTimeoutMs: 5000, accessTtlMs: 1000,
    callerFingerprints: [], apps: [],
  };
  const proxy = await startProxy(config, { upstreams: { 'api.github.com': `http://127.0.0.1:${address.port}` } });
  stopProxy = () => proxy.close();
  // Isolated settings/token: no interaction with the real user's GitHub login.
  // Normal TCP egress is directed to a closed local port as an extra safeguard.
  const environment = {
    PATH: process.env.PATH, HOME: directory, GH_CONFIG_DIR: ghDirectory,
    GH_TOKEN: 'fixture-personal-token', GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    DO_NOT_TRACK: '1', NO_COLOR: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '',
  };
  const runGh = (args: string[]) => new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>(resolve => {
    execFile('gh', args, { env: environment, cwd: directory, encoding: 'buffer', timeout: 8000 }, (error, stdout, stderr) => {
      resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr });
    });
  });
  await t.test('REST and jq formatting', async () => {
    const result = await runGh(['api', 'user', '--jq', '.login']);
    assert.equal(result.code, 0, result.stderr.toString());
    assert.equal(result.stdout.toString().trim(), 'socket-user');
  });
  await t.test('GraphQL body and jq formatting', async () => {
    const result = await runGh(['api', 'graphql', '-f', 'query=query { viewer { login } }', '--jq', '.data.viewer.login']);
    assert.equal(result.code, 0, result.stderr.toString());
    assert.equal(result.stdout.toString().trim(), 'socket-user');
    assert.deepEqual(JSON.parse(seen.find(request => request.url === '/graphql')!.body), { query: 'query { viewer { login } }' });
  });
  await t.test('pagination follows absolute GitHub links', async () => {
    const result = await runGh(['api', 'items', '--paginate', '--jq', '.[].id']);
    assert.equal(result.code, 0, result.stderr.toString());
    assert.equal(result.stdout.toString().trim(), '1\n2');
    assert.ok(seen.some(request => request.url === '/items?page=2'));
  });
  await t.test('binary response bytes are preserved', async () => {
    const result = await runGh(['api', 'binary']);
    assert.equal(result.code, 0, result.stderr.toString());
    assert.deepEqual(result.stdout, bytes);
  });
  await t.test('GitHub errors retain CLI failure behavior', async () => {
    const result = await runGh(['api', 'missing']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr.toString(), /404/);
    assert.match(result.stderr.toString(), /Fixture missing/);
  });
  assert.ok(seen.length >= 6);
  assert.ok(seen.every(request => request.auth === 'token fixture-personal-token'), 'personal authentication must reach upstream unchanged');
});
