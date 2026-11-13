import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createApiSession } from '../server/session.js';
import type { ApiRequest, ApiResponse, JiraGraph, JiraSprintPlan } from '../shared/contracts.js';
import { createWebServer } from './main.js';

const origin = 'http://127.0.0.1:5173';
const graphRequest: ApiRequest = { method: 'loadGraph', input: { jql: 'project = MIG', depth: 0 } };
const connectionRequest: ApiRequest = { method: 'getConnection', input: null };

async function listen(t: TestContext, server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function login(url: string, token: string): ApiRequest {
  return { method: 'connect', input: { url, token, edition: 'data-center', username: '', email: '' } };
}

function rpc(site: string, payload: ApiRequest, cookie?: string, caller = origin): Promise<Response> {
  return fetch(`${site}/api/rpc`, {
    method: 'POST',
    headers: { Origin: caller, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  assert.ok(value && value.includes('HttpOnly') && value.includes('SameSite=Strict'));
  const [cookie] = value.split(';');
  return cookie;
}

test('web RPC checks the request origin and exact Jira context path, then isolates browser sessions', async t => {
  let jiraRequests = 0;
  const jira = await listen(t, createServer((request, response) => {
    jiraRequests++;
    const user = request.headers.authorization === 'Bearer first-secret' ? 'First' : 'Second';
    response.setHeader('Content-Type', 'application/json');
    switch (request.url) {
      case '/jira/rest/api/2/myself':
        response.end(JSON.stringify({ displayName: user, key: `${user}-key` }));
        break;
      case '/jira/rest/api/2/field':
        response.end('[]');
        break;
      case '/jira/rest/api/2/issueLinkType':
        response.end('{"issueLinkTypes":[]}');
        break;
      case '/jira/rest/api/2/search':
        response.end(JSON.stringify({ total: 1, issues: [{ key: 'MIG-1', fields: { summary: user } }] }));
        break;
      default:
        response.writeHead(404).end('{}');
    }
  }));
  const web = await listen(t, createWebServer({ port: 8080, rendererDirectory: '.', allowedSites: `${jira}/jira/` }));
  const crossOrigin = await rpc(web, login(`${jira}/jira`, 'first-secret'), undefined, 'https://other.example');
  assert.equal(crossOrigin.status, 403);
  const wrongPath = await rpc(web, login(`${jira}/jira/another`, 'first-secret'));
  assert.equal(wrongPath.status, 403);
  assert.equal(jiraRequests, 0);

  const guest = await rpc(web, connectionRequest);
  assert.equal(guest.headers.get('set-cookie'), null);
  assert.deepEqual(await guest.json(), { ok: true, data: null });

  const first = await rpc(web, login(`${jira}/jira`, 'first-secret'));
  const second = await rpc(web, login(`${jira}/jira`, 'second-secret'));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const firstCookie = sessionCookie(first);
  const secondCookie = sessionCookie(second);
  assert.notEqual(firstCookie, secondCookie);
  assert.doesNotMatch(await first.text(), /first-secret/);
  assert.doesNotMatch(await second.text(), /second-secret/);

  const resumed = await rpc(web, connectionRequest, firstCookie);
  assert.deepEqual(await resumed.json(), { ok: true, data: {
    connection: { url: `${jira}/jira`, displayName: 'First', profileId: 'First-key' }, edition: 'data-center',
  } });

  const firstGraph = await (await rpc(web, graphRequest, firstCookie)).json() as ApiResponse<JiraGraph>;
  const secondGraph = await (await rpc(web, graphRequest, secondCookie)).json() as ApiResponse<JiraGraph>;
  assert.ok(firstGraph.ok && secondGraph.ok);
  assert.equal(firstGraph.data.issues[0]?.summary, 'First');
  assert.equal(secondGraph.data.issues[0]?.summary, 'Second');

  const logout = await rpc(web, { method: 'disconnect', input: null }, firstCookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
  const loggedOut = await rpc(web, graphRequest, firstCookie);
  assert.equal(loggedOut.status, 401);
  assert.deepEqual(await (await rpc(web, connectionRequest, firstCookie)).json(), { ok: true, data: null });
  const otherSession = await rpc(web, graphRequest, secondCookie);
  assert.equal(otherSession.status, 200);
});

test('an in-flight login cannot reconnect a disconnected session', async t => {
  let finishLogin: (() => void) | undefined;
  let loginArrived: (() => void) | undefined;
  const arrived = new Promise<void>(resolve => { loginArrived = resolve; });
  const jira = await listen(t, createServer((_request, response) => {
    finishLogin = () => response.end('{"displayName":"First"}');
    loginArrived?.();
  }));
  const session = createApiSession();
  const pending = session.invoke(login(jira, 'test-secret'));
  await arrived;
  session.disconnect();
  finishLogin?.();
  const result: ApiResponse = await pending;
  assert.ok(!result.ok);
  assert.equal(result.status, 409);
  const graph = await session.invoke(graphRequest);
  assert.ok(!graph.ok);
  assert.equal(graph.status, 401);
  assert.deepEqual(await session.invoke(connectionRequest), { ok: true, data: null });
});

test('web sprint RPC applies only an explicit reviewed diff and refreshes the Jira membership', async (t) => {
  const sprint = { id: 7, name: 'Sprint 7', state: 'future', originBoardId: 2 };
  const membership = new Set(['APP-1']);
  const issue = (key: string) => ({ key, fields: {
    summary: key, issuetype: { id: '1', name: 'Task', subtask: false },
    status: { id: '1', name: 'To do', statusCategory: { key: 'new' } },
    customfield_10100: 3, customfield_10200: 2, sprint: membership.has(key) ? sprint : null,
  } });
  const writes: Array<{ path: string; keys: string[] }> = [];
  const jira = await listen(t, createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    const path = url.pathname;
    const page = (issues: unknown[]) => ({ issues, startAt: 0, total: issues.length });
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { issues: keys } = JSON.parse(body) as { issues: string[] };
      writes.push({ path, keys });
      assert.ok(path === '/rest/agile/1.0/sprint/7/issue' || path === '/rest/agile/1.0/backlog/issue');
      for (const key of keys) {
        if (path.endsWith('/backlog/issue')) membership.delete(key);
        else membership.add(key);
      }
      response.writeHead(204).end();
      return;
    }
    const issueKey = /^\/rest\/agile\/1\.0\/issue\/(APP-[12])$/.exec(path)?.[1];
    const body = issueKey ? issue(issueKey) : ({
      '/rest/api/2/myself': { key: 'user-1', displayName: 'Planner' },
      '/rest/api/2/field': [
        { id: 'customfield_10100', name: 'Story Points', schema: { type: 'number' } },
        { id: 'customfield_10200', name: 'QA Points', schema: { type: 'number' } },
      ],
      '/rest/api/2/issueLinkType': { issueLinkTypes: [] },
      '/rest/agile/1.0/board': { values: [{ id: 2, name: 'Delivery', type: 'scrum' }], isLast: true },
      '/rest/agile/1.0/board/2/sprint': { values: [sprint], isLast: true },
      '/rest/agile/1.0/board/2/configuration': { estimation: { field: { fieldId: 'customfield_10100' } } },
      '/rest/agile/1.0/sprint/7': sprint,
      '/rest/agile/1.0/sprint/7/issue': page([...membership].map(issue)),
      '/rest/agile/1.0/board/2/backlog': page(['APP-1', 'APP-2']
        .filter((key) => !membership.has(key) && (!url.searchParams.has('jql') || url.searchParams.get('jql')?.includes(key)))
        .map(issue)),
    } as Record<string, unknown>)[path];
    if (!body) response.writeHead(404).end('{}');
    else response.end(JSON.stringify(body));
  }));
  const web = await listen(t, createWebServer({ port: 8080, rendererDirectory: '.', allowedSites: jira }));
  const loginResponse = await rpc(web, login(jira, 'fixture'));
  const cookie = sessionCookie(loginResponse);
  const scope = { boardId: '2', sprintId: '7' };
  const draft: ApiRequest = { method: 'loadSprintPlan', input: scope };
  const apply: ApiRequest = { method: 'applySprintMembership', input: {
    ...scope, expectedIssueKeys: ['APP-1'], addIssueKeys: ['APP-2'], removeIssueKeys: ['APP-1'],
  } };
  assert.equal((await rpc(web, apply)).status, 401);
  assert.equal((await rpc(web, { ...draft, input: { ...scope, boardId: '2/3' } }, cookie)).status, 400);
  const baseline = await (await rpc(web, draft, cookie)).json() as ApiResponse<JiraSprintPlan>;
  assert.equal(baseline.ok, true);
  assert.deepEqual(baseline.data.sprintIssueKeys, ['APP-1']);
  assert.deepEqual(baseline.data.backlogIssueKeys, ['APP-2']);
  assert.deepEqual(baseline.data.graph.issues.map((row: { qaPoints?: number }) => row.qaPoints), [2, 2]);
  assert.deepEqual(writes, []);
  assert.equal((await rpc(web, { ...apply, input: { ...apply.input, expectedIssueKeys: ['APP-1', 'APP-3'] } }, cookie)).status, 409);
  assert.deepEqual(writes, []);
  const result = await (await rpc(web, apply, cookie)).json();
  assert.deepEqual(result, { ok: true, data: { added: ['APP-2'], removed: ['APP-1'], failed: [] } });
  assert.deepEqual(writes, [
    { path: '/rest/agile/1.0/sprint/7/issue', keys: ['APP-2'] },
    { path: '/rest/agile/1.0/backlog/issue', keys: ['APP-1'] },
  ]);
  const fresh = await (await rpc(web, draft, cookie)).json() as ApiResponse<JiraSprintPlan>;
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.data.sprintIssueKeys, ['APP-2']);
  assert.deepEqual(fresh.data.backlogIssueKeys, ['APP-1']);
  assert.equal((await rpc(web, apply, cookie)).status, 409);
  assert.equal(writes.length, 2);
});

test('web update checks require the application origin, cache results and link only to the official release', async (t) => {
  const request = globalThis.fetch;
  const origin = 'https://dag.example.com';
  const releaseVersion = '99.0.1';
  const archive = `jira-dag-web-${releaseVersion}.tar.gz`;
  const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
  const lookup = t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'https://api.github.com/repos/Yekteniya2202/jira-dag/releases/latest');
    return Response.json({
      tag_name: `v${releaseVersion}`,
      draft: false,
      prerelease: false,
      assets: [{ name: archive, state: 'uploaded', size: 42, browser_download_url: 'https://example.com/untrusted' }],
    });
  });
  const site = await listen(t, createWebServer({ port: 0, rendererDirectory: '.', publicOrigin: origin }));
  const url = `${site}/api/update`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  assert.equal((await request(url)).status, 405);
  assert.equal((await request(url, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example.com' }, body: 'null' })).status, 403);
  assert.equal((await request(url, { method: 'POST', headers: { Origin: origin }, body: 'null' })).status, 415);
  assert.equal((await request(url, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal(lookup.mock.callCount(), 0);

  const responses = await Promise.all(Array.from({ length: 3 }, () =>
    request(url, { method: 'POST', headers, body: 'null' })));
  const releases = 'https://github.com/Yekteniya2202/jira-dag/releases';
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.deepEqual(await response.json(), { ok: true, data: {
      status: 'available',
      currentVersion: manifest.version,
      version: releaseVersion,
      mode: 'release',
      releaseUrl: `${releases}/tag/v${releaseVersion}`,
      webArchiveUrl: `${releases}/download/v${releaseVersion}/${archive}`,
    } });
  }
  assert.equal(lookup.mock.callCount(), 1);
});
