import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendJqlClauses, emptyGraphFilters, filterGraph, highlightedIssueKeys, issueFacetOptions, jiraFacetClause,
  manualJiraFacetValue, noFacetValue, projectJiraFacetValues, queryIssueFacetOptions, scopeJql, selectedSprintIds, sprintFacetLabels,
} from '../renderer/filter-model.js';
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

test('highlights match without removing cards or their edges', () => {
  const filters = { ...emptyGraphFilters, facets: { labels: ['cleanup'] } };
  assert.deepEqual(highlightedIssueKeys(graph, filters), new Set(['APP-1', 'OPS-3', 'APP-4']));
  assert.strictEqual(filterGraph(graph, filters), graph);
  assert.equal(graph.issues.length, 5);
  assert.equal(graph.edges.length, 4);
  assert.equal(highlightedIssueKeys(graph, emptyGraphFilters), undefined);
  assert.deepEqual(highlightedIssueKeys(graph, { ...filters, search: 'nothing matches' }), new Set());
});

test('facet choices are OR within a facet and AND across facets including zero Story Points', () => {
  const result = highlightedIssueKeys(graph, {
    search: 'cleanup',
    facets: { project: ['APP', 'OPS'], estimate: ['present'], statusCategory: ['new'] },
  });
  assert.deepEqual(result, new Set(['APP-1', 'OPS-3']));
  assert.ok(issueFacetOptions(graph.issues).epic.some(({ value, count }) => value === 'APP-9' && count === 3));
  assert.deepEqual(
    highlightedIssueKeys(graph, { search: '', facets: { epic: [noFacetValue] } }),
    new Set(['APP-4']),
  );
});

test('link-type selection keeps all cards and distinguishes all from none', () => {
  assert.strictEqual(filterGraph(graph, emptyGraphFilters), graph);
  const filtered = filterGraph(graph, { ...emptyGraphFilters, edgeTypes: ['parent', '10002'] });
  assert.strictEqual(filtered.issues, graph.issues);
  assert.deepEqual(filtered.edges.map(({ id }) => id), ['1', '3', '4']);
  const none = filterGraph(graph, { ...emptyGraphFilters, edgeTypes: [] });
  assert.strictEqual(none.issues, graph.issues);
  assert.deepEqual(none.edges, []);
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

test('direct query fields quote literals and handle issue hierarchy on both Jira editions', () => {
  assert.equal(jiraFacetClause('epic', ['APP-9'], 'cloud'), '(key = "APP-9" OR parentEpic = "APP-9")');
  assert.equal(jiraFacetClause('epic', ['APP-9'], 'data-center'), '(key = "APP-9" OR "Epic Link" = "APP-9")');
  assert.equal(jiraFacetClause('subtaskParent', ['APP-9', 'APP-10'], 'cloud'),
    '(key in ("APP-9", "APP-10") OR (parent in ("APP-9", "APP-10") AND issuetype in subtaskIssueTypes()))');
  assert.equal(jiraFacetClause('key', ['APP-9', 'APP-10'], 'cloud'), 'key in ("APP-9", "APP-10")');
  assert.equal(jiraFacetClause('labels', ['x" OR labels = "other'], 'cloud'), String.raw`labels = "x\" OR labels = \"other"`);
  assert.equal(scopeJql('saved', '10001'), 'filter = 10001');
  assert.equal(scopeJql('project', 'APP'), 'project = "APP"');
  assert.equal(scopeJql('project', 'A\nB'), '');
});

test('Jira filter clauses preserve raw input, normalize bare keys and keep ORDER BY after the combined predicate', () => {
  assert.equal(appendJqlClauses('  project = APP\n', []), '  project = APP\n');
  assert.equal(appendJqlClauses('app-1', ['labels = "cleanup"']), '(key = "APP-1") AND labels = "cleanup"');
  assert.equal(appendJqlClauses('project = APP OR project = OPS\norder   by priority DESC, key', ['status = "Open"']),
    '(project = APP OR project = OPS) AND status = "Open" order   by priority DESC, key');
  assert.equal(appendJqlClauses('ORDER BY created DESC', ['project = "APP"']), 'project = "APP" ORDER BY created DESC');
  assert.equal(appendJqlClauses('', ['project = "APP"']), 'project = "APP"');
});

test('ORDER BY inside JQL literals or function arguments is preserved', () => {
  const where = String.raw`summary ~ "Before \"ORDER BY\"" OR issue in linkedIssues('ORDER BY')`;
  assert.equal(appendJqlClauses(`${where} ORDER BY key`, ['priority = "High"']),
    `(${where}) AND priority = "High" ORDER BY key`);
  assert.equal(appendJqlClauses(where, ['priority = "High"']), `(${where}) AND priority = "High"`);
});

test('Jira facets produce quoted field values, missing values, and native hierarchy conditions', () => {
  assert.equal(jiraFacetClause('statusCategory', ['new', 'indeterminate'], 'cloud'), 'statusCategory in ("To Do", "In Progress")');
  assert.equal(jiraFacetClause('assignee', ['Alex', noFacetValue], 'cloud'), '(assignee = "Alex" OR assignee IS EMPTY)');
  assert.equal(jiraFacetClause('labels', ['a"b', 'c\\d'], 'cloud'), String.raw`labels in ("a\"b", "c\\d")`);
  assert.equal(jiraFacetClause('hierarchy', ['epic', 'subtask'], 'cloud'), 'hierarchyLevel in (1, -1)');
  assert.equal(jiraFacetClause('hierarchy', ['subtask'], 'data-center'), 'issuetype in subtaskIssueTypes()');
  assert.equal(jiraFacetClause('epic', ['APP-9'], 'data-center'), '(key = "APP-9" OR "Epic Link" = "APP-9")');
  assert.equal(jiraFacetClause('parent', [noFacetValue], 'cloud'), '');
  assert.equal(jiraFacetClause('dueDate', ['present'], 'cloud'), 'due IS NOT EMPTY');
  assert.equal(jiraFacetClause('estimate', ['missing'], 'cloud', 'customfield_10016'), 'cf[10016] IS EMPTY');
  assert.equal(jiraFacetClause('estimate', ['missing'], 'cloud'), '');
});

test('sprint IDs separate duplicate names and counters exclude expanded and pinned issues', () => {
  const sprint = (id: string) => ({ id, name: 'Sprint 30' });
  const issues = [
    issue('APP-1', { sprintDetails: [sprint('30')], sprints: ['Sprint 30'] }),
    issue('APP-2', { sprintDetails: [sprint('31')] }),
    issue('APP-3', { sprintDetails: [sprint('30')], external: true }),
    issue('APP-4', { sprintDetails: [sprint('30')] }),
  ];
  assert.deepEqual(queryIssueFacetOptions(issues, new Set(['APP-1', 'APP-2'])).sprints, [
    { value: 'id:30', count: 1 }, { value: 'id:31', count: 1 },
  ]);
  assert.deepEqual(sprintFacetLabels(issues), new Map([['id:30', 'Sprint 30 · #30'], ['id:31', 'Sprint 30 · #31']]));
  assert.deepEqual(selectedSprintIds(['id:42', 'sprint 30'], issues), ['42', '30', '31']);
  assert.equal(jiraFacetClause('sprints', ['id:30', 'id:31', 'Sprint 29'], 'cloud'), 'sprint in (30, 31, "Sprint 29")');
});

test('project metadata produces query filters before a graph loads', () => {
  const options = projectJiraFacetValues({
    statuses: [{ id: '101', name: 'Review' }, { id: '102', name: 'Review' }],
    issueTypes: [{ id: '10008', name: 'Story' }],
    versions: [{ id: '24', name: '24' }],
    sprints: [{ id: '30', name: 'Sprint 30' }],
  });
  assert.deepEqual(options.status, [
    { value: 'id:101', name: 'Review', label: 'Review · #101' },
    { value: 'id:102', name: 'Review', label: 'Review · #102' },
  ]);
  assert.equal(appendJqlClauses('', [scopeJql('project', 'APP'),
    jiraFacetClause('status', [options.status![0].value], 'cloud'),
    jiraFacetClause('issueType', [options.issueType![0].value], 'cloud'),
    jiraFacetClause('fixVersions', [options.fixVersions![0].value], 'cloud'),
    jiraFacetClause('sprints', [options.sprints![0].value], 'cloud'),
  ]), 'project = "APP" AND status = 101 AND issuetype = 10008 AND fixVersion = 24 AND sprint = 30');
});

test('manual filter entry handles names and IDs without metadata', () => {
  assert.equal(manualJiraFacetValue('epic', ' app-42 '), 'APP-42');
  assert.equal(manualJiraFacetValue('key', 'APP-x'), '');
  assert.equal(manualJiraFacetValue('subtaskParent', ' app-17 '), 'APP-17');
  assert.equal(manualJiraFacetValue('sprints', ' 44 '), 'id:44');
  assert.equal(manualJiraFacetValue('sprints', ' Sprint 44 '), 'Sprint 44');
  assert.equal(jiraFacetClause('sprints', [manualJiraFacetValue('sprints', '44')], 'cloud'), 'sprint = 44');
  assert.equal(jiraFacetClause('sprints', [manualJiraFacetValue('sprints', 'Sprint 44')], 'cloud'), 'sprint = "Sprint 44"');
  assert.equal(manualJiraFacetValue('labels', ' 44 '), '44');
  assert.equal(manualJiraFacetValue('labels', 'broken\nvalue'), '');
});
