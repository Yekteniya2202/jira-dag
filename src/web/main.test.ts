import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createApiSession } from '../server/session.js';
import type { ApiRequest, ApiResponse, JiraGraph } from '../shared/contracts.js';
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
