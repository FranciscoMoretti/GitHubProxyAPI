import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { defaultConfig, saveConfig } from '../src/config.js';
import { getStatus, ghSocket } from '../src/control.js';
import { activationFd } from '../src/activation.js';
import { ManagedService, type Installation, type ServiceDriver } from '../src/service.js';

const available = ['darwin', 'linux'].includes(process.platform) && spawnSync('gh', ['--version']).status === 0 && spawnSync('python3', ['--version']).status === 0;
test('invalid or foreign activation metadata fails closed and is cleared', () => {
  const env = { LISTEN_PID: '99999', LISTEN_FDS: '1', LISTEN_FDNAMES: 'ghpa' };
  assert.throws(() => activationFd(env, 123, 'linux'), /listener missing/);
  assert.deepEqual(env, {});
  assert.throws(() => activationFd({ GHPA_LAUNCH_FD: '4' }, 123, 'darwin'), /listener missing/);
});

test('real gh: queued first calls, crash recovery, identity, upgrade and uninstall', { skip: !available, timeout: 45000 }, async t => {
  const dir = await mkdtemp('/tmp/ghpa-a-'), path = join(dir, 'config.json'), gh = join(dir, 'gh');
  await mkdir(gh, { mode: 0o700 });
  await saveConfig(defaultConfig(path), path);
  const seen: { path: string; authorization?: string }[] = [];
  let rejectAuth = false, crashPid = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain request before simulating an ambiguous write. */ }
    seen.push({ path: req.url!, authorization: req.headers.authorization });
    if (req.url === '/write') { process.kill(crashPid, 'SIGKILL'); req.socket.destroy(); return; }
    res.setHeader('content-type', 'application/json');
    if (rejectAuth) { res.writeHead(401); res.end('{"message":"Bad credentials"}'); }
    else res.end('{"login":"fixture-personal"}');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  const supervisors = new Map<string, { child: ChildProcessWithoutNullStreams; starts: number; output: string }>();
  const driver: ServiceDriver = {
    async install(i) {
      const child = spawn('python3', [resolve('test/fixtures/socket-supervisor.py'), i.socketPath, process.execPath, '--import', 'tsx', resolve('test/fixtures/activated-proxy.ts')], {
        env: { PATH: process.env.PATH, HOME: dir, GITHUBPROXYAPI_CONFIG: path, GHPA_SOCKET_PATH: i.socketPath, GHPA_GENERATION: i.generation, FIXTURE_UPSTREAM: `http://127.0.0.1:${address.port}` },
        stdio: 'pipe',
      });
      const entry = { child, starts: 0, output: '' };
      supervisors.set(i.generation, entry);
      child.stdout.on('data', data => { entry.output += data.toString(); entry.starts += (data.toString().match(/started /g) ?? []).length; });
      child.stderr.on('data', data => { entry.output += data.toString(); });
      await new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(entry.output)), 5000);
        child.once('error', reject);
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(entry.output)); });
        child.stdout.on('data', () => { if (entry.output.includes('ready')) { clearTimeout(timeout); resolveReady(); } });
      });
    },
    async remove(i) {
      const entry = supervisors.get(i.generation);
      if (!entry) return;
      const exited = once(entry.child, 'exit'); entry.child.stdin.end(); await exited;
      supervisors.delete(i.generation);
    },
    async inspect() { return 'isolated descriptor supervisor (not launchd/systemd)'; },
  };
  t.after(async () => {
    for (const entry of supervisors.values()) { const exited = once(entry.child, 'exit'); entry.child.stdin.end(); await exited; }
    upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  const environment = {
    PATH: process.env.PATH, HOME: dir, GH_CONFIG_DIR: gh, GH_TOKEN: 'fixture-personal-token', GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', DO_NOT_TRACK: '1', NO_COLOR: '1',
    XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'), XDG_DATA_HOME: join(dir, 'data'),
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '',
  };
  const runGh = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(r => {
    execFile('gh', args, { env: environment, cwd: dir, timeout: 8000 }, (error, stdout, stderr) => r({ code: error ? 1 : 0, stdout, stderr }));
  });
  const initial: Installation = { version: 1, platform: process.platform as 'darwin' | 'linux', generation: 'initial', label: 'fixture', directory: dir, socketPath: join(dir, 'p.sock'), configPath: path, ghDirectory: gh, definitionDirectory: dir };
  await driver.install(initial);
  await writeFile(join(gh, 'config.yml'), `http_unix_socket: ${initial.socketPath}\n`);
  await t.test('the listening socket queues concurrent first calls before the daemon exists', async () => {
    assert.equal(supervisors.get('initial')!.starts, 0);
    const calls = await Promise.all(Array.from({ length: 8 }, () => runGh('api', 'user', '--jq', '.login')));
    for (const call of calls) { assert.equal(call.code, 0, call.stderr + supervisors.get('initial')!.output); assert.equal(call.stdout.trim(), 'fixture-personal'); }
    assert.equal(supervisors.get('initial')!.starts, 1);
    assert.equal((await stat(initial.socketPath)).mode & 0o777, 0o600);
  });
  await t.test('SIGKILL preserves the OS-owned listener and the next gh call starts a new process', async () => {
    const before = await getStatus(initial.socketPath) as { pid: number };
    const inode = (await stat(initial.socketPath)).ino;
    process.kill(before.pid, 'SIGKILL');
    const result = await runGh('api', 'user'); assert.equal(result.code, 0, result.stderr);
    const after = await getStatus(initial.socketPath) as { pid: number };
    assert.notEqual(before.pid, after.pid);
    assert.equal((await stat(initial.socketPath)).ino, inode);
    assert.equal(supervisors.get('initial')!.starts, 2);
  });
  await t.test('an ambiguous write fails once and is never replayed on restart', async () => {
    crashPid = (await getStatus(initial.socketPath) as { pid: number }).pid;
    const result = await runGh('api', 'write', '-X', 'POST', '-f', 'body=once');
    assert.notEqual(result.code, 0);
    const next = await runGh('api', 'user'); assert.equal(next.code, 0, next.stderr);
    assert.equal(seen.filter(s => s.path === '/write').length, 1);
  });
  await t.test('GitHub 401 is distinguishable from missing local transport', async () => {
    rejectAuth = true;
    const result = await runGh('api', 'user'); assert.notEqual(result.code, 0); assert.match(result.stderr, /401/);
    assert.ok(await getStatus(initial.socketPath));
    const authRequests = seen.length;
    assert.notEqual((await runGh('auth', 'status')).code, 0);
    assert.ok(seen.length > authRequests, 'auth status reached the fixture GitHub API');
    rejectAuth = false;
    await driver.remove(initial);
    const requests = seen.length;
    const offline = await runGh('api', 'user'); assert.notEqual(offline.code, 0); assert.doesNotMatch(offline.stderr, /HTTP 401/);
    await assert.rejects(getStatus(initial.socketPath), /local transport, not a GitHub authentication result/);
    assert.equal(seen.length, requests);
    assert.notEqual((await runGh('auth', 'status')).code, 0);
    assert.equal(seen.length, requests, 'offline auth status cannot establish token validity');
  });
  await t.test('verified upgrades keep ordinary gh working and uninstall restores unrelated settings', async () => {
    await writeFile(join(gh, 'config.yml'), 'git_protocol: ssh\n');
    const service = new ManagedService(path, { driver, prepare: async () => {}, home: dir, ghDirectory: gh });
    const first = await service.enable();
    assert.equal((await runGh('api', 'user')).code, 0);
    const second = await service.enable();
    assert.notEqual(first.generation, second.generation);
    assert.equal(supervisors.size, 1);
    assert.equal((await runGh('api', 'user')).code, 0);
    await service.uninstall(); assert.equal(supervisors.size, 0);
    assert.equal(await ghSocket(gh), undefined);
    assert.match(await readFile(join(gh, 'config.yml'), 'utf8'), /git_protocol: ssh/);
  });
  assert.ok(seen.every(s => s.authorization === 'token fixture-personal-token'));
});
