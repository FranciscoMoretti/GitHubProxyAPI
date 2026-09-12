export type Permission = 'contents' | 'pull_requests' | 'issues' | 'actions';
export interface RepositoryConfig { name: string; id: number }
export interface AppConfig {
  name: string;
  appId: string;
  installationId: number;
  privateKeyPath: string;
  repositories: RepositoryConfig[];
  permissions: Partial<Record<Permission, 'read'>>;
}
export interface Config {
  version: 1;
  socketPath: string;
  statePath: string;
  maxConcurrency: number;
  requestTimeoutMs: number;
  accessTtlMs: number;
  /** Explicit enrolled caller credentials, SHA-256 of token only (no scheme). */
  callerFingerprints: string[];
  apps: AppConfig[];
}
export interface TokenInfo {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
  repositoryIds: number[];
}
export interface TokenProvider {
  getToken(app: AppConfig): Promise<TokenInfo>;
  invalidate(app: AppConfig): void;
}
export interface BudgetSnapshot {
  key: string; resource: string; remaining?: number; limit?: number;
  resetAt?: number; inFlight: number;
}
export interface Reservation { key: string; resource: string; release(): void }
export interface SchedulerSnapshot {
  cooldownUntil: number;
  budgets: BudgetSnapshot[];
}
export interface SchedulerLike {
  reserve(keys: string[], resource: string): Reservation | undefined;
  observe(key: string, resource: string, status: number, headers: Record<string, string | string[] | undefined>, body?: string): void;
  snapshot(): SchedulerSnapshot;
  restore(state: SchedulerSnapshot): void;
}
export const appKey = (app: AppConfig): string => `installation:${app.installationId}`;
