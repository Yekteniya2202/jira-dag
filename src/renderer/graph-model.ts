import dagre from '@dagrejs/dagre';
import type { JiraEdge, JiraGraph, JiraIssue, JiraLinkType } from '../shared/contracts';

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 104;
export type Direction = 'LR' | 'TB';
export type GraphPosition = { x: number; y: number };

export function layoutGraph(graph: JiraGraph, direction: Direction): Map<string, GraphPosition> {
  const layout = new dagre.graphlib.Graph({ multigraph: true })
    .setGraph({ rankdir: direction, nodesep: 38, ranksep: 92, marginx: 20, marginy: 22 })
    .setDefaultEdgeLabel(() => ({}));
  for (const issue of graph.issues) {
    layout.setNode(issue.key, { width: CARD_WIDTH, height: CARD_HEIGHT });
  }
  for (const edge of graph.edges) {
    if (layout.hasNode(edge.source) && layout.hasNode(edge.target)) {
      layout.setEdge(edge.source, edge.target, {}, edge.id);
    }
  }
  dagre.layout(layout);
  return new Map(graph.issues.map(({ key }) => {
    const { x, y } = layout.node(key);
    return [key, { x: x - CARD_WIDTH / 2, y: y - CARD_HEIGHT / 2 }];
  }));
}

export function statusTone(issue: JiraIssue): 'done' | 'active' | 'waiting' {
  if (issue.statusCategory === 'done') return 'done';
  if (issue.statusCategory === 'indeterminate' || issue.statusCategory === 'in-progress') return 'active';
  return 'waiting';
}

export function isBlockingType(type?: JiraLinkType): boolean {
  return Boolean(type && (
    /^blocks?$/i.test(type.name) || /^blocks?$/i.test(type.outward) || /^блокирует$/i.test(type.outward)
  ));
}

export function tracePath(edges: JiraEdge[], initial: string, direction: 'up' | 'down'): Set<string> {
  const visited = new Set([initial]);
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    const from = direction === 'down' ? edge.source : edge.target;
    const to = direction === 'down' ? edge.target : edge.source;
    const neighbors = adjacent.get(from) ?? [];
    neighbors.push(to);
    adjacent.set(from, neighbors);
  }
  const pending = [initial];
  while (pending.length) {
    const key = pending.pop()!;
    for (const next of adjacent.get(key) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  return visited;
}

export function blockersFor(graph: JiraGraph, key: string): JiraIssue[] {
  const blockerTypes = new Set(graph.linkTypes.filter(isBlockingType).map(({ id }) => id));
  const sources = new Set(graph.edges.filter((edge) => edge.target === key &&
    edge.typeId && blockerTypes.has(edge.typeId)).map(({ source }) => source));
  return graph.issues.filter((issue) => sources.has(issue.key) && statusTone(issue) !== 'done');
}

export function linkClosesCycle(graph: JiraGraph, source: string, target: string, type: JiraLinkType) {
  if (source === target) return true;
  if (!isBlockingType(type)) return false;
  const ids = new Set(graph.linkTypes.filter(isBlockingType).map(({ id }) => id));
  const edges = graph.edges.filter(({ typeId }) => typeId && ids.has(typeId));
  return tracePath(edges, target, 'down').has(source);
}

export function putIssue(graph: JiraGraph, issue: JiraIssue): JiraGraph {
  const existing = graph.issues.some(({ key }) => key === issue.key);
  return {
    ...graph,
    issues: existing
      ? graph.issues.map((previous) => previous.key === issue.key ? { ...previous, ...issue } : previous)
      : [...graph.issues, issue],
  };
}
