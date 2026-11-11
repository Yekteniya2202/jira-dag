import assert from 'node:assert/strict';
import test from 'node:test';
import type { JiraEdge, JiraGraph, JiraIssue } from '../shared/contracts.js';
import { analyzeDependencies } from '../renderer/dependency-analysis.js';

const issue = (key: string, fields: Partial<JiraIssue> = {}): JiraIssue => ({
  key, summary: key, status: 'To Do', url: '', ...fields,
});
const blocks = (id: string, source: string, target: string): JiraEdge => ({
  id, source, target, label: 'blocks', typeId: 'blocks', kind: 'link',
});
const graph = (issues: JiraIssue[], edges: JiraEdge[]): JiraGraph => ({
  issues,
  edges,
  linkTypes: [
    { id: 'blocks', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
    { id: 'relates', name: 'Relates', outward: 'relates to', inward: 'relates to' },
  ],
  storyPointsFields: [],
  warnings: [],
});
const keys = (issues: readonly JiraIssue[]) => issues.map(({ key }) => key);

test('earliest dependency waves respect open blockers and count convergent downstream work once', () => {
  const data = graph([
    issue('APP-5', { storyPoints: 0 }), issue('APP-3', { storyPoints: 5 }),
    issue('APP-1', { storyPoints: 2 }), issue('APP-4', { storyPoints: 3 }),
    issue('APP-2', { storyPoints: 1 }), issue('APP-6', { statusCategory: 'done' }),
  ], [
    blocks('1', 'APP-1', 'APP-2'), blocks('2', 'APP-1', 'APP-3'),
    blocks('3', 'APP-2', 'APP-4'), blocks('4', 'APP-3', 'APP-4'),
    blocks('5', 'APP-1', 'APP-2'), blocks('6', 'APP-6', 'APP-1'),
    { ...blocks('7', 'APP-4', 'APP-1'), typeId: 'relates' },
    { ...blocks('8', 'APP-4', 'APP-1'), kind: 'parent' },
  ]);
  const result = analyzeDependencies(data);

  assert.deepEqual(keys(result.ready), ['APP-1', 'APP-5']);
  assert.deepEqual(result.waves.map(keys), [['APP-1', 'APP-5'], ['APP-2', 'APP-3'], ['APP-4']]);
  assert.equal(result.peakParallel, 2);
  assert.deepEqual(result.prerequisites.get('APP-2'), ['APP-1']);
  assert.deepEqual(result.cycleGroups, []);
  assert.deepEqual(result.bottlenecks.map(({ issue, direct, downstream }) => [issue.key, direct, downstream]), [
    ['APP-1', 2, 3], ['APP-2', 1, 1], ['APP-3', 1, 1],
  ]);
  assert.equal(result.criticalPath?.unit, 'sp');
  assert.equal(result.criticalPath?.weight, 10);
  assert.equal(result.criticalPath?.partial, false);
  assert.deepEqual(keys(result.criticalPath?.issues ?? []), ['APP-1', 'APP-3', 'APP-4']);
});

test('cycles and their downstream work are excluded from dependency waves', () => {
  const data = graph([
    ...Array.from({ length: 8 }, (_, index) => issue(`APP-${index + 1}`)),
    issue('APP-9', { statusCategory: 'done' }),
  ], [
    blocks('1', 'APP-2', 'APP-1'), blocks('2', 'APP-1', 'APP-2'),
    blocks('3', 'APP-2', 'APP-3'), blocks('4', 'APP-3', 'APP-4'),
    blocks('5', 'APP-5', 'APP-5'), blocks('6', 'APP-6', 'APP-7'),
    blocks('7', 'APP-8', 'APP-9'), blocks('8', 'APP-9', 'APP-8'),
  ]);
  const result = analyzeDependencies(data);

  assert.deepEqual(result.cycleGroups, [['APP-1', 'APP-2'], ['APP-5']]);
  assert.deepEqual(keys(result.blockedByCycle), ['APP-3', 'APP-4']);
  assert.deepEqual(result.waves.map(keys), [['APP-6', 'APP-8'], ['APP-7']]);
  assert.deepEqual(result.bottlenecks.slice(0, 2).map(({ issue, direct, downstream }) => [issue.key, direct, downstream]), [
    ['APP-2', 2, 3], ['APP-1', 1, 3],
  ]);
  assert.equal(result.bottlenecks.some(({ issue }) => issue.key === 'APP-5'), false);
  assert.equal(result.criticalPath?.partial, true);
});

test('external prerequisites from loaded edges and graph boundaries stay open until known complete', () => {
  const data = graph([
    issue('EXT-1', { external: true }), issue('EXT-2', { external: true, statusCategory: 'done' }),
    issue('APP-1', { unloadedBlockerKeys: ['EXT-1', 'EXT-2'] }),
    issue('APP-2', { unloadedBlockerKeys: ['OTHER-22'] }),
    issue('APP-3'), issue('APP-4', { unloadedBlockerKeys: ['APP-5'] }),
    issue('APP-5', { storyPoints: 0 }), issue('APP-6', { unloadedBlockerKeys: ['APP-5'], storyPoints: 3 }),
  ], [
    blocks('1', 'EXT-1', 'APP-1'), blocks('2', 'APP-1', 'APP-3'),
    blocks('3', 'APP-2', 'APP-3'), blocks('4', 'EXT-6', 'APP-3'),
    blocks('5', 'APP-3', 'APP-4'),
  ]);
  const result = analyzeDependencies(data);

  assert.deepEqual(result.prerequisites.get('APP-1'), ['EXT-1']);
  assert.deepEqual(result.prerequisites.get('APP-4'), ['APP-3', 'APP-5']);
  assert.deepEqual(result.externalBlockers.get('APP-4'), ['EXT-1', 'EXT-6', 'OTHER-22']);
  assert.deepEqual(keys(result.blockedByExternal), ['APP-1', 'APP-2', 'APP-3', 'APP-4']);
  assert.deepEqual(result.waves.map(keys), [['APP-5'], ['APP-6']]);
  assert.equal(result.criticalPath?.weight, 3);
  assert.equal(result.criticalPath?.unit, 'sp');
  assert.equal(result.criticalPath?.partial, true);
  assert.deepEqual(keys(result.criticalPath?.issues ?? []), ['APP-5', 'APP-6']);
});

test('missing estimates use task count for the entire executable graph and retain source warnings', () => {
  const data = graph([
    issue('APP-1', { storyPoints: 99 }), issue('APP-2', { storyPoints: 20 }), issue('APP-3', { storyPoints: 0 }),
    issue('APP-4'), issue('APP-5', { storyPoints: 0 }),
  ], [blocks('1', 'APP-1', 'APP-2'), blocks('2', 'APP-3', 'APP-4'), blocks('3', 'APP-4', 'APP-5')]);
  data.warnings.push('Graph search truncated');
  const result = analyzeDependencies(data);

  assert.equal(result.criticalPath?.unit, 'issues');
  assert.equal(result.criticalPath?.weight, 3);
  assert.equal(result.criticalPath?.partial, true);
  assert.deepEqual(keys(result.criticalPath?.issues ?? []), ['APP-3', 'APP-4', 'APP-5']);
});

test('dependency waves ignore epic containers unless they participate in unfinished blockers', () => {
  const data = graph([
    issue('APP-1', { isEpic: true }), issue('APP-2', { isEpic: true, storyPoints: 3 }),
    issue('APP-3', { storyPoints: 1 }), issue('APP-4', { storyPoints: 2, parentKey: 'APP-1' }),
    issue('EXT-1', { isEpic: true, external: true }),
  ], [
    { id: 'parent', source: 'APP-1', target: 'APP-4', label: 'Parent issue', kind: 'parent' },
    blocks('1', 'APP-2', 'APP-3'), blocks('2', 'EXT-1', 'APP-4'),
  ]);
  const result = analyzeDependencies(data);

  assert.deepEqual(keys(result.openIssues), ['APP-1', 'APP-2', 'APP-3', 'APP-4', 'EXT-1']);
  assert.deepEqual(keys(result.scopeIssues), ['APP-2', 'APP-3', 'APP-4']);
  assert.deepEqual(result.waves.map(keys), [['APP-2'], ['APP-3']]);
  assert.deepEqual(result.externalBlockers.get('APP-4'), ['EXT-1']);
  assert.equal(result.criticalPath?.unit, 'sp');
  assert.equal(result.criticalPath?.weight, 4);
});

test('no executable issues produce no path or parallel work', () => {
  const result = analyzeDependencies(graph([issue('APP-1'), issue('APP-2', { statusCategory: 'done' })], [
    blocks('1', 'APP-1', 'APP-1'),
  ]));
  assert.equal(result.criticalPath, undefined);
  assert.equal(result.peakParallel, 0);
  assert.deepEqual(result.waves, []);
  assert.deepEqual(result.ready, []);
});
