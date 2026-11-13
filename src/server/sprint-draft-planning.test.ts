import assert from 'node:assert/strict';
import test from 'node:test';
import type { JiraEdge, JiraGraph, JiraIssue, JiraSprintVelocitySample } from '../shared/contracts.js';
import { inferSprintRole, planSprintDraft, sprintDraftVelocity, type SprintDraftOptions } from '../renderer/sprint-draft-planning.js';

const issue = (number: number, fields: Partial<JiraIssue> = {}): JiraIssue => ({
  key: `APP-${number}`, summary: `[BE] Task ${number}`, status: 'To do', url: '', storyPoints: 1, ...fields,
});
const block = (source: number, target: number): JiraEdge => ({
  id: `${source}-${target}`, source: `APP-${source}`, target: `APP-${target}`, label: 'blocks', kind: 'link', typeId: '10001',
});
const graph = (issues: JiraIssue[], edges: JiraEdge[] = [], warnings: string[] = []): JiraGraph => ({
  issues, edges, warnings, storyPointsFields: [],
  linkTypes: [{ id: '10001', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }],
});
const defaults = {
  selectedKeys: [], roster: [
    { id: 'be', name: 'Backend', roles: ['BE'], capacity: 8 },
    { id: 'fe', name: 'Frontend', roles: ['FE'], capacity: 8 },
    { id: 'sa', name: 'Analyst', roles: ['SA'], capacity: 8 },
    { id: 'qa', name: 'Tester', roles: ['QA'], qaCapacity: 3 },
  ],
} satisfies SprintDraftOptions;

function sample(id: string, completedStoryPoints: number, data: Partial<JiraSprintVelocitySample> = {}): JiraSprintVelocitySample {
  return {
    sprint: { id, name: `Sprint ${id}`, state: 'closed' }, completedStoryPoints, completedIssues: 3,
    evaluatedIssues: 4, totalIssues: 4, complete: true, ...data,
  };
}

test('capacity uses arithmetic velocity and applies the reserve and availability once per unit', () => {
  const history = [
    sample('30', 12, { completedQaPoints: 2, people: [{ id: 'be', name: 'Backend', storyPoints: 5, completedIssues: 2 }] }),
    sample('29', 6, { completedQaPoints: 0, people: [{ id: 'be', name: 'Backend', storyPoints: 1, completedIssues: 1 }] }),
    sample('28', 30, { people: [{ id: 'qa', name: 'QA', storyPoints: 0, qaPoints: 4, completedIssues: 3 }] }),
    sample('27', 100),
  ];
  const result = planSprintDraft(graph([]), {
    selectedKeys: [], history, reservePercent: 25, roster: [
      { id: 'be', name: 'Backend', roles: ['BE'], availabilityPercent: 50 },
      { id: 'qa', name: 'QA', roles: ['QA'], qaCapacity: 0 },
    ],
  });
  assert.equal(result.velocity.sampleCount, 3);
  assert.equal(result.velocity.averagePoints, 16);
  assert.equal(result.velocity.averageQaPoints, 1);
  assert.equal(result.velocity.people.get('be')?.averagePoints, 3);
  assert.equal(result.capacity, 1.5);
  assert.equal(result.qaCapacity, 0);
  assert.equal(result.loads[0].capacity, 1.5);
  assert.equal(result.loads[1].qaCapacity, 0);
  assert.deepEqual(result.risks, []);

  const incomplete = [history[0], { ...history[1], complete: false }, history[2], history[3]];
  assert.equal(sprintDraftVelocity(incomplete).averagePoints, 21);
  assert.equal(sprintDraftVelocity(incomplete).sampleCount, 2);
});

test('missing QA or personal attribution does not invalidate available team SP history', () => {
  const history = [
    sample('30', 3, { completedQaPoints: 10, qaPointsComplete: false, peopleComplete: false,
      people: [{ id: 'be', name: 'Backend', storyPoints: 3, completedIssues: 1 }] }),
    sample('29', 9, { completedQaPoints: 2, people: [{ id: 'be', name: 'Backend', storyPoints: 6, completedIssues: 1 }] }),
    sample('28', 0, { storyPointsComplete: false, completedQaPoints: 4 }),
  ];
  const result = sprintDraftVelocity(history);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.averagePoints, 6);
  assert.equal(result.averageQaPoints, 3);
  assert.equal(result.people.get('be')?.averagePoints, 6);
});

test('selected issues stay fixed and expose unresolved blockers, missing estimates and over-capacity', () => {
  const data = graph([
    issue(1, { storyPoints: 6, assigneeId: 'be' }),
    issue(2, { unloadedBlockerKeys: ['EXT-1'] }),
    issue(3, { storyPoints: undefined }),
    issue(4, { statusCategory: 'done', storyPoints: 15 }),
    issue(5), issue(6),
  ], [block(5, 6), block(6, 5)], ['Backlog incomplete']);
  const result = planSprintDraft(data, {
    ...defaults, selectedKeys: ['APP-1', 'APP-2', 'APP-3', 'APP-4', 'APP-5', 'APP-99'], capacity: 5, history: [],
  });

  assert.equal(result.items.length, 5);
  assert.ok(result.items.every(({ source }) => source === 'selected'));
  assert.deepEqual(result.items.find(({ issue }) => issue.key === 'APP-2')?.blockers, ['EXT-1']);
  assert.deepEqual(result.items.find(({ issue }) => issue.key === 'APP-4')?.stages, []);
  assert.equal(result.items.find(({ issue }) => issue.key === 'APP-1')?.stages[0].assigneeId, 'be');
  assert.equal(result.items.find(({ issue }) => issue.key === 'APP-1')?.stages[0].wave, undefined);
  assert.equal(result.used, 8);
  assert.equal(result.remaining, 0);
  assert.ok(result.risks.some(({ kind, issueKey }) => kind === 'unestimated' && issueKey === 'APP-3'));
  assert.ok(result.risks.some(({ kind, issueKey }) => kind === 'cycle' && issueKey === 'APP-5'));
  assert.ok(result.risks.some(({ kind, issueKey }) => kind === 'missing-selected' && issueKey === 'APP-99'));
  assert.ok(result.risks.some(({ kind }) => kind === 'over-capacity'));
  assert.ok(result.risks.some(({ kind }) => kind === 'history-incomplete'));
  assert.ok(result.risks.some(({ kind }) => kind === 'graph-incomplete'));
});

test('high-priority epic gets a dependency-complete package and roles execute in parallel', () => {
  const result = planSprintDraft(graph([
    issue(1, { summary: '[SA] Design the schema', storyPoints: 2 }),
    issue(2, { storyPoints: 3, qaPoints: 2, epicKey: 'APP-100' }),
    issue(3, { storyPoints: 3, summary: '[FE] Adapt UI', epicKey: 'APP-100' }),
    issue(4, { priority: 'Highest', storyPoints: 8, epicKey: 'APP-101' }),
    issue(5, { summary: '[QA] Test another service', qaPoints: 1, storyPoints: 20 }),
  ], [block(1, 2), block(1, 3)]), {
    ...defaults, capacity: 8, qaCapacity: 3, epicPriorities: ['APP-100', 'APP-101'],
  });
  const stages = (key: string) => result.items.find(({ issue }) => issue.key === key)?.stages.map(({ role, points, assigneeId, wave }) =>
    [role, points, assigneeId, wave]);
  assert.deepEqual(stages('APP-1'), [['SA', 2, 'sa', 1]]);
  assert.deepEqual(stages('APP-2'), [['BE', 3, 'be', 2], ['QA', 2, 'qa', 3]]);
  assert.deepEqual(stages('APP-3'), [['FE', 3, 'fe', 2]]);
  assert.deepEqual(stages('APP-5'), [['QA', 1, 'qa', 1]]);
  assert.equal(result.used, 8);
  assert.equal(result.qaUsed, 3);
  assert.equal(result.roleLoads.find(({ role }) => role === 'QA')?.qaUsed, 3);
  assert.equal(result.skipped.find(({ issue }) => issue.key === 'APP-4')?.reason, 'team-capacity');
});

test('unavailable QA, cyclic, external and unestimated dependencies reject automatic packages', () => {
  const result = planSprintDraft(graph([
    issue(1, { storyPoints: 4, qaPoints: 2, priority: 'Highest', epicKey: 'APP-100' }),
    issue(2, { storyPoints: 4 }), issue(3, { storyPoints: undefined }), issue(4),
    issue(5, { unloadedBlockerKeys: ['EXT-1'] }), issue(6),
    issue(7), issue(8), issue(9, { labels: ['qa-required'] }),
  ], [block(2, 1), block(3, 4), block(5, 6), block(7, 8), block(8, 7)]), {
    ...defaults, capacity: 4, qaCapacity: 0, epicPriorities: ['APP-100'],
  });
  assert.deepEqual(result.items.map(({ issue }) => issue.key), ['APP-2']);
  const skipped = new Map(result.skipped.map(({ issue, ...reason }) => [issue.key, reason]));
  assert.equal(skipped.get('APP-1')?.reason, 'qa-capacity');
  assert.equal(skipped.get('APP-3')?.reason, 'unestimated');
  assert.deepEqual(skipped.get('APP-4'), { reason: 'blocked', blockers: ['APP-3'] });
  assert.deepEqual(skipped.get('APP-6'), { reason: 'external-blocker', blockers: ['EXT-1'] });
  assert.equal(skipped.get('APP-7')?.reason, 'cycle');
  assert.equal(skipped.get('APP-9')?.reason, 'qa-unestimated');
});

test('dependency package failure rolls back assignments and explicit backlog scope protects removed issues', () => {
  const result = planSprintDraft(graph([
    issue(1, { storyPoints: 2, qaPoints: 2, epicKey: 'APP-100' }),
    issue(2, { storyPoints: 1 }),
    issue(3, { storyPoints: 2, priority: 'Highest' }),
    issue(4), issue(5),
  ], [block(2, 1), block(5, 4)]), {
    ...defaults, capacity: 2, qaCapacity: 1, epicPriorities: ['APP-100'],
    backlogKeys: ['APP-1', 'APP-2', 'APP-3', 'APP-4'],
  });
  assert.deepEqual(result.items.map(({ issue }) => issue.key), ['APP-3']);
  assert.equal(result.used, 2);
  assert.equal(result.qaUsed, 0);
  assert.equal(result.skipped.find(({ issue }) => issue.key === 'APP-4')?.reason, 'blocked');
  assert.equal(result.skipped.some(({ issue }) => issue.key === 'APP-5'), false);
});

test('explicit role and assignee override labels, preserves duplicate names, and charges QA only once', () => {
  const mislabeled = issue(1, { labels: ['role:BE', 'role-FE'], qaPoints: 1, assigneeId: 'dev-2', assignee: 'Alex' });
  assert.equal(inferSprintRole(mislabeled), undefined);
  assert.equal(inferSprintRole(issue(2, { labels: ['role:system analyst'] })), 'SA');
  const result = planSprintDraft(graph([
    mislabeled, issue(2, { storyPoints: 5, qaPoints: 2 }),
    issue(3, { assigneeId: 'someone-else', assignee: 'Unconfigured' }),
  ]), {
    selectedKeys: [], capacity: 5, qaCapacity: 3,
    roster: [
      { id: 'dev-1', name: 'Alex', roles: ['BE'], capacity: 5 },
      { id: 'dev-2', name: 'Alex', roles: ['FE'], capacity: 0 },
      { id: 'qa', name: 'Tester', roles: ['QA'], qaCapacity: 3 },
    ],
    overrides: {
      'APP-1': { role: 'BE', estimate: 5, assigneeId: 'dev-1', qaAssigneeId: 'qa' },
      'APP-2': { role: 'QA', qaAssigneeId: 'qa' },
    },
  });
  assert.deepEqual(result.items.map(({ issue, stages }) => [issue.key, stages.map(({ assigneeId }) => assigneeId)]), [
    ['APP-1', ['dev-1', 'qa']], ['APP-2', ['qa']],
  ]);
  assert.equal(result.used, 5);
  assert.equal(result.qaUsed, 3);
  assert.equal(result.skipped[0].reason, 'unknown-assignee');
});

test('selected subtasks covered by parent keep dependency order and avoid duplicate capacity', () => {
  const data = graph([
    issue(1, { storyPoints: 5 }), issue(2, { isSubtask: true, parentKey: 'APP-1', storyPoints: 2 }),
    issue(3, { storyPoints: 1 }), issue(4, { isSubtask: true, parentKey: 'APP-1', storyPoints: 0 }),
  ], [block(2, 1), block(1, 3)]);
  const result = planSprintDraft(data, { ...defaults, selectedKeys: ['APP-1', 'APP-2'], capacity: 6 });
  assert.equal(result.items.find(({ issue }) => issue.key === 'APP-2')?.coveredBy, 'APP-1');
  assert.deepEqual(result.items.find(({ issue }) => issue.key === 'APP-2')?.stages, []);
  assert.equal(result.items.find(({ issue }) => issue.key === 'APP-1')?.stages[0].wave, 1);
  assert.equal(result.items.find(({ issue }) => issue.key === 'APP-3')?.stages[0].wave, 2);
  assert.equal(result.items.some(({ issue }) => issue.key === 'APP-4'), false);
  assert.equal(result.used, 6);
  const separate = planSprintDraft(data, {
    ...defaults, selectedKeys: ['APP-1', 'APP-2'], capacity: 7, overrides: { 'APP-2': { estimate: 2 } },
  });
  assert.equal(separate.items.find(({ issue }) => issue.key === 'APP-2')?.coveredBy, undefined);
  assert.equal(separate.items.find(({ issue }) => issue.key === 'APP-2')?.stages[0].points, 2);
  assert.equal(separate.used, 7);
});

test('work and QA share time lanes for the same team member but never capacity units', () => {
  const result = planSprintDraft(graph([
    issue(1, { storyPoints: 2, qaPoints: 1 }), issue(2, { summary: '[FE] Frontend' }),
    issue(3, { summary: '[QA] Testing', qaPoints: 1, storyPoints: 30 }),
  ]), {
    selectedKeys: [],
    roster: [
      { id: 'dev-test', name: 'Dev-test', roles: ['BE', 'QA'], capacity: 2, qaCapacity: 2 },
      { id: 'ui', name: 'UI', roles: ['FE'], capacity: 2 },
    ],
  });
  const byPerson = result.items.flatMap(({ stages }) => stages).filter(({ assigneeId }) => assigneeId === 'dev-test');
  assert.equal(new Set(byPerson.map(({ wave }) => wave)).size, byPerson.length);
  assert.equal(result.used, 3);
  assert.equal(result.qaUsed, 2);
  assert.equal(result.loads[0].used, 2);
  assert.equal(result.loads[0].qaUsed, 2);
});
