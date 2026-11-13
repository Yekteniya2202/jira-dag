import type { JiraGraph, JiraIssue } from '../shared/contracts.js';
import { blockingEdges, statusTone } from './graph-model.js';
import { inferSprintRole, type SprintDraftPlan, type SprintDraftStage, type SprintRole } from './sprint-draft-planning.js';

export const sprintCardWidth = 232;
export const sprintCardHeight = 100;
const laneLabelWidth = 158;
const horizontalGap = 68;
const verticalGap = 17;
const headerHeight = 43;
const laneGap = 10;
const collator = new Intl.Collator('en', { numeric: true });

export type SprintNodeKind = 'selected' | 'recommended' | 'backlog' | 'blocker';
export type SprintColumn = number | 'outside' | 'unscheduled' | 'backlog';
type Link = { source: string; target: string; blocked?: boolean };

export interface SprintGraphCard {
  id: string;
  key: string;
  issue?: JiraIssue;
  stage?: SprintDraftStage;
  primary: boolean;
  kind: SprintNodeKind;
  role?: SprintRole;
  column: SprintColumn;
  laneId: string;
  laneName?: string;
  laneKind: 'person' | 'role' | 'unassigned' | 'outside';
  blocked: boolean;
  x: number;
  y: number;
}

export interface SprintGraphLayout {
  cards: SprintGraphCard[];
  links: Array<Link & { kind: 'dependency' | 'qa' }>;
  lanes: Array<{ id: string; name?: string; kind: SprintGraphCard['laneKind']; roles: SprintRole[]; y: number; height: number }>;
  columns: Array<{ id: SprintColumn; x: number }>;
  width: number;
  omittedBacklog: number;
}

export function layoutSprintGraph(graph: JiraGraph, plan: SprintDraftPlan, options: {
  selectedKeys: readonly string[];
  backlogKeys: ReadonlySet<string>;
  visibleBacklogKeys: readonly string[];
  includeBacklog: boolean;
  maximumBacklog?: number;
}): SprintGraphLayout {
  const { selectedKeys, backlogKeys, visibleBacklogKeys, includeBacklog, maximumBacklog = 100 } = options;
  const issues = new Map(graph.issues.map((issue) => [issue.key, issue]));
  const items = new Map(plan.items.map((item) => [item.issue.key, item]));
  const selected = new Set(selectedKeys);
  const recommended = new Set(plan.items.filter(({ source }) => source === 'recommended').map(({ issue }) => issue.key));
  const skipped = new Map(plan.skipped.map(({ issue, blockers }) => [issue.key, blockers]));
  const issueLinks = new Map<string, Link>();
  const predecessors = new Map<string, string[]>();
  function addLink(source: string, target: string) {
    if (issues.get(source) && statusTone(issues.get(source)!) === 'done') return;
    const id = JSON.stringify([source, target]);
    if (issueLinks.has(id)) return;
    issueLinks.set(id, { source, target });
    const upstream = predecessors.get(target) ?? [];
    upstream.push(source);
    predecessors.set(target, upstream);
  }
  for (const edge of blockingEdges(graph)) if (edge.kind === 'link') addLink(edge.source, edge.target);
  for (const issue of graph.issues) for (const blocker of issue.unloadedBlockerKeys ?? []) addLink(blocker, issue.key);

  const visible = new Set([...selectedKeys, ...recommended]);
  // Add causal context before optional backlog so the surrounding graph can explain every blocker shown.
  const backlog = includeBacklog ? visibleBacklogKeys.filter((key) => !visible.has(key)) : [];
  for (const key of backlog.slice(0, maximumBacklog)) visible.add(key);
  const pending = [...visible];
  while (pending.length) {
    const key = pending.pop()!;
    for (const blocker of predecessors.get(key) ?? []) {
      if (visible.has(blocker)) continue;
      visible.add(blocker);
      pending.push(blocker);
    }
  }
  const omittedBacklog = backlog.filter((key) => !visible.has(key)).length;
  const cards: SprintGraphCard[] = [];
  const starts = new Map<string, string>();
  const ends = new Map<string, string>();
  const links: SprintGraphLayout['links'] = [];
  const laneRoles = new Map<string, Set<SprintRole>>();

  for (const key of visible) {
    const issue = issues.get(key);
    const item = items.get(key);
    const kind: SprintNodeKind = selected.has(key) ? 'selected' : recommended.has(key) ? 'recommended' : backlogKeys.has(key) ? 'backlog' : 'blocker';
    const blocked = Boolean(item?.blockers.length || skipped.get(key)?.length || kind === 'blocker');
    const stages: (SprintDraftStage | undefined)[] = item?.stages.length ? item.stages : [undefined];
    const stageIds: string[] = [];
    for (const [index, stage] of stages.entries()) {
      const id = `${key}:${stage?.kind ?? 'issue'}`;
      const role = stage?.role ?? (issue && inferSprintRole(issue));
      const outside = kind === 'blocker';
      const assignee = stage ? stage.assignee : issue?.assignee;
      const assigneeId = (stage ? stage.assigneeId : issue?.assigneeId) ?? assignee;
      const laneKind = outside ? 'outside' : assigneeId ? 'person' : role ? 'role' : 'unassigned';
      const laneName = outside ? undefined : assignee ?? role;
      const laneId = `${laneKind}:${outside ? '' : assigneeId ?? role ?? ''}`;
      const column = outside ? 'outside' : stage?.wave ?? (kind === 'backlog' ? 'backlog' : 'unscheduled');
      const roleSet = laneRoles.get(laneId) ?? new Set();
      if (role) roleSet.add(role);
      laneRoles.set(laneId, roleSet);
      cards.push({ id, key, issue, stage, primary: index === 0, kind, role, column, laneId, laneName, laneKind, blocked, x: 0, y: 0 });
      stageIds.push(id);
    }
    starts.set(key, stageIds[0]);
    ends.set(key, stageIds.at(-1)!);
    if (stageIds.length > 1) links.push({ source: stageIds[0], target: stageIds[1], kind: 'qa' });
  }
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const { source, target } of issueLinks.values()) {
    const from = ends.get(source);
    const to = starts.get(target);
    if (!from || !to) continue;
    links.push({ source: from, target: to, kind: 'dependency',
      blocked: byId.get(from)?.kind === 'blocker' || (items.get(target)?.blockers ?? skipped.get(target))?.includes(source) });
  }
  const columns = layoutColumns(cards);
  const lanes = layoutLanes(cards, columns, laneRoles);
  return {
    cards, links, lanes, columns, omittedBacklog,
    width: (columns.at(-1)?.x ?? laneLabelWidth) + sprintCardWidth + 24,
  };
}

function layoutColumns(cards: SprintGraphCard[]) {
  const ids = new Set(cards.map(({ column }) => column));
  const waves = [...ids].filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  const order: SprintColumn[] = ['outside', ...waves, 'unscheduled', 'backlog'];
  return order.filter((id) => ids.has(id)).map((id, index) => ({
    id, x: laneLabelWidth + 16 + index * (sprintCardWidth + horizontalGap),
  }));
}

function layoutLanes(
  cards: SprintGraphCard[], columns: SprintGraphLayout['columns'], laneRoles: ReadonlyMap<string, ReadonlySet<SprintRole>>,
): SprintGraphLayout['lanes'] {
  const groups = new Map<string, SprintGraphCard[]>();
  for (const card of cards) {
    const group = groups.get(card.laneId) ?? [];
    group.push(card);
    groups.set(card.laneId, group);
  }
  const order: Record<SprintGraphCard['laneKind'], number> = { person: 0, role: 1, unassigned: 2, outside: 3 };
  const lanes = [...groups].sort(([, [a]], [, [b]]) =>
    order[a.laneKind] - order[b.laneKind] || collator.compare(a.laneName ?? a.laneId, b.laneName ?? b.laneId) || collator.compare(a.laneId, b.laneId));
  const horizontal = new Map(columns.map(({ id, x }) => [id, x]));
  let y = headerHeight;
  return lanes.map(([id, lane]) => {
    const position = y;
    const counts = new Map<SprintColumn, number>();
    let depth = 1;
    for (const card of lane) {
      const index = counts.get(card.column) ?? 0;
      card.x = horizontal.get(card.column) ?? laneLabelWidth;
      card.y = position + verticalGap + index * (sprintCardHeight + verticalGap);
      counts.set(card.column, index + 1);
      depth = Math.max(depth, index + 1);
    }
    const height = verticalGap + depth * (sprintCardHeight + verticalGap);
    y += height + laneGap;
    return { id, y: position, height, name: lane[0].laneName, kind: lane[0].laneKind, roles: [...(laneRoles.get(id) ?? [])] };
  });
}
