import type { BudgetSnapshot, Reservation, SchedulerLike, SchedulerSnapshot } from './types.js';

interface Budget extends BudgetSnapshot { lastChosen: number }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const counter = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);

/** Independent TypeScript implementation inspired by quota-aware selection in
 * https://github.com/bored-engineer/github-rate-limit-http-transport/blob/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9/balancing.go
 * Budgets belong to installations, not to individual short-lived access tokens.
 */
export class BudgetScheduler implements SchedulerLike {
  private readonly budgets = new Map<string, Budget>();
  private readonly now: () => number;
  private cooldownUntil = 0;
  private sequence = 0;

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  private budget(key: string, resource: string): Budget {
    const id = JSON.stringify([key, resource]);
    let budget = this.budgets.get(id);
    if (!budget) {
      budget = { key, resource, inFlight: 0, lastChosen: 0 };
      this.budgets.set(id, budget);
    }
    // A reset is an opportunity to probe, never a promise that capacity is full.
    if (budget.resetAt !== undefined && budget.resetAt <= this.now()) {
      delete budget.remaining;
      delete budget.resetAt;
    }
    return budget;
  }

  reserve(keys: string[], resource: string): Reservation | undefined {
    const now = this.now();
    if (now < this.cooldownUntil) return undefined;
    const candidates = [...new Set(keys)].map(key => this.budget(key, resource)).filter(b =>
      b.remaining === undefined ? b.inFlight === 0 : b.remaining > b.inFlight);
    candidates.sort((a, b) => {
      // Discover each unused installation, with at most one probe in flight.
      const score = (v: Budget) => v.remaining === undefined ? Infinity :
        (v.remaining - v.inFlight) / Math.max(1, ((v.resetAt ?? now + 3_600_000) - now) / 1000);
      const x = score(a), y = score(b);
      return x === y ? a.lastChosen - b.lastChosen : x > y ? -1 : 1;
    });
    const selected = candidates[0];
    if (!selected) return undefined;
    selected.inFlight++;
    selected.lastChosen = ++this.sequence;
    let released = false;
    return { key: selected.key, resource, release: () => {
      if (!released) { selected.inFlight = Math.max(0, selected.inFlight - 1); released = true; }
    } };
  }

  observe(key: string, resource: string, status: number, headers: Record<string, string | string[] | undefined>, body?: string): void {
    const normalized = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    const numberHeader = (name: string): number | undefined => {
      const raw = normalized.get(name);
      if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
      const n = Number(raw);
      return counter(n) ? n : undefined;
    };
    const remaining = numberHeader('x-ratelimit-remaining');
    const limit = numberHeader('x-ratelimit-limit');
    const seconds = numberHeader('x-ratelimit-reset');
    const resetAt = seconds === undefined ? undefined : seconds * 1000;
    const bucket = this.budget(key, normalized.get('x-ratelimit-resource') || resource);
    const now = this.now();
    // Ignore delayed responses from an older window. Within a window, never let
    // an out-of-order higher remaining count replenish already spent quota.
    if (resetAt === undefined || resetAt > now) {
      if (resetAt !== undefined && (bucket.resetAt === undefined || resetAt > bucket.resetAt)) {
        bucket.resetAt = resetAt;
        bucket.remaining = remaining;
      } else if (resetAt === undefined || bucket.resetAt === undefined || resetAt === bucket.resetAt) {
        if (remaining !== undefined) bucket.remaining = Math.min(bucket.remaining ?? remaining, remaining);
      }
      if (bucket.remaining === 0 && bucket.resetAt === undefined) bucket.resetAt = now + 60_000;
      if (limit !== undefined) bucket.limit = limit;
    }
    let messages: string[] = [];
    let graphRateLimit = false;
    try {
      const parsed: unknown = JSON.parse(body ?? 'null');
      if (parsed && typeof parsed === 'object') {
        const data = parsed as { message?: unknown; errors?: unknown };
        if (typeof data.message === 'string') messages.push(data.message);
        if (Array.isArray(data.errors)) for (const error of data.errors) {
          if (error && typeof error === 'object') {
            if (error.type === 'RATE_LIMITED' || error.extensions?.code === 'RATE_LIMITED') graphRateLimit = true;
            if (typeof error.message === 'string') messages.push(error.message);
          }
        }
      }
    } catch { /* An HTML error page does not establish a permission or limit error. */ }
    const secondary = messages.some(m => /secondary rate limit|abuse detection|abuse rate limit/i.test(m));
    const rateMessage = messages.some(m => /(?:api )?rate limit exceeded|rate limit has been exceeded/i.test(m));
    const throttled = status === 429 || ((status === 403 || status === 200) && (secondary || rateMessage || graphRateLimit));
    const retry = normalized.get('retry-after');
    let retryAt: number | undefined;
    if (retry !== undefined) {
      if (/^\d+(?:\.\d+)?$/.test(retry.trim())) retryAt = now + Number(retry) * 1000;
      else { const date = Date.parse(retry); if (Number.isFinite(date)) retryAt = date; }
    }
    // Primary exhaustion affects this resource only; secondary throttling is
    // shared across the pool so rotation cannot amplify GitHub's backoff.
    if ((status === 403 || status === 429 || graphRateLimit || rateMessage) && remaining === 0 && !secondary && retry === undefined) {
      if (resetAt === undefined || (resetAt > now && (bucket.resetAt === undefined || resetAt >= bucket.resetAt))) {
        bucket.remaining = 0;
        bucket.resetAt = Math.max(bucket.resetAt ?? 0, resetAt ?? now + 60_000);
      }
    } else if (throttled || ((status === 403 || status === 429) && retry !== undefined)) {
      this.cooldownUntil = Math.max(this.cooldownUntil, finite(retryAt) && retryAt > now ? retryAt : now + 60_000);
    }
  }

  snapshot(): SchedulerSnapshot {
    return { cooldownUntil: this.cooldownUntil, budgets: [...this.budgets.values()].map(({ lastChosen: _, ...b }) => ({ ...b })) };
  }

  restore(state: SchedulerSnapshot): void {
    this.budgets.clear();
    this.sequence = 0;
    this.cooldownUntil = finite(state?.cooldownUntil) ? state.cooldownUntil : 0;
    if (!Array.isArray(state?.budgets)) return;
    for (const value of state.budgets) {
      if (!value || typeof value.key !== 'string' || !value.key || typeof value.resource !== 'string' || !value.resource) continue;
      const b = this.budget(value.key, value.resource);
      if (counter(value.remaining)) b.remaining = value.remaining;
      if (counter(value.limit)) b.limit = value.limit;
      if (finite(value.resetAt)) b.resetAt = value.resetAt;
      // Requests from the previous process are no longer in flight.
      b.inFlight = 0;
    }
  }
}
