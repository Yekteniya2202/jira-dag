import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { JiraCredentials } from '../shared/contracts.js';
import { connectJira, JiraError } from './jira.js';

const cloud: JiraCredentials = {
  edition: 'cloud', url: 'https://team.atlassian.net/', username: 'Test user',
  email: 'user@example.com', token: 'fake-test-token',
};
const basic = `Basic ${Buffer.from(`${cloud.email}:${cloud.token}`).toString('base64')}`;
const blocks = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const reviews = { id: '10100', name: 'Reviews', inward: 'is reviewed by', outward: 'reviews' };

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const noContent = (status = 204) => new Response(null, { status });
const profile = () => json({ displayName: 'Jira User', accountId: 'abc' });
const rawIssue = (key: string, fields: Record<string, unknown> = {}) => ({ key, fields: { summary: key, ...fields } });

function mockFetch(t: TestContext, handler: (url: URL, init: RequestInit) => Response) {
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(init.redirect, 'error');
    return handler(url, init);
  });
}

test('scoped Cloud credentials use the original Jira site only for Cloud ID lookup and links', async (t) => {
  const cloudId = '12345678-abcd-abcd-abcd-1234567890ab';
  const seen: string[] = [];
  mockFetch(t, (url, init) => {
    seen.push(url.href);
    const authorization = new Headers(init.headers).get('Authorization');
    if (url.pathname === '/_edge/tenant_info') {
      assert.equal(authorization, null);
      return json({ cloudId });
    }
    assert.equal(authorization, basic);
    return profile();
  });
  const { connection, client } = await connectJira({ ...cloud, scopedToken: true }, (site, edition) => {
    assert.equal(site.origin, 'https://team.atlassian.net');
    assert.equal(edition, 'cloud');
  });
  assert.deepEqual(seen, [
    'https://team.atlassian.net/_edge/tenant_info',
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
  ]);
  assert.deepEqual(connection, { url: 'https://team.atlassian.net', displayName: 'Jira User' });
  assert.equal(client.getIssueUrl('APP-1'), 'https://team.atlassian.net/browse/APP-1');
});

test('Cloud search preserves link direction, convergent links, hierarchy, zero points and external nodes', async (t) => {
  const externalJql: string[] = [];
  const searchTokens: Array<string | undefined> = [];
  mockFetch(t, (url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), basic);
    switch (url.pathname) {
      case '/rest/api/3/myself': return profile();
      case '/rest/api/3/field': return json([{ id: 'customfield_14000', name: 'Story point estimate', schema: { type: 'number' } }]);
      case '/rest/api/3/issueLinkType': return json({ issueLinkTypes: [blocks, reviews] });
      case '/rest/api/3/search/jql': {
        const query = JSON.parse(String(init.body)) as { jql: string; nextPageToken?: string; fields: string[] };
        assert.ok(query.fields.includes('customfield_14000'));
        if (query.jql === 'project = APP') {
          searchTokens.push(query.nextPageToken);
          if (!query.nextPageToken) return json({ nextPageToken: 'next-page', issues: [rawIssue('APP-1', {
            customfield_14000: 0,
            issuelinks: [{ id: '200', type: blocks, outwardIssue: rawIssue('APP-2') }],
          })] });
          return json({ isLast: true, issues: [rawIssue('APP-2', {
            customfield_14000: 3,
            parent: rawIssue('APP-4'),
            issuelinks: [
              { id: '200', type: blocks, inwardIssue: rawIssue('APP-1') },
              { id: '201', type: blocks, inwardIssue: rawIssue('EXT-3') },
            ],
          })] });
        }
        externalJql.push(query.jql);
        return json({ isLast: true, issues: [rawIssue('EXT-3', {
          customfield_14000: 2,
          issuelinks: [{ id: '202', type: reviews, outwardIssue: rawIssue('EXT-5') }],
        }), rawIssue('APP-4', { subtasks: [rawIssue('APP-2')] })] });
      }
      default: assert.fail(`Unexpected Jira URL ${url.pathname}`);
    }
  });
  const { client } = await connectJira(cloud, () => {});
  const graph = await client.loadGraph({ jql: 'project = APP', depth: 1 });
  assert.deepEqual(searchTokens, [undefined, 'next-page']);
  assert.deepEqual(externalJql, ['key in ("EXT-3", "APP-4")']);
  assert.deepEqual(graph.issues.map(({ key, storyPoints, external }) => ({ key, storyPoints, external })), [
    { key: 'APP-1', storyPoints: 0, external: false },
    { key: 'APP-2', storyPoints: 3, external: false },
    { key: 'EXT-3', storyPoints: 2, external: true },
    { key: 'APP-4', storyPoints: undefined, external: true },
    { key: 'EXT-5', storyPoints: undefined, external: true },
  ]);
  assert.deepEqual(graph.edges.map(({ id, source, target, label }) => ({ id, source, target, label })), [
    { id: '200', source: 'APP-1', target: 'APP-2', label: 'blocks' },
    { id: '201', source: 'EXT-3', target: 'APP-2', label: 'blocks' },
    { id: 'parent:APP-4:APP-2', source: 'APP-4', target: 'APP-2', label: 'Родительская задача' },
    { id: '202', source: 'EXT-3', target: 'EXT-5', label: 'reviews' },
  ]);
  assert.deepEqual(graph.warnings, []);
});

test('Data Center requests preserve the Jira context path and use offset paging and PAT', async (t) => {
  const offsets: number[] = [];
  mockFetch(t, (url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${cloud.token}`);
    switch (url.pathname) {
      case '/jira/rest/api/2/myself': return json({ displayName: 'Jira User', name: 'jira-user' });
      case '/jira/rest/api/2/field': return json([{ id: 'customfield_10002', name: 'Epic Link', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } }]);
      case '/jira/rest/api/2/issueLinkType': return json({ errorMessages: ['Issue linking is disabled'] }, 404);
      case '/jira/rest/api/2/search': {
        const query = JSON.parse(String(init.body)) as { startAt: number };
        offsets.push(query.startAt);
        return json({ total: 2, issues: [query.startAt ? rawIssue('APP-2') : rawIssue('APP-1', { customfield_10002: 'APP-2' })] });
      }
      default: assert.fail(`Unexpected Jira URL ${url.pathname}`);
    }
  });
  const { client } = await connectJira({ ...cloud, edition: 'data-center', url: 'https://jira.example.com/jira/' }, () => {});
  const graph = await client.loadGraph({ jql: 'project = APP', depth: 0 });
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(graph.issues[0]?.url, 'https://jira.example.com/jira/browse/APP-1');
  assert.deepEqual(graph.edges[0], { id: 'parent:APP-2:APP-1', source: 'APP-2', target: 'APP-1', label: 'Родительская задача', kind: 'parent' });
  assert.match(graph.warnings.join(' '), /типов связей/);
});

test('a newly created key survives a failed detail read and custom fields cannot override core fields', async (t) => {
  mockFetch(t, (url, init) => {
    if (url.pathname === '/rest/api/3/myself') return profile();
    if (url.pathname === '/rest/api/3/issue/APP-31') return json({ errorMessages: ['Issue read forbidden'] }, 403);
    assert.equal(url.pathname, '/rest/api/3/issue');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { fields: {
      project: { key: 'APP' }, issuetype: { id: '10001' }, summary: 'New cleanup task', customfield_12345: 4,
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Remove old fields' }] }] },
    } });
    return json({ key: 'APP-31' }, 201);
  });
  const { client } = await connectJira(cloud, () => {});
  const issue = await client.createIssue({
    projectKey: 'APP', typeId: '10001', summary: 'New cleanup task', description: 'Remove old fields',
    fields: { project: { key: 'BAD' }, key: 'BAD-2', description: 'Wrong', summary: 'Wrong', customfield_12345: 4 },
  });
  assert.equal(issue.key, 'APP-31');
  assert.equal(issue.summary, 'New cleanup task');
});

test('Cloud create fields preserve required metadata and encode configured textarea fields as ADF', async (t) => {
  const createMeta = '/rest/api/3/issue/createmeta/APP/issuetypes';
  let postedDescription: unknown;
  mockFetch(t, (url, init) => {
    if (url.pathname === '/rest/api/3/myself') return profile();
    if (url.pathname === createMeta) return json({ issueTypes: [{ id: '10001', name: 'Task' }], total: 1 });
    if (url.pathname === `${createMeta}/10001`) return json({ fields: [
      { fieldId: 'description', name: 'Description', required: true },
      { fieldId: 'customfield_12888', name: 'Risk', required: true, schema: {
        type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea',
      } },
    ], total: 2 });
    if (url.pathname === '/rest/api/3/issue') {
      postedDescription = JSON.parse(String(init.body)).fields.customfield_12888;
      return json({ key: 'APP-31' }, 201);
    }
    assert.equal(url.pathname, '/rest/api/3/issue/APP-31');
    return json(rawIssue('APP-31'));
  });
  const { client } = await connectJira(cloud, () => {});
  const options = await client.getCreateOptions('APP', '10001');
  assert.equal(options.issueTypes[0]?.name, 'Task');
  assert.equal(options.fields.find((field) => field.id === 'description')?.required, true);
  await client.createIssue({ projectKey: 'APP', typeId: '10001', summary: 'Cleanup', description: 'Detail', fields: {
    customfield_12888: 'Old readers may remain',
  } });
  assert.deepEqual(postedDescription, { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Old readers may remain' },
  ] }] });
});

test('creating an outward Jira link resolves its real ID for subsequent deletion', async (t) => {
  const mutations: string[] = [];
  mockFetch(t, (url, init) => {
    switch (url.pathname) {
      case '/rest/api/3/myself': return profile();
      case '/rest/api/3/issueLink':
        mutations.push(String(init.method));
        assert.deepEqual(JSON.parse(String(init.body)), {
          type: { id: '10000' }, inwardIssue: { key: 'APP-1' }, outwardIssue: { key: 'APP-2' },
        });
        return noContent(201);
      case '/rest/api/3/issue/APP-1':
        assert.equal(url.searchParams.get('fields'), 'issuelinks');
        return json(rawIssue('APP-1', { issuelinks: [{ id: '401', type: blocks, outwardIssue: rawIssue('APP-2') }] }));
      case '/rest/api/3/issueLink/401':
        mutations.push(String(init.method));
        return noContent();
      default: assert.fail(`Unexpected Jira URL ${url.pathname}`);
    }
  });
  const { client } = await connectJira(cloud, () => {});
  const edge = await client.createLink({ source: 'APP-1', target: 'APP-2', typeId: blocks.id });
  assert.deepEqual(edge, { id: '401', source: 'APP-1', target: 'APP-2', label: 'blocks', kind: 'link', typeId: blocks.id });
  await client.deleteLink('401');
  assert.deepEqual(mutations, ['POST', 'DELETE']);
});

test('a title change preserves rich Cloud descriptions and a plain-text edit cannot discard rich content', async (t) => {
  const description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Keep the link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
  ] }] };
  const updates: unknown[] = [];
  mockFetch(t, (url, init) => {
    if (url.pathname === '/rest/api/3/myself') return profile();
    assert.equal(url.pathname, '/rest/api/3/issue/APP-1');
    if (init.method === 'PUT') {
      updates.push(JSON.parse(String(init.body)));
      return noContent();
    }
    return json(rawIssue('APP-1', { description, summary: 'Title' }));
  });
  const { client } = await connectJira(cloud, () => {});
  await client.updateIssue({ key: 'APP-1', summary: 'Title', description: 'Keep the link' });
  await assert.rejects(client.updateIssue({ key: 'APP-1', summary: 'Title', description: 'Remove the link' }),
    (error) => error instanceof JiraError && error.status === 409);
  assert.deepEqual(updates, [{ fields: { summary: 'Title' } }]);
});

test('Jira errors redact credential data', async (t) => {
  mockFetch(t, () => json({ errorMessages: [`Invalid ${cloud.token} or ${basic}`] }, 401));
  await assert.rejects(connectJira(cloud, () => {}), (error) => {
    assert.ok(error instanceof JiraError);
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Ответ Jira HTTP 401: Invalid [redacted] or [redacted]');
    return true;
  });
});
