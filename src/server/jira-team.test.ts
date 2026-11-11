import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { JiraCredentials } from '../shared/contracts.js';
import { connectJira, MAX_AVATAR_BATCH } from './jira.js';
import { createApiSession } from './session.js';

const credentials: JiraCredentials = {
  edition: 'cloud', url: 'https://team.atlassian.net', username: '', email: 'developer@example.net', token: 'fake-token',
};
const dc = { ...credentials, edition: 'data-center' as const, url: 'https://jira.example.net/jira' };
const cloudAvatarHost = 'avatar-management--avatars.eu-central-1.prod.public.atl-paas.net';
const cloudAvatar = `https://${cloudAvatarHost}/initials/AA-1.png`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lGxsAAAAASUVORK5CYII=', 'base64');
const image = `data:image/png;base64,${png.toString('base64')}`;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const user = (id: string, displayName: string, source?: string) => ({
  accountId: id, displayName, active: true, ...(source ? { avatarUrls: { '32x32': source } } : {}),
});

function mockFetch(t: TestContext, handler: (url: URL, input: RequestInit) => Response) {
  t.mock.method(globalThis, 'fetch', async (url: URL, input: RequestInit) => {
    assert.equal(input.redirect, 'error');
    return handler(url, input);
  });
}

test('Cloud project team scans sparse directory pages and includes a confirmed current user', async (t) => {
  const offsets: number[] = [];
  let avatars = 0;
  let exactLookups = 0;
  mockFetch(t, (url, input) => {
    if (url.hostname === cloudAvatarHost) {
      assert.equal(new Headers(input.headers).has('Authorization'), false);
      avatars++;
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    }
    assert.equal(url.origin, 'https://team.atlassian.net');
    if (url.pathname.endsWith('/myself')) return json(user('own:account', 'Own name', cloudAvatar));
    assert.equal(url.pathname, '/rest/api/3/user/assignable/multiProjectSearch');
    assert.equal(url.searchParams.get('projectKeys'), 'APP');
    if (url.searchParams.has('accountId')) {
      assert.equal(url.searchParams.get('accountId'), 'own:account');
      exactLookups++;
      return json([user('own:account', 'Own name', cloudAvatar), user('someone-else', 'Someone else')]);
    }
    const start = Number(url.searchParams.get('startAt'));
    offsets.push(start);
    if (start === 0) return json([
      user('org:alpha', 'A Person', cloudAvatar),
      { ...user('inactive', 'Inactive'), active: false },
      { ...user('app-user', 'Automation app'), accountType: 'app' },
    ]);
    if (start === 200) return json([user('org:beta', 'B Person', 'https://wrong.example.net/avatar.png')]);
    return json([]);
  });
  const { client, connection } = await connectJira(credentials, () => {});
  assert.equal(connection.profileId, 'own:account');
  const result = await client.listProjectTeam('app');
  assert.deepEqual(result, { members: [
    { id: 'org:alpha', name: 'A Person' }, { id: 'org:beta', name: 'B Person' }, { id: 'own:account', name: 'Own name' },
  ], limited: true });
  assert.deepEqual(offsets.sort((left, right) => left - right), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  assert.equal(exactLookups, 1);
  assert.deepEqual(await client.getAvatars({ project: 'OTHER', memberIds: ['org:alpha'] }), { issues: {}, members: {} });
  assert.deepEqual(await client.getAvatars({ project: 'APP', memberIds: ['org:alpha', 'org:beta', 'own:account'], includeCurrentUser: true }), {
    issues: {}, members: { 'org:alpha': image, 'own:account': image }, currentUser: image,
  });
  assert.equal(avatars, 1);
});

test('Data Center project discovery and same-context avatars use the authenticated API session', async (t) => {
  const own = { key: 'JIRAUSER10100', name: 'jira-user', displayName: 'DC user', avatarUrls: {
    '48x48': '/jira/secure/useravatar?ownerId=jira-user',
  } };
  let avatarReads = 0;
  mockFetch(t, (url, input) => {
    assert.equal(url.origin, 'https://jira.example.net');
    assert.equal(new Headers(input.headers).get('Authorization'), 'Bearer fake-token');
    if (url.pathname === '/jira/rest/api/2/myself') return json(own);
    if (url.pathname === '/jira/rest/api/2/user/assignable/search') {
      if (url.searchParams.get('project') === 'HIDDEN') return json({ errorMessages: ['Forbidden'] }, 403);
      assert.equal(url.searchParams.get('project'), 'APP');
      assert.equal(url.searchParams.get('maxResults'), '100');
      assert.equal(url.searchParams.get('username'), 'DC');
      return json([own, { key: 'DELETED', name: 'former', displayName: 'Former member', deleted: true }]);
    }
    assert.equal(url.pathname, '/jira/secure/useravatar');
    avatarReads++;
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  const session = createApiSession(() => {});
  assert.equal((await session.invoke({ method: 'connect', input: dc })).ok, true);
  assert.deepEqual(await session.invoke({ method: 'listProjectTeam', input: { project: 'APP', query: 'DC' } }), {
    ok: true, data: { members: [{ id: own.key, name: own.displayName }] },
  });
  assert.deepEqual(await session.invoke({ method: 'getAvatars', input: { project: 'APP', memberIds: [own.key] } }), {
    ok: true, data: { issues: {}, members: { [own.key]: image } },
  });
  assert.equal(avatarReads, 1);
  const hidden = await session.invoke({ method: 'listProjectTeam', input: { project: 'HIDDEN' } });
  assert.equal(!hidden.ok && hidden.status, 403);
  assert.deepEqual(await session.invoke({ method: 'getAvatars', input: { project: 'HIDDEN', memberIds: [own.key] } }), {
    ok: true, data: { issues: {}, members: {} },
  });
});

test('graph avatars reuse loaded Jira assignees without reading each issue again', async (t) => {
  let avatarReads = 0;
  let noAvatars = false;
  const issue = (key: string, source: string) => ({ key, fields: {
    summary: key, assignee: user('org:alpha', 'A Person', source),
  } });
  mockFetch(t, (url) => {
    if (url.hostname === cloudAvatarHost) {
      avatarReads++;
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    }
    if (url.pathname.endsWith('/myself')) return json(user('own-account', 'Own name'));
    if (url.pathname.endsWith('/field')) return json([]);
    if (url.pathname.endsWith('/issueLinkType')) return json({ issueLinkTypes: [] });
    assert.equal(url.pathname, '/rest/api/3/search/jql');
    return json({ isLast: true, issues: noAvatars ? [{ key: 'APP-1', fields: { summary: 'No assignee' } }]
      : [issue('APP-1', cloudAvatar), issue('APP-2', cloudAvatar), issue('APP-3', 'https://127.0.0.1/avatar.png')] });
  });
  const { client } = await connectJira(credentials, () => {});
  await client.loadGraph({ jql: 'project = APP', depth: 0 });
  assert.deepEqual(await client.getAvatars({ issueKeys: ['APP-1', 'APP-2', 'APP-3', 'HIDDEN-4', 'APP-1'] }), {
    issues: { 'APP-1': image, 'APP-2': image }, members: {},
  });
  assert.equal(avatarReads, 1);
  noAvatars = true;
  await client.loadGraph({ jql: 'project = APP', depth: 0 });
  assert.deepEqual(await client.getAvatars({ issueKeys: ['APP-1'] }), { issues: {}, members: {} });
});

test('avatar RPC validates the batch and project before accessing Jira', async () => {
  const session = createApiSession(() => {});
  for (const input of [
    { issueKeys: Array.from({ length: MAX_AVATAR_BATCH + 1 }, () => 'APP-1') },
    { memberIds: ['org:alpha'] }, { memberIds: ['org:alpha'], project: 'APP,OTHER' }, { includeCurrentUser: 'yes' },
  ]) {
    const response = await session.invoke({ method: 'getAvatars', input });
    assert.equal(!response.ok && response.status, 400);
  }
  const anonymous = await session.invoke({ method: 'getAvatars', input: { includeCurrentUser: true } });
  assert.equal(!anonymous.ok && anonymous.status, 401);
});
