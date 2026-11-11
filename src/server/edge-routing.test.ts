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

function chordCrosses(a: RoutePoint, b: RoutePoint, box: RouteObstacle): boolean {
  const times = (start: number, end: number, low: number, high: number): [number, number] => {
    if (start === end) return low < start && start < high ? [-Infinity, Infinity] : [Infinity, -Infinity];
    const left = (low - start) / (end - start);
    const right = (high - start) / (end - start);
    return [Math.min(left, right), Math.max(left, right)];
  };
  const x = times(a.x, b.x, box.x, box.x + box.width);
  const y = times(a.y, b.y, box.y, box.y + box.height);
  return Math.max(0, x[0], y[0]) < Math.min(1, x[1], y[1]);
}

function assertClear(route: RoutedEdge | undefined, obstacles: readonly RouteObstacle[]): asserts route is RoutedEdge {
  assert.ok(route?.path);
  assert.ok(route.points.length >= 2);
  assert.deepEqual(route.arrowTip, route.points.at(-1));
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1];
    const b = route.points[i];
    assert.ok(obstacles.every((box) => !chordCrosses(a, b, box)), `Segment ${i} crosses a card`);
  }
}

test('direct edges keep the shaft and tip outside their ports', () => {
  const source = card('source', 0, 0);
  const target = card('target', 124, 0);
  const edge = link('direct', source, target);
  const route = routeEdges('LR', [source, target], [edge]).get(edge.id);
  assertClear(route, [source, target]);
  assert.deepEqual(route.points, [{ x: 101, y: 40 }, { x: 123, y: 40 }]);
  assert.deepEqual(route.arrowFrom, route.points[0]);
});

test('a clear staggered route is a single flowing cubic with an outward tangent at each port', () => {
  const source = card('source', 0, 0);
  const target = card('target', 370, 200);
  const edge = link('slanted', source, target);
  const route = routeEdges('LR', [source, target], [edge]).get(edge.id);
  assertClear(route, [source, target]);
  assert.match(route.path, /^M 101 40 C [\d.]+ 40 [\d.]+ 240 369 240$/);
  assert.equal(route.arrowFrom?.y, route.arrowTip.y);
  assert.ok(route.arrowFrom!.x < route.arrowTip.x);
});

test('a comparable arc can avoid an earlier crossing between independent edges', () => {
  const earlier: RouteEdge = {
    id: 'earlier', source: 'upper', target: 'middle',
    sourcePoint: { x: 125, y: -52 }, targetPoint: { x: 190, y: 12 }, labelWidth: 0, labelHeight: 0,
  };
  const following: RouteEdge = {
    id: 'following', source: 'left', target: 'right',
    sourcePoint: { x: 0, y: 0 }, targetPoint: { x: 300, y: 0 }, labelWidth: 0, labelHeight: 0,
  };
  const original = routeEdges('LR', [], [following]).get(following.id);
  const rerouted = routeEdges('LR', [], [earlier, following]).get(following.id);
  assert.match(original!.path, /^M 1 0 L 299 0$/);
  assert.match(rerouted!.path, /C/);
  assert.ok(rerouted!.points.some(({ y }) => y >= 20));
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
  assert.match(route.path, /Q/);
  assert.deepEqual(route.arrowTip, { x: target.x - 1, y: 230 });
  assert.ok(route.arrowFrom!.x < route.arrowTip.x);
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
    assert.match(route.path, /[CQ]/);
    assert.ok(route.arrowFrom!.x < route.arrowTip.x);
    assert.equal(route.arrowFrom?.y, route.arrowTip.y);
  }
  assert.match(routes.get('reverse')!.path, /C/);
});

test('vertical edges route past intervening cards and keep the arrow above the target handle', () => {
  const source = card('top', 0, 0);
  const target = card('bottom', 0, 400);
  const obstacles = [source, target, card('middle', -15, 160, 145, 110)];
  const edge = link('vertical', source, target, 'TB');
  const route = routeEdges('TB', obstacles, [edge]).get(edge.id);
  assertClear(route, obstacles);
  assert.deepEqual(route.arrowTip, { x: 50, y: 399 });
  assert.ok(route.arrowFrom!.y < route.arrowTip.y);
  assert.equal(route.arrowFrom?.x, route.arrowTip.x);
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
  assert.ok(routes.get('lane--1')!.points.some(({ y }) => y <= 20));
  assert.ok(routes.get('lane-1')!.points.some(({ y }) => y >= 60));
});

test('links to different neighbours fan out along both sides of a card in either orientation', () => {
  for (const direction of ['LR', 'TB'] as const) {
    const across = direction === 'LR';
    const place = (id: string, along: number, acrossFlow: number) => across
      ? card(id, along, acrossFlow) : card(id, acrossFlow, along, 80, 100);
    const hub = place('hub', 0, 0);
    const upstream = [-120, 0, 120].map((row, i) => place(`up-${i}`, -420, row));
    const downstream = [-120, 0, 120].map((row, i) => place(`down-${i}`, 420, row));
    const incoming = upstream.map((source, i) => link(`in-${i}`, source, hub, direction));
    const outgoing = downstream.map((target, i) => link(`out-${i}`, hub, target, direction));
    const obstacles = [hub, ...upstream, ...downstream];
    const routes = routeEdges(direction, obstacles, [...outgoing, ...incoming].reverse());
    const side = (point: RoutePoint) => across ? point.y : point.x;
    const along = (point: RoutePoint) => across ? point.x : point.y;
    const entries = incoming.map(({ id }) => {
      const route = routes.get(id);
      assertClear(route, obstacles);
      assert.equal(along(route.arrowTip), -1);
      return side(route.arrowTip);
    });
    const exits = outgoing.map(({ id }) => {
      const route = routes.get(id);
      assertClear(route, obstacles);
      assert.equal(along(route.points[0]), 101);
      return side(route.points[0]);
    });
    for (const offsets of [entries, exits]) {
      assert.ok(offsets.every((offset) => offset >= 8 && offset <= 72));
      assert.ok(offsets[1] - offsets[0] >= 8);
      assert.ok(offsets[2] - offsets[1] >= 8);
    }
  }
});

test('unrelated detours use separate tracks along a shared obstacle even in a large graph', () => {
  const sourceA = card('source-a', 0, 0);
  const sourceB = card('source-b', 0, 110);
  const targetA = card('target-a', 800, 0);
  const targetB = card('target-b', 800, 110);
  const blocker = card('blocker', 250, -5, 320, 380);
  const obstacles = [sourceA, sourceB, targetA, targetB, blocker];
  const first = link('first', sourceA, targetA);
  const second = link('second', sourceB, targetB);
  const elsewhere = Array.from({ length: 185 }, (_, i) =>
    link(`distant-${i}`, card(`distant-source-${i}`, 0, 600 + 20 * i), card(`distant-target-${i}`, 230, 600 + 20 * i)));
  const routes = routeEdges('LR', obstacles, [first, ...elsewhere, second]);
  const a = routes.get(first.id);
  const b = routes.get(second.id);
  assertClear(a, obstacles);
  assertClear(b, obstacles);
  const positionAt = ({ points }: RoutedEdge, x: number): number => {
    const index = points.findIndex((point, i) => i > 0 && points[i - 1].x < x && x <= point.x);
    assert.ok(index > 0, `Expected the route to reach x=${x}`);
    const [start, end] = [points[index - 1], points[index]];
    return start.y + (end.y - start.y) * (x - start.x) / (end.x - start.x);
  };
  for (const x of [280, 350, 420, 500, 550]) {
    assert.ok(Math.abs(positionAt(a, x) - positionAt(b, x)) >= 6, `Detours overlap near x=${x}`);
  }
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

test('a blocked fan position falls back to the reachable centre of the card', () => {
  const source = card('source', 0, 0);
  const upper = card('upper', 450, -120);
  const lower = card('lower', 450, 100);
  const obstacles = [source, upper, lower, card('overlay', 100, 22, 60, 16)];
  const routes = routeEdges('LR', obstacles, [link('upper', source, upper), link('lower', source, lower)]);
  const route = routes.get('upper');
  assertClear(route, obstacles);
  assert.deepEqual(route.points[0], { x: 101, y: 40 });
  assertClear(routes.get('lower'), obstacles);
});

test('large graphs route deterministically with populated corridors', () => {
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
