import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { JiraStartSprintInput } from '../shared/contracts.js';
import { JiraClient, JiraError } from './jira.js';
import { createApiSession } from './session.js';

const cloud = 'cloud';
const dc = 'data-center';
const sp = 'customfield_10001';
const qa = 'customfield_10002';
const alternateSp = 'customfield_10003';
const fields = [
  { id: sp, name: 'Story Points', schema: { type: 'number' } },
  { id: qa, name: 'QA Points', schema: { type: 'number' } },
  { id: alternateSp, name: 'Story point estimate', schema: { type: 'number' } },
  { id: 'customfield_10004', name: 'Weight', schema: { type: 'number' } },
  { id: 'customfield_10005', name: 'QA workflow', schema: { type: 'string' } },
];
const future = { id: 7, name: 'Next', state: 'future', originBoardId: 1, goal: 'Switch clients' };
const active = { id: 8, name: 'Now', state: 'active', startDate: '2026-11-10T12:00:00Z' };
const closed = { id: 6, name: 'Before', state: 'closed', endDate: '2026-11-09T12:00:00Z', completeDate: '2026-11-09T13:00:00Z' };
const blocks = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const issueType = { id: '10003', name: 'Task' };
const status = (id: string) => ({ id, name: id === '3' ? 'In progress' : 'Done', statusCategory: { key: id === '3' ? 'indeterminate' : 'done' } });
const board = {
  estimation: { type: 'field', field: { fieldId: sp } },
  columnConfig: { columns: [{ statuses: [{ id: '3' }, { id: '4' }] }, { statuses: [{ id: '5' }] }, { statuses: [] }] },
};
const rawIssue = (key: string, fields: Record<string, unknown> = {}) => ({ key, fields: { summary: key, issuetype: issueType, ...fields } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const collection = (values: unknown[]) => json({ values, isLast: true });
const sprintMembership = (issues: unknown[]) => json({ issues });
const noContent = () => new Response(null, { status: 204 });
const client = (edition: 'cloud' | 'data-center' = cloud) => {
  const site = new URL('https://jira.example.test');
  return new JiraClient(site, site, edition, 'Bearer local-fixture', 'local-fixture');
};

function mockFetch(t: TestContext, handler: (url: URL, init: RequestInit) => Response) {
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => handler(url, init));
}

const startInput: JiraStartSprintInput = {
  boardId: '1', sprintId: '7', expectedIssueKeys: ['APP-1'],
  startDate: '2026-11-16T09:00:00+04:00', endDate: '2026-11-30T18:00:00+04:00',
};
const normalizedDates = { startDate: '2026-11-16T05:00:00.000Z', endDate: '2026-11-30T14:00:00.000Z' };

test('Cloud starts a future sprint through the RPC and preserves fields outside the partial update', async (t) => {
  const requests: string[] = [];
  mockFetch(t, (url, init) => {
    requests.push(`${init.method} ${url.pathname}`);
    switch (url.pathname) {
      case '/rest/api/3/myself': return json({ displayName: 'Tester', accountId: 'abc' });
      case '/rest/agile/1.0/board/1/sprint': return collection([future]);
      case '/rest/software/1.0/sprint/7/issue':
        return sprintMembership([rawIssue('APP-1')]);
      case '/rest/agile/1.0/sprint/7':
        if (init.method === 'GET') return json(future);
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(String(init.body)), { state: 'active', ...normalizedDates });
        return json({ ...future, ...normalizedDates, state: 'active' });
      default: assert.fail(url.href);
    }
  });
  const session = createApiSession(() => undefined);
  const connection = await session.invoke({ method: 'connect', input: {
    edition: 'cloud', url: 'https://jira.example.test', username: 'Tester', email: 'user@example.test', token: 'fixture',
  } });
  assert.equal(connection.ok, true);
  assert.deepEqual(await session.invoke({ method: 'startSprint', input: startInput }), {
    ok: true, data: { id: '7', name: 'Next', state: 'active', goal: future.goal, originBoardId: '1', ...normalizedDates },
  });
  assert.deepEqual(requests, [
    'GET /rest/api/3/myself', 'GET /rest/agile/1.0/board/1/sprint', 'GET /rest/software/1.0/sprint/7/issue',
    'GET /rest/agile/1.0/sprint/7', 'POST /rest/agile/1.0/sprint/7',
  ]);
});

test('Data Center confirms an ambiguous sprint start once, with explicit goal clearing and offset paging', async (t) => {
  let writes = 0;
  mockFetch(t, (url, init) => {
    switch (url.pathname) {
      case '/rest/agile/1.0/board/1/sprint': return collection([future]);
      case '/rest/agile/1.0/sprint/7/issue':
        return url.searchParams.get('startAt') === '0'
          ? json({ startAt: 0, total: 2, issues: [rawIssue('APP-2')] })
          : json({ startAt: 1, total: 2, issues: [rawIssue('APP-1')] });
      case '/rest/agile/1.0/sprint/7':
        if (init.method === 'GET') {
          return json(writes ? { ...future, state: 'active', goal: '', startDate: startInput.startDate, endDate: startInput.endDate } : future);
        }
        assert.equal(init.method, 'POST');
        writes += 1;
        assert.deepEqual(JSON.parse(String(init.body)), { state: 'active', ...normalizedDates, goal: '' });
        return json({ message: 'Gateway timeout' }, 504);
      default: assert.fail(url.href);
    }
  });
  const result = await client(dc).startSprint({ ...startInput, expectedIssueKeys: ['APP-1', 'APP-2'], goal: '' });
  assert.equal(result.state, 'active');
  assert.equal(result.goal, undefined);
  assert.equal(writes, 1);
});

test('sprint start blocks malformed dates, stale or incomplete membership, and a concurrent state change', async (t) => {
  let stage = 'validate';
  mockFetch(t, (url, init) => {
    assert.notEqual(stage, 'validate', 'Local validation must not read Jira');
    assert.equal(init.method, 'GET');
    switch (url.pathname) {
      case '/rest/agile/1.0/board/1/sprint': return collection([future]);
      case '/rest/software/1.0/sprint/7/issue':
        if (stage === 'incomplete') return json({ issues: [rawIssue('APP-1')], isLast: false });
        return sprintMembership([rawIssue(stage === 'stale' ? 'APP-9' : 'APP-1')]);
      case '/rest/agile/1.0/sprint/7': return json({ ...future, state: 'active' });
      default: assert.fail(url.href);
    }
  });
  const jira = client();
  const status = (code: number) => (error: unknown) => error instanceof JiraError && error.status === code;
  for (const startDate of ['2026-11-16T09:00', '2026-02-29T09:00:00Z', startInput.endDate]) {
    await assert.rejects(() => jira.startSprint({ ...startInput, startDate }), status(400));
  }
  for (const scenario of ['stale', 'incomplete', 'state change']) {
    stage = scenario;
    await assert.rejects(() => jira.startSprint(startInput), status(409));
  }
});

test('sprint start does not retry a write when Jira cannot confirm that the sprint is active', async (t) => {
  let writes = 0;
  let confirmations = 0;
  mockFetch(t, (url, init) => {
    switch (url.pathname) {
      case '/rest/agile/1.0/board/1/sprint': return collection([future]);
      case '/rest/software/1.0/sprint/7/issue': return sprintMembership([rawIssue('APP-1')]);
      case '/rest/agile/1.0/sprint/7':
        if (init.method === 'POST') { writes += 1; return noContent(); }
        if (writes) confirmations += 1;
        return json(future);
      default: assert.fail(url.href);
    }
  });
  await assert.rejects(() => client().startSprint(startInput), /Jira не подтвердила запуск/);
  assert.equal(writes, 1);
  assert.equal(confirmations, 1);
});

test('Cloud lists only Scrum boards, all sprint states and a token-paginated plan with independent QA points', async (t) => {
  mockFetch(t, (url, init) => {
    if (url.pathname === '/rest/api/3/search/jql') {
      assert.equal(init.method, 'POST');
      const query = JSON.parse(String(init.body)) as { jql: string };
      assert.equal(query.jql, 'key in ("APP-5", "APP-6")');
      return json({ isLast: true, issues: [rawIssue('APP-5', { status: status('5') })] });
    }
    assert.equal(init.method, 'GET');
    switch (url.pathname) {
      case '/rest/agile/1.0/board':
        assert.equal(url.searchParams.get('projectKeyOrId'), 'APP');
        assert.equal(url.searchParams.get('type'), 'scrum');
        return url.searchParams.get('startAt') === '0'
          ? json({ values: [{ id: 2, name: 'Kanban', type: 'kanban' }], isLast: false, startAt: 0 })
          : collection([{ id: 1, name: 'Delivery', type: 'scrum' }]);
      case '/rest/agile/1.0/board/1/sprint':
        assert.equal(url.searchParams.get('state'), 'active,future,closed');
        return url.searchParams.get('startAt') === '0'
          ? json({ values: [closed], isLast: false, startAt: 0 })
          : collection([active, future]);
      case '/rest/agile/1.0/board/1/configuration': return json(board);
      case '/rest/api/3/field': return json(fields);
      case '/rest/api/3/issueLinkType': return json({ issueLinkTypes: [blocks] });
      case '/rest/software/1.0/sprint/7/issue':
        assert.ok(url.searchParams.get('fields')?.includes(qa));
        assert.ok(!url.searchParams.get('fields')?.includes(alternateSp));
        return url.searchParams.has('nextPageToken') ? sprintMembership([rawIssue('APP-4')]) : json({
          issues: [rawIssue('APP-1', { [sp]: 5, [qa]: 0, issuelinks: [
            { id: '42', type: blocks, inwardIssue: rawIssue('APP-2') },
            { id: '43', type: blocks, inwardIssue: rawIssue('APP-5') },
            { id: '44', type: blocks, inwardIssue: rawIssue('APP-6') },
          ] })],
          nextPageToken: 'page-2',
        });
      case '/rest/software/1.0/board/1/backlog':
        assert.equal(url.searchParams.get('jql'), 'key = APP-2');
        return sprintMembership([rawIssue('APP-2', { [sp]: 3, [qa]: 2 })]);
      default: assert.fail(url.href);
    }
  });
  const jira = client();
  assert.deepEqual(await jira.listScrumBoards({ project: 'app' }), [{ id: '1', name: 'Delivery' }]);
  const sprints = await jira.listBoardSprints({ boardId: '1' });
  assert.deepEqual(sprints.map((sprint) => [sprint.id, sprint.state]), [['6', 'closed'], ['8', 'active'], ['7', 'future']]);
  assert.equal(sprints[0]?.completeDate, closed.completeDate);
  assert.equal(sprints[1]?.startDate, active.startDate);
  assert.equal(sprints[2]?.goal, future.goal);
  assert.equal(sprints[2]?.originBoardId, '1');
  const plan = await jira.loadSprintPlan({ boardId: '1', sprintId: '7', backlogJql: 'key = APP-2' });
  assert.deepEqual(plan.sprintIssueKeys, ['APP-1', 'APP-4']);
  assert.deepEqual(plan.backlogIssueKeys, ['APP-2']);
  assert.equal(plan.membershipComplete, true);
  assert.equal(plan.backlogComplete, true);
  assert.equal(plan.storyPointsField, sp);
  assert.equal(plan.qaPointsField, qa);
  assert.deepEqual(plan.graph.qaPointsFields?.map((field) => field.id), [qa, 'customfield_10004']);
  assert.deepEqual(plan.graph.issues.map(({ key, storyPoints, qaPoints }) => [key, storyPoints, qaPoints]), [
    ['APP-1', 5, 0], ['APP-4', undefined, undefined], ['APP-2', 3, 2], ['APP-5', undefined, undefined],
  ]);
  assert.deepEqual(plan.graph.edges.map(({ source, target }) => [source, target]), [['APP-2', 'APP-1'], ['APP-5', 'APP-1']]);
  assert.deepEqual(plan.graph.issues[0]?.unloadedBlockerKeys, ['APP-6']);
  assert.equal(plan.graph.issues[3]?.external, true);
  assert.equal(plan.graph.issues[3]?.statusCategory, 'done');
});

test('Data Center rejects stale baselines and applies only rechecked diff, with partial failure reporting', async (t) => {
  const writes: [string, string[]][] = [];
  const memberships: Record<string, unknown> = { 'APP-1': [future], 'APP-2': [], 'APP-3': [active], 'APP-4': [] };
  mockFetch(t, (url, init) => {
    if (init.method === 'POST') {
      const { issues } = JSON.parse(String(init.body)) as { issues: string[] };
      writes.push([url.pathname, issues]);
      if (url.pathname === '/rest/agile/1.0/backlog/issue') {
        memberships['APP-1'] = [];
        return noContent();
      }
      assert.equal(url.pathname, '/rest/agile/1.0/sprint/7/issue');
      memberships['APP-2'] = [future];
      return json({ errorMessages: ['One issue may not be scheduled'] }, 403);
    }
    switch (url.pathname) {
      case '/rest/agile/1.0/board/1/sprint': return collection([future, active]);
      case '/rest/agile/1.0/sprint/7': return json(future);
      case '/rest/agile/1.0/sprint/7/issue':
        assert.equal(url.searchParams.get('startAt'), '0');
        return json({ issues: [rawIssue('APP-1')], startAt: 0, total: 1 });
      case '/rest/agile/1.0/board/1/backlog':
        assert.match(url.searchParams.get('jql') ?? '', /APP-2.*APP-3.*APP-4/);
        return url.searchParams.get('startAt') === '0'
          ? json({ issues: [rawIssue('APP-2')], startAt: 0, total: 3 })
          : json({ issues: [rawIssue('APP-3'), rawIssue('APP-4')], startAt: 1, total: 3 });
      default: {
        const key = url.pathname.split('/').at(-1)!;
        assert.ok(Object.hasOwn(memberships, key));
        return json(rawIssue(key, { sprint: (memberships[key] as unknown[])[0] ?? null, closedSprints: [closed] }));
      }
    }
  });
  const jira = client(dc);
  const input = { boardId: '1', sprintId: '7', addIssueKeys: ['APP-2', 'APP-3', 'APP-4'], removeIssueKeys: [] };
  await assert.rejects(() => jira.applySprintMembership({ ...input, expectedIssueKeys: [] }),
    (error: unknown) => error instanceof JiraError && error.status === 409);
  assert.deepEqual(writes, []);

  const result = await jira.applySprintMembership({ ...input, expectedIssueKeys: ['APP-1'], removeIssueKeys: ['APP-1'] });
  assert.deepEqual(writes, [
    ['/rest/agile/1.0/sprint/7/issue', ['APP-2', 'APP-4']],
    ['/rest/agile/1.0/backlog/issue', ['APP-1']],
  ]);
  assert.deepEqual(result.added, ['APP-2']);
  assert.deepEqual(result.removed, ['APP-1']);
  assert.deepEqual(result.failed.map(({ key }) => key), ['APP-3', 'APP-4']);
  assert.match(result.failed[1]!.reason, /HTTP 403/);
});

test('Cloud velocity rolls status, estimates and assignee back to completion and keeps exactly three samples', async (t) => {
  const later = '2026-11-11T12:00:00Z';
  const before = '2026-11-07T12:00:00Z';
  const assignee = { accountId: 'new-owner', displayName: 'New Owner' };
  mockFetch(t, (url) => {
    switch (url.pathname) {
      case '/rest/agile/1.0/board/1/sprint':
        assert.equal(url.searchParams.get('state'), 'closed');
        return collection([
          { ...closed, id: 3, completeDate: '2026-10-09T13:00:00Z' },
          { ...closed, id: 4, completeDate: '2026-10-19T13:00:00Z' },
          { ...closed, id: 5, name: 'Unavailable', completeDate: '2026-11-02T13:00:00Z' }, closed,
        ]);
      case '/rest/agile/1.0/board/1/configuration': return json(board);
      case '/rest/api/3/field': return json(fields);
      case '/rest/software/1.0/board/1/sprint/4/issue': return sprintMembership([]);
      case '/rest/software/1.0/board/1/sprint/5/issue': return json({ message: 'No access' }, 403);
      case '/rest/software/1.0/board/1/sprint/6/issue': return sprintMembership([
        rawIssue('APP-1', { status: status('3'), [sp]: 9, [qa]: 6, assignee, created: before, updated: later }),
        rawIssue('APP-2', { status: status('4'), [sp]: 20, [qa]: 10, assignee, created: before, updated: before }),
        rawIssue('APP-3', { status: status('5'), [sp]: 12, [qa]: 10, assignee, created: before, updated: later }),
      ]);
      case '/rest/api/3/issue/APP-1/changelog':
        return url.searchParams.get('startAt') === '0' ? json({ startAt: 0, total: 2, isLast: false,
          values: [{ id: '1', created: before, items: [{ field: 'status', fieldId: 'status', from: '3' }] }],
        }) : json({ startAt: 1, total: 2, isLast: true, values: [{ id: '2', created: later, items: [
          { fieldId: 'status', from: '5', to: '3' }, { fieldId: sp, fromString: '4', toString: '9' },
          { fieldId: qa, fromString: '2', toString: '6' },
          { fieldId: 'assignee', from: 'old-owner', fromString: 'Old Owner' },
        ] }] });
      case '/rest/api/3/issue/APP-3/changelog': return json({ message: 'Restricted' }, 403);
      default: assert.fail(url.href);
    }
  });
  const result = await client().loadSprintVelocity({ boardId: '1', qaPointsField: qa });
  assert.deepEqual(result.samples.map(({ sprint }) => sprint.id), ['6', '5', '4']);
  const partial = result.samples[0]!;
  assert.equal(partial.complete, false);
  assert.equal(partial.evaluatedIssues, 2);
  assert.equal(partial.totalIssues, 3);
  assert.equal(partial.completedStoryPoints, 4);
  assert.equal(partial.completedQaPoints, 2);
  assert.equal(partial.qaPointsComplete, false);
  assert.equal(partial.storyPointsComplete, false);
  assert.equal(partial.peopleComplete, false);
  assert.deepEqual(partial.people, [{ id: 'old-owner', name: 'Old Owner', storyPoints: 4, completedIssues: 1 }]);
  assert.equal(result.samples[1]?.completedStoryPoints, undefined);
  assert.equal(result.samples[2]?.complete, true);
  assert.equal(result.samples[2]?.completedStoryPoints, 0);
});
