import type { JiraEdge, JiraGraph, JiraIssue, JiraLinkType } from '../shared/contracts.js';
import { isBlockingType } from '../shared/jira-links.js';

export { isBlockingType };

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 112;
export type Direction = 'LR' | 'TB';
export type GraphPosition = { x: number; y: number };

export function assigneeInitials(name: string): string {
  return name.trim().split(/\s+/u).slice(0, 2).map((part) => [...part][0] ?? '').join('').toUpperCase();
}

export function statusTone(issue: JiraIssue): 'done' | 'active' | 'waiting' {
  if (issue.statusCategory === 'done') return 'done';
  if (issue.statusCategory === 'indeterminate' || issue.statusCategory === 'in-progress') return 'active';
  return 'waiting';
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

export function blockingEdges(graph: JiraGraph): JiraEdge[] {
  const types = new Set(graph.linkTypes.filter(isBlockingType).map(({ id }) => id));
  return graph.edges.filter((edge) => edge.typeId && types.has(edge.typeId));
}

export function mergeGraphs(current: JiraGraph, incoming: JiraGraph): JiraGraph {
  const issues = new Map(current.issues.map((issue) => [issue.key, issue]));
  for (const issue of incoming.issues) {
    const existing = issues.get(issue.key);
    if (!existing || existing.external || !issue.external) issues.set(issue.key, issue);
  }
  const linkKey = ({ source, target, typeId }: JiraEdge) => JSON.stringify([source, target, typeId]);
  const confirmedLinks = new Set(incoming.edges.map(linkKey));
  const retained = current.edges.filter((edge) => !edge.id.startsWith('unconfirmed:') || !confirmedLinks.has(linkKey(edge)));
  return {
    issues: [...issues.values()],
    edges: [...new Map([...retained, ...incoming.edges].map((edge) => [edge.id, edge])).values()],
    linkTypes: [...new Map([...current.linkTypes, ...incoming.linkTypes].map((type) => [type.id, type])).values()],
    storyPointsFields: [...new Map([...current.storyPointsFields, ...incoming.storyPointsFields].map((field) => [field.id, field])).values()],
    qaPointsFields: [...new Map([...(current.qaPointsFields ?? []), ...(incoming.qaPointsFields ?? [])]
      .map((field) => [field.id, field])).values()],
    warnings: [...new Set([...current.warnings, ...incoming.warnings])],
  };
}
