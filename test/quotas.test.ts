import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQuotas, quotaRows, withPersonalRateLimit } from '../src/quotas.js';
import type { AppConfig } from '../src/types.js';

const apps: AppConfig[] = [{
  name: 'reader-a', appId: '1', installationId: 42, privateKeyPath: '/key.pem',
  repositories: [{ name: 'owner/repo', id: 7 }],
  permissions: { contents: 'read', issues: 'read' },
}];

test('quota view labels personal writes and App read-only access without exposing fingerprints', () => {
  const rows = quotaRows({ scheduler: { budgets: [
    { key: 'personal:secret-fingerprint', resource: 'core', remaining: 12, limit: 5000, resetAt: 1_800_000_000_000, inFlight: 0 },
    { key: 'installation:42', resource: 'core', remaining: 4999, limit: 5000, resetAt: 1_800_000_000_000, inFlight: 0 },
  ] } }, apps);
  assert.deepEqual(rows.map(row => ({ credential: row.credential, access: row.access, available: `${row.remaining}/${row.limit}` })), [
    { credential: 'gh', access: 'personal (writes)', available: '12/5000' },
    { credential: 'reader-a', access: 'read-only', available: '4999/5000' },
  ]);
  const output = formatQuotas(rows);
  assert.match(output, /reader-a\s+app\s+read-only/);
  assert.match(output, /contents,issues/);
  assert.doesNotMatch(output, /secret-fingerprint/);
});

test('Apps with no observed response show an unknown core quota', () => {
  const rows = quotaRows({ scheduler: { budgets: [] } }, apps);
  assert.equal(rows[0]?.credential, 'reader-a');
  assert.match(formatQuotas(rows), /unknown/);
});

test('canonical rate-limit response refreshes personal resources without changing Apps', () => {
  const cached = quotaRows({ scheduler: { budgets: [
    { key: 'personal:old', resource: 'core', remaining: 1, limit: 5000, resetAt: 1, inFlight: 0 },
    { key: 'installation:42', resource: 'core', remaining: 4000, limit: 5000, resetAt: 1_800_000_000_000, inFlight: 0 },
  ] } }, apps);
  const rows = withPersonalRateLimit(cached, { resources: {
    core: { remaining: 4990, limit: 5000, reset: 1_800_000_000 },
    graphql: { remaining: 4500, limit: 5000, reset: 1_800_000_000 },
  } });
  assert.deepEqual(rows.filter(row => row.kind === 'personal').map(row => [row.resource, row.remaining]), [['core', 4990], ['graphql', 4500]]);
  assert.equal(rows.find(row => row.kind === 'app')?.remaining, 4000);
});
