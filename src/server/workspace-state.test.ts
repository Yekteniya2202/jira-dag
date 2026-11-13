import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySprintDraftEntry, readSprintDraftState, saveSprintDraftState } from '../renderer/sprint-draft-state.js';
import {
  clearWorkspace, moveWorkspaceTab, readSavedFilters, readWorkspace, saveFilters, saveWorkspace, setWorkspaceTabPinned, workspaceScope,
  type LocalStore, type QueryDraft, type TabSnapshot, type WorkspaceTab,
} from '../renderer/workspace-state.js';

function memoryStore() {
  const values = new Map<string, string>();
  const store: LocalStore = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { store, values };
}

const connection = { url: 'https://example.atlassian.net', displayName: 'Jira user', profileId: 'profile-1' };
const draft: QueryDraft = {
  baseJql: 'status = "In Progress" ORDER BY key ASC', projectKey: 'APP', facets: { labels: ['cleanup'] },
  depth: 2, storyField: 'customfield_10001',
};

test('workspace restores applied and draft queries, graph view and refresh per tab', () => {
  const { store } = memoryStore();
  const scope = workspaceScope(connection, 'cloud');
  const state: TabSnapshot = {
    draft, applied: { jql: 'project = "APP" AND sprint = 30', depth: 0, storyField: '', sprintIds: ['30'] },
    includedKeys: ['APP-27'], filters: { search: 'cleanup', facets: {}, edgeTypes: [], hideExternal: true, hideIsolated: false,
      crossProject: false, crossEpic: false },
    groupMode: 'none', fields: { points: true, assignee: true, priority: true, labels: false, dueDate: false, estimate: false },
    showEdgePoints: true, focusMode: 'upstream', direction: 'TB', selectedKey: 'APP-27', selectedEdge: undefined,
    leftWidth: 300, rightWidth: 280, leftHidden: true, rightHidden: false, viewport: { x: -200, y: 35, zoom: 1.5 },
    manualPositions: { 'APP-27': { x: 15, y: 20 } }, autoRefresh: true, refreshMinutes: 1,
    analysis: { capacity: '25', people: [{ id: 'member-a', name: 'Developer', capacity: '10' }], strategy: 'fit' },
    analysisHighlight: ['APP-27'],
  };
  assert.ok(saveWorkspace(store, scope, { activeTab: 8, tabs: [{ id: 1, state }, { id: 8 }] }));
  const restored = readWorkspace(store, workspaceScope({ ...connection, displayName: 'Renamed' }, 'cloud'));
  assert.equal(restored.activeTab, 8);
  assert.deepEqual(restored.tabs.map(({ id }) => id), [1, 8]);
  assert.deepEqual(restored.tabs[0].state, state);
  assert.equal(restored.tabs[1].state, undefined);
});

test('clearing one profile preserves saved filters and the workspace of another profile', () => {
  const { store } = memoryStore();
  const first = workspaceScope(connection, 'cloud');
  const second = workspaceScope({ ...connection, profileId: 'profile-2' }, 'cloud');
  const filter = { id: 'cleanup', name: 'Cleanup', draft };
  assert.ok(saveWorkspace(store, first, { activeTab: 2, tabs: [{ id: 2 }] }));
  assert.ok(saveWorkspace(store, second, { activeTab: 3, tabs: [{ id: 3 }] }));
  assert.ok(saveFilters(store, first, [filter]));
  assert.ok(clearWorkspace(store, first));
  assert.deepEqual(readWorkspace(store, first), { activeTab: 1, tabs: [{ id: 1 }] });
  assert.equal(readWorkspace(store, second).activeTab, 3);
  assert.deepEqual(readSavedFilters(store, first), [filter]);
  assert.deepEqual(readSavedFilters(store, second), []);
});

test('invalid local storage falls back to an empty workspace', () => {
  const { store, values } = memoryStore();
  assert.ok(saveWorkspace(store, 'demo', { activeTab: 2, tabs: [{ id: 2 }] }));
  for (const key of values.keys()) store.setItem(key, '{');
  assert.deepEqual(readWorkspace(store, 'demo'), { activeTab: 1, tabs: [{ id: 1 }] });
});

test('a sprint draft and team survive restart only in their Jira profile', () => {
  const { store } = memoryStore();
  const scope = workspaceScope(connection, 'cloud');
  assert.ok(saveSprintDraftState(store, scope, {
    projectKey: 'APP', boardId: '8', sprintId: '12',
    teams: { '8': [{ id: 'dev', name: 'Developer', roles: ['BE', 'SA'], capacity: 0 }] },
    drafts: { '8:12': {
      ...emptySprintDraftEntry, added: ['APP-7'], removed: ['APP-9'], epicPriorities: ['APP-6'],
      goal: 'Release the migration', availability: { dev: 50 }, qaCapacity: 0,
      overrides: { 'APP-7': { role: 'BE', qaRequired: false, qaEstimate: 0, qaAssigneeId: 'tester' } },
    } },
  }));
  const restored = readSprintDraftState(store, scope);
  assert.deepEqual(restored.teams['8'][0].roles, ['BE', 'SA']);
  assert.equal(restored.teams['8'][0].capacity, 0);
  assert.deepEqual(restored.drafts['8:12'].added, ['APP-7']);
  assert.equal(restored.drafts['8:12'].overrides['APP-7'].qaRequired, false);
  assert.equal(restored.drafts['8:12'].qaCapacity, 0);
  assert.equal(restored.drafts['8:12'].availability.dev, 50);
  assert.deepEqual(readSprintDraftState(store, 'demo').drafts, {});
});

test('pinning and moving tabs keeps the pinned group first and preserves snapshots', () => {
  const tab: WorkspaceTab = { id: 4, epicKey: 'APP-12', epicTitle: 'Release', state: { draft } };
  const initial: WorkspaceTab[] = [{ id: 1, pinned: true }, { id: 2 }, { id: 3 }, tab];
  const pinned = setWorkspaceTabPinned(initial, 4, true);
  assert.deepEqual(pinned.map(({ id }) => id), [1, 4, 2, 3]);
  assert.equal(pinned[1].state, tab.state);
  assert.equal(pinned[1].epicKey, 'APP-12');
  assert.equal(moveWorkspaceTab(pinned, 3, 1, 'before'), pinned);
  assert.deepEqual(moveWorkspaceTab(pinned, 1, 4, 'after').map(({ id }) => id), [4, 1, 2, 3]);
  const unpinned = setWorkspaceTabPinned(pinned, 1, false);
  assert.deepEqual(unpinned.map(({ id }) => id), [4, 1, 2, 3]);
  assert.deepEqual(moveWorkspaceTab(unpinned, 3, 1, 'before').map(({ id }) => id), [4, 3, 1, 2]);
});

test('restoring tabs preserves order within pinned and unpinned groups and restores epic scope', () => {
  const { store } = memoryStore();
  const scope = workspaceScope(connection, 'cloud');
  const jql = 'key = "APP-12" OR parent = "APP-12"';
  const tabs: WorkspaceTab[] = [
    { id: 3 },
    { id: 1, pinned: true },
    { id: 4, pinned: true, epicKey: 'APP-12', epicTitle: 'Release', state: {
      draft: { ...draft, baseJql: jql },
      applied: { jql, depth: 0, storyField: '', sprintIds: [], epicKey: 'APP-12' },
    } },
    { id: 2 },
  ];
  assert.ok(saveWorkspace(store, scope, { activeTab: 4, tabs }));
  const restored = readWorkspace(store, scope);
  assert.deepEqual(restored.tabs.map(({ id, pinned }) => [id, Boolean(pinned)]), [[1, true], [4, true], [3, false], [2, false]]);
  assert.equal(restored.activeTab, 4);
  assert.equal(restored.tabs[1].epicKey, 'APP-12');
  assert.equal(restored.tabs[1].epicTitle, 'Release');
  assert.equal(restored.tabs[1].state?.applied?.epicKey, 'APP-12');
});
