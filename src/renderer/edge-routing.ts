export type RoutePoint = { x: number; y: number };

export type RouteObstacle = RoutePoint & { id: string; width: number; height: number; labelOnly?: boolean };

export interface RouteEdge {
  id: string;
  source: string;
  target: string;
  sourcePoint: RoutePoint;
  targetPoint: RoutePoint;
  lane?: number;
  labelWidth: number;
  labelHeight: number;
}

export interface RoutedEdge {
  path: string;
  points: RoutePoint[];
  label?: RoutePoint;
  labelLeader?: RoutePoint;
  arrowTip: RoutePoint;
  arrowFrom?: RoutePoint;
}

type Bounds = { left: number; top: number; right: number; bottom: number };
type Obstacle = Bounds & { id: string; labelOnly?: boolean };
type Axis = 'x' | 'y';
type Heading = 0 | 1;
type StrokeSegment = [RoutePoint, RoutePoint] | [RoutePoint, RoutePoint, RoutePoint] | [RoutePoint, RoutePoint, RoutePoint, RoutePoint];
type TracedStroke = Pick<RouteEdge, 'source' | 'target'> & { points: RoutePoint[]; bounds: Bounds };

const cellSize = 256;
const obstacleClearance = 8;
const bendCost = 28;
const sourceOffset = 1;
const arrowOffset = 1;
const portOffset = 26;
const laneSpacing = 12;

function intersects(a: Bounds, b: Bounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function extent(a: RoutePoint, b: RoutePoint, padding = 0): Bounds {
  return {
    left: Math.min(a.x, b.x) - padding,
    top: Math.min(a.y, b.y) - padding,
    right: Math.max(a.x, b.x) + padding,
    bottom: Math.max(a.y, b.y) + padding,
  };
}

function expand(box: Bounds, padding: number): Bounds {
  return {
    left: box.left - padding, top: box.top - padding,
    right: box.right + padding, bottom: box.bottom + padding,
  };
}

class ObstacleIndex {
  private readonly cells = new Map<string, Obstacle[]>();
  readonly boxes: Obstacle[] = [];

  constructor(boxes: readonly Obstacle[] = []) {
    for (const box of boxes) this.add(box);
  }

  add(box: Obstacle) {
    this.boxes.push(box);
    const { left, top, right, bottom } = this.cellsOf(box);
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const key = `${col},${row}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(box);
        else this.cells.set(key, [box]);
      }
    }
  }

  some(bounds: Bounds, predicate: (box: Obstacle) => boolean): boolean {
    const { left, top, right, bottom } = this.cellsOf(bounds);
    if ((right - left + 1) * (bottom - top + 1) > this.boxes.length) return this.boxes.some(predicate);
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const cell = this.cells.get(`${col},${row}`);
        if (cell?.some(predicate)) return true;
      }
    }
    return false;
  }

  around(bounds: Bounds): Obstacle[] {
    const found = new Set<Obstacle>();
    this.some(bounds, (box) => {
      if (intersects(bounds, box)) found.add(box);
      return false;
    });
    return [...found];
  }

  private cellsOf(bounds: Bounds): Bounds {
    return {
      left: Math.floor(bounds.left / cellSize), top: Math.floor(bounds.top / cellSize),
      right: Math.floor(bounds.right / cellSize), bottom: Math.floor(bounds.bottom / cellSize),
    };
  }
}

function segmentClear(index: ObstacleIndex, a: RoutePoint, b: RoutePoint, ignored?: string, alsoIgnored?: string): boolean {
  const line = extent(a, b);
  // Strict comparisons leave the perimeter of an expanded obstacle available as a routing channel.
  return !index.some(line, (box) => box.id !== ignored && box.id !== alsoIgnored && intersects(line, box));
}

function distance(a: RoutePoint, b: RoutePoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function interpolate(a: RoutePoint, b: RoutePoint, fraction: number): RoutePoint {
  return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
}

function controlBounds(points: readonly RoutePoint[]): Bounds {
  return points.reduce((box, point) => ({
    left: Math.min(box.left, point.x), top: Math.min(box.top, point.y),
    right: Math.max(box.right, point.x), bottom: Math.max(box.bottom, point.y),
  }), extent(points[0], points[0]));
}

function splitCurve(points: readonly RoutePoint[]): [RoutePoint[], RoutePoint[]] {
  const left = [points[0]];
  const right = [points.at(-1)!];
  let row = points;
  while (row.length > 1) {
    row = row.slice(1).map((point, index) => interpolate(row[index], point, 0.5));
    left.push(row[0]);
    right.push(row.at(-1)!);
  }
  return [left, right.reverse()];
}

function strokeClear(points: readonly RoutePoint[], blocked: (bounds: Bounds) => boolean, remaining = 8): boolean {
  if (!blocked(controlBounds(points))) return true;
  if (!remaining || points.length < 3) return false;
  // A Bézier lies inside its control hull. Subdivision gives tighter bounds near obstacles.
  const [left, right] = splitCurve(points);
  return strokeClear(left, blocked, remaining - 1) && strokeClear(right, blocked, remaining - 1);
}

function pointOn(segment: StrokeSegment, fraction: number): RoutePoint {
  if (fraction === 1) return segment.at(-1)!;
  const [a, b, c, d] = segment;
  const ab = interpolate(a, b, fraction);
  if (!c) return ab;
  const bc = interpolate(b, c, fraction);
  const abc = interpolate(ab, bc, fraction);
  return d ? interpolate(abc, interpolate(bc, interpolate(c, d, fraction), fraction), fraction) : abc;
}

function straightened(points: RoutePoint[]): RoutePoint[] {
  const result: RoutePoint[] = [];
  for (const next of points) {
    const last = result.at(-1);
    if (last && !distance(last, next)) continue;
    const previous = result.at(-2);
    if (previous && last && ((previous.x === last.x && last.x === next.x) || (previous.y === last.y && last.y === next.y)) &&
      distance(previous, last) + distance(last, next) === distance(previous, next)) {
      result.pop();
    }
    result.push(next);
  }
  return result;
}

function channelPath(a: RoutePoint, b: RoutePoint, axis: Axis, position: number): RoutePoint[] {
  return straightened([a, { ...a, [axis]: position }, { ...b, [axis]: position }, b]);
}

function clearPath(index: ObstacleIndex, points: RoutePoint[]): boolean {
  return points.every((point, i) => i === 0 || segmentClear(index, points[i - 1], point));
}

function bestChannel(
  index: ObstacleIndex, a: RoutePoint, b: RoutePoint, coordinates: readonly [Axis, number][], requireTurn = false,
): RoutePoint[] | undefined {
  let best: RoutePoint[] | undefined;
  let cost = Infinity;
  for (const [axis, position] of coordinates) {
    const path = channelPath(a, b, axis, position);
    if (requireTurn && (path.length < 3 || (axis === 'x' ? a.y === b.y : a.x === b.x))) continue;
    const nextCost = path.reduce((total, point, i) => total + (i ? distance(path[i - 1], point) : 0), 0)
      + Math.max(0, path.length - 2) * bendCost;
    if (nextCost >= cost || !clearPath(index, path)) continue;
    best = path;
    cost = nextCost;
  }
  return best;
}

function coordinateOptions(boxes: readonly Bounds[], axis: Axis): number[] {
  return boxes.flatMap((box) => axis === 'x' ? [box.left, box.right] : [box.top, box.bottom]);
}

function closeChannels(boxes: readonly Bounds[], a: RoutePoint, b: RoutePoint, axis: Axis, lane: number): Array<[Axis, number]> {
  const midpoint = (a[axis] + b[axis]) / 2 + lane * laneSpacing;
  return [...new Set([a[axis], b[axis], ...coordinateOptions(boxes, axis)])]
    .sort((left, right) => Math.abs(left - midpoint) - Math.abs(right - midpoint) || left - right)
    .slice(0, 20)
    .map((position) => [axis, position]);
}

function availableApproaches(index: ObstacleIndex, point: RoutePoint): number[] {
  const nearby = index.around({
    left: point.x - 90, right: point.x + 90, top: point.y - 260, bottom: point.y + 260,
  });
  const columns = [...new Set([point.x, point.x - 16, point.x + 16, ...coordinateOptions(nearby, 'x')])];
  return columns.filter((x) => Math.abs(x - point.x) <= 90 && segmentClear(index, point, { x, y: point.y }))
    .sort((left, right) => Math.abs(left - point.x) - Math.abs(right - point.x) || left - right)
    .slice(0, 12);
}

function shiftedChannel(index: ObstacleIndex, a: RoutePoint, b: RoutePoint, rows: readonly [Axis, number][]): RoutePoint[] | undefined {
  const startColumns = availableApproaches(index, a);
  const endColumns = availableApproaches(index, b);
  for (const [, y] of rows) {
    const starts = startColumns.filter((x) => segmentClear(index, { x, y: a.y }, { x, y }));
    if (!starts.length) continue;
    const ends = endColumns.filter((x) => segmentClear(index, { x, y: b.y }, { x, y }));
    for (const from of starts) {
      for (const to of ends) {
        if (!segmentClear(index, { x: from, y }, { x: to, y })) continue;
        return straightened([a, { x: from, y: a.y }, { x: from, y }, { x: to, y }, { x: to, y: b.y }, b]);
      }
    }
  }
  return undefined;
}

interface SearchStep {
  column: number;
  row: number;
  heading: Heading;
  cost: number;
  remaining: number;
  previous?: SearchStep;
}

function byEstimate(a: SearchStep, b: SearchStep): number {
  return a.cost + a.remaining - b.cost - b.remaining || a.remaining - b.remaining || a.row - b.row || a.column - b.column;
}

class RouteQueue {
  private readonly heap: SearchStep[] = [];

  push(step: SearchStep) {
    const heap = this.heap;
    let index = heap.length;
    heap.push(step);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (byEstimate(heap[parent], step) <= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = step;
  }

  pop(): SearchStep | undefined {
    const heap = this.heap;
    const first = heap[0];
    const last = heap.pop();
    if (!last || !heap.length) return first;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const next = right < heap.length && byEstimate(heap[right], heap[left]) < 0 ? right : left;
      if (byEstimate(last, heap[next]) <= 0) break;
      heap[index] = heap[next];
      index = next;
    }
    heap[index] = last;
    return first;
  }
}

function axisCoordinates(boxes: readonly Obstacle[], a: RoutePoint, b: RoutePoint, window: Bounds, axis: Axis): number[] {
  const low = axis === 'x' ? window.left : window.top;
  const high = axis === 'x' ? window.right : window.bottom;
  return [...new Set([a[axis], b[axis], low, high, ...coordinateOptions(boxes, axis)])]
    .filter((coordinate) => coordinate >= low && coordinate <= high)
    .sort((left, right) => left - right);
}

const moves = [
  { column: 1, row: 0, heading: 0 }, { column: -1, row: 0, heading: 0 },
  { column: 0, row: 1, heading: 1 }, { column: 0, row: -1, heading: 1 },
] as const;

function searchChannels(index: ObstacleIndex, a: RoutePoint, b: RoutePoint, window: Bounds, budget: number): RoutePoint[] | undefined {
  const boxes = index.around(window);
  const x = axisCoordinates(boxes, a, b, window, 'x');
  const y = axisCoordinates(boxes, a, b, window, 'y');
  const targetColumn = x.indexOf(b.x);
  const targetRow = y.indexOf(b.y);
  const queue = new RouteQueue();
  const bestCosts = new Map<number, number>();
  const point = (step: SearchStep): RoutePoint => ({ x: x[step.column], y: y[step.row] });
  const identity = (column: number, row: number, heading: Heading) => (row * x.length + column) * 2 + heading;
  const start: SearchStep = { column: x.indexOf(a.x), row: y.indexOf(a.y), heading: 0, cost: 0, remaining: distance(a, b) };
  queue.push(start);
  bestCosts.set(identity(start.column, start.row, start.heading), 0);
  for (let visited = 0; visited < budget; visited++) {
    const step = queue.pop();
    if (!step) return undefined;
    if (step.cost !== bestCosts.get(identity(step.column, step.row, step.heading))) continue;
    if (step.column === targetColumn && step.row === targetRow) {
      const path: RoutePoint[] = [];
      for (let current: SearchStep | undefined = step; current; current = current.previous) path.push(point(current));
      return straightened(path.reverse());
    }
    const from = point(step);
    for (const move of moves) {
      const column = step.column + move.column;
      const row = step.row + move.row;
      if (column < 0 || column >= x.length || row < 0 || row >= y.length) continue;
      const to = { x: x[column], y: y[row] };
      const cost = step.cost + distance(from, to) + (move.heading === step.heading ? 0 : bendCost);
      const key = identity(column, row, move.heading);
      if (cost >= (bestCosts.get(key) ?? Infinity) || !segmentClear(index, from, to)) continue;
      bestCosts.set(key, cost);
      queue.push({ column, row, heading: move.heading, cost, remaining: distance(to, b), previous: step });
    }
  }
  return undefined;
}

function routeBetween(index: ObstacleIndex, a: RoutePoint, b: RoutePoint, lane: number, outside: Bounds): RoutePoint[] | undefined {
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const offset = lane * laneSpacing;
  const direct = (lane !== 0 && bestChannel(index, a, b, [['x', midX + offset], ['y', midY + offset]], true))
    || bestChannel(index, a, b, [['x', midX], ['y', midY], ['x', a.x], ['x', b.x]]);
  if (direct) return direct;

  const neighborhood = index.around(extent(a, b, 128 + Math.abs(offset)));
  const rows = closeChannels(neighborhood, a, b, 'y', lane);
  const nearby = bestChannel(index, a, b, [
    ...closeChannels(neighborhood, a, b, 'x', lane), ...rows,
  ]);
  if (nearby) return nearby;

  // A short move within the port gap often reaches a clear column without searching the grid.
  const shifted = shiftedChannel(index, a, b, rows);
  if (shifted) return shifted;
  const local = searchChannels(index, a, b, extent(a, b, 190 + Math.abs(offset)), 2_000);
  if (local) return local;
  const around = bestChannel(index, a, b, [
    ['y', outside.top], ['y', outside.bottom], ['x', outside.left], ['x', outside.right],
  ]);
  return around ?? searchChannels(index, a, b, extent(a, b, 750 + Math.abs(offset)), 4_000);
}

function findPort(
  bounds: ReadonlyMap<string, Obstacle>, index: ObstacleIndex, point: RoutePoint, id: string, outgoing: boolean,
): RoutePoint | undefined {
  const own = bounds.get(id);
  const endOffset = outgoing ? sourceOffset : arrowOffset;
  const direction = outgoing ? 1 : -1;
  const edge = (outgoing ? own?.right : own?.left) ?? point.x;
  const minimum = Math.max(endOffset + 6, (edge - point.x) * direction);
  const end = { x: point.x + direction * endOffset, y: point.y };
  for (const length of [Math.max(portOffset, minimum), minimum]) {
    const port = { x: point.x + direction * length, y: point.y };
    if (segmentClear(index, end, port, id)) return port;
  }
  return undefined;
}

function pathFor(
  edge: RouteEdge, source: RoutePoint, target: RoutePoint, index: ObstacleIndex,
  bounds: ReadonlyMap<string, Obstacle>, outside: Bounds,
): RoutePoint[] | undefined {
  const sourceStart = { x: source.x + sourceOffset, y: source.y };
  const arrowTip = { x: target.x - arrowOffset, y: target.y };
  if (!edge.lane && sourceStart.y === arrowTip.y && sourceStart.x < arrowTip.x &&
      segmentClear(index, sourceStart, arrowTip, edge.source, edge.target)) {
    return [sourceStart, arrowTip];
  }
  const start = findPort(bounds, index, source, edge.source, true);
  const end = findPort(bounds, index, target, edge.target, false);
  if (!start || !end) return undefined;
  const route = routeBetween(index, start, end, edge.lane ?? 0, outside);
  if (!route) return undefined;
  return straightened([sourceStart, ...route, arrowTip]);
}

function directStroke(start: RoutePoint, tip: RoutePoint, lane: number): StrokeSegment[] {
  if (!lane && start.y === tip.y) return [[start, tip]];
  const span = tip.x - start.x;
  const reach = Math.min(span / 2, Math.max(span * 0.43, Math.min(72, Math.abs(tip.y - start.y) * 0.24)));
  if (!lane) return [[start, { x: start.x + reach, y: start.y }, { x: tip.x - reach, y: tip.y }, tip]];
  const midpoint = { x: (start.x + tip.x) / 2, y: (start.y + tip.y) / 2 + lane * 23 };
  const half = reach / 2;
  const slope = (tip.y - start.y) / Math.max(1, span);
  return [
    [start, { x: start.x + half, y: start.y }, { x: midpoint.x - half, y: midpoint.y - half * slope }, midpoint],
    [midpoint, { x: midpoint.x + half, y: midpoint.y + half * slope }, { x: tip.x - half, y: tip.y }, tip],
  ];
}

function reverseStroke(start: RoutePoint, tip: RoutePoint, row: number, lead: number): StrokeSegment[] {
  const departure = { x: start.x + lead, y: row };
  const arrival = { x: tip.x - lead, y: row };
  return [
    [start, { x: start.x + lead * 2, y: start.y }, { x: departure.x + lead, y: row }, departure],
    [departure, arrival],
    [arrival, { x: arrival.x - lead, y: row }, { x: tip.x - lead * 2, y: tip.y }, tip],
  ];
}

function controlLength(stroke: StrokeSegment[]): number {
  return stroke.reduce((total, segment) => total + segment.reduce((sum, point, index) => index
    ? sum + Math.hypot(point.x - segment[index - 1].x, point.y - segment[index - 1].y) : sum, 0), 0);
}

function flowingStroke(
  edge: RouteEdge, start: RoutePoint, tip: RoutePoint, index: ObstacleIndex, raw: ReadonlyMap<string, Obstacle>,
  crossings?: (stroke: StrokeSegment[]) => number,
): StrokeSegment[] | undefined {
  const source = raw.get(edge.source);
  const target = raw.get(edge.target);
  const blocked = (bounds: Bounds) => Boolean(
    (source && intersects(bounds, source)) || (target && intersects(bounds, target)) ||
    index.some(bounds, (box) => box.id !== edge.source && box.id !== edge.target && intersects(bounds, box)),
  );
  const lane = edge.lane ?? 0;
  let choices: StrokeSegment[][];
  if (tip.x > start.x) {
    choices = [directStroke(start, tip, lane)];
    if (crossings && !lane && tip.x - start.x >= 90) {
      choices.push(directStroke(start, tip, -1), directStroke(start, tip, 1));
    }
  } else {
    const lift = obstacleClearance + 13 + Math.abs(lane) * 18;
    const above = Math.min(start.y, tip.y, source?.top ?? start.y, target?.top ?? tip.y) - lift;
    const below = Math.max(start.y, tip.y, source?.bottom ?? start.y, target?.bottom ?? tip.y) + lift;
    const lead = Math.min(48, Math.max(18, (start.x - tip.x) * 0.11));
    const topFirst = lane < 0 || (!lane && start.y + tip.y - above * 2 <= below * 2 - start.y - tip.y);
    choices = (topFirst ? [above, below] : [below, above]).map((row) => reverseStroke(start, tip, row, lead));
  }

  let best: StrokeSegment[] | undefined;
  let bestScore = Infinity;
  let limit = Infinity;
  for (const candidate of choices) {
    if ((best && controlLength(candidate) > limit) || !candidate.every((segment) => strokeClear(segment, blocked))) continue;
    if (!crossings || lane) return candidate;
    const score = crossings(candidate);
    if (!score) return candidate;
    if (score < bestScore) {
      if (!best) limit = controlLength(candidate) * 1.25 + 12;
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function roundStroke(points: RoutePoint[], obstacles: ObstacleIndex): StrokeSegment[] {
  const segments: StrokeSegment[] = [];
  let cursor = points[0];
  const lineTo = (point: RoutePoint) => {
    if (distance(cursor, point)) segments.push([cursor, point]);
    cursor = point;
  };
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const incoming = distance(previous, corner);
    const outgoing = distance(corner, next);
    if ((previous.x === corner.x) === (corner.x === next.x)) {
      lineTo(corner);
      continue;
    }
    const cap = Math.min(58, incoming / 2, outgoing / 2);
    const blocked = (bounds: Bounds) => {
      const padded = expand(bounds, 1.5);
      return obstacles.some(padded, (box) => intersects(padded, box));
    };
    let rounded = false;
    for (let radius = cap; radius >= 1; radius *= 0.65) {
      const before = interpolate(corner, previous, radius / incoming);
      const after = interpolate(corner, next, radius / outgoing);
      const curve: StrokeSegment = [before, corner, after];
      if (!strokeClear(curve, blocked)) continue;
      lineTo(before);
      segments.push(curve);
      cursor = after;
      rounded = true;
      break;
    }
    if (!rounded) lineTo(corner);
  }
  lineTo(points.at(-1)!);
  return segments;
}

function labelBox(point: RoutePoint, width: number, height: number): Bounds {
  return {
    left: point.x - width / 2, top: point.y - height / 2,
    right: point.x + width / 2, bottom: point.y + height / 2,
  };
}

function labelAnchors(segments: StrokeSegment[], width: number, height: number, flipped: boolean): RoutePoint[] {
  const lengths = segments.map((segment) =>
    segment.reduce((total, point, index) => total + (index ? distance(segment[index - 1], point) : 0), 0));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const anchors: Array<{ point: RoutePoint; score: number }> = [];
  let traveled = 0;
  for (const [i, length] of lengths.entries()) {
    const segment = segments[i];
    const a = segment[0];
    const b = segment.at(-1)!;
    const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
    const measure = vertical ? height : width;
    const horizontalOnScreen = vertical === flipped;
    for (const fraction of length < 24 ? [0.5] : [0.5, 0.25, 0.75, 0.1, 0.9, 0.375, 0.625]) {
      const point = pointOn(segment, fraction);
      const score = Math.abs(traveled + length * fraction - total / 2) / Math.max(total, 1)
        + (horizontalOnScreen ? 0 : 0.2) + (length < measure + 8 ? 0.3 : 0);
      anchors.push({ point, score });
    }
    traveled += length;
  }
  return anchors.sort((left, right) => left.score - right.score).slice(0, 140).map(({ point }) => point);
}

function placeLabel(
  segments: StrokeSegment[], width: number, height: number, flipped: boolean, obstacles: ObstacleIndex, labels: ObstacleIndex, id: string,
): { label?: RoutePoint; labelLeader?: RoutePoint } {
  if (!width || !height) return {};
  const anchors = labelAnchors(segments, width, height, flipped);
  function reserve(point: RoutePoint): boolean {
    const box = expand(labelBox(point, width, height), 4);
    if (obstacles.some(box, (obstacle) => intersects(box, obstacle)) || labels.some(box, (other) => intersects(box, other))) return false;
    labels.add({ ...box, id });
    return true;
  }
  for (const label of anchors) {
    if (reserve(label)) return { label };
  }

  const directions = flipped
    ? [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }]
    : [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
  const nearbyAnchors = anchors.slice(0, 35);
  for (const extra of [10, 24, 40, 64, 96, 150, 240, 380]) {
    for (const anchor of nearbyAnchors) {
      for (const shift of directions) {
        const label = {
          x: anchor.x + shift.x * (width / 2 + extra),
          y: anchor.y + shift.y * (height / 2 + extra),
        };
        if (segmentClear(obstacles, anchor, label) && reserve(label)) return { label, labelLeader: anchor };
      }
    }
  }
  return {};
}

function strokePath(segments: StrokeSegment[], orient: (point: RoutePoint) => RoutePoint): string {
  const svgPoint = (point: RoutePoint) => {
    const { x, y } = orient(point);
    return `${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
  };
  const commands = segments.map((segment) =>
    `${segment.length === 2 ? 'L' : segment.length === 3 ? 'Q' : 'C'} ${segment.slice(1).map(svgPoint).join(' ')}`);
  return `M ${svgPoint(segments[0][0])} ${commands.join(' ')}`;
}

function strokeSamples(segments: StrokeSegment[], quadraticSteps = 8, cubicSteps = 16): RoutePoint[] {
  const points = [segments[0][0]];
  for (const segment of segments) {
    const steps = segment.length === 2 ? 1 : segment.length === 3 ? quadraticSteps : cubicSteps;
    for (let index = 1; index <= steps; index++) points.push(pointOn(segment, index / steps));
  }
  return points;
}

function sharesLine(a: RoutePoint, b: RoutePoint, c: RoutePoint, d: RoutePoint): boolean {
  const side = (first: RoutePoint, last: RoutePoint, point: RoutePoint) =>
    (last.x - first.x) * (point.y - first.y) - (last.y - first.y) * (point.x - first.x);
  const near = side(a, b, c);
  const far = side(a, b, d);
  if (!near && !far) {
    const axis = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? 'x' : 'y';
    return Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
      - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > 12;
  }
  return near * far <= 0 && side(c, d, a) * side(c, d, b) <= 0;
}

function crossingCount(stroke: StrokeSegment[], edge: RouteEdge, traces: readonly TracedStroke[]): number {
  const points = strokeSamples(stroke, 3, 6);
  const bounds = expand(controlBounds(points), 1);
  return traces.reduce((count, prior) => {
    if (edge.source === prior.source || edge.source === prior.target || edge.target === prior.source ||
        edge.target === prior.target || !intersects(bounds, prior.bounds)) return count;
    const crosses = points.some((point, index) => index > 0 && prior.points.some((other, priorIndex) =>
      priorIndex > 0 && sharesLine(points[index - 1], point, prior.points[priorIndex - 1], other)));
    return count + Number(crosses);
  }, 0);
}

function endpointPair({ source, target }: RouteEdge): string {
  return source < target ? `${source}\0${target}` : `${target}\0${source}`;
}

export function routeEdges(direction: 'LR' | 'TB', obstacles: readonly RouteObstacle[], edges: readonly RouteEdge[]): Map<string, RoutedEdge> {
  const flipped = direction === 'TB';
  const orient = (point: RoutePoint): RoutePoint => flipped ? { x: point.y, y: point.x } : point;
  const boxes = obstacles.filter(({ x, y, width, height }) => [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0)
    .map((box) => ({ ...extent(orient(box), orient({ x: box.x + box.width, y: box.y + box.height })), id: box.id, labelOnly: box.labelOnly }));
  const routeBoxes = boxes.filter(({ labelOnly }) => !labelOnly);
  const padded = routeBoxes.map((box) => ({ ...expand(box, obstacleClearance), id: box.id }));
  const index = new ObstacleIndex(padded);
  const byId = new Map(padded.map((box) => [box.id, box]));
  const rawById = new Map(routeBoxes.map((box) => [box.id, box]));
  const occupied = new ObstacleIndex(boxes);
  const routeObstacles = routeBoxes.length === boxes.length ? occupied : new ObstacleIndex(routeBoxes);
  const labels = new ObstacleIndex();
  const routes = new Map<string, RoutedEdge>();
  // Compare a bounded window of already routed neighbors. Large canvases keep routing independent during drag.
  const traces: TracedStroke[] | undefined = edges.length <= 180 ? [] : undefined;
  const pairs = new Map<string, number>();
  if (traces) {
    for (const edge of edges) {
      const pair = endpointPair(edge);
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
  }
  const outside = expand(routeBoxes.reduce<Bounds>((area, box) => ({
    left: Math.min(area.left, box.left), top: Math.min(area.top, box.top),
    right: Math.max(area.right, box.right), bottom: Math.max(area.bottom, box.bottom),
  }), { left: 0, top: 0, right: 0, bottom: 0 }), 44);
  let tight: { index: ObstacleIndex; byId: Map<string, Obstacle> } | undefined;

  for (const edge of edges) {
    const source = orient(edge.sourcePoint);
    const target = orient(edge.targetPoint);
    const start = { x: source.x + sourceOffset, y: source.y };
    const tip = { x: target.x - arrowOffset, y: target.y };
    let stroke = flowingStroke(edge, start, tip, index, rawById,
      traces?.length && pairs.get(endpointPair(edge)) === 1 ? (candidate) => crossingCount(candidate, edge, traces) : undefined);
    if (!stroke) {
      let route = pathFor(edge, source, target, index, byId, outside);
      if (!route) {
        if (!tight) {
          const narrow = routeBoxes.map((box) => ({ ...expand(box, 2), id: box.id }));
          tight = { index: new ObstacleIndex(narrow), byId: new Map(narrow.map((box) => [box.id, box])) };
        }
        route = pathFor(edge, source, target, tight.index, tight.byId, outside);
      }
      if (route && route.length > 1) stroke = roundStroke(route, routeObstacles);
    }
    if (!stroke?.length) {
      routes.set(edge.id, { path: '', points: [], arrowTip: orient(tip) });
      continue;
    }
    const width = flipped ? edge.labelHeight : edge.labelWidth;
    const height = flipped ? edge.labelWidth : edge.labelHeight;
    const { label, labelLeader } = placeLabel(stroke, width, height, flipped, occupied, labels, edge.id);
    if (traces) {
      const points = strokeSamples(stroke, 3, 6);
      traces.push({ source: edge.source, target: edge.target, points, bounds: expand(controlBounds(points), 1) });
      if (traces.length > 24) traces.shift();
    }
    routes.set(edge.id, {
      path: strokePath(stroke, orient),
      points: strokeSamples(stroke).map(orient),
      arrowTip: orient(tip),
      arrowFrom: orient(stroke.at(-1)!.at(-2)!),
      ...(label ? { label: orient(label) } : {}),
      ...(labelLeader ? { labelLeader: orient(labelLeader) } : {}),
    });
  }
  return routes;
}
