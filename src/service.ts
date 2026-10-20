import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { atomic, locked, optional, privateDirectory } from './files.js';
import { disableGh, enableGh, getStatus, ghConfigDir, ghSocket, rollbackGhBackup } from './control.js';
import { loadConfig } from './config.js';

export interface Installation {
  version: 1;
  platform: 'darwin' | 'linux';
  generation: string;
  label: string;
  directory: string;
  socketPath: string;
  configPath: string;
  ghDirectory: string;
  definitionDirectory: string;
}
export interface ServiceDriver {
  install(installation: Installation): Promise<void>;
  remove(installation: Installation): Promise<void>;
  inspect(installation: Installation): Promise<string>;
}
interface Pending { candidate: Installation; previous?: Installation; backupBefore: string }
export interface ServiceOptions {
  /** Test seams. The production CLI supplies none. */
  driver?: ServiceDriver;
  prepare?: (installation: Installation) => Promise<void>;
  health?: (installation: Installation) => Promise<void>;
  home?: string;
  platform?: 'darwin' | 'linux';
  ghDirectory?: string;
}
const exec = promisify(execFile);
const run = async (file: string, args: string[]) => (await exec(file, args, { timeout: 15000, maxBuffer: 256 * 1024 })).stdout;
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
// systemd performs specifier and environment expansion independently of quoting.
const unit = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
export function definitions(i: Installation): Record<string, string> {
  const node = join(i.directory, 'node'), cli = join(i.directory, 'app/dist/cli.js');
  const env = { GITHUBPROXYAPI_CONFIG: i.configPath, GHPA_SOCKET_PATH: i.socketPath, GHPA_GENERATION: i.generation };
  if (i.platform === 'darwin') {
    const args = [join(i.directory, 'launch'), node, cli, 'managed-serve'];
    return { [`${i.label}.plist`]: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(i.label)}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>Sockets</key><dict><key>Proxy</key><dict><key>SockPathName</key><string>${xml(i.socketPath)}</string><key>SockType</key><string>stream</string><key>SockPathMode</key><integer>384</integer></dict></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(i.directory, 'proxy.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(i.directory, 'proxy.log'))}</string>
</dict></plist>\n` };
  }
  return {
    [`${i.label}.socket`]: `[Unit]\nDescription=GHPA private activation socket\n[Socket]\nListenStream=${i.socketPath.replaceAll('%', '%%')}\nSocketMode=0600\nDirectoryMode=0700\nFileDescriptorName=ghpa\nRemoveOnStop=yes\n[Install]\nWantedBy=sockets.target\n`,
    [`${i.label}.service`]: `[Unit]\nDescription=GHPA personal API proxy\nRequires=${i.label}.socket\nAfter=${i.label}.socket\nStartLimitIntervalSec=30\nStartLimitBurst=5\n[Service]\nType=simple\nExecStart=${[node, cli, 'managed-serve'].map(unit).join(' ')}\n${Object.entries(env).map(([k,v]) => `Environment=${unit(`${k}=${v}`).replaceAll('$$', '$')}`).join('\n')}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=10\nUMask=0077\nNoNewPrivileges=yes\n`,
  };
}
const domain = () => `gui/${process.getuid?.()}`;
export const osDriver: ServiceDriver = {
  async install(i) {
    await mkdir(i.definitionDirectory, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(definitions(i))) await atomic(join(i.definitionDirectory, name), content);
    if (i.platform === 'darwin') {
      await run('/bin/launchctl', ['bootstrap', domain(), join(i.definitionDirectory, `${i.label}.plist`)]);
    } else {
      await run('/usr/bin/systemctl', ['--user', 'daemon-reload']);
      await run('/usr/bin/systemctl', ['--user', 'enable', '--now', `${i.label}.socket`]);
    }
  },
  async remove(i) {
    if (i.platform === 'darwin') {
      // Verify manager access before interpreting a missing job as already removed.
      await run('/bin/launchctl', ['print-disabled', domain()]);
      let loaded = true;
      try { await run('/bin/launchctl', ['print', `${domain()}/${i.label}`]); } catch { loaded = false; }
      if (loaded) await run('/bin/launchctl', ['bootout', `${domain()}/${i.label}`]);
    } else {
      for (const suffix of ['socket', 'service']) {
        const name = `${i.label}.${suffix}`;
        let state: string;
        try { state = await run('/usr/bin/systemctl', ['--user', 'show', name, '--property=LoadState', '--value']); }
        catch (error) {
          // Some systemd versions return nonzero while still reporting not-found.
          const output = (error as { stdout?: string }).stdout;
          if (output?.trim() !== 'not-found') throw error;
          state = output;
        }
        if (state.trim() !== 'not-found') await run('/usr/bin/systemctl', ['--user', ...(suffix === 'socket' ? ['disable', '--now'] : ['stop']), name]);
      }
    }
    for (const name of Object.keys(definitions(i))) await rm(join(i.definitionDirectory, name), { force: true });
    if (i.platform === 'linux') await run('/usr/bin/systemctl', ['--user', 'daemon-reload']);
  },
  async inspect(i) {
    return i.platform === 'darwin'
      ? run('/bin/launchctl', ['print', `${domain()}/${i.label}`])
      : run('/usr/bin/systemctl', ['--user', 'show', `${i.label}.socket`, `${i.label}.service`, '--property=Id,LoadState,ActiveState,SubState,Result,NRestarts,ExecMainStatus', '--no-pager']);
  },
};

/** Snapshot code, dependency closure and runtime so npm/Node version-manager upgrades cannot remove them. */
export async function prepareRuntime(i: Installation): Promise<void> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await privateDirectory(i.directory);
  await copyFile(await realpath(process.execPath), join(i.directory, 'node'));
  await chmod(join(i.directory, 'node'), 0o700);
  const app = join(i.directory, 'app');
  await mkdir(app, { mode: 0o700 });
  await cp(join(packageRoot, 'dist'), join(app, 'dist'), { recursive: true, dereference: true });
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  await atomic(join(app, 'package.json'), JSON.stringify({ type: 'module', version: pkg.version }));
  const seen = new Set<string>();
  async function dependency(name: string, from: string): Promise<void> {
    if (seen.has(name)) return;
    seen.add(name);
    const require = createRequire(join(from, 'package.json'));
    const source = dirname(require.resolve(`${name}/package.json`));
    await cp(source, join(app, 'node_modules', name), { recursive: true, dereference: true });
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    for (const child of Object.keys(metadata.dependencies ?? {})) await dependency(child, source);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) await dependency(name, packageRoot);
  // A clean environment intentionally excludes credentials, NODE_OPTIONS and shell initialization.
  try {
    await exec(join(i.directory, 'node'), [join(app, 'dist/cli.js'), 'config', 'validate'], {
      env: { HOME: homedir(), GITHUBPROXYAPI_CONFIG: i.configPath }, timeout: 10000,
    });
  } catch {
    throw new Error('The copied Node runtime could not validate the service configuration in a clean environment. Use an official standalone Node.js distribution (for example via Volta or nvm), verify ghpa config validate, and retry enable-gh. Shared-library-dependent Homebrew runtimes may not be relocatable.');
  }
  if (i.platform === 'darwin') {
    try { await run('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', join(packageRoot, 'native/launch.c'), '-o', join(i.directory, 'launch')]); }
    catch { throw new Error('Could not build launchd socket launcher; install Apple Command Line Tools (xcode-select --install), then retry'); }
    await chmod(join(i.directory, 'launch'), 0o700);
  }
  await atomic(join(i.directory, 'proxy.log'), '');
}
async function healthy(i: Installation): Promise<void> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const status = await getStatus(i.socketPath, 1000) as { generation?: string };
      const socket = await lstat(i.socketPath);
      if (status.generation === i.generation && socket.isSocket() && !(socket.mode & 0o077) && socket.uid === process.getuid?.()) return;
    } catch { /* Bounded wait for activation, never replay an upstream request. */ }
    await delay(100);
  }
  throw new Error(`Service activation failed. Inspect ghpa service status and ${join(i.directory, 'proxy.log')}; on Linux also use journalctl --user -u ${i.label}.service`);
}
export const serviceRoot = (path: string) => join(dirname(path), 'service');
export async function installedService(path: string): Promise<Installation | undefined> {
  const raw = await optional(join(serviceRoot(path), 'installed.json'));
  return raw ? JSON.parse(raw) as Installation : undefined;
}

export class ManagedService {
  readonly root: string;
  readonly backup: string;
  readonly driver: ServiceDriver;
  constructor(readonly path: string, readonly options: ServiceOptions = {}) {
    this.root = serviceRoot(path); this.backup = join(dirname(path), 'gh-backup.json');
    this.driver = options.driver ?? osDriver;
  }
  private async remove(i: Installation) {
    await this.driver.remove(i);
    await rm(i.directory, { recursive: true, force: true });
  }
  private async record(i?: Installation) {
    if (i) await atomic(join(this.root, 'installed.json'), JSON.stringify(i));
    else await rm(join(this.root, 'installed.json'), { force: true });
  }
  /** Recover the single durable commit point: gh's socket value. Retain failed cleanup for retry. */
  private async recover() {
    const raw = await optional(join(this.root, 'pending.json'));
    if (!raw) return;
    const { candidate, previous, backupBefore } = JSON.parse(raw) as Pending;
    if (await ghSocket(candidate.ghDirectory) === candidate.socketPath) {
      await this.record(candidate);
      if (previous) await this.remove(previous);
    } else {
      await rollbackGhBackup(candidate.socketPath, this.backup, backupBefore ?? '', candidate.ghDirectory);
      await this.remove(candidate);
      await this.record(previous);
    }
    await rm(join(this.root, 'pending.json'));
  }
  async enable(): Promise<Installation> {
    await privateDirectory(this.root);
    return locked(join(this.root, 'lock'), async () => {
      await this.recover();
      const config = await loadConfig(this.path);
      const previous = await installedService(this.path);
      const platform = this.options.platform ?? process.platform;
      if (platform !== 'darwin' && platform !== 'linux') throw new Error('Managed services support macOS launchd and Linux systemd user sessions');
      const home = this.options.home ?? homedir();
      const generation = randomUUID().slice(0, 8);
      const directory = join(this.root, generation);
      const candidate: Installation = {
        version: 1, platform, generation, directory, socketPath: join(directory, 'p.sock'), configPath: this.path,
        ghDirectory: this.options.ghDirectory ?? ghConfigDir(),
        label: `dev.ghpa.${createHash('sha256').update(this.path).digest('hex').slice(0, 10)}.${generation}`,
        definitionDirectory: platform === 'darwin' ? join(home, 'Library/LaunchAgents') : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd/user'),
      };
      if (previous && previous.ghDirectory !== candidate.ghDirectory) throw new Error('Use the original GH_CONFIG_DIR to upgrade or uninstall this service');
      if (Buffer.byteLength(candidate.socketPath) > 103 || /[\x00-\x1f\x7f]/.test(this.path + directory + home)) throw new Error('Managed paths must contain no control characters and socket path must be at most 103 bytes; use a shorter configuration directory');
      await privateDirectory(directory);
      await atomic(join(this.root, 'pending.json'), JSON.stringify({ candidate, previous, backupBefore: await optional(this.backup) } satisfies Pending));
      try {
        await (this.options.prepare ?? prepareRuntime)(candidate);
        await this.driver.install(candidate);
        await (this.options.health ?? healthy)(candidate);
        // The old service remains available until this atomic config update commits.
        await enableGh(candidate.socketPath, this.backup, candidate.ghDirectory, previous?.socketPath ?? config.socketPath);
      } catch (error) {
        try { await this.recover(); } catch (cleanup) {
          throw new AggregateError([error, cleanup], `Setup failed; rollback needs attention. Retry enable-gh or service uninstall. ${String(error)}; ${String(cleanup)}`);
        }
        throw error;
      }
      // A failed cleanup must not undo a healthy committed transport. Journal allows retry.
      try { await this.recover(); } catch (error) { throw new Error(`New service is active, but cleanup needs retry with enable-gh: ${String(error)}`); }
      return candidate;
    });
  }
  async uninstall(): Promise<void> {
    await privateDirectory(this.root);
    await locked(join(this.root, 'lock'), async () => {
      await this.recover();
      const installed = await installedService(this.path);
      const dir = installed?.ghDirectory ?? this.options.ghDirectory ?? ghConfigDir();
      await disableGh(this.backup, dir);
      if (installed && await ghSocket(dir) === installed.socketPath) throw new Error('Cannot remove service while gh still points at it; restore gh transport first');
      if (installed) await this.remove(installed);
      await this.record();
    });
  }
  async status(): Promise<unknown> {
    const installed = await installedService(this.path);
    const pending = !!await optional(join(this.root, 'pending.json'));
    if (!installed) return { installed: false, pending, recovery: pending ? 'Run enable-gh or service uninstall' : undefined };
    let manager: string;
    try { manager = await this.driver.inspect(installed); } catch (error) { manager = String(error); }
    let health: unknown;
    try { health = await getStatus(installed.socketPath); } catch (error) { health = String(error); }
    return { installed, pending, health, manager };
  }
}
