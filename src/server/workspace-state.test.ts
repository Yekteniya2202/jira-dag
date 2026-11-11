import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWorkspace, readSavedFilters, readWorkspace, saveFilters, saveWorkspace, workspaceScope,
  type LocalStore, type QueryDraft, type TabSnapshot,
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
