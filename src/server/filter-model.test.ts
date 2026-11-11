import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyGraphFilters, filterGraph, issueFacetOptions, noFacetValue, scopeJql } from '../renderer/filter-model.js';
import type { JiraGraph, JiraIssue } from '../shared/contracts.js';

const issue = (key: string, fields: Partial<JiraIssue> = {}): JiraIssue => ({
  key, summary: key, status: 'To Do', url: '', ...fields,
});

const graph: JiraGraph = {
  issues: [
    issue('APP-1', { project: 'APP', epicKey: 'APP-9', summary: 'Prepare cleanup', labels: ['cleanup'], storyPoints: 0 }),
    issue('APP-2', { project: 'APP', epicKey: 'APP-9', parentKey: 'APP-1', isSubtask: true, statusCategory: 'indeterminate' }),
    issue('OPS-3', { project: 'OPS', epicKey: 'OPS-9', summary: 'Verify cleanup', labels: ['cleanup'], external: true, storyPoints: 3 }),
    issue('APP-4', { project: 'APP', summary: 'Cancel old job', labels: ['cleanup'], statusCategory: 'done' }),
    issue('APP-9', { project: 'APP', isEpic: true }),
  ],
  edges: [
    { id: '1', source: 'APP-1', target: 'APP-2', label: 'Parent', kind: 'parent' },
    { id: '2', source: 'APP-2', target: 'OPS-3', label: 'blocks', kind: 'link', typeId: '10001' },
    { id: '3', source: 'OPS-3', target: 'APP-4', label: 'reviews', kind: 'link', typeId: '10002' },
    { id: '4', source: 'APP-9', target: 'APP-1', label: 'Parent', kind: 'parent' },
  ],
  linkTypes: [
    { id: '10001', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    { id: '10002', name: 'Reviews', inward: 'is reviewed by', outward: 'reviews' },
  ],
  warnings: [],
  storyPointsFields: [],
};

test('filtering removes only edges whose endpoints are excluded and retains disconnected issues', () => {
  const result = filterGraph(graph, { ...emptyGraphFilters, facets: { labels: ['cleanup'] } });
  assert.deepEqual(result.issues.map(({ key }) => key), ['APP-1', 'OPS-3', 'APP-4']);
  assert.deepEqual(result.edges.map(({ id }) => id), ['3']);
  assert.equal(graph.issues.length, 5);
  assert.equal(graph.edges.length, 4);
  assert.strictEqual(filterGraph(graph, emptyGraphFilters), graph);
});

test('facet choices are OR within a facet and AND across facets including zero Story Points', () => {
  const result = filterGraph(graph, {
    ...emptyGraphFilters,
    search: 'cleanup',
    facets: { project: ['APP', 'OPS'], estimate: ['present'], statusCategory: ['new'] },
  });
  assert.deepEqual(result.issues.map(({ key }) => key), ['APP-1', 'OPS-3']);
  assert.deepEqual(result.edges, []);
  assert.ok(issueFacetOptions(graph.issues).epic.some(({ value, count }) => value === 'APP-9' && count === 3));
  assert.deepEqual(
    filterGraph(graph, { ...emptyGraphFilters, facets: { epic: [noFacetValue] } }).issues.map(({ key }) => key),
    ['APP-4'],
  );
});

test('cross-epic and edge-type filtering does not introduce links to hidden issues', () => {
  const filters = { ...emptyGraphFilters, crossEpic: true, crossProject: true, hideIsolated: true, edgeTypes: ['10001'] };
  const result = filterGraph(graph, filters);
  assert.deepEqual(result.edges.map(({ id }) => id), ['2']);
  assert.deepEqual(result.issues.map(({ key }) => key), ['APP-2', 'OPS-3']);
  const internal = filterGraph(graph, { ...filters, hideExternal: true });
  assert.deepEqual(internal.issues, []);
  assert.deepEqual(internal.edges, []);
});

test('scope presets quote names and switch to the Data Center Epic Link field', () => {
  assert.equal(scopeJql('epic', 'APP-9'), '(key = "APP-9" OR parent = "APP-9")');
  assert.equal(scopeJql('epic', 'APP-9', 'data-center'), '(key = "APP-9" OR "Epic Link" = "APP-9")');
  assert.equal(scopeJql('label', 'x" OR labels = "other'), String.raw`labels = "x\" OR labels = \"other"`);
  assert.equal(scopeJql('saved', '10001'), 'filter = 10001');
  assert.equal(scopeJql('sprint', 'Sprint 24'), 'sprint = "Sprint 24"');
  assert.equal(scopeJql('mine', ''), 'assignee = currentUser()');
  assert.equal(scopeJql('project', 'A\nB'), '');
});
