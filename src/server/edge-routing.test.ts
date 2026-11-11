import assert from 'node:assert/strict';
import test from 'node:test';
import { routeEdges, type RouteEdge, type RouteObstacle, type RoutePoint, type RoutedEdge } from '../renderer/edge-routing.js';

const card = (id: string, x: number, y: number, width = 100, height = 80): RouteObstacle => ({ id, x, y, width, height });

function link(id: string, source: RouteObstacle, target: RouteObstacle, direction: 'LR' | 'TB' = 'LR',
  options: Partial<Pick<RouteEdge, 'lane' | 'labelWidth' | 'labelHeight'>> = {}): RouteEdge {
  return {
    id, source: source.id, target: target.id, labelWidth: 0, labelHeight: 0, ...options,
    sourcePoint: direction === 'LR' ? { x: source.x + source.width, y: source.y + source.height / 2 }
      : { x: source.x + source.width / 2, y: source.y + source.height },
    targetPoint: direction === 'LR' ? { x: target.x, y: target.y + target.height / 2 }
      : { x: target.x + target.width / 2, y: target.y },
  };
}

function crosses(a: RoutePoint, b: RoutePoint, box: RouteObstacle): boolean {
  return Math.min(a.x, b.x) < box.x + box.width && Math.max(a.x, b.x) > box.x &&
    Math.min(a.y, b.y) < box.y + box.height && Math.max(a.y, b.y) > box.y;
}

function assertClear(route: RoutedEdge | undefined, obstacles: readonly RouteObstacle[]): asserts route is RoutedEdge {
  assert.ok(route?.path);
  assert.ok(route.points.length >= 2);
  assert.deepEqual(route.arrowTip, route.points.at(-1));
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1];
    const b = route.points[i];
    assert.ok(a.x === b.x || a.y === b.y);
    assert.ok(obstacles.every((box) => !crosses(a, b, box)), `Segment ${i} crosses a card`);
  }
}

test('direct edges keep the shaft and tip outside their ports', () => {
  const source = card('source', 0, 0);
  const target = card('target', 124, 0);
  const edge = link('direct', source, target);
  const route = routeEdges('LR', [source, target], [edge]).get(edge.id);
  assertClear(route, [source, target]);
  assert.deepEqual(route.points, [{ x: 105, y: 40 }, { x: 111, y: 40 }]);
});

test('routes search alternate corridors when a single detour still crosses an obstacle', () => {
  const source = card('source', 0, 190);
  const target = card('target', 600, 190);
  const obstacles = [source, target,
    card('central', 245, 156, 150, 150),
    card('note-above-source', 110, 100, 65, 105),
    card('below-source', 112, 255, 62, 110),
    card('note-above-target', 520, 110, 70, 94),
    card('below-target', 522, 255, 70, 100),
  ];
  const edge = link('across', source, target);
  const route = routeEdges('LR', obstacles, [edge]).get(edge.id);
  assertClear(route, obstacles);
  assert.ok(route.points.length >= 6);
  assert.deepEqual(route.arrowTip, { x: target.x - 13, y: 230 });
  assert.ok(route.points.at(-2)!.x < route.arrowTip.x);
});

test('reverse and self edges stay outside endpoint cards and preserve arrow direction', () => {
  const left = card('left', 0, 0);
  const right = card('right', 280, 0);
  const obstacles = [left, right, card('below', 130, 28)];
  const edges = [link('reverse', right, left), link('loop', left, left)];
  const routes = routeEdges('LR', obstacles, edges);
  for (const edge of edges) {
    const route = routes.get(edge.id);
    assertClear(route, obstacles);
    assert.ok(route.points.at(-2)!.x < route.arrowTip.x);
  }
});

test('vertical edges route past intervening cards and keep the arrow above the target handle', () => {
  const source = card('top', 0, 0);
  const target = card('bottom', 0, 400);
  const obstacles = [source, target, card('middle', -15, 160, 145, 110)];
  const edge = link('vertical', source, target, 'TB');
  const route = routeEdges('TB', obstacles, [edge]).get(edge.id);
  assertClear(route, obstacles);
  assert.deepEqual(route.arrowTip, { x: 50, y: 387 });
  assert.ok(route.points.at(-2)!.y < route.arrowTip.y);
});

test('top cards inside titled groups remain reachable on a vertical canvas', () => {
  const source = card('source', 20, 0);
  const target = card('target', 20, 236);
  const heading = { ...card('heading:group', 0, 200, 160, 36), labelOnly: true };
  const obstacles = [source, target, heading];
  const edge = link('cross-group', source, target, 'TB', { labelWidth: 120, labelHeight: 23 });
  const route = routeEdges('TB', obstacles, [edge]).get(edge.id);
  assertClear(route, [source, target]);
  assert.ok(route.label);
  const { x, y } = route.label;
  assert.ok(!crosses({ x: x - 60, y: y - 11.5 }, { x: x + 60, y: y + 11.5 }, heading));
  assert.ok(route.points.at(-2)!.y < route.arrowTip.y);
});

test('parallel labels fit outside cards and each other, with a leader when the label leaves the line', () => {
  const source = card('source', 0, 0);
  const target = card('target', 190, 0);
  const obstacles = [source, target];
  const edges = [-1, 0, 1].map((lane) => link(`lane-${lane}`, source, target, 'LR', { lane, labelWidth: 148, labelHeight: 24 }));
  const routes = routeEdges('LR', obstacles, edges);
  const labelBounds: RouteObstacle[] = [];
  for (const edge of edges) {
    const route = routes.get(edge.id);
    assertClear(route, obstacles);
    assert.ok(route.label);
    assert.ok(route.labelLeader);
    const { x, y } = route.label;
    const left = { x: x - edge.labelWidth / 2, y: y - edge.labelHeight / 2 };
    const right = { x: x + edge.labelWidth / 2, y: y + edge.labelHeight / 2 };
    assert.ok([...obstacles, ...labelBounds].every((box) => !crosses(left, right, box)));
    assert.ok(obstacles.every((box) => !crosses(route.labelLeader!, route.label!, box)));
    labelBounds.push(card(edge.id, left.x, left.y, edge.labelWidth, edge.labelHeight));
  }
  assert.equal(new Set([...routes.values()].map(({ path }) => path)).size, edges.length);
});

test('overlapping cards with an obscured port never produce an edge through a card', () => {
  const source = card('source', 0, 0);
  const target = card('target', 280, 0);
  const edge = link('hidden-port', source, target);
  const route = routeEdges('LR', [source, target, card('overlay', 94, 20, 58, 45)], [edge]).get(edge.id);
  assert.ok(route);
  assert.equal(route.path, '');
  assert.deepEqual(route.points, []);
});

test('large orthogonal graphs route deterministically with populated corridors', () => {
  const obstacles = Array.from({ length: 1_200 }, (_, i) => card(`node-${i}`, i % 40 * 240, Math.floor(i / 40) * 142));
  const edges = Array.from({ length: 360 }, (_, i) => {
    const row = i % 30;
    const column = i % 12;
    const source = obstacles[row * 40 + column];
    const target = obstacles[row * 40 + column + (i % 9 ? 1 : 24)];
    return link(`edge-${i}`, source, target, 'LR', { labelWidth: 88, labelHeight: 22 });
  });
  const routes = routeEdges('LR', obstacles, edges);
  assert.equal(routes.size, edges.length);
  for (const route of routes.values()) assertClear(route, obstacles);
  assert.deepEqual(routeEdges('LR', obstacles, edges), routes);
});
