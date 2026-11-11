import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { JiraCredentials } from '../shared/contracts.js';
import { connectJira, JiraError } from './jira.js';
import { createApiSession } from './session.js';

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
const adf = (...lines: string[]) => ({
  type: 'doc', version: 1,
  content: lines.map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })),
});
const noteMarker = 'Jira DAG note v1';
const rawComment = (id: string, body: unknown) => ({
  id, body, author: { displayName: 'Jira User' }, created: '2026-11-11T12:00:00.000Z',
});

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
      case '/jira/rest/api/2/field': return json([
        { id: 'customfield_10002', name: 'Epic Link', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
        { id: 'customfield_10003', name: 'Local Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
      ]);
      case '/jira/rest/api/2/issueLinkType': return json({ errorMessages: ['Issue linking is disabled'] }, 404);
      case '/jira/rest/api/2/search': {
        const query = JSON.parse(String(init.body)) as { startAt: number; fields: string[] };
        offsets.push(query.startAt);
        assert.ok(query.fields.includes('customfield_10003'));
        return json({ total: 2, issues: [query.startAt ? rawIssue('APP-2') : rawIssue('APP-1', {
          customfield_10002: 'APP-2',
          customfield_10003: [
            'com.atlassian.greenhopper.service.sprint.Sprint@1bf75fd[id=1,rapidViewId=1,state=CLOSED,name=Спринт, ноябрь,goal=Цель,sequence=1]',
          ],
        })] });
      }
      default: assert.fail(`Unexpected Jira URL ${url.pathname}`);
    }
  });
  const { client } = await connectJira({ ...cloud, edition: 'data-center', url: 'https://jira.example.com/jira/' }, () => {});
  const graph = await client.loadGraph({ jql: 'project = APP', depth: 0 });
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(graph.issues[0]?.url, 'https://jira.example.com/jira/browse/APP-1');
  assert.equal(graph.issues[0]?.parentKey, 'APP-2');
  assert.equal(graph.issues[0]?.epicKey, 'APP-2');
  assert.deepEqual(graph.issues[0]?.sprints, ['Спринт, ноябрь']);
  assert.equal(graph.issues[1]?.isEpic, true);
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

test('Cloud search supplies filters and finds the epic of a nested subtask', async (t) => {
  mockFetch(t, (url, init) => {
    switch (url.pathname) {
      case '/rest/api/3/myself': return profile();
      case '/rest/api/3/field': return json([
        { id: 'customfield_10004', name: 'Plan', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
      ]);
      case '/rest/api/3/issueLinkType': return json({ issueLinkTypes: [] });
      case '/rest/api/3/search/jql': {
        const { fields } = JSON.parse(String(init.body)) as { fields: string[] };
        for (const key of ['labels', 'priority', 'fixVersions', 'duedate', 'timeoriginalestimate', 'timeestimate', 'customfield_10004']) {
          assert.ok(fields.includes(key));
        }
        return json({ isLast: true, issues: [
          rawIssue('APP-3', { issuetype: { name: 'Local Subtask', hierarchyLevel: -1 }, parent: rawIssue('APP-2') }),
          rawIssue('APP-2', {
            parent: rawIssue('APP-1'), labels: ['cleanup', 'cleanup', 'schema'], priority: { name: 'High' },
            fixVersions: [{ name: 'Release 2.1' }], customfield_10004: [{ name: 'Sprint 2' }, { name: 'Sprint 1' }],
            duedate: '2026-11-19', timeoriginalestimate: 3_600, timeestimate: 0,
          }),
          rawIssue('APP-1', { issuetype: { name: 'Local Epic', hierarchyLevel: 1 } }),
        ] });
      }
      default: assert.fail(`Unexpected Jira URL ${url.pathname}`);
    }
  });
  const { client } = await connectJira(cloud, () => {});
  const { issues } = await client.loadGraph({ jql: 'project = APP', depth: 0 });
  const [subtask, task, epic] = issues;
  assert.equal(subtask?.isSubtask, true);
  assert.equal(subtask?.parentKey, 'APP-2');
  assert.equal(subtask?.epicKey, 'APP-1');
  assert.deepEqual(task?.labels, ['cleanup', 'schema']);
  assert.equal(task?.priority, 'High');
  assert.deepEqual(task?.fixVersions, ['Release 2.1']);
  assert.deepEqual(task?.sprints, ['Sprint 2', 'Sprint 1']);
  assert.equal(task?.dueDate, '2026-11-19');
  assert.equal(task?.originalEstimateSeconds, 3_600);
  assert.equal(task?.remainingEstimateSeconds, 0);
  assert.equal(epic?.isEpic, true);
  assert.equal(epic?.epicKey, 'APP-1');
});

test('Cloud project listing pages on the authenticated gateway and ignores malformed records', async (t) => {
  const cloudId = '12345678-abcd-abcd-abcd-1234567890ab';
  const offsets: number[] = [];
  mockFetch(t, (url, init) => {
    if (url.pathname === '/_edge/tenant_info') return json({ cloudId });
    assert.equal(url.origin, 'https://api.atlassian.com');
    assert.equal(new Headers(init.headers).get('Authorization'), basic);
    if (url.pathname.endsWith('/myself')) return profile();
    assert.equal(url.pathname, `/ex/jira/${cloudId}/rest/api/3/project/search`);
    assert.equal(init.method, 'GET');
    assert.equal(url.searchParams.get('maxResults'), '100');
    const startAt = Number(url.searchParams.get('startAt'));
    offsets.push(startAt);
    if (startAt === 0) return json({
      startAt, isLast: false, maxResults: 2, nextPage: 'https://unrelated.invalid/projects',
      values: [{ id: '10001', key: 'APP', name: 'Application' }, { id: '10002', key: 'X" OR project = "PRIVATE', name: 'Bad key' }],
    });
    if (startAt === 2) return json({
      startAt, isLast: false, maxResults: 2, values: [
        { id: 10001, key: 'APP', name: 'Application' }, { id: 10003, key: 'OPS_2', name: ' Operations ' },
      ],
    });
    return json({ startAt, isLast: true, maxResults: 2, values: [] });
  });
  const { client } = await connectJira({ ...cloud, scopedToken: true }, () => {});
  assert.deepEqual(await client.listProjects(), [
    { id: '10001', key: 'APP', name: 'Application' }, { id: '10003', key: 'OPS_2', name: 'Operations' },
  ]);
  assert.deepEqual(offsets, [0, 2, 4]);
});

test('Data Center project listing uses the session PAT and propagates Jira permissions', async (t) => {
  let forbidden = false;
  mockFetch(t, (url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${cloud.token}`);
    if (url.pathname === '/jira/rest/api/2/myself') return profile();
    assert.equal(url.pathname, '/jira/rest/api/2/project');
    return forbidden ? json({ errorMessages: ['Forbidden'] }, 403) : json([
      { id: '10001', key: 'APP', name: 'Application' }, { id: 10002, key: 'OLD', name: ' ' },
    ]);
  });
  const session = createApiSession();
  const action = { method: 'listProjects', input: null };
  const unauthenticated = await session.invoke(action);
  assert.equal(unauthenticated.ok ? null : unauthenticated.status, 401);
  assert.equal((await session.invoke({
    method: 'connect', input: { ...cloud, edition: 'data-center', url: 'https://jira.example.com/jira' },
  })).ok, true);
  const invalid = await session.invoke({ ...action, input: {} });
  assert.equal(invalid.ok ? null : invalid.status, 400);
  assert.deepEqual(await session.invoke(action), {
    ok: true, data: [{ id: '10001', key: 'APP', name: 'Application' }],
  });
  forbidden = true;
  const denied = await session.invoke(action);
  assert.equal(denied.ok ? null : denied.status, 403);
});

test('Cloud avatars are limited to the Atlassian CDN without forwarding Jira authorization', async (t) => {
  const cdn = 'avatar-management--avatars.us-west-2.prod.public.atl-paas.net';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lGxsAAAAASUVORK5CYII=';
  let source = `https://${cdn}/initials/JS-1.png?size=48`;
  let requests = 0;
  mockFetch(t, (url, init) => {
    const authorization = new Headers(init.headers).get('Authorization');
    if (url.origin === 'https://team.atlassian.net') {
      assert.equal(authorization, basic);
      if (url.pathname.endsWith('/myself')) return profile();
      assert.equal(url.pathname, '/rest/api/3/issue/APP-1');
      assert.equal(url.searchParams.get('fields'), 'assignee');
      return json(rawIssue('APP-1', { assignee: { avatarUrls: { '48x48': source } } }));
    }
    requests += 1;
    assert.equal(url.hostname, cdn);
    assert.equal(authorization, null);
    assert.equal(init.credentials, 'omit');
    return new Response(Uint8Array.from(Buffer.from(png, 'base64')), { headers: { 'Content-Type': 'image/png' } });
  });
  const { client } = await connectJira(cloud, () => {});
  assert.equal(await client.getAssigneeAvatar('APP-1'), `data:image/png;base64,${png}`);
  source = `https://${cdn}.example.com/initials/JS-1.png`;
  assert.equal(await client.getAssigneeAvatar('APP-1'), null);
  source = '/rest/api/3/user/search';
  assert.equal(await client.getAssigneeAvatar('APP-1'), null);
  assert.equal(requests, 1);
});

test('Data Center avatar fetch uses the context path and rejects non-raster and oversized responses', async (t) => {
  let body = () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
  mockFetch(t, (url, init) => {
    assert.equal(url.origin, 'https://jira.example.com');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${cloud.token}`);
    if (url.pathname === '/jira/rest/api/2/myself') return profile();
    if (url.pathname === '/jira/rest/api/2/issue/APP-1') return json(rawIssue('APP-1', {
      assignee: { avatarUrls: { '48x48': '/jira/secure/useravatar?ownerId=jira-user' } },
    }));
    assert.equal(url.pathname, '/jira/secure/useravatar');
    return body();
  });
  const session = createApiSession();
  const action = { method: 'getAssigneeAvatar', input: { key: 'APP-1' } };
  assert.equal((await session.invoke({
    method: 'connect', input: { ...cloud, edition: 'data-center', url: 'https://jira.example.com/jira' },
  })).ok, true);
  assert.deepEqual(await session.invoke(action), { ok: true, data: null });
  body = () => new Response('<svg/>', { headers: { 'Content-Type': 'image/png' } });
  assert.deepEqual(await session.invoke(action), { ok: true, data: null });
  body = () => new Response(new Uint8Array(128 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } });
  assert.deepEqual(await session.invoke(action), { ok: true, data: null });
  body = () => Response.redirect('https://unrelated.invalid/avatar.png');
  assert.deepEqual(await session.invoke(action), { ok: true, data: null });
});

test('saved favorites support Jira Cloud and Data Center, including filters without exposed JQL', async (t) => {
  const paths: string[] = [];
  mockFetch(t, (url) => {
    if (url.pathname.endsWith('/myself')) return profile();
    paths.push(url.pathname);
    return json([
      { id: '1010', name: 'Dependencies', jql: 'project = APP' },
      { id: 1011, name: 'Restricted query' },
      { id: 'bad', name: 'Invalid' },
    ]);
  });
  const { client } = await connectJira(cloud, () => {});
  const { client: dc } = await connectJira({ ...cloud, edition: 'data-center', url: 'https://jira.example.com/jira' }, () => {});
  const expected = [
    { id: '1010', name: 'Dependencies', jql: 'project = APP' },
    { id: '1011', name: 'Restricted query', jql: undefined },
  ];
  assert.deepEqual(await client.listSavedFilters(), expected);
  assert.deepEqual(await dc.listSavedFilters(), expected);
  assert.deepEqual(paths, ['/rest/api/3/filter/favourite', '/jira/rest/api/2/filter/favourite']);
});

test('Cloud graph notes read all pages and refuse to delete comments outside the note namespace', async (t) => {
  const methods: string[] = [];
  const path = '/rest/api/3/issue/APP-1/comment';
  mockFetch(t, (url, init) => {
    if (url.pathname.endsWith('/myself')) return profile();
    methods.push(`${init.method} ${url.pathname}`);
    if (url.pathname === path && init.method === 'GET') {
      const startAt = Number(url.searchParams.get('startAt'));
      return startAt === 0
        ? json({ startAt, total: 4, comments: [rawComment('1', adf(noteMarker, 'First note')), rawComment('2', adf('Normal comment', noteMarker, 'Not a note'))] })
        : json({ startAt, total: 4, comments: [rawComment('3', adf(`${noteMarker}0`, 'Wrong version')), rawComment('4', adf(noteMarker, 'Second note', 'Line two'))] });
    }
    if (url.pathname === path && init.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { body: unknown };
      assert.deepEqual(payload.body, adf(noteMarker, 'New note', '', 'Line two'));
      return json(rawComment('5', payload.body), 201);
    }
    if (url.pathname === `${path}/2`) return json(rawComment('2', adf('Normal comment')));
    if (url.pathname === `${path}/4` && init.method === 'GET') return json(rawComment('4', adf(noteMarker, 'Second note')));
    if (url.pathname === `${path}/4` && init.method === 'DELETE') return noContent();
    assert.fail(`Unexpected Jira URL ${url.pathname}`);
  });
  const { client } = await connectJira(cloud, () => {});
  assert.deepEqual((await client.listNotes('APP-1')).map(({ id, text }) => [id, text]), [
    ['1', 'First note'], ['4', 'Second note\nLine two'],
  ]);
  assert.deepEqual(await client.createNote('APP-1', 'New note\r\n\r\nLine two'), {
    id: '5', text: 'New note\n\nLine two', author: 'Jira User', createdAt: '2026-11-11T12:00:00.000Z',
  });
  await assert.rejects(client.deleteNote('APP-1', '2'), (error) => error instanceof JiraError && error.status === 409);
  await client.deleteNote('APP-1', '4');
  assert.deepEqual(methods, [
    `GET ${path}`, `GET ${path}`, `POST ${path}`, `GET ${path}/2`, `GET ${path}/4`, `DELETE ${path}/4`,
  ]);
});

test('Data Center graph notes use plain Jira comments and the session rejects invalid note inputs', async (t) => {
  const calls: string[] = [];
  const path = '/jira/rest/api/2/issue/APP-1/comment';
  mockFetch(t, (url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${cloud.token}`);
    calls.push(`${init.method} ${url.pathname}`);
    if (url.pathname.endsWith('/myself')) return profile();
    assert.equal(url.pathname, path);
    if (init.method === 'GET') return json({ startAt: 0, total: 2, comments: [
      rawComment('1', `${noteMarker}\r\nLegacy note`), rawComment('2', ` ${noteMarker}\nRegular comment`),
    ] });
    assert.deepEqual(JSON.parse(String(init.body)), { body: `${noteMarker}\nWrite a note` });
    return json(rawComment('3', `${noteMarker}\nWrite a note`), 201);
  });
  const session = createApiSession();
  assert.equal((await session.invoke({
    method: 'connect', input: { ...cloud, edition: 'data-center', url: 'https://jira.example.com/jira' },
  })).ok, true);
  assert.equal((await session.invoke({ method: 'createNote', input: { key: 'APP-1', text: ' ' } })).ok, false);
  assert.equal((await session.invoke({ method: 'createNote', input: { key: 'APP-1', text: 'x'.repeat(8_001) } })).ok, false);
  assert.equal((await session.invoke({ method: 'deleteNote', input: { key: 'APP-1', id: 'bad' } })).ok, false);
  assert.equal((await session.invoke({ method: 'listNotes', input: { key: 'invalid' } })).ok, false);
  const listed = await session.invoke({ method: 'listNotes', input: { key: 'APP-1' } });
  assert.deepEqual(listed, { ok: true, data: [{
    id: '1', text: 'Legacy note', author: 'Jira User', createdAt: '2026-11-11T12:00:00.000Z',
  }] });
  const created = await session.invoke({ method: 'createNote', input: { key: 'APP-1', text: 'Write a note' } });
  assert.deepEqual(created, { ok: true, data: {
    id: '3', text: 'Write a note', author: 'Jira User', createdAt: '2026-11-11T12:00:00.000Z',
  } });
  assert.deepEqual(calls, ['GET /jira/rest/api/2/myself', `GET ${path}`, `POST ${path}`]);
});
