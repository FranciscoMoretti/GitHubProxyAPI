import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
test('CLI onboarding smoke and actionable offline status', async () => {
 const dir = await mkdtemp(join(tmpdir(),'ghpa-cli-'));
 const path = join(dir,'config.json');
 const run = (...args:string[]) => exec(process.execPath,['--import','tsx',resolve('src/cli.ts'),...args],{env:{...process.env,GITHUBPROXYAPI_CONFIG:path}});
 try {
  assert.match((await run('--help')).stdout,/apps discover/);
  assert.match((await run('init')).stdout,/Created/);
  await assert.rejects(run('init'),/already exists/);
  assert.match((await run('config','validate')).stdout,/valid/);
  assert.deepEqual(JSON.parse((await run('apps','list')).stdout),[]);
  await run('apps','add','--name','reader','--app-id','123','--installation-id','456','--key-file',join(dir,'app.pem'),'--repo','owner/repo:789','--permission','contents');
  const data=JSON.parse(await readFile(path,'utf8'));assert.equal(data.apps[0].installationId,456);
  await assert.rejects(run('status'),/Proxy is unavailable/);
  await assert.rejects(run('apps','whoops'),/Unexpected arguments/);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test('background daemon starts idempotently and stops through the socket', async () => {
 const dir = await mkdtemp(join(tmpdir(),'ghpa-bg-'));
 const path = join(dir,'config.json');
 const run = (...args:string[]) => exec(process.execPath,['--import','tsx',resolve('src/cli.ts'),...args],{env:{...process.env,GITHUBPROXYAPI_CONFIG:path},timeout:12000});
 let started = false;
 try {
  await run('init');
  assert.match((await run('start')).stdout,/Proxy started/); started = true;
  assert.match((await run('start')).stdout,/already running/);
  assert.ok(JSON.parse((await run('status')).stdout));
  assert.match((await run('rate-limit')).stdout,/CREDENTIAL/);
  assert.ok(Array.isArray(JSON.parse((await run('rate-limit','--json')).stdout).quotas));
  assert.match((await run('quotas')).stdout,/CREDENTIAL/);
  assert.ok(Array.isArray(JSON.parse((await run('quotas','--json')).stdout).quotas));
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(join(dir,'proxy.log'))).mode & 0o777,0o600);
  assert.match((await run('stop')).stdout,/shutdown requested/);
  let stopped = false;
  for (let attempt=0;attempt<30;attempt++) {
   try { await run('status'); } catch { stopped=true;break; }
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(stopped,'daemon should close its socket'); started = false;
 } finally {
  if (started) await run('stop').catch(()=>{});
  await rm(dir,{recursive:true,force:true});
 }
});
