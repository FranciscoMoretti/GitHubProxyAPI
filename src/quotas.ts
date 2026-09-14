import type { AppConfig, BudgetSnapshot } from './types.js';

interface ProxyStatus {
  scheduler?: { budgets?: BudgetSnapshot[] };
}

export interface QuotaRow {
  credential: string;
  kind: 'personal' | 'app';
  access: string;
  permissions: string[];
  resource: string;
  remaining?: number;
  limit?: number;
  resetAt?: string;
}

const isBudget = (value: unknown): value is BudgetSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const budget = value as Partial<BudgetSnapshot>;
  return typeof budget.key === 'string' && typeof budget.resource === 'string' && typeof budget.inFlight === 'number';
};

/** Build a secret-free view of the last quotas observed in GitHub responses. */
export function quotaRows(status: unknown, apps: AppConfig[]): QuotaRow[] {
  const input = status as ProxyStatus;
  const budgets = Array.isArray(input?.scheduler?.budgets) ? input.scheduler.budgets.filter(isBudget) : [];
  const rows: QuotaRow[] = [];
  for (const budget of budgets.filter(item => item.key.startsWith('personal:'))) {
    rows.push({
      credential: 'gh', kind: 'personal', access: 'personal (writes)', permissions: [],
      resource: budget.resource, remaining: budget.remaining, limit: budget.limit,
      resetAt: budget.resetAt ? new Date(budget.resetAt).toISOString() : undefined,
    });
  }
  for (const app of apps) {
    const permissions = Object.entries(app.permissions).filter(([, access]) => access === 'read').map(([name]) => name).sort();
    const appBudgets = budgets.filter(item => item.key === `installation:${app.installationId}`);
    for (const budget of appBudgets.length ? appBudgets : [{ key: '', resource: 'core', inFlight: 0 }]) {
      rows.push({
        credential: app.name, kind: 'app', access: 'read-only', permissions,
        resource: budget.resource, remaining: budget.remaining, limit: budget.limit,
        resetAt: budget.resetAt ? new Date(budget.resetAt).toISOString() : undefined,
      });
    }
  }
  return rows.sort((a, b) => Number(a.kind === 'app') - Number(b.kind === 'app') || a.credential.localeCompare(b.credential) || a.resource.localeCompare(b.resource));
}

/** Replace cached personal rows with the canonical `GET /rate_limit` response. */
export function withPersonalRateLimit(rows: QuotaRow[], response: unknown): QuotaRow[] {
  if (!response || typeof response !== 'object') return rows;
  const resources = (response as { resources?: unknown }).resources;
  if (!resources || typeof resources !== 'object') return rows;
  const current: QuotaRow[] = [];
  for (const resource of ['core', 'graphql', 'search', 'code_search']) {
    const value = (resources as Record<string, unknown>)[resource];
    if (!value || typeof value !== 'object') continue;
    const quota = value as { remaining?: unknown; limit?: unknown; reset?: unknown };
    if (typeof quota.remaining !== 'number' || typeof quota.limit !== 'number') continue;
    current.push({
      credential: 'gh', kind: 'personal', access: 'personal (writes)', permissions: [], resource,
      remaining: quota.remaining, limit: quota.limit,
      resetAt: typeof quota.reset === 'number' ? new Date(quota.reset * 1000).toISOString() : undefined,
    });
  }
  return current.length ? [...current, ...rows.filter(row => row.kind !== 'personal')] : rows;
}

function table(headers: string[], values: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...values.map(row => row[column]?.length ?? 0)));
  const line = (row: string[]) => row.map((value, column) => value.padEnd(widths[column]!)).join('  ').trimEnd();
  return [line(headers), line(widths.map(width => '-'.repeat(width))), ...values.map(line)].join('\n');
}

export function formatQuotas(rows: QuotaRow[]): string {
  return table(
    ['CREDENTIAL', 'TYPE', 'ACCESS', 'RESOURCE', 'AVAILABLE', 'RESET', 'PERMISSIONS'],
    rows.map(row => [
      row.credential,
      row.kind,
      row.access,
      row.resource,
      row.remaining == null || row.limit == null ? 'unknown' : `${row.remaining}/${row.limit}`,
      row.resetAt ?? 'unknown',
      row.permissions.length ? row.permissions.join(',') : '—',
    ]),
  );
}
