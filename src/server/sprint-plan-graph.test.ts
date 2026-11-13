import assert from 'node:assert/strict';
import test from 'node:test';
import type { JiraEdge, JiraGraph, JiraIssue } from '../shared/contracts.js';
import type { SprintDraftPlan } from '../renderer/sprint-draft-planning.js';
import { layoutSprintGraph } from '../renderer/sprint-plan-graph-model.js';

function issue(key: string, fields: Partial<JiraIssue> = {}): JiraIssue {
  return { key, summary: key, status: 'To do', url: '', ...fields };
}

function dependency(source: string, target: string): JiraEdge {
  return { id: `${source}:${target}`, source, target, label: 'blocks', kind: 'link', typeId: '1' };
}

function graph(issues: JiraIssue[], edges: JiraEdge[]): JiraGraph {
  return { issues, edges, storyPointsFields: [], warnings: [],
    linkTypes: [{ id: '1', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }] };
}

const emptyPlan: SprintDraftPlan = {
  items: [], skipped: [], loads: [], roleLoads: [], risks: [], velocity: { sampleCount: 0, people: new Map() }, used: 0, qaUsed: 0,
};

test('planner graph puts QA handoff in a later wave and links the next issue from QA', () => {
  const development = issue('APP-1', { assignee: 'Developer', assigneeId: 'dev' });
  const next = issue('APP-2');
  const plan: SprintDraftPlan = {
    ...emptyPlan, items: [
      { issue: development, source: 'selected', blockers: [], stages: [
        { kind: 'work', role: 'BE', assigneeId: 'dev', assignee: 'Developer', wave: 1, points: 3 },
        { kind: 'qa', role: 'QA', wave: 2, points: 1 },
      ] },
      { issue: next, source: 'recommended', blockers: [], stages: [{ kind: 'work', role: 'FE', wave: 3, points: 2 }] },
    ],
  };
  const layout = layoutSprintGraph(graph([development, next], [dependency('APP-1', 'APP-2')]), plan, {
    selectedKeys: ['APP-1'], backlogKeys: new Set(['APP-2']), visibleBacklogKeys: [], includeBacklog: false,
  });
  const [work, qa, followup] = layout.cards;
  assert.equal(work.laneName, 'Developer');
  assert.equal(qa.laneKind, 'role');
  assert.equal(qa.laneName, 'QA');
  assert.ok(work.x < qa.x && qa.x < followup.x);
  assert.deepEqual(layout.links, [
    { source: 'APP-1:work', target: 'APP-1:qa', kind: 'qa' },
    { source: 'APP-1:qa', target: 'APP-2:work', kind: 'dependency', blocked: false },
  ]);
  assert.equal(qa.primary, false);
  assert.equal(followup.kind, 'recommended');
});

test('planner graph includes open external prerequisites without rendering completed blockers', () => {
  const first = issue('APP-1', { unloadedBlockerKeys: ['APP-40'] });
  const second = issue('APP-2');
  const completed = issue('APP-3', { statusCategory: 'done' });
  const backlog = issue('APP-4');
  const plan: SprintDraftPlan = { ...emptyPlan, items: [
    { issue: first, source: 'selected', blockers: ['APP-40'], stages: [] },
  ] };
  const layout = layoutSprintGraph(graph([first, second, completed, backlog], [
    dependency('APP-2', 'APP-1'), dependency('APP-3', 'APP-1'),
  ]), plan, { selectedKeys: ['APP-1'], backlogKeys: new Set(['APP-2', 'APP-4']),
    visibleBacklogKeys: ['APP-4'], includeBacklog: false });
  assert.deepEqual(layout.cards.map(({ key, kind, blocked }) => [key, kind, blocked]), [
    ['APP-1', 'selected', true], ['APP-2', 'backlog', false], ['APP-40', 'blocker', true],
  ]);
  assert.equal(layout.cards.find(({ key }) => key === 'APP-40')?.column, 'outside');
  assert.equal(layout.links.find(({ source }) => source === 'APP-40:issue')?.blocked, true);
});

test('planner graph bounds unrelated backlog while preserving prerequisites of displayed candidates', () => {
  const issues = ['APP-1', 'APP-2', 'APP-3'].map((key) => issue(key));
  const layout = layoutSprintGraph(graph(issues, [dependency('APP-3', 'APP-1')]), emptyPlan, {
    selectedKeys: [], backlogKeys: new Set(issues.map(({ key }) => key)), visibleBacklogKeys: issues.map(({ key }) => key),
    includeBacklog: true, maximumBacklog: 1,
  });
  assert.deepEqual(layout.cards.map(({ key }) => key), ['APP-1', 'APP-3']);
  assert.equal(layout.omittedBacklog, 1);
});
