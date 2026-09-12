import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, lstat, readFile, rename, unlink, chmod, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppTokenProvider } from './credentials.js';
import { BudgetScheduler } from './scheduler.js';
import { classify, fingerprint, type Decision } from './policy.js';
import { appKey, type Config, type SchedulerLike, type TokenProvider, type Reservation, type AppConfig } from './types.js';

export interface ProxyOptions {
  /** Programmatic test seam only. Production CLI never accepts arbitrary upstreams. */
  upstreams?: Record<string, string>;
  tokenProvider?: TokenProvider;
  scheduler?: SchedulerLike;
  now?: () => number;
}
const hosts = new Set(['api.github.com', 'github.com', 'uploads.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const authorizedHosts = new Set(['api.github.com', 'github.com', 'uploads.github.com']);
function inspectBody(buffer: Buffer | undefined, encoding: string | string[] | undefined): string | undefined {
  if (!buffer) return undefined;
  try {
    const options = { maxOutputLength: 1024 * 1024 };
    if (encoding === 'gzip') return gunzipSync(buffer, options).toString();
    if (encoding === 'deflate') return inflateSync(buffer, options).toString();
    if (encoding === 'br') return brotliDecompressSync(buffer, options).toString();
    return encoding && encoding !== 'identity' ? undefined : buffer.toString();
  } catch { return undefined; }
}
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
function headersFor(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set([...HOP, ...(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key) && !key.startsWith('x-forwarded-')));
}
class Gate {
  active = 0;
  waiters: { resolve: (release: () => void) => void; reject: (e: Error) => void; signal: AbortSignal; abort: () => void }[] = [];
  constructor(readonly limit: number) {}
  async enter(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return this.release(); }
    if (this.waiters.length >= 64) throw new Error('queue-full');
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: () => { this.waiters = this.waiters.filter(w => w !== entry); reject(new Error('cancelled')); } };
      signal.addEventListener('abort', entry.abort, { once: true }); this.waiters.push(entry);
    });
  }
  private release(): () => void {
    let done = false;
    return () => {
      if (done) return; done = true;
      const next = this.waiters.shift();
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(this.release()); }
      else this.active--;
    };
  }
}
async function peek(stream: Readable, limit = 1024 * 1024): Promise<{ buffer?: Buffer; stream: Readable }> {
  const iterator = stream[Symbol.asyncIterator](); const chunks: Buffer[] = []; let size = 0;
  while (true) {
    const value = await iterator.next();
    if (value.done) { const buffer = Buffer.concat(chunks); return { buffer, stream: Readable.from([buffer]) }; }
    const chunk = Buffer.isBuffer(value.value) ? value.value : Buffer.from(value.value);
    chunks.push(chunk); size += chunk.length;
    if (size > limit) return { stream: Readable.from((async function* () {
      try { yield* chunks; while (true) { const next = await iterator.next(); if (next.done) break; yield next.value; } }
      finally { await iterator.return?.(); }
    })()) };
  }
}
function send(res: ServerResponse, status: number, message: string, retry?: number): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...(retry ? { 'retry-after': String(retry) } : {}) });
  res.end(JSON.stringify({ message }));
}
async function socketAlive(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const client = net.connect(path); const timer = setTimeout(() => { client.destroy(); resolve(true); }, 500);
    client.once('connect', () => { clearTimeout(timer); client.destroy(); resolve(true); });
    client.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'); });
  });
}

export async function startProxy(config: Config, options: ProxyOptions = {}) {
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? new BudgetScheduler({ now });
  const upstreamGate = new Gate(config.maxConcurrency);
  const upstreamFor = (host: string): URL => new URL(options.upstreams?.[host] ?? `https://${host}`);
  const targetFor = (host: string, path: string): URL => {
    const target = upstreamFor(host); target.pathname = path.split('?')[0]!; target.search = path.includes('?') ? path.slice(path.indexOf('?')) : ''; return target;
  };
  // Token exchange, authorization probes, and client forwarding share one network gate.
  const gatedFetch: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? AbortSignal.timeout(config.requestTimeoutMs);
    const release = await upstreamGate.enter(signal);
    try {
      const response = await fetch(input, init); const bytes = await response.arrayBuffer();
      if ([403, 429].includes(response.status)) scheduler.observe('authentication', 'core', response.status, Object.fromEntries(response.headers), Buffer.from(bytes).toString().slice(0, 65536));
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    finally { release(); }
  };
  const tokens = options.tokenProvider ?? new AppTokenProvider({ apiBaseUrl: upstreamFor('api.github.com').origin, fetch: gatedFetch, now, requestTimeoutMs: config.requestTimeoutMs });
  try { scheduler.restore(JSON.parse(await readFile(config.statePath, 'utf8'))); } catch { /* Missing/invalid non-secret state starts cold. */ }
  const reasons: Record<string, number> = {}; const routes: Record<string, number> = {};
  const counts = { requests: 0, validationRequests: 0, upstreamRequests: 0, errors: 0 };
  let closing: Promise<void> | undefined;
  const since = now(); const controllers = new Set<AbortController>();
  const access = new Map<string, { expiresAt: number; repositoryId: number }>();
  const quarantine = new Map<string, number>();
  const validating = new Map<string, Promise<boolean>>();
  const status = () => ({ version: '0.1.0', uptimeSeconds: Math.floor((now() - since) / 1000), socketPath: config.socketPath,
    counts, routes, reasons, apps: config.apps.map(a => ({ name: a.name, installationId: a.installationId, repositories: a.repositories.map(r => r.name) })), scheduler: scheduler.snapshot() });
  let saving: Promise<void> = Promise.resolve();
  const save = () => {
    saving = saving.catch(() => {}).then(async () => {
      await mkdir(dirname(config.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${config.statePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(scheduler.snapshot()), { mode: 0o600 }); await rename(temporary, config.statePath);
    }); return saving;
  };
  const interval = setInterval(() => { void save().catch(() => {}); }, 5000); interval.unref();
  async function probe(path: string, authorization: string, personalKey: string, signal: AbortSignal): Promise<unknown> {
    if (scheduler.snapshot().cooldownUntil > now()) throw new Error('cooldown');
    const response = await gatedFetch(targetFor('api.github.com', path), { headers: { authorization, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'GitHubProxyAPI/0.1.0' }, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]) });
    counts.validationRequests++;
    const text = await response.text();
    scheduler.observe(personalKey, 'core', response.status, Object.fromEntries(response.headers), text.slice(0, 65536));
    if (!response.ok || text.length > 1024 * 1024) throw new Error('access-unverified');
    return JSON.parse(text);
  }
  async function canUse(app: AppConfig, decision: Decision, authorization: string, caller: string, signal: AbortSignal): Promise<boolean> {
    const repository = app.repositories.find(r => r.name.toLowerCase() === decision.repository);
    if (!repository || !decision.permission || app.permissions[decision.permission] !== 'read') return false;
    const key = `${caller}:${repository.id}:${decision.repository}:${decision.permission}`;
    const cached = access.get(key);
    if (cached && cached.expiresAt > now()) return cached.repositoryId === repository.id;
    let pending = validating.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const metadata = await probe(`/repos/${decision.repository}`, authorization, `personal:${caller}`, signal) as { id?: number };
          if (metadata.id !== repository.id) return false;
          const permissionPath = decision.permission === 'contents' ? 'contents' : decision.permission === 'pull_requests' ? 'pulls?per_page=1' : 'issues?per_page=1';
          await probe(`/repos/${decision.repository}/${permissionPath}`, authorization, `personal:${caller}`, signal);
          access.set(key, { expiresAt: now() + config.accessTtlMs, repositoryId: repository.id });
          if (access.size > 1000) access.delete(access.keys().next().value!);
          return true;
        } catch { return false; }
      })(); validating.set(key, pending);
      void pending.finally(() => { validating.delete(key); });
    }
    return pending;
  }
  async function upstream(host: string, path: string, method: string, headers: IncomingHttpHeaders, body: Readable, signal: AbortSignal): Promise<{ response: IncomingMessage; release: () => void }> {
    const release = await upstreamGate.enter(signal);
    try {
      const target = targetFor(host, path); const transport = target.protocol === 'https:' ? https : http;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = transport.request(target, { method, headers: { ...headers, host: target.host }, signal }, resolve);
        request.on('error', reject);
        void pipeline(body, request).catch(reject);
      });
      counts.upstreamRequests++; return { response, release };
    } catch (e) { release(); throw e; }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = (req.headers.host ?? '').toLowerCase(); const path = req.url ?? '/';
    if (host === 'githubproxyapi.local' && req.method === 'POST' && path === '/_githubproxyapi/stop') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stopping: true }), () => { void close().catch(() => {}); }); return;
    }
    if (host === 'githubproxyapi.local' && req.method === 'GET' && path === '/_githubproxyapi/status') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(status())); return;
    }
    if (!hosts.has(host) && !options.upstreams?.[host]) { send(res, 421, 'Unsupported destination. Use githubproxyapi disable-gh for direct gh access.'); return; }
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20]/.test(path)) { send(res, 400, 'Invalid request target.'); return; }
    if (req.method === 'CONNECT') { send(res, 405, 'CONNECT is not supported.'); return; }
    if (controllers.size >= 64) { send(res, 503, 'Proxy queue is full.', 1); return; }
    counts.requests++;
    const controller = new AbortController(); controllers.add(controller);
    controller.signal.addEventListener('abort', () => { req.destroy(); }, { once: true });
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    let reservation: Reservation | undefined; let releaseNetwork: (() => void) | undefined;
    try {
      let body: Readable = req; let buffer: Buffer | undefined;
      if (host === 'api.github.com' && path.split('?')[0] === '/graphql' && req.method === 'POST') {
        const captured = await peek(req); body = captured.stream; buffer = captured.buffer;
      }
      const decision = host === 'api.github.com' ? classify(req.method ?? 'GET', path, req.headers, buffer) : { reason: 'non-api-origin', resource: 'core' };
      const outgoing = headersFor(req.headers); const caller = fingerprint(req.headers.authorization);
      let key = caller ? `personal:${caller}` : 'anonymous'; let route = 'personal'; let reason = decision.reason;
      let selected: AppConfig | undefined;
      const eligible: AppConfig[] = [];
      if (host === 'api.github.com' && scheduler.snapshot().cooldownUntil > now()) {
        send(res, 429, 'GitHub requests are paused until the shared rate-limit cooldown ends.', Math.max(1, Math.ceil((scheduler.snapshot().cooldownUntil - now()) / 1000))); return;
      }
      controller.signal.throwIfAborted();
      if (decision.repository && caller && config.callerFingerprints.includes(caller)) {
        for (const app of config.apps) {
          controller.signal.throwIfAborted();
          if ((quarantine.get(appKey(app)) ?? 0) <= now() && await canUse(app, decision, req.headers.authorization!, caller, controller.signal)) eligible.push(app);
        }
        reservation = scheduler.reserve(eligible.map(appKey), decision.resource);
        if (reservation) {
          selected = eligible.find(app => appKey(app) === reservation!.key)!;
          try {
            const token = await tokens.getToken(selected);
            const repositoryId = selected.repositories.find(r => r.name.toLowerCase() === decision.repository)!.id;
            if (!token.repositoryIds.includes(repositoryId) || !['read', 'write'].includes(token.permissions[decision.permission!] ?? '')) throw new Error('scope');
            outgoing.authorization = `Bearer ${token.token}`; key = reservation.key; route = selected.name;
          } catch { reservation.release(); reservation = undefined; selected = undefined; reason = 'app-token-unavailable'; }
        } else reason = eligible.length ? 'app-budget-unavailable' : 'access-not-verified';
      } else if (decision.repository) reason = 'caller-not-enrolled';
      if (host === 'api.github.com' && scheduler.snapshot().cooldownUntil > now()) {
        send(res, 429, 'GitHub requests are paused until the shared rate-limit cooldown ends.', Math.max(1, Math.ceil((scheduler.snapshot().cooldownUntil - now()) / 1000))); return;
      }
      if (!reservation && host === 'api.github.com' && path.split('?')[0] !== '/rate_limit') {
        reservation = scheduler.reserve([key], decision.resource);
        if (!reservation) { send(res, 429, 'No capacity available for this identity. Check githubproxyapi status.', 1); return; }
      }
      if (!authorizedHosts.has(host)) delete outgoing.authorization;
      outgoing['user-agent'] ??= 'GitHubProxyAPI/0.1.0';
      for (let attempt = 0; ; attempt++) {
        routes[route] = (routes[route] ?? 0) + 1; reasons[reason] = (reasons[reason] ?? 0) + 1;
        const result = await upstream(host, path, req.method ?? 'GET', outgoing, body, controller.signal);
        releaseNetwork = result.release; const response = result.response;
        let responseBody: Readable = response; let responseBuffer: Buffer | undefined;
        if (host === 'api.github.com' && ((response.statusCode ?? 500) >= 400 || decision.resource === 'graphql')) {
          const captured = await peek(response); responseBody = captured.stream; responseBuffer = captured.buffer;
        }
        const inspected = inspectBody(responseBuffer, response.headers['content-encoding']);
        if (host === 'api.github.com') scheduler.observe(key, decision.resource, response.statusCode ?? 502, response.headers, inspected);
        if (selected && [401, 403, 404].includes(response.statusCode ?? 0) && response.headers['x-ratelimit-remaining'] !== '0') {
          if (response.statusCode === 401) tokens.invalidate(selected);
          quarantine.set(appKey(selected), now() + 60000); access.clear();
        }
        // Retry only an already approved read after an explicit primary rejection, at most once.
        // Never replay writes, transport failures, partial GraphQL data or secondary throttles.
        const primary = [403, 429].includes(response.statusCode ?? 0) && response.headers['x-ratelimit-remaining'] === '0';
        if (attempt === 0 && selected && primary && responseBuffer && scheduler.snapshot().cooldownUntil <= now() && (req.method === 'GET' || buffer)) {
          responseBody.destroy(); releaseNetwork(); releaseNetwork = undefined; reservation?.release(); reservation = undefined;
          const previous = key;
          reservation = scheduler.reserve(eligible.map(appKey).filter(k => k !== previous), decision.resource);
          selected = reservation ? eligible.find(a => appKey(a) === reservation!.key) : undefined;
          if (selected && reservation) {
            try {
              const token = await tokens.getToken(selected);
              const repo = selected.repositories.find(r => r.name.toLowerCase() === decision.repository)!;
              if (!token.repositoryIds.includes(repo.id) || !['read', 'write'].includes(token.permissions[decision.permission!] ?? '')) throw new Error('scope');
              outgoing.authorization = `Bearer ${token.token}`; key = reservation.key; route = selected.name;
            } catch { reservation.release(); reservation = undefined; selected = undefined; }
          }
          if (!selected) {
            key = `personal:${caller}`; route = 'personal'; outgoing.authorization = req.headers.authorization;
            reservation = scheduler.reserve([key], decision.resource);
          }
          if (!reservation) { send(res, 429, 'All eligible credentials are exhausted. Check githubproxyapi status.', 1); return; }
          if (scheduler.snapshot().cooldownUntil > now()) { send(res, 429, 'GitHub requests are paused by a shared cooldown.', 60); return; }
          body = Readable.from(buffer ? [buffer] : []); reason = 'primary-limit-failover'; continue;
        }
        // Preserve Link, Location, body bytes and upstream quota headers. gh owns redirects and pagination.
        res.writeHead(response.statusCode ?? 502, headersFor(response.headers));
        await pipeline(responseBody, res, { signal: controller.signal }); break;
      }
    } catch {
      counts.errors++; send(res, controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'Upstream request timed out or was cancelled.' : 'Upstream request failed.');
    } finally {
      reservation?.release(); releaseNetwork?.(); clearTimeout(timer); controllers.delete(controller); req.off('aborted', abort); res.off('close', abort);
    }
  }
  // Socket support is inspired by bored-engineer/github-api-proxy main.go; implemented with Node HTTP.
  const directory = dirname(config.socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0 || (process.getuid && directoryInfo.uid !== process.getuid())) {
    clearInterval(interval); throw new Error('Socket parent directory must be owned by you and have mode 0700.');
  }
  try {
    const existing = await lstat(config.socketPath);
    if (!existing.isSocket() || (process.getuid && existing.uid !== process.getuid())) throw new Error('Socket path is occupied by another file.');
    if (await socketAlive(config.socketPath)) throw new Error('A daemon is already listening on this socket.');
    await unlink(config.socketPath);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { clearInterval(interval); throw e; } }
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.on('clientError', (_e, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'); });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, () => { server.off('error', reject); resolve(); }); });
    await chmod(config.socketPath, 0o600);
  } catch (e) { clearInterval(interval); server.close(); throw e; }
  function close(): Promise<void> { return closing ??= (async () => {
    clearInterval(interval); for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await save();
  })(); }
  return { close, status };
}
