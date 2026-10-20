import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfig, saveConfig } from '../src/config.js';
import { disableGh, ghSocket } from '../src/control.js';
import { definitions, installedService, ManagedService, prepareRuntime, type Installation, type ServiceDriver } from '../src/service.js';
import { atomic } from '../src/files.js';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp('/tmp/ghpa-s-');
  const path = join(dir, 'config.json'), gh = join(dir, 'gh');
  await mkdir(gh, { mode: 0o700 }); await saveConfig(defaultConfig(path), path);
  await writeFile(join(gh, 'config.yml'), '# preserved\ngit_protocol: ssh\nhttp_unix_socket: /original.sock\n');
  const servers = new Map<string, Server>();
  const events: string[] = [];
  let failInstall = false, failRemove = false;
  const driver: ServiceDriver = {
    async install(i) {
      events.push('install');
      if (failInstall) throw new Error('fixture registration failed');
      const server = createServer((_req, res) => res.end(JSON.stringify({ generation: i.generation })));
      await new Promise<void>(r => server.listen(i.socketPath, r)); await chmod(i.socketPath, 0o600);
      servers.set(i.generation, server);
    },
    async remove(i) {
      events.push('remove');
      if (failRemove) throw new Error('fixture cleanup failed');
      assert.notEqual(await ghSocket(gh), i.socketPath, 'never remove current gh transport');
      const server = servers.get(i.generation);
      if (server) { await new Promise<void>(r => server.close(() => r())); servers.delete(i.generation); }
    },
    async inspect() { return 'fixture'; },
  };
  const options = { driver, prepare: async () => {}, home: dir, ghDirectory: gh };
  const service = new ManagedService(path, options);
  t.after(async () => {
    for (const server of servers.values()) await new Promise<void>(r => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path, gh, service, options, servers, events,
    failInstall: () => { failInstall = true; }, failRemove: (value: boolean) => { failRemove = value; } };
}

test('setup verifies service, upgrades without losing original config, and restores before removal', async t => {
  const f = await fixture(t);
  const first = await f.service.enable();
  assert.equal(await ghSocket(f.gh), first.socketPath);
  await writeFile(join(f.gh, 'config.yml'), (await readFile(join(f.gh, 'config.yml'), 'utf8')) + 'editor: vim\n');
  const second = await f.service.enable();
  assert.notEqual(first.generation, second.generation);
  assert.equal(f.servers.size, 1);
  assert.equal(await ghSocket(f.gh), second.socketPath);
  await f.service.uninstall();
  assert.equal(await ghSocket(f.gh), '/original.sock');
  assert.match(await readFile(join(f.gh, 'config.yml'), 'utf8'), /# preserved[\s\S]*editor: vim/);
  assert.equal(f.servers.size, 0);
  assert.equal(await installedService(f.path), undefined);
  await f.service.uninstall();
});
test('registration and health failures preserve the original transport and previous service', async t => {
  const f = await fixture(t);
  f.failInstall();
  await assert.rejects(f.service.enable(), /registration failed/);
  assert.equal(await ghSocket(f.gh), '/original.sock');
  const g = await fixture(t);
  const first = await g.service.enable();
  const failing = new ManagedService(g.path, { ...g.options, health: async () => { throw new Error('fixture health failed'); } });
  await assert.rejects(failing.enable(), /health failed/);
  assert.equal(await ghSocket(g.gh), first.socketPath);
  assert.equal(g.servers.size, 1);
  assert.equal((await installedService(g.path))?.generation, first.generation);
});
test('concurrent setup serializes and user config conflicts prevent destructive uninstall', async t => {
  const f = await fixture(t);
  await Promise.all([f.service.enable(), f.service.enable()]);
  assert.equal(f.servers.size, 1);
  await writeFile(join(f.gh, 'config.yml'), 'http_unix_socket: /edited.sock\n');
  await assert.rejects(f.service.uninstall(), /refusing/);
  assert.equal(f.servers.size, 1);
  await assert.rejects(f.service.enable(), /refusing/);
  assert.equal(f.servers.size, 1);
});
test('committed upgrade cleanup is journaled and recovered without reverting live gh', async t => {
  const f = await fixture(t);
  await f.service.enable(); f.failRemove(true);
  await assert.rejects(f.service.enable(), /New service is active/);
  const current = await ghSocket(f.gh);
  assert.equal((await installedService(f.path))?.socketPath, current);
  assert.equal(f.servers.size, 2);
  f.failRemove(false);
  await f.service.uninstall();
  assert.equal(f.servers.size, 0);
  assert.equal(await ghSocket(f.gh), '/original.sock');
});
test('interrupted pre-commit setup is recovered and disabled service can be re-enabled', async t => {
  const f = await fixture(t);
  const first = await f.service.enable();
  const candidate = { ...first, generation: 'interrupted', directory: join(f.dir, 'interrupted'), socketPath: join(f.dir, 'interrupted/p.sock') };
  await mkdir(candidate.directory, { mode: 0o700 }); await f.options.driver.install(candidate);
  await atomic(join(f.dir, 'service/pending.json'), JSON.stringify({ candidate, previous: first }));
  await disableGh(join(f.dir, 'gh-backup.json'), f.gh);
  await f.service.enable();
  assert.equal(f.servers.size, 1);
  await f.service.uninstall(); assert.equal(await ghSocket(f.gh), '/original.sock');
});
test('native launcher compiles and runtime snapshot works without shell or source install', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const i: Installation = {
    version: 1, platform: process.platform as 'darwin' | 'linux', generation: 'copy', label: 'dev.ghpa.fixture',
    directory: join(f.dir, 'snapshot'), socketPath: join(f.dir, 'snapshot/p.sock'), configPath: f.path,
    ghDirectory: f.gh, definitionDirectory: f.dir,
  };
  await prepareRuntime(i);
  assert.equal((await stat(join(i.directory, 'node'))).mode & 0o777, 0o700);
  const result = await promisify(execFile)(join(i.directory, 'node'), [join(i.directory, 'app/dist/cli.js'), 'config', 'validate'], { env: { GITHUBPROXYAPI_CONFIG: f.path }, cwd: '/', timeout: 10000 });
  assert.match(result.stdout, /Configuration valid/);
  if (process.platform === 'darwin') {
    await assert.rejects(promisify(execFile)(join(i.directory, 'launch'), [join(i.directory, 'node'), join(i.directory, 'app/dist/cli.js')]), /socket activation/);
    const plist = join(f.dir, 'fixture.plist');
    await writeFile(plist, Object.values(definitions(i))[0]!);
    await promisify(execFile)('/usr/bin/plutil', ['-lint', plist]);
  } else {
    for (const [name, content] of Object.entries(definitions(i))) await writeFile(join(f.dir, name), content);
    await promisify(execFile)('/usr/bin/systemd-analyze', ['--man=no', 'verify', join(f.dir, `${i.label}.socket`), join(f.dir, `${i.label}.service`)]);
  }
});
test('service definitions quote executable paths and escape systemd specifiers without shell expansion', () => {
  const i: Installation = { version: 1, platform: 'linux', generation: 'test', label: 'dev.ghpa.fixture', directory: '/tmp/a b%$"', socketPath: '/tmp/a b%$/p.sock', configPath: '/tmp/config.json', ghDirectory: '/tmp/gh', definitionDirectory: '/tmp/units' };
  const files = definitions(i);
  assert.match(files[`${i.label}.socket`]!, /ListenStream=\/tmp\/a b%%\$\/p.sock/);
  assert.match(files[`${i.label}.service`]!, /Restart=on-failure/);
  assert.match(files[`${i.label}.service`]!, /a b%%\$\$\\"/);
  assert.match(files[`${i.label}.service`]!, /StartLimitBurst=5/);
});
test('crash between backup and gh config writes restores the backup before a retry', async t => {
  const f = await fixture(t);
  const previous = await f.service.enable();
  const backupPath = join(f.dir, 'gh-backup.json');
  const before = await readFile(backupPath, 'utf8');
  const candidate = { ...previous, generation: 'interrupted', directory: join(f.dir, 'interrupted'), socketPath: join(f.dir, 'interrupted/p.sock') };
  await mkdir(candidate.directory, { mode: 0o700 }); await f.options.driver.install(candidate);
  await atomic(join(f.dir, 'service/pending.json'), JSON.stringify({ candidate, previous, backupBefore: before }));
  await atomic(backupPath, JSON.stringify({ ...JSON.parse(before), previousSocket: previous.socketPath, socketPath: candidate.socketPath }));
  await f.service.enable();
  assert.equal(f.servers.size, 1);
  await f.service.uninstall(); assert.equal(await ghSocket(f.gh), '/original.sock');
});
test('activation verification has a bounded deadline and rolls back a wrong daemon', { timeout: 16000 }, async t => {
  const f = await fixture(t);
  const badDriver = { ...f.options.driver, async install(i: Installation) { await f.options.driver.install({ ...i, generation: 'wrong' }); } };
  const service = new ManagedService(f.path, { ...f.options, driver: badDriver });
  const started = Date.now();
  await assert.rejects(service.enable(), /Service activation failed/);
  assert.ok(Date.now() - started < 14500);
  assert.equal(await ghSocket(f.gh), '/original.sock');
});
