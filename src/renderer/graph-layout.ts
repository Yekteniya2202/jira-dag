import dagre from '@dagrejs/dagre';
import type { JiraEdge, JiraGraph, JiraIssue } from '../shared/contracts.js';
import { blockingEdges, CARD_WIDTH, statusTone, type Direction, type GraphPosition } from './graph-model.js';

export type GroupMode = 'none' | 'hierarchy' | 'project' | 'status' | 'assignee' | 'sprint' | 'release' | 'priority' | 'level' | 'open-level';

export interface LayoutLabels {
  component: string;
  emptyGroup: string;
  level: string;
  cycle: string;
  done: string;
}

interface Dimensions { width: number; height: number }

export interface GraphZone extends GraphPosition, Dimensions {
  id: string;
  title: string;
  kind: 'component' | 'group' | 'nested';
  issues: number;
  done: number;
  points?: number;
}

interface GroupName { key: string; title: string }

interface GroupTree {
  id: string;
  title: string;
  issues: JiraIssue[];
  children: Map<string, GroupTree>;
}

interface LayoutBox extends Dimensions {
  positions: Map<string, GraphPosition>;
  zones: GraphZone[];
  issues: number;
  done: number;
  points?: number;
}

const gap = 52;

export function connectedParts(issues: JiraIssue[], edges: JiraEdge[], groups = new Map<string, GroupName[]>()) {
  const roots = new Map(issues.map(({ key }) => [key, key]));
  function root(key: string) {
    let current = key;
    while (roots.get(current) !== current) current = roots.get(current)!;
    while (key !== current) {
      const previous = roots.get(key)!;
      roots.set(key, current);
      key = previous;
    }
    return current;
  }
  for (const { source, target } of edges) {
    if (roots.has(source) && roots.has(target)) roots.set(root(target), root(source));
  }
  const anchors = new Map<string, string>();
  for (const issue of issues) {
    const group = groups.get(issue.key)?.[0];
    if (!group) continue;
    const anchor = anchors.get(group.key);
    if (anchor) roots.set(root(issue.key), root(anchor));
    else anchors.set(group.key, issue.key);
  }
  const parts = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const id = root(issue.key);
    const part = parts.get(id) ?? [];
    part.push(issue);
    parts.set(id, part);
  }
  return [...parts.values()];
}

function dependencyLevels(graph: JiraGraph, onlyOpen: boolean): Map<string, number> {
  const active = new Set(graph.issues.filter((issue) => !onlyOpen || statusTone(issue) !== 'done').map(({ key }) => key));
  const incoming = new Map([...active].map((key) => [key, 0]));
  const outgoing = new Map<string, string[]>();
  for (const { source, target } of blockingEdges(graph)) {
    if (!active.has(source) || !active.has(target)) continue;
    incoming.set(target, incoming.get(target)! + 1);
    const neighbors = outgoing.get(source) ?? [];
    neighbors.push(target);
    outgoing.set(source, neighbors);
  }
  const queue = [...active].filter((key) => incoming.get(key) === 0);
  const levels = new Map(queue.map((key) => [key, 1]));
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i];
    for (const target of outgoing.get(key) ?? []) {
      levels.set(target, Math.max(levels.get(target) ?? 0, levels.get(key)! + 1));
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  for (const [key, count] of incoming) if (count > 0) levels.delete(key);
  return levels;
}

export function cyclicBlockingEdges(graph: JiraGraph): Set<string> {
  const edges = blockingEdges(graph);
  const links = new dagre.graphlib.Graph();
  for (const issue of graph.issues) links.setNode(issue.key);
  for (const { source, target } of edges) links.setEdge(source, target);
  const components = new Map<string, number>();
  const clusters = dagre.graphlib.alg.tarjan(links) as string[][];
  clusters.forEach((members, id) => {
    if (members.length > 1) members.forEach((key) => components.set(key, id));
  });
  return new Set(edges.filter(({ source, target }) => source === target ||
    (components.has(source) && components.get(source) === components.get(target))).map(({ id }) => id));
}

function hierarchyGroups(graph: JiraGraph): Map<string, GroupName[]> {
  const byKey = new Map(graph.issues.map((issue) => [issue.key, issue]));
  const parents = new Map(graph.edges.filter(({ kind }) => kind === 'parent').map(({ source, target }) => [target, source]));
  const isEpic = (issue?: JiraIssue) => Boolean(issue?.isEpic || /^(epic|эпик)$/i.test(issue?.issueType ?? ''));
  for (const issue of graph.issues) if (issue.parentKey) parents.set(issue.key, issue.parentKey);
  const parentZones = new Set<string>();
  for (const issue of graph.issues) {
    const parent = parents.get(issue.key);
    if (parent && !isEpic(issue) && (issue.isSubtask || (byKey.has(parent) && !isEpic(byKey.get(parent))))) {
      parentZones.add(parent);
    }
  }
  const title = (key: string) => {
    const summary = byKey.get(key)?.summary;
    return summary && summary !== key ? `${key} · ${summary}` : key;
  };
  return new Map(graph.issues.map((issue) => {
    const path: GroupName[] = [];
    const parent = parents.get(issue.key);
    const seen = new Set<string>();
    let epic = issue.epicKey ?? (isEpic(issue) ? issue.key : undefined);
    for (let ancestor = parent; !epic && ancestor && !seen.has(ancestor); ancestor = parents.get(ancestor)) {
      seen.add(ancestor);
      const candidate = byKey.get(ancestor);
      if (isEpic(candidate)) epic = ancestor;
      else if (candidate?.epicKey) epic = candidate.epicKey;
    }
    if (epic) path.push({ key: `epic:${epic}`, title: title(epic) });
    const task = parentZones.has(issue.key) ? issue.key : parent && parentZones.has(parent) ? parent : undefined;
    if (task && task !== epic) path.push({ key: `parent:${task}`, title: title(task) });
    return [issue.key, path];
  }));
}

function groupPaths(graph: JiraGraph, mode: GroupMode, labels: LayoutLabels): Map<string, GroupName[]> {
  if (mode === 'none') return new Map();
  if (mode === 'hierarchy') return hierarchyGroups(graph);
  const levels = mode === 'level' || mode === 'open-level' ? dependencyLevels(graph, mode === 'open-level') : undefined;
  return new Map(graph.issues.map((issue) => {
    const level = levels?.get(issue.key);
    const choices: Record<Exclude<GroupMode, 'none' | 'hierarchy'>, string | undefined> = {
      project: issue.project, status: issue.status, assignee: issue.assignee,
      sprint: issue.sprints?.join(' / '), release: issue.fixVersions?.join(' / '), priority: issue.priority,
      level: level ? `${labels.level} ${level}` : labels.cycle,
      'open-level': statusTone(issue) === 'done' ? labels.done : level ? `${labels.level} ${level}` : labels.cycle,
    };
    const title = choices[mode] || labels.emptyGroup;
    return [issue.key, [{ key: title, title }]];
  }));
}

function groupTree(issues: JiraIssue[], paths: Map<string, GroupName[]>, id: string): GroupTree {
  const root: GroupTree = { id, title: '', issues: [], children: new Map() };
  for (const issue of issues) {
    let group = root;
    for (const { key, title } of paths.get(issue.key) ?? []) {
      let child = group.children.get(key);
      if (!child) {
        child = { id: `${group.id}/${encodeURIComponent(key)}`, title, issues: [], children: new Map() };
        group.children.set(key, child);
      }
      group = child;
    }
    group.issues.push(issue);
  }
  return root;
}

function collectMembers(tree: GroupTree): string[] {
  return [...tree.issues.map(({ key }) => key), ...[...tree.children.values()].flatMap(collectMembers)];
}

function moveBox(target: LayoutBox, box: LayoutBox, x: number, y: number) {
  for (const [key, position] of box.positions) {
    target.positions.set(key, { x: position.x + x, y: position.y + y });
  }
  target.zones.push(...box.zones.map((zone) => ({ ...zone, x: zone.x + x, y: zone.y + y })));
  target.issues += box.issues;
  target.done += box.done;
  if (box.points !== undefined) target.points = (target.points ?? 0) + box.points;
}

function zone(box: LayoutBox, id: string, title: string, kind: GraphZone['kind']): GraphZone {
  return { id, title, kind, x: 0, y: 0, width: box.width, height: box.height,
    issues: box.issues, done: box.done, points: box.points };
}

function layoutTree(tree: GroupTree, edges: JiraEdge[], direction: Direction, cardHeight: number, depth = 0): LayoutBox {
  const items = new Map<string, LayoutBox>();
  const memberToGroup = new Map<string, string>();
  const withinGroups = new Map<string, JiraEdge[]>();
  const projected: Array<[string, string]> = [];
  for (const issue of tree.issues) {
    items.set(issue.key, {
      width: CARD_WIDTH, height: cardHeight, issues: 1, done: statusTone(issue) === 'done' ? 1 : 0,
      points: issue.storyPoints, positions: new Map([[issue.key, { x: 0, y: 0 }]]), zones: [],
    });
  }
  for (const group of tree.children.values()) {
    for (const key of collectMembers(group)) memberToGroup.set(key, group.id);
    withinGroups.set(group.id, []);
  }
  for (const edge of edges) {
    const source = memberToGroup.get(edge.source) ?? edge.source;
    const target = memberToGroup.get(edge.target) ?? edge.target;
    if (source === target) withinGroups.get(source)?.push(edge);
    else projected.push([source, target]);
  }
  for (const group of tree.children.values()) {
    items.set(group.id, layoutTree(group, withinGroups.get(group.id)!, direction, cardHeight, depth + 1));
  }
  const layout = new dagre.graphlib.Graph().setGraph({
    rankdir: direction, nodesep: 36, ranksep: 82, marginx: depth ? 22 : 0, marginy: depth ? 20 : 0,
  }).setDefaultEdgeLabel(() => ({}));
  for (const [id, { width, height }] of items) layout.setNode(id, { width, height });
  for (const [source, target] of projected) {
    if (items.has(source) && items.has(target)) layout.setEdge(source, target);
  }
  dagre.layout(layout);
  const header = depth ? 31 : 0;
  const box: LayoutBox = {
    width: layout.graph().width ?? 0, height: (layout.graph().height ?? 0) + header,
    positions: new Map(), zones: [], issues: 0, done: 0,
  };
  for (const [id, item] of items) {
    const { x, y } = layout.node(id);
    moveBox(box, item, x - item.width / 2, y - item.height / 2 + header);
  }
  if (depth) box.zones.unshift(zone(box, tree.id, tree.title, depth === 1 ? 'group' : 'nested'));
  return box;
}

export function layoutWorkspace(graph: JiraGraph, direction: Direction, mode: GroupMode, labels: LayoutLabels, cardHeight: number, basis = graph) {
  const paths = groupPaths(basis, mode, labels);
  const parts = connectedParts(graph.issues, graph.edges, paths);
  const byKey = new Map<string, number>();
  const edgesByPart = parts.map((): JiraEdge[] => []);
  parts.forEach((part, index) => part.forEach(({ key }) => byKey.set(key, index)));
  for (const edge of graph.edges) {
    const index = byKey.get(edge.source);
    if (index !== undefined && index === byKey.get(edge.target)) edgesByPart[index].push(edge);
  }
  const boxes = parts.map((issues, index) => {
    const id = `zone:${index}`;
    const box = layoutTree(groupTree(issues, paths, id), edgesByPart[index], direction, cardHeight);
    if (parts.length < 2 || issues.length < 2 || box.zones.some(({ kind }) => kind === 'group')) return box;
    const framed: LayoutBox = {
      width: box.width + 34, height: box.height + 55, positions: new Map(), zones: [], issues: 0, done: 0,
    };
    moveBox(framed, box, 17, 36);
    framed.zones.unshift(zone(framed, id, labels.component, 'component'));
    return framed;
  });
  const area = boxes.reduce((sum, box) => sum + (box.width + gap) * (box.height + gap), 0);
  const rowWidth = Math.max(840, Math.sqrt(area) * 1.45);
  const canvas: LayoutBox = { width: rowWidth, height: 0, positions: new Map(), zones: [], issues: 0, done: 0 };
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const box of boxes) {
    if (x && x + box.width > rowWidth) {
      y += rowHeight + gap;
      x = 0;
      rowHeight = 0;
    }
    moveBox(canvas, box, x, y);
    x += box.width + gap;
    rowHeight = Math.max(rowHeight, box.height);
  }
  return { positions: canvas.positions, zones: canvas.zones, parts: connectedParts(graph.issues, graph.edges).length };
}

export function downstreamPoints(graph: JiraGraph): Map<string, number> {
  const edges = blockingEdges(graph);
  const outgoing = new Map<string, Set<string>>();
  for (const { source, target } of edges) {
    const targets = outgoing.get(source) ?? new Set<string>();
    targets.add(target);
    outgoing.set(source, targets);
  }
  const estimates = new Map(graph.issues.map(({ key, storyPoints }) => [key, storyPoints]));
  const pointsByTarget = new Map<string, number>();
  for (const target of new Set(edges.map((edge) => edge.target))) {
    const seen = new Set<string>();
    const pending = [target];
    let total: number | undefined;
    while (pending.length) {
      const key = pending.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const value = estimates.get(key);
      if (value !== undefined) total = (total ?? 0) + value;
      pending.push(...(outgoing.get(key) ?? []));
    }
    if (total !== undefined) pointsByTarget.set(target, total);
  }
  return new Map(edges.flatMap(({ id, target }) => {
    const value = pointsByTarget.get(target);
    return value === undefined ? [] : [[id, value]];
  }));
}
