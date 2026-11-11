import assert from 'node:assert/strict';
import test from 'node:test';
import type { JiraEdge, JiraGraph, JiraIssue } from '../shared/contracts.js';
import {
  connectedParts, cyclicBlockingEdges, downstreamPoints, layoutWorkspace,
  type GraphZone, type LayoutLabels,
} from '../renderer/graph-layout.js';
import { CARD_HEIGHT, CARD_WIDTH, type GraphPosition } from '../renderer/graph-model.js';

const labels: LayoutLabels = {
  component: 'Component', emptyGroup: 'No group', level: 'Level', cycle: 'Cycle', done: 'Done',
};
const issue = (key: string, fields: Partial<JiraIssue> = {}): JiraIssue => ({
  key, summary: key, status: 'To Do', url: '', ...fields,
});
const blocks = (id: string, source: string, target: string): JiraEdge => ({
  id, source, target, label: 'blocks', kind: 'link', typeId: 'blocks',
});
const parent = (source: string, target: string): JiraEdge => ({
  id: `parent:${source}:${target}`, source, target, label: 'Parent', kind: 'parent',
});
const relates = (id: string, source: string, target: string): JiraEdge => ({
  id, source, target, label: 'relates to', kind: 'link', typeId: 'relates',
});
const graph = (issues: JiraIssue[], edges: JiraEdge[]): JiraGraph => ({
  issues,
  edges,
  linkTypes: [
    { id: 'blocks', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
    { id: 'relates', name: 'Relates', outward: 'relates to', inward: 'relates to' },
  ],
  warnings: [],
  storyPointsFields: [],
});

function position(layout: ReturnType<typeof layoutWorkspace>, key: string): GraphPosition {
  const value = layout.positions.get(key);
  assert.ok(value, `No position for ${key}`);
  assert.ok(Number.isFinite(value.x) && Number.isFinite(value.y), `Invalid position for ${key}`);
  return value;
}

function contains(zone: GraphZone, rectangle: GraphPosition, width: number, height: number): boolean {
  return rectangle.x >= zone.x && rectangle.y >= zone.y &&
    rectangle.x + width <= zone.x + zone.width && rectangle.y + height <= zone.y + zone.height;
}

test('unconnected components and an isolated task remain distinct and get non-overlapping positions', () => {
  const data = graph(
    ['APP-1', 'APP-2', 'APP-3', 'APP-4', 'APP-5'].map((key) => issue(key)),
    [blocks('1', 'APP-1', 'APP-2'), blocks('2', 'APP-4', 'APP-3'), blocks('3', 'APP-5', 'MISSING-1')],
  );
  assert.deepEqual(connectedParts(data.issues, data.edges).map((part) => part.map(({ key }) => key)), [
    ['APP-1', 'APP-2'], ['APP-3', 'APP-4'], ['APP-5'],
  ]);

  for (const direction of ['LR', 'TB'] as const) {
    const layout = layoutWorkspace(data, direction, 'none', labels, CARD_HEIGHT);
    assert.equal(layout.parts, 3);
    assert.equal(layout.zones.filter(({ kind }) => kind === 'component').length, 2);
    assert.equal(layout.positions.size, data.issues.length);
    const axis = direction === 'LR' ? 'x' : 'y';
    assert.ok(position(layout, 'APP-1')[axis] < position(layout, 'APP-2')[axis]);
    assert.ok(position(layout, 'APP-4')[axis] < position(layout, 'APP-3')[axis]);
    const positions = data.issues.map(({ key }) => position(layout, key));
    for (const [index, left] of positions.entries()) {
      for (const right of positions.slice(index + 1)) {
        assert.ok(Math.abs(left.x - right.x) >= CARD_WIDTH || Math.abs(left.y - right.y) >= CARD_HEIGHT);
      }
    }
    assert.equal(layout.zones.some((zone) => contains(zone, position(layout, 'APP-5'), CARD_WIDTH, CARD_HEIGHT)), false);
  }
});

test('a parent and its subtasks stay inside a nested zone within the epic and share its totals', () => {
  const data = graph([
    issue('APP-1', { isEpic: true, summary: 'Migration' }),
    issue('APP-2', { parentKey: 'APP-1', epicKey: 'APP-1', storyPoints: 0 }),
    issue('APP-3', { parentKey: 'APP-2', isSubtask: true, statusCategory: 'done', storyPoints: 2 }),
    issue('APP-4', { parentKey: 'APP-1', storyPoints: 3 }),
    issue('OPS-1', { storyPoints: 8 }),
  ], [
    parent('APP-1', 'APP-2'), parent('APP-2', 'APP-3'), parent('APP-1', 'APP-4'),
    blocks('1', 'APP-3', 'OPS-1'), blocks('2', 'APP-1', 'OPS-1'),
  ]);

  const layout = layoutWorkspace(data, 'LR', 'hierarchy', labels, CARD_HEIGHT);
  const epic = layout.zones.find(({ kind }) => kind === 'epic');
  const nested = layout.zones.find(({ kind }) => kind === 'nested');
  assert.ok(epic);
  assert.ok(nested);
  assert.equal(epic.title, 'APP-1 · Migration');
  assert.equal(epic.epicKey, 'APP-1');
  assert.equal(layout.positions.has('APP-1'), false);
  assert.equal(nested.title, 'APP-2');
  assert.deepEqual([epic.issues, epic.done, epic.points], [4, 1, 5]);
  assert.deepEqual([nested.issues, nested.done, nested.points], [2, 1, 2]);
  assert.ok(contains(epic, nested, nested.width, nested.height));
  for (const key of ['APP-2', 'APP-3']) assert.ok(contains(nested, position(layout, key), CARD_WIDTH, CARD_HEIGHT));
  assert.ok(contains(epic, position(layout, 'APP-4'), CARD_WIDTH, CARD_HEIGHT));
  assert.equal(contains(epic, position(layout, 'OPS-1'), CARD_WIDTH, CARD_HEIGHT), false);
  assert.deepEqual(layout.visibleEdges.map(({ id }) => id), ['parent:APP-2:APP-3', '1']);

  const ungrouped = layoutWorkspace(data, 'LR', 'none', labels, CARD_HEIGHT);
  position(ungrouped, 'APP-1');
  assert.deepEqual(ungrouped.visibleEdges, data.edges);
});

test('an isolated epic has a selectable zone with finite dimensions', () => {
  const data = graph([issue('APP-1', { issueType: 'Epic', statusCategory: 'done', storyPoints: 0 })], []);
  for (const direction of ['LR', 'TB'] as const) {
    const layout = layoutWorkspace(data, direction, 'hierarchy', labels, CARD_HEIGHT);
    assert.equal(layout.positions.size, 0);
    assert.equal(layout.zones.length, 1);
    const [epic] = layout.zones;
    assert.equal(epic.kind, 'epic');
    assert.equal(epic.epicKey, 'APP-1');
    assert.ok(Number.isFinite(epic.width) && epic.width >= CARD_WIDTH);
    assert.ok(Number.isFinite(epic.height) && epic.height > 0);
    assert.deepEqual([epic.issues, epic.done, epic.points], [1, 1, 0]);
  }
});

test('a filter can leave only children of a known epic without adding its card or counting it in the zone', () => {
  const child = issue('APP-2', { epicKey: 'APP-1', storyPoints: 3 });
  const basis = graph([issue('APP-1', { summary: 'Migration', external: true }), child], [parent('APP-1', 'APP-2')]);
  const filtered = graph([child], []);
  const layout = layoutWorkspace(filtered, 'LR', 'hierarchy', labels, CARD_HEIGHT, basis);
  const epic = layout.zones.find(({ kind }) => kind === 'epic');
  assert.ok(epic);
  assert.equal(epic.title, 'APP-1 · Migration');
  assert.equal(epic.epicKey, 'APP-1');
  assert.ok(contains(epic, position(layout, 'APP-2'), CARD_WIDTH, CARD_HEIGHT));
  assert.deepEqual([epic.issues, epic.done, epic.points], [1, 0, 3]);
  assert.equal(layoutWorkspace(basis, 'LR', 'hierarchy', labels, CARD_HEIGHT).positions.has('APP-1'), false);
});

test('only blocking edges internal to a cycle are marked including parallel edges and self-loops', () => {
  const data = graph(
    ['APP-1', 'APP-2', 'APP-3', 'APP-4', 'APP-5'].map((key) => issue(key)),
    [
      blocks('ab', 'APP-1', 'APP-2'), blocks('ab2', 'APP-1', 'APP-2'), blocks('ba', 'APP-2', 'APP-1'),
      blocks('bc', 'APP-2', 'APP-3'), blocks('cc', 'APP-3', 'APP-3'),
      relates('de', 'APP-4', 'APP-5'), relates('ed', 'APP-5', 'APP-4'),
    ],
  );
  assert.deepEqual(cyclicBlockingEdges(data), new Set(['ab', 'ab2', 'ba', 'cc']));
});

test('downstream estimates count a shared descendant once and retain a known total of zero', () => {
  const data = graph([
    issue('APP-1'), issue('APP-2', { storyPoints: 0 }), issue('APP-3', { storyPoints: 2 }),
    issue('APP-4', { storyPoints: 3 }), issue('APP-5', { storyPoints: 0 }), issue('APP-6'),
    issue('APP-7', { storyPoints: 13 }),
  ], [
    blocks('ab', 'APP-1', 'APP-2'), blocks('bc', 'APP-2', 'APP-3'), blocks('bd', 'APP-2', 'APP-4'),
    blocks('cd', 'APP-3', 'APP-4'), blocks('ae', 'APP-1', 'APP-5'), blocks('af', 'APP-1', 'APP-6'),
    relates('dg', 'APP-4', 'APP-7'),
  ]);
  assert.deepEqual(downstreamPoints(data), new Map([
    ['ab', 5], ['bc', 5], ['bd', 3], ['cd', 3], ['ae', 0],
  ]));
});

test('open dependency levels drop done blockers while the full levels retain them', () => {
  const data = graph([
    issue('APP-1', { statusCategory: 'done' }),
    issue('APP-2', { statusCategory: 'indeterminate' }),
    issue('APP-3'),
    issue('APP-4'),
  ], [blocks('ab', 'APP-1', 'APP-2'), blocks('bc', 'APP-2', 'APP-3'), relates('db', 'APP-4', 'APP-2')]);
  const full = layoutWorkspace(data, 'TB', 'level', labels, CARD_HEIGHT);
  const open = layoutWorkspace(data, 'TB', 'open-level', labels, CARD_HEIGHT);
  const zoneTitle = (layout: ReturnType<typeof layoutWorkspace>, key: string) => layout.zones.find(
    (zone) => contains(zone, position(layout, key), CARD_WIDTH, CARD_HEIGHT),
  )?.title;
  const keys = data.issues.map(({ key }) => key);
  assert.deepEqual(keys.map((key) => zoneTitle(full, key)), ['Level 1', 'Level 2', 'Level 3', 'Level 1']);
  assert.deepEqual(keys.map((key) => zoneTitle(open, key)), ['Done', 'Level 1', 'Level 2', 'Level 1']);
});
