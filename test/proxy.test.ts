import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProxy } from '../src/proxy.js';
import { fingerprint } from '../src/policy.js';
import type { Config, AppConfig, TokenProvider } from '../src/types.js';

const sha = 'a'.repeat(40);
const auth = 'token enrolled-fixture';
const app = (id: number): AppConfig => ({ name: `app${id}`, appId: String(id), installationId: id,
  privateKeyPath: '/unused.pem', repositories: [{ name: 'owner/repo', id: 9 }], permissions: { contents: 'read', pull_requests: 'read', issues: 'read' } });
const tokenProvider: TokenProvider = { async getToken(a) { return { token: a.name, expiresAt: Date.now() + 3600000, repositoryIds: [9], permissions: a.permissions as Record<string,string> }; }, invalidate() {} };
async function setup(t: any, handler: http.RequestListener, extra: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gpa-'));
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const config: Config = { version: 1, socketPath: join(dir, 'p.sock'), statePath: join(dir, 'state.json'),
    maxConcurrency: 4, requestTimeoutMs: 2000, accessTtlMs: 60000, callerFingerprints: [fingerprint(auth)!], apps: [app(1), app(2)], ...extra };
  const proxy = await startProxy(config, { upstreams: { 'api.github.com': `http://127.0.0.1:${port}`, 'uploads.github.com': `http://127.0.0.1:${port}`, 'objects.githubusercontent.com': `http://127.0.0.1:${port}` }, tokenProvider });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const request = (path: string, { method = 'GET', authorization = auth, host = 'api.github.com', body = '', headers = {} }: { method?: string; authorization?: string; host?: string; body?: string; headers?: Record<string,string> } = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ socketPath: config.socketPath, path, method, headers: { host, authorization, ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  return { request, proxy, config, dir };
}
function reply(res: http.ServerResponse, value: unknown, remaining = 50, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now()/1000)+3600) }); res.end(JSON.stringify(value));
}

test('pool uses independent apps, verifies caller access once, preserves writes and unknown callers', async t => {
  const seen: {path:string;auth?:string;method?:string}[] = [];
  const { request, proxy, config } = await setup(t, (req,res) => {
    seen.push({path:req.url!,auth:req.headers.authorization,method:req.method});
    if (req.url === '/repos/owner/repo') reply(res, { id: 9 });
    else if (req.url === '/repos/owner/repo/contents') reply(res, []);
    else reply(res, { actor: req.headers.authorization });
  });
  const path = `/repos/owner/repo/git/blobs/${sha}`;
  assert.equal(JSON.parse((await request(path)).body).actor, 'Bearer app1');
  assert.equal(JSON.parse((await request(path)).body).actor, 'Bearer app2');
  assert.equal(seen.filter(s=>s.path === '/repos/owner/repo').length, 1);
  assert.equal(JSON.parse((await request('/repos/owner/repo/issues',{method:'POST',body:'{"title":"fixture"}'})).body).actor, auth);
  assert.equal(JSON.parse((await request(path,{authorization:'token different-fixture'})).body).actor, 'token different-fixture');
  assert.equal(JSON.parse((await request(path,{headers:{'if-none-match':'"fixture"'}})).body).actor, auth);
  assert.ok(!JSON.stringify(proxy.status()).includes('enrolled-fixture'));
  assert.equal((await stat(config.socketPath)).mode & 0o777, 0o600);
});

test('primary exhaustion retries one certified read on another app without touching personal quota', async t => {
  const actors: string[] = [];
  const { request } = await setup(t, (req,res) => {
    if (req.url === '/repos/owner/repo') return reply(res, {id:9});
    if (req.url === '/repos/owner/repo/contents') return reply(res, []);
    actors.push(req.headers.authorization!);
    if (req.headers.authorization === 'Bearer app1') reply(res, {message:'API rate limit exceeded'}, 0, 403);
    else reply(res, {ok:true});
  });
  assert.equal((await request(`/repos/owner/repo/git/blobs/${sha}`)).status,200);
  assert.deepEqual(actors,['Bearer app1','Bearer app2']);
  await request(`/repos/owner/repo/git/blobs/${sha}`);
  assert.equal(actors.at(-1),'Bearer app2');
});

test('permission failure and repository identity mismatch never grant app access', async t => {
  let permit = false; const actors: string[] = [];
  const {request} = await setup(t, (req,res) => {
    if (req.url === '/repos/owner/repo') return reply(res,{id:permit ? 9 : 999});
    if (req.url === '/repos/owner/repo/contents') return reply(res,{message:'Resource not accessible'},50,403);
    actors.push(req.headers.authorization!); reply(res,{ok:true});
  });
  await request(`/repos/owner/repo/git/blobs/${sha}`); permit=true;
  await request(`/repos/owner/repo/git/blobs/${sha}`);
  assert.deepEqual(actors,[auth,auth]);
});

test('secondary throttle halts pool, writes are never retried, and state persists cooldown', async t => {
  let calls=0;
  const {request,proxy,config}=await setup(t, (_req,res)=>{calls++;res.setHeader('retry-after','60');reply(res,{message:'secondary rate limit'},50,403);},{apps:[]});
  assert.equal((await request('/repos/owner/repo/issues',{method:'POST',body:'{}'})).status,403);
  assert.equal((await request('/user')).status,429);
  assert.equal(calls,1);
  await proxy.close();
  assert.ok(JSON.parse(await readFile(config.statePath,'utf8')).cooldownUntil > Date.now());
});

test('destinations, redirects and upload bodies retain protocol boundaries', async t => {
  const seen: {auth?:string;body:string}[]=[];
  const {request}=await setup(t,async(req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    seen.push({auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});
    res.writeHead(302,{location:'https://objects.githubusercontent.com/signed-fixture',link:'<https://api.github.com/next>; rel="next"'});res.end('redirect');
  },{apps:[]});
  const blocked=await request('/private',{host:'127.0.0.1'});assert.equal(blocked.status,421);assert.equal(seen.length,0);
  const upload=await request('/upload',{host:'uploads.github.com',method:'POST',body:'binary-fixture'});
  assert.equal(upload.status,302);assert.equal(upload.headers.location,'https://objects.githubusercontent.com/signed-fixture');
  assert.deepEqual(seen[0],{auth,body:'binary-fixture'});
  await request('/signed-fixture',{host:'objects.githubusercontent.com'});assert.equal(seen[1]?.auth,undefined);
});

test('existing socket is protected and non-socket files are never deleted',async t=>{
  const {config,dir}=await setup(t,(_req,res)=>reply(res,{}),{apps:[]});
  await assert.rejects(startProxy(config),/already listening/);
  const file=join(dir,'keep');await writeFile(file,'important');
  await assert.rejects(startProxy({...config,socketPath:file}),/another file/);
  assert.equal(await readFile(file,'utf8'),'important');
});
