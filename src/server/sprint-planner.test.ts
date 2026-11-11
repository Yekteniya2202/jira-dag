import assert from 'node:assert/strict';
import test from 'node:test';
import type { JiraEdge, JiraGraph, JiraIssue } from '../shared/contracts.js';
import { analyzeDependencies } from '../renderer/dependency-analysis.js';
import { planSprint, sprintRoster, type SprintPlanOptions } from '../renderer/sprint-planner.js';

const issue = (number: number, fields: Partial<JiraIssue> = {}): JiraIssue => ({
  key: `APP-${number}`, summary: `Task ${number}`, status: 'To do', url: '', storyPoints: 1, ...fields,
});

const blocks = (source: number, target: number): JiraEdge => ({
  id: `${source}-${target}`, source: `APP-${source}`, target: `APP-${target}`, label: 'blocks', kind: 'link', typeId: '10001',
});

function plan(issues: JiraIssue[], edges: JiraEdge[], options: SprintPlanOptions) {
  const graph: JiraGraph = {
    issues, edges, linkTypes: [{ id: '10001', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
    storyPointsFields: [], warnings: [],
  };
  return planSprint(analyzeDependencies(graph), options);
}

test('sprint includes only estimated executable issues with completed or planned prerequisites', () => {
  const issues = [
    issue(1, { statusCategory: 'done' }),
    issue(2, { storyPoints: 0 }),
    issue(3, { storyPoints: 2 }),
    issue(4, { storyPoints: undefined }),
    issue(5),
    issue(6, { isEpic: true }),
    issue(7),
    issue(8, { storyPoints: -1 }),
  ];
  const result = plan(issues, [blocks(1, 2), blocks(2, 3), blocks(4, 5), blocks(6, 7)], { capacity: 2, people: [] });
  assert.deepEqual(result.planned.map(({ issue, wave, points }) => [issue.key, wave, points]), [
    ['APP-2', 1, 0], ['APP-3', 2, 2],
  ]);
  assert.deepEqual(result.skipped.map(({ issue, reason, blockers }) => [issue.key, reason, blockers]), [
    ['APP-4', 'unestimated', undefined],
    ['APP-5', 'blocked', ['APP-4']],
    ['APP-7', 'blocked', ['APP-6']],
    ['APP-8', 'unestimated', undefined],
  ]);
  assert.equal(result.used, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.waveCount, 2);
});

test('sprint explains missing and external blockers and rejects cycle members and their dependents', () => {
  const issues = [
    issue(1, { external: true }), issue(2), issue(3), issue(4), issue(5), issue(6),
    issue(7, { unloadedBlockerKeys: ['OTHER-8'] }), issue(8), issue(9, { external: true, statusCategory: 'done' }), issue(10),
  ];
  const edges = [blocks(1, 2), blocks(2, 3), blocks(4, 5), blocks(5, 4), blocks(5, 6), blocks(9, 10)];
  const result = plan(issues, edges, { capacity: 10, people: [] });
  assert.deepEqual(result.planned.map(({ issue }) => issue.key), ['APP-8', 'APP-10']);
  assert.deepEqual(result.skipped.map(({ issue, reason, blockers }) => [issue.key, reason, blockers]), [
    ['APP-2', 'external-blocker', ['APP-1']],
    ['APP-3', 'external-blocker', ['APP-1']],
    ['APP-4', 'cycle', ['APP-5']],
    ['APP-5', 'cycle', ['APP-4']],
    ['APP-6', 'cycle', ['APP-5']],
    ['APP-7', 'external-blocker', ['OTHER-8']],
  ]);
});

test('sprint respects personal limits and preserves Jira assignments despite shared display names', () => {
  const issues = [
    issue(1, { assigneeId: 'user-1', assignee: 'Alex', storyPoints: 2 }),
    issue(2, { assigneeId: 'user-2', assignee: 'Alex', storyPoints: 1 }),
    issue(3, { assigneeId: 'user-1', assignee: 'Alex', storyPoints: 1 }),
    issue(4, { storyPoints: 1 }),
    issue(5, { storyPoints: 1 }),
    issue(6, { assignee: 'Legacy assignee', storyPoints: 1 }),
  ];
  const people = [{ id: 'user-1', name: 'Alex', capacity: 2 }, { id: 'user-2', name: 'Alex', capacity: 2 }];
  const result = plan(issues, [blocks(1, 3), blocks(2, 4), blocks(4, 5)], { capacity: 8, people });
  assert.deepEqual(sprintRoster(issues), [
    { id: 'user-1', name: 'Alex' }, { id: 'user-2', name: 'Alex' }, { id: 'name:Legacy assignee', name: 'Legacy assignee' },
  ]);
  assert.deepEqual(result.planned.map(({ issue, assigneeId, wave, suggested }) => [issue.key, assigneeId, wave, suggested]), [
    ['APP-2', 'user-2', 1, false], ['APP-1', 'user-1', 1, false], ['APP-6', 'name:Legacy assignee', 1, false],
    ['APP-4', 'user-2', 2, true],
  ]);
  assert.deepEqual(result.skipped.map(({ issue, reason }) => [issue.key, reason]), [
    ['APP-3', 'person-capacity'], ['APP-5', 'person-capacity'],
  ]);
  assert.deepEqual(result.loads.map(({ id, points, capacity, count }) => [id, points, capacity, count]), [
    ['user-1', 2, 2, 1], ['user-2', 2, 2, 2], ['name:Legacy assignee', 1, undefined, 1],
  ]);
});

test('independent tasks can share a wave when assigned to different team members', () => {
  const issues = [issue(1), issue(2), issue(3), issue(4)];
  const people = [{ id: 'dev-a', name: 'Dev A', capacity: 3 }, { id: 'dev-b', name: 'Dev B' }];
  const result = plan(issues, [blocks(1, 4), blocks(2, 4)], { capacity: 4, people });
  assert.deepEqual(result.planned.map(({ issue, wave, assigneeId }) => [issue.key, wave, assigneeId]), [
    ['APP-1', 1, 'dev-a'], ['APP-2', 1, 'dev-b'], ['APP-3', 2, 'dev-a'], ['APP-4', 2, 'dev-b'],
  ]);
  assert.ok(result.planned.every(({ suggested }) => suggested));
  assert.equal(result.waveCount, 2);
});

test('choosing urgency or dependency impact makes explicit budget tradeoffs', () => {
  const issues = [issue(1, { storyPoints: 2 }), issue(2, { storyPoints: 2 }), issue(3, { storyPoints: 5, priority: 'Высокий' })];
  const edges = [blocks(1, 2)];
  const result = plan(issues, edges, { capacity: 5, people: [] });
  assert.deepEqual(result.planned.map(({ issue }) => issue.key), ['APP-1', 'APP-2']);
  assert.equal(result.skipped[0].reason, 'team-capacity');
  for (const strategy of ['priority', 'fit'] as const) {
    const alternative = plan([...issues].reverse(), edges, { capacity: 5, people: [], strategy });
    assert.deepEqual(alternative.planned.map(({ issue }) => issue.key), ['APP-3']);
    assert.deepEqual(alternative.skipped.map(({ reason }) => reason), ['team-capacity', 'blocked']);
  }
});

test('fractional estimates fill exactly the specified budget while zero capacity permits zero SP only', () => {
  const issues = [issue(1, { storyPoints: 0.1 }), issue(2, { storyPoints: 0.2 }), issue(3, { storyPoints: 0 })];
  const people = [{ id: 'dev-a', name: 'Dev A', capacity: 0.3 }];
  const result = plan(issues, [], { capacity: 0.3, people });
  assert.equal(result.planned.length, 3);
  assert.equal(result.remaining, 0);
  const empty = plan(issues, [], { capacity: 0, people: [{ ...people[0], capacity: 0 }] });
  assert.deepEqual(empty.planned.map(({ issue }) => issue.key), ['APP-3']);
  assert.equal(empty.used, 0);
});
