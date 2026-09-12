import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, validateConfig, loadConfig, saveConfig } from '../src/config.js';
const app = () => ({ name: 'reader', appId: '12', installationId: 34, privateKeyPath: '/tmp/key.pem', repositories: [{name:'owner/repo',id:56}], permissions:{contents:'read'} });
test('defaults and private configuration round trip', async () => { const dir = await mkdtemp(join(tmpdir(),'ghpa-config-')); try { const path = join(dir,'config.json'); const c = defaultConfig(path); await saveConfig(c,path); assert.deepEqual(await loadConfig(path),c); assert.equal((await stat(path)).mode & 0o777,0o600); } finally { await rm(dir,{recursive:true,force:true}); } });
test('reject invalid boundaries and ambiguous credentials', () => {
 const base = defaultConfig('/tmp/g/config.json');
 for (const patch of [{version:2},{socketPath:'relative'}, {maxConcurrency:0},{accessTtlMs:60001},{callerFingerprints:['token']},{apps:[app(),app()]},{apps:[{...app(),permissions:{contents:'write'}}]},{apps:[{...app(),installationId:NaN}]},{apps:[{...app(),repositories:[{name:'bad',id:1}]}]}]) assert.throws(()=>validateConfig({...base,...patch}));
 assert.equal(validateConfig({...base,apps:[app()]}).apps.length,1);
});
