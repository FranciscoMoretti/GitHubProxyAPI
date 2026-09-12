import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classify, fingerprint } from '../src/policy.js';

const sha = 'a'.repeat(40);
const graph = (query: string, variables?: unknown, operationName?: unknown) =>
  classify('POST', '/graphql', {}, Buffer.from(JSON.stringify({ query, variables, operationName })));
const pr = '{ repository(owner:"Owner", name:"Repo") { pullRequest(number:1) { title } } }';
const personal = (decision: ReturnType<typeof classify>) => assert.equal(decision.repository, undefined);

test('fingerprints the credential without preserving scheme or token', () => {
  const expected = createHash('sha256').update('token-secret').digest('hex');
  assert.equal(fingerprint('Bearer token-secret'), expected);
  assert.equal(fingerprint('token token-secret'), expected);
  assert.equal(fingerprint('bEaReR token-secret'), expected);
  for (const value of [undefined, '', 'Basic token-secret', 'Bearer token secret', 'Bearer ']) {
    assert.equal(fingerprint(value), undefined);
  }
});

test('allows only exact supported REST routes with correct permission and quota family', () => {
  assert.deepEqual(classify('GET', `/repos/Owner/Repo/git/blobs/${sha}`, {}), {
    reason: 'eligible-read', resource: 'core', repository: 'owner/repo', permission: 'contents', family: 'git-blob',
  });
  assert.equal(classify('GET', `/repos/owner/repo/git/trees/${sha}?recursive=1`, {}).family, 'git-tree');
  assert.deepEqual(classify('GET', '/repos/owner/repo/pulls/123/files?page=2&per_page=100', {}), {
    reason: 'eligible-read', resource: 'core', repository: 'owner/repo', permission: 'pull_requests', family: 'pull-files',
  });
  for (const path of ['/user', '/user/repos', '/repos/o/r', '/repos/o/r/issues', '/repos/o/r/pulls/1',
    '/repos/o/r/contents/file', '/repos/o/r/pulls/0/files', '/repos/o/r/pulls/01/files', '/repos/o/r/pulls/1/files/',
    `/repos/o/r/git/blobs/main`, `/repos/o/r/git/trees/${sha}/extra`, '/repos/o%2Fother/r/pulls/1/files']) {
    personal(classify('GET', path, {}));
  }
});

test('REST routing rejects unknown, repeated and out of range query parameters', () => {
  for (const query of ['page=0', 'page=-1', 'page=1.2', 'page=1e2', 'page=10001', 'per_page=101',
    'per_page=0', 'page=1&page=2', 'unknown=1', 'page=', 'page=01']) {
    personal(classify('GET', `/repos/o/r/pulls/1/files?${query}`, {}));
  }
  personal(classify('GET', `/repos/o/r/git/blobs/${sha}?page=1`, {}));
  personal(classify('GET', `/repos/o/r/git/trees/${sha}?recursive=true`, {}));
  personal(classify('GET', `/repos/o/r/git/trees/${sha}?recursive=1&recursive=1`, {}));
});

test('writes, conditional requests, alternate media and unknown versions retain personal identity', () => {
  const path = '/repos/o/r/pulls/1/files';
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) personal(classify(method, path, {}));
  for (const header of ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'range']) {
    personal(classify('GET', path, { [header]: 'value' }));
    personal(classify('POST', '/graphql', { [header]: 'value' }, Buffer.from(JSON.stringify({ query: pr }))));
  }
  for (const accept of ['application/vnd.github.raw+json', 'application/vnd.github.diff', 'text/plain', 'application/json;q=0.9']) {
    personal(classify('GET', path, { accept }));
  }
  for (const accept of ['application/vnd.github+json', 'application/json', '*/*', 'application/vnd.github.v3+json']) {
    assert.equal(classify('GET', path, { accept }).repository, 'o/r');
  }
  personal(classify('GET', path, { 'x-github-api-version': '2099-01-01' }));
  personal(classify('GET', path, { 'x-github-api-version': ['2022-11-28'] }));
  assert.equal(classify('GET', path, { 'x-github-api-version': '2022-11-28' }).repository, 'o/r');
  assert.equal(classify('GET', '/search/code?q=test', {}).resource, 'code_search');
  assert.equal(classify('GET', '/search/issues?q=test', {}).resource, 'search');
});

test('ordinary scalar PR and issue queries are useful eligible reads', () => {
  assert.deepEqual(graph(pr), { reason: 'eligible-read', resource: 'graphql', repository: 'owner/repo',
    permission: 'pull_requests', family: 'graphql-pull_requests' });
  const issue = graph('{ repository(owner:"o",name:"r") { nameWithOwner issue(number:42) { id number title body url state createdAt updatedAt closedAt } } }');
  assert.equal(issue.repository, 'o/r');
  assert.equal(issue.permission, 'issues');
  assert.equal(graph('{ repository(owner:"o",name:"r") { pullRequest(number:2) { id number title body url state isDraft headRefName baseRefName createdAt updatedAt closedAt mergedAt additions deletions changedFiles __typename } } }').permission, 'pull_requests');
});

test('GraphQL supports aliases, safe fragments, variables and defaults', () => {
  const query = `query Read($owner: String!, $name: String! = "Repo", $number: Int! = 1) {
    selected: repository(owner:$owner,name:$name) {
      ...RepoFields
      item: pullRequest(number:$number) { renamed:title ...PrFields ... on PullRequest { number } }
    }
  }
  fragment RepoFields on Repository { nameWithOwner }
  fragment PrFields on PullRequest { id body }`;
  assert.equal(graph(query, { owner: 'Owner' }).repository, 'owner/repo');
  assert.equal(graph(query, { owner: 'Owner', name: 'Other', number: 42 }).repository, 'owner/other');
  assert.equal(graph('{ repository(owner:"o",name:"r") { issue(number:1) { title title } } }').permission, 'issues');
});

test('selects only the named operation and rejects ambiguous operation selection', () => {
  const query = `query Pull { repository(owner:"o",name:"r") { pullRequest(number:1) { title } } }
    query Issue { repository(owner:"other",name:"repo") { issue(number:2) { title } } }`;
  assert.equal(graph(query, undefined, 'Pull').permission, 'pull_requests');
  assert.equal(graph(query, undefined, 'Issue').repository, 'other/repo');
  for (const operation of [undefined, '', 'Missing', 1, {}]) personal(graph(query, undefined, operation));
  personal(graph(`query Same ${pr} query Same ${pr}`, undefined, 'Same'));
});

test('viewer, affiliations, unknown nested objects and multiple resources remain personal', () => {
  const queries = [
    '{ viewer { login } }',
    '{ repository(owner:"o",name:"r") { viewerPermission issue(number:1) { title } } }',
    '{ repository(owner:"o",name:"r") { pullRequest(number:1) { viewerDidAuthor title } } }',
    '{ repository(owner:"o",name:"r") { pullRequest(number:1) { author { login } } } }',
    '{ repository(owner:"o",name:"r") { issues(first:1) { nodes { title } } } }',
    '{ viewer { repositories(affiliations:[OWNER]) { totalCount } } }',
    '{ repository(owner:"o",name:"r") { issue(number:1) { title } pullRequest(number:1) { title } } }',
    '{ a:repository(owner:"o",name:"r") { issue(number:1) { title } } b:repository(owner:"x",name:"y") { issue(number:1) { title } } }',
    '{ repository(owner:"o",name:"r") { issue(number:1) { title @skip(if:true) } } }',
    'mutation { addComment(input:{subjectId:"abc",body:"hello"}) { clientMutationId } }',
  ];
  for (const query of queries) personal(graph(query));
});

test('invalid or ambiguous GraphQL definitions, field shapes and arguments remain personal', () => {
  for (const query of [
    '{ repository(owner:"o",name:"r") { issue(number:1) { same:title same:body } } }',
    '{ repository(owner:"o",owner:"x",name:"r") { issue(number:1) { title } } }',
    '{ repository(owner:"o",name:"r") { issue(number:"1") { title } } }',
    '{ repository(owner:"o",name:"r") { issue(number:2147483648) { title } } }',
    '{ repository(owner:"o",name:"r") { issue(number:0) { title } } }',
    '{ repository(owner:"o",name:"r") { issue(number:1) { title { id } } } }',
    '{ repository(owner:"o",name:"r") { issue(number:1) { title(extra:1) } } }',
    '{ repository(owner:"o",name:"r") { issue(number:1) } }',
    '{ repository(owner:"o",name:"r") { ...Cycle } } fragment Cycle on Repository { ...Cycle }',
    '{ repository(owner:"o",name:"r") { issue(number:1) { ...Missing } } }',
    '{ repository(owner:"o",name:"r") { issue(number:1) { ...F } } } fragment F on PullRequest { title }',
    '{ repository(owner:"o",name:"r") { issue(number:1) { ...F } } } fragment F on Issue { title } fragment F on Issue { body }',
    'query Read($n:Int!, $n:Int!) { repository(owner:"o",name:"r") { issue(number:$n) { title } } }',
    'query Read($n:String!) { repository(owner:"o",name:"r") { issue(number:$n) { title } } }',
    'query Read($n:Int) { repository(owner:"o",name:"r") { issue(number:$n) { title } } }',
    'query Read($unused:Int) { repository(owner:"o",name:"r") { issue(number:1) { title } } }',
    '{ repository(owner:"o",name:"r") { issue(number:$n) { title } } }',
  ]) personal(graph(query, query.includes('$n') ? { n: 1 } : undefined));
});

test('GraphQL variables must conform to declarations and supplied extras are conservative', () => {
  const query = 'query Read($n:Int!) { repository(owner:"o",name:"r") { issue(number:$n) { title } } }';
  assert.equal(graph(query, { n: 1 }).permission, 'issues');
  for (const variables of [undefined, {}, { n: '1' }, { n: 1.5 }, { n: null }, { n: 2147483648 },
    { n: 1, extra: true }, [], 'bad', { n: {} }]) personal(graph(query, variables));
});

test('unsupported GraphQL request envelopes and encodings stay personal', () => {
  personal(classify('GET', '/graphql', {}));
  personal(classify('POST', '/graphql?extra=1', {}, Buffer.from(JSON.stringify({ query: pr }))));
  personal(classify('POST', '/graphql', { 'content-encoding': 'gzip' }, Buffer.from(JSON.stringify({ query: pr }))));
  for (const value of ['{', 'null', '[]', JSON.stringify({ query: pr, extra: true }), JSON.stringify({ query: 1 })]) {
    personal(classify('POST', '/graphql', {}, Buffer.from(value)));
  }
  personal(classify('POST', '/graphql', {}, Buffer.alloc(1024 * 1024 + 1)));
});
