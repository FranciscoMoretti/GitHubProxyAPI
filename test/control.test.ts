import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { enableGh, disableGh } from '../src/control.js';
async function fixture(run: (dir:string,socket:string)=>Promise<void>) { const dir=await mkdtemp(join(tmpdir(),'ghpa-')); const socket=join(dir,'p.sock'); const server=createServer((req,res)=>{ assert.equal(req.headers.host,'githubproxyapi.local'); res.end('{}'); }); await new Promise<void>(r=>server.listen(socket,r)); try {await run(dir,socket);} finally {await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await rm(dir,{recursive:true,force:true});} }
test('enable is idempotent and restores previous socket preserving unrelated edits',()=>fixture(async(dir,socket)=>{const path=join(dir,'config.yml'),backup=join(dir,'backup.json');await writeFile(path,'# keep comment\ngit_protocol: ssh\nhttp_unix_socket: /previous.sock\n');await enableGh(socket,backup,dir);await enableGh(socket,backup,dir);await writeFile(path,(await readFile(path,'utf8'))+'editor: vim\n');await disableGh(backup,dir); const text=await readFile(path,'utf8');assert.ok(text.includes('# keep comment'));assert.deepEqual(parse(text),{git_protocol:'ssh',http_unix_socket:'/previous.sock',editor:'vim'});await disableGh(backup,dir);}));
test('restore absent key and refuse overwriting subsequent user changes',()=>fixture(async(dir,socket)=>{const path=join(dir,'config.yml'),backup=join(dir,'backup.json');await writeFile(path,'git_protocol: ssh\n');await enableGh(socket,backup,dir);await disableGh(backup,dir);assert.equal(Object.hasOwn(parse(await readFile(path,'utf8')),'http_unix_socket'),false);await enableGh(socket,backup,dir);await writeFile(path,'http_unix_socket: /user-change.sock\n');await assert.rejects(disableGh(backup,dir),/refusing/);await assert.rejects(enableGh(socket,backup,dir),/refusing/);assert.equal(parse(await readFile(path,'utf8')).http_unix_socket,'/user-change.sock');}));
