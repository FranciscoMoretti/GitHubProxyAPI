import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetScheduler } from '../src/scheduler.js';

const headers = (remaining: number, reset = 100) => ({ 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset) });

test('unknown credentials get one concurrent probe, release is idempotent', () => {
  const scheduler = new BudgetScheduler({ now: () => 0 });
  const a = scheduler.reserve(['a', 'b'], 'core')!;
  const b = scheduler.reserve(['a', 'b'], 'core')!;
  assert.notEqual(a.key, b.key);
  assert.equal(scheduler.reserve(['a', 'b'], 'core'), undefined);
  a.release(); a.release();
  assert.equal(scheduler.snapshot().budgets[0].inFlight, 0);
});

test('selects by available budget per second and subtracts concurrent work', () => {
  const scheduler = new BudgetScheduler({ now: () => 0 });
  scheduler.observe('a', 'core', 200, headers(1, 10));
  scheduler.observe('b', 'core', 200, headers(5, 100));
  assert.equal(scheduler.reserve(['a', 'b'], 'core')?.key, 'a');
  assert.equal(scheduler.reserve(['a', 'b'], 'core')?.key, 'b');
});

test('out-of-order counts never replenish the same window; old windows ignored', () => {
  let now = 0;
  const scheduler = new BudgetScheduler({ now: () => now });
  scheduler.observe('a', 'core', 200, headers(2));
  scheduler.observe('a', 'core', 200, headers(10));
  assert.equal(scheduler.snapshot().budgets[0].remaining, 2);
  now = 100_001;
  scheduler.observe('a', 'core', 200, headers(20, 200));
  scheduler.observe('a', 'core', 403, headers(0, 100));
  assert.equal(scheduler.snapshot().budgets[0].remaining, 20);
});

test('primary exhaustion is per resource and resets to a single probe', () => {
  let now = 0;
  const scheduler = new BudgetScheduler({ now: () => now });
  scheduler.observe('a', 'core', 403, headers(0));
  assert.equal(scheduler.reserve(['a'], 'core'), undefined);
  assert.ok(scheduler.reserve(['a'], 'search'));
  assert.ok(scheduler.reserve(['b'], 'core'));
  now = 100_001;
  assert.ok(scheduler.reserve(['a'], 'core'));
  assert.equal(scheduler.reserve(['a'], 'core'), undefined);
});

test('secondary limits block the whole pool including GraphQL HTTP 200', () => {
  let now = 0;
  const scheduler = new BudgetScheduler({ now: () => now });
  scheduler.observe('a', 'graphql', 200, {}, JSON.stringify({ errors: [{ type: 'RATE_LIMITED' }] }));
  assert.equal(scheduler.reserve(['b'], 'core'), undefined);
  assert.equal(scheduler.snapshot().cooldownUntil, 60_000);
  now = 60_000;
  assert.ok(scheduler.reserve(['b'], 'core'));
});

test('Retry-After seconds and HTTP date respected, ambiguous 429 backs off', () => {
  const scheduler = new BudgetScheduler({ now: () => 0 });
  scheduler.observe('a', 'core', 429, { 'Retry-After': '120' });
  assert.equal(scheduler.snapshot().cooldownUntil, 120_000);
  scheduler.observe('a', 'core', 403, { 'retry-after': new Date(180_000).toUTCString() });
  assert.equal(scheduler.snapshot().cooldownUntil, 180_000);
  const other = new BudgetScheduler({ now: () => 0 });
  other.observe('a', 'core', 429, {});
  assert.equal(other.snapshot().cooldownUntil, 60_000);
});

test('permission denials do not throttle; explicit secondary beats primary headers', () => {
  const scheduler = new BudgetScheduler({ now: () => 0 });
  scheduler.observe('a', 'core', 403, {}, '{"message":"Resource not accessible by integration"}');
  assert.equal(scheduler.snapshot().cooldownUntil, 0);
  scheduler.observe('a', 'core', 403, headers(0), '{"message":"You have exceeded a secondary rate limit"}');
  assert.equal(scheduler.snapshot().cooldownUntil, 60_000);
});

test('state persists budgets and cooldown but never stale inflight counters', () => {
  const original = new BudgetScheduler({ now: () => 0 });
  original.observe('a', 'core', 200, headers(3));
  original.reserve(['a'], 'core');
  original.observe('b', 'core', 429, {});
  const restored = new BudgetScheduler({ now: () => 0 });
  restored.restore(original.snapshot());
  assert.equal(restored.snapshot().budgets[0].inFlight, 0);
  assert.equal(restored.snapshot().budgets[0].remaining, 3);
  assert.equal(restored.reserve(['a'], 'core'), undefined);
  restored.restore({ cooldownUntil: NaN, budgets: [{ key: 'a', resource: 'core', inFlight: -1, remaining: -2, resetAt: Infinity }] });
  assert.equal(restored.snapshot().cooldownUntil, 0);
  assert.equal(restored.snapshot().budgets[0].remaining, undefined);
  assert.ok(restored.reserve(['a'], 'core'));
});
