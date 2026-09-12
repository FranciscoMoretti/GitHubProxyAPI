import { createHash } from 'node:crypto';
import { Kind, parse, valueFromASTUntyped, buildSchema, validate, getVariableValues, type SelectionSetNode, type FragmentDefinitionNode } from 'graphql';
import type { IncomingHttpHeaders } from 'node:http';
import type { Permission } from './types.js';

export interface Decision {
  reason: string;
  resource: string;
  repository?: string;
  permission?: Permission;
  family?: string;
}
export function fingerprint(authorization?: string): string | undefined {
  const match = /^(?:bearer|token) ([^\s]+)$/i.exec(authorization ?? '');
  return match ? createHash('sha256').update(match[1]!).digest('hex') : undefined;
}
const personal = (reason: string, resource = 'core'): Decision => ({ reason, resource });
const versions = new Set(['2022-11-28', '2026-03-10']);
const validName = /^[A-Za-z0-9_.-]+$/;

/** An explicit request-level allowlist, never a /repos wildcard or CLI command parser. */
export function classify(method: string, path: string, headers: IncomingHttpHeaders, body?: Buffer): Decision {
  const url = new URL(path, 'https://api.github.com');
  const resource = url.pathname === '/graphql' ? 'graphql' : url.pathname.startsWith('/search/') ?
    (url.pathname === '/search/code' ? 'code_search' : 'search') : 'core';
  if (headers['if-none-match'] || headers['if-modified-since'] || headers.range || headers['if-match'] || headers['if-unmodified-since']) {
    return personal('conditional-or-range', resource);
  }
  const version = headers['x-github-api-version'];
  if (version && (typeof version !== 'string' || !versions.has(version))) return personal('unknown-api-version', resource);
  const accept = headers.accept ?? 'application/vnd.github+json';
  if (!['application/vnd.github+json', 'application/json', '*/*', 'application/vnd.github.v3+json'].includes(accept)) {
    return personal('unknown-representation', resource);
  }
  if (url.pathname === '/graphql') {
    if (method !== 'POST' || url.search || headers['content-encoding']) return personal('graphql-unsupported', resource);
    return classifyGraphQL(body);
  }
  if (method !== 'GET') return personal('write-or-unsupported-method', resource);
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/.exec(url.pathname);
  if (!match) return personal('personal-or-unknown-route', resource);
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  const tail = match[3]!;
  let permission: Permission; let family: string; let allowed: string[];
  if (/^git\/blobs\/[a-fA-F0-9]{40,64}$/.test(tail)) {
    permission = 'contents'; family = 'git-blob'; allowed = [];
  } else if (/^git\/trees\/[a-fA-F0-9]{40,64}$/.test(tail)) {
    permission = 'contents'; family = 'git-tree'; allowed = ['recursive'];
  } else if (/^pulls\/[1-9][0-9]*\/files$/.test(tail)) {
    permission = 'pull_requests'; family = 'pull-files'; allowed = ['page', 'per_page'];
  } else return personal('personal-or-unknown-route', resource);
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return personal('unknown-query', resource);
    if (key === 'recursive' ? value !== '1' : !/^[1-9][0-9]*$/.test(value) || Number(value) > (key === 'per_page' ? 100 : 10000)) {
      return personal('unknown-query', resource);
    }
  }
  return { reason: 'eligible-read', resource, repository, permission, family };
}

const scalarFields: Record<string, Set<string>> = {
  PullRequest: new Set(['__typename', 'id', 'number', 'title', 'body', 'url', 'state', 'isDraft', 'headRefName', 'baseRefName', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'additions', 'deletions', 'changedFiles']),
  Issue: new Set(['__typename', 'id', 'number', 'title', 'body', 'url', 'state', 'createdAt', 'updatedAt', 'closedAt']),
  Repository: new Set(['__typename', 'id', 'name', 'nameWithOwner', 'url']),
};

// This intentionally small schema validates only the supported read subset. Full-document
// validation catches invalid aliases, variable types and fragment definitions before changing identity.
const readSchema = buildSchema(`
  type Query { repository(owner: String!, name: String!): Repository }
  type Repository {
    id: ID! name: String! nameWithOwner: String! url: String!
    pullRequest(number: Int!): PullRequest issue(number: Int!): Issue
  }
  type PullRequest {
    id: ID! number: Int! title: String! body: String! url: String! state: String!
    isDraft: Boolean! headRefName: String! baseRefName: String! createdAt: String!
    updatedAt: String! closedAt: String mergedAt: String additions: Int! deletions: Int! changedFiles: Int!
  }
  type Issue {
    id: ID! number: Int! title: String! body: String! url: String! state: String!
    createdAt: String! updatedAt: String! closedAt: String
  }
`);

/** Only single-repository scalar issue/PR reads. Connections, viewer fields, search and unknown selections stay personal. */
function classifyGraphQL(body?: Buffer): Decision {
  const denied = () => personal('graphql-personal-or-unknown', 'graphql');
  if (!body || body.length > 1024 * 1024) return denied();
  try {
    const input = JSON.parse(body.toString()) as Record<string, unknown>;
    if (typeof input.query !== 'string' || Object.keys(input).some(k => !['query', 'variables', 'operationName'].includes(k))) return denied();
    if (input.variables != null && (typeof input.variables !== 'object' || Array.isArray(input.variables))) return denied();
    if (input.operationName != null && typeof input.operationName !== 'string') return denied();
    const doc = parse(input.query, { maxTokens: 10000 });
    if (validate(readSchema, doc).length) return denied();
    const operations = doc.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION);
    const operation = typeof input.operationName === 'string' ? operations.find(o => o.name?.value === input.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!operation || operation.operation !== 'query' || operation.directives?.length) return denied();
    const supplied = input.variables as Record<string, unknown> ?? {};
    const definitions = operation.variableDefinitions ?? [];
    const variableNames = new Set(definitions.map(definition => definition.variable.name.value));
    if (Object.keys(supplied).some(name => !variableNames.has(name)) || definitions.some(definition => definition.directives?.length)) return denied();
    const coerced = getVariableValues(readSchema, definitions, supplied);
    if (coerced.errors) return denied();
    const variables = coerced.coerced;
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of doc.definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      if (fragments.has(definition.name.value)) return denied();
      fragments.set(definition.name.value, definition);
    }
    let repository: string | undefined; let permission: Permission | undefined; let repositories = 0; let items = 0;
    const walk = (set: SelectionSetNode, type: string, stack: string[] = []): boolean => {
      for (const field of set.selections) {
        if (field.directives?.length) return false;
        if (field.kind === Kind.FRAGMENT_SPREAD) {
          const fragment = fragments.get(field.name.value);
          if (!fragment || fragment.directives?.length || fragment.typeCondition.name.value !== type || stack.includes(field.name.value)) return false;
          if (!walk(fragment.selectionSet, type, [...stack, field.name.value])) return false;
          continue;
        }
        if (field.kind === Kind.INLINE_FRAGMENT) {
          if (field.typeCondition && field.typeCondition.name.value !== type) return false;
          if (!walk(field.selectionSet, type, stack)) return false;
          continue;
        }
        const args: Record<string, unknown> = {};
        for (const arg of field.arguments ?? []) {
          if (arg.name.value in args) return false;
          args[arg.name.value] = valueFromASTUntyped(arg.value, variables);
        }
        const name = field.name.value;
        if (type === 'Query' && name === 'repository') {
          if (++repositories !== 1 || Object.keys(args).sort().join(',') !== 'name,owner' || typeof args.owner !== 'string' || typeof args.name !== 'string' || !validName.test(args.owner) || !validName.test(args.name) || !field.selectionSet) return false;
          repository = `${args.owner}/${args.name}`.toLowerCase();
          if (!walk(field.selectionSet, 'Repository', stack)) return false;
        } else if (type === 'Repository' && ['pullRequest', 'issue'].includes(name)) {
          if (++items !== 1 || Object.keys(args).join(',') !== 'number' || !Number.isSafeInteger(args.number) || (args.number as number) < 1 || !field.selectionSet) return false;
          permission = name === 'pullRequest' ? 'pull_requests' : 'issues';
          if (!walk(field.selectionSet, name === 'pullRequest' ? 'PullRequest' : 'Issue', stack)) return false;
        } else if (!scalarFields[type]?.has(name) || field.selectionSet || Object.keys(args).length) return false;
      }
      return true;
    };
    if (!walk(operation.selectionSet, 'Query') || !repository || !permission || items !== 1) return denied();
    return { reason: 'eligible-read', resource: 'graphql', repository, permission, family: `graphql-${permission}` };
  } catch { return denied(); }
}
