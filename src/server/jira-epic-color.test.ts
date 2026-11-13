import assert from 'node:assert/strict';
import test from 'node:test';
import type { JiraCredentials } from '../shared/contracts.js';
import { epicColorHex } from '../shared/jira-epic-color.js';
import { connectJira } from './jira.js';

const cloud: JiraCredentials = {
  edition: 'cloud', url: 'https://team.atlassian.net', username: 'Test user', email: 'user@example.org', token: 'test-token',
};
const dataCenter: JiraCredentials = { ...cloud, edition: 'data-center', url: 'https://jira.example.org/jira' };
const issue = (key: string, fields: Record<string, unknown> = {}) => ({ key, fields: { summary: key, ...fields } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('Jira epic color normalization distinguishes modern, legacy, and literal palettes', () => {
  assert.equal(epicColorHex('GHX-LABEL-7'), '#8677D9');
  assert.equal(epicColorHex('color_7'), '#2966B8');
  assert.equal(epicColorHex('dark_purple'), '#5244AA');
  assert.equal(epicColorHex('Dark Grey'), '#243859');
  assert.equal(epicColorHex('#a3b'), '#AA33BB');
  assert.equal(epicColorHex('#a1b2c3'), '#A1B2C3');
  assert.equal(epicColorHex('red'), undefined);
  assert.equal(epicColorHex('ghx-label-99'), undefined);
  assert.equal(epicColorHex('var(--accent)'), undefined);
});

test('Cloud discovers the Epic Color custom field and shares the parent color with subtasks', async (t) => {
  const queries: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    switch (url.pathname) {
      case '/rest/api/3/myself': return response({ displayName: 'Jira User', accountId: 'cloud-user' });
      case '/rest/api/3/field': return response([
        { id: 'customfield_10015', name: 'Other language', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-color' } },
        { id: 'customfield_10016', name: 'Color name', untranslatedName: 'Issue Color' },
      ]);
      case '/rest/api/3/issueLinkType': return response({ issueLinkTypes: [] });
      case '/rest/api/3/search/jql': {
        const { jql, fields } = JSON.parse(String(init.body)) as { jql: string; fields: string[] };
        queries.push(jql);
        assert.ok(fields.includes('customfield_10015'));
        assert.ok(fields.includes('customfield_10016'));
        return response({ isLast: true, issues: jql === 'project = APP' ? [
          issue('APP-2', { parent: issue('APP-1', { issuetype: { hierarchyLevel: 1 }, summary: 'Roadmap' }) }),
          issue('APP-3', { parent: issue('APP-2'), issuetype: { hierarchyLevel: -1 } }),
          issue('APP-4', { customfield_10015: 'ghx-label-3' }),
        ] : [issue('APP-1', { issuetype: { hierarchyLevel: 1 }, summary: 'Roadmap',
          customfield_10015: 'ghx-label-7', customfield_10016: 'dark_yellow' })] });
      }
      default: assert.fail(`Unexpected Jira URL ${url.pathname}`);
    }
  });
  const { client } = await connectJira(cloud, () => {});
  const graph = await client.loadGraph({ jql: 'project = APP', depth: 0 });
  assert.deepEqual(queries, ['project = APP', 'key in ("APP-1")']);
  assert.deepEqual(graph.issues.map(({ key, epicKey, epicColor }) => [key, epicKey, epicColor]), [
    ['APP-2', 'APP-1', '#FA9920'], ['APP-3', 'APP-1', '#FA9920'], ['APP-4', undefined, undefined],
  ]);
});

test('Data Center reads Agile epic colors once per epic and leaves inaccessible or unknown colors unset', async (t) => {
  const lookups: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    const path = url.pathname;
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${dataCenter.token}`);
    if (path === '/jira/rest/api/2/myself') return response({ displayName: 'Jira User', key: 'JIRAUSER1' });
    if (path === '/jira/rest/api/2/field') return response([]);
    if (path === '/jira/rest/api/2/issueLinkType') return response({ issueLinkTypes: [] });
    if (path === '/jira/rest/api/2/search') {
      const epic = (key: string) => issue(key, { issuetype: { name: 'Epic' } });
      return response({ total: 6, issues: [
        epic('APP-1'), issue('APP-2', { parent: epic('APP-1') }), issue('APP-3', { parent: epic('APP-1') }),
        epic('APP-4'), epic('APP-5'), epic('APP-6'),
      ] });
    }
    assert.ok(path.startsWith('/jira/rest/agile/1.0/epic/'));
    assert.equal(init.method, 'GET');
    assert.ok(init.signal instanceof AbortSignal);
    const key = path.split('/').at(-1);
    lookups.push(key!);
    if (key === 'APP-4') return response({}, 403);
    if (key === 'APP-5') return response({ key, color: { key: 'unknown' } });
    if (key === 'APP-6') return response({ key, color: { key: 'color_9' } });
    return response({ key, color: { key: 'ghx-label-11' } });
  });
  const { client } = await connectJira(dataCenter, () => {});
  const graph = await client.loadGraph({ jql: 'project = APP', depth: 0 });
  assert.deepEqual(lookups, ['APP-1', 'APP-4', 'APP-5', 'APP-6']);
  assert.deepEqual(graph.issues.map(({ epicColor }) => epicColor), ['#34C7E6', '#34C7E6', '#34C7E6', undefined, undefined, '#FF2626']);
  assert.equal(Object.hasOwn(graph.issues[3], 'epicColor'), false);
  assert.deepEqual(graph.warnings, []);
});
