import dagre from '@dagrejs/dagre';
import type { JiraGraph, JiraIssue } from '../shared/contracts.js';
import { blockingEdges, statusTone } from './graph-model.js';

export interface CriticalPath {
  issues: JiraIssue[];
  weight: number;
  unit: 'sp' | 'issues';
  partial: boolean;
}

export interface DependencyAnalysis {
  openIssues: JiraIssue[];
  scopeIssues: JiraIssue[];
  prerequisites: ReadonlyMap<string, readonly string[]>;
  ready: JiraIssue[];
  waves: JiraIssue[][];
  peakParallel: number;
  cycleGroups: string[][];
  blockedByCycle: JiraIssue[];
  blockedByExternal: JiraIssue[];
  externalBlockers: ReadonlyMap<string, readonly string[]>;
  bottlenecks: Array<{ issue: JiraIssue; direct: number; downstream: number }>;
  criticalPath?: CriticalPath;
}

const issueOrder = new Intl.Collator('en', { numeric: true });
const compareKeys = (left: string, right: string) => issueOrder.compare(left, right) || left.localeCompare(right);
const compareIssues = (left: JiraIssue, right: JiraIssue) => compareKeys(left.key, right.key);

type Successors = ReadonlyMap<string, ReadonlySet<string>>;
type Prerequisites = ReadonlyMap<string, readonly string[]>;

export function analyzeDependencies(graph: JiraGraph): DependencyAnalysis {
  const issues = new Map(graph.issues.map((issue) => [issue.key, issue]));
  const openIssues = [...issues.values()].filter((issue) => statusTone(issue) !== 'done').sort(compareIssues);
  const openByKey = new Map(openIssues.map((issue) => [issue.key, issue]));
  const incoming = new Map(openIssues.map(({ key, unloadedBlockerKeys }) => [key, new Set(unloadedBlockerKeys)]));
  const outgoing = new Map<string, Set<string>>();
  const links = new dagre.graphlib.Graph();

  for (const { kind, source, target } of blockingEdges(graph)) {
    if (kind === 'link') incoming.get(target)?.add(source);
  }

  const prerequisites = new Map<string, string[]>();
  for (const [key, sources] of incoming) {
    const open = [...sources].filter((source) => openByKey.has(source) || !issues.has(source)).sort(compareKeys);
    prerequisites.set(key, open);
    for (const source of open) {
      const targets = outgoing.get(source) ?? new Set<string>();
      targets.add(key);
      outgoing.set(source, targets);
      links.setEdge(source, key);
    }
  }
  const scopeIssues = openIssues.filter(({ key, external, isEpic }) => !external &&
    (!isEpic || outgoing.has(key) || Boolean(prerequisites.get(key)?.length)));
  const scopeKeys = new Set(scopeIssues.map(({ key }) => key));
  const cycleGroups = (dagre.graphlib.alg.tarjan(links) as string[][])
    .filter((members) => members.length > 1 || outgoing.get(members[0])?.has(members[0]))
    .map((members) => members.sort(compareKeys))
    .sort((left, right) => compareKeys(left[0], right[0]));
  const cycleKeys = new Set(cycleGroups.flat());
  const downstreamOfCycle = reachable(outgoing, cycleKeys);
  const { bottlenecks, externalBlockers } = downstreamImpact(openByKey, outgoing, scopeKeys);
  const blockedByCycle = scopeIssues.filter(({ key }) => downstreamOfCycle.has(key) && !cycleKeys.has(key));
  const blockedByExternal = scopeIssues.filter(({ key }) => externalBlockers.has(key));
  const waves = dependencyWaves(scopeIssues, outgoing, prerequisites);

  return {
    openIssues, scopeIssues, prerequisites, ready: waves[0] ?? [], waves, cycleGroups, blockedByCycle, blockedByExternal, externalBlockers,
    peakParallel: waves.reduce((peak, wave) => Math.max(peak, wave.length), 0),
    bottlenecks,
    criticalPath: longestPath(waves, prerequisites, openByKey,
      graph.warnings.length > 0 || waves.reduce((count, wave) => count + wave.length, 0) < scopeIssues.length),
  };
}

function reachable(outgoing: Successors, startingKeys: Iterable<string>): Set<string> {
  const seen = new Set(startingKeys);
  const pending = [...seen];
  while (pending.length) {
    const key = pending.pop()!;
    for (const target of outgoing.get(key) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
  }
  return seen;
}

function dependencyWaves(issues: JiraIssue[], outgoing: Successors, prerequisites: Prerequisites): JiraIssue[][] {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const unresolved = new Map(issues.map(({ key }) => [key, prerequisites.get(key)?.length ?? 0]));
  const waves: JiraIssue[][] = [];
  let current = issues.filter(({ key }) => unresolved.get(key) === 0);
  while (current.length) {
    waves.push(current);
    const next: JiraIssue[] = [];
    for (const { key } of current) {
      for (const target of outgoing.get(key) ?? []) {
        const issue = byKey.get(target);
        if (!issue) continue;
        const remaining = unresolved.get(target)! - 1;
        unresolved.set(target, remaining);
        if (remaining === 0) next.push(issue);
      }
    }
    current = next.sort(compareIssues);
  }
  return waves;
}

function downstreamImpact(issues: ReadonlyMap<string, JiraIssue>, outgoing: Successors, scopeKeys: ReadonlySet<string>) {
  const bottlenecks: DependencyAnalysis['bottlenecks'] = [];
  const externalBlockers = new Map<string, string[]>();
  for (const [key, targets] of outgoing) {
    const issue = issues.get(key);
    const external = !scopeKeys.has(key);
    let direct = 0;
    let downstream = 0;
    for (const target of targets) {
      if (target !== key && scopeKeys.has(target)) direct++;
    }
    for (const target of reachable(outgoing, [key])) {
      if (target === key || !scopeKeys.has(target)) continue;
      downstream++;
      if (external) {
        const blockers = externalBlockers.get(target) ?? [];
        blockers.push(key);
        externalBlockers.set(target, blockers);
      }
    }
    if (issue && downstream) bottlenecks.push({ issue, direct, downstream });
  }
  bottlenecks.sort((left, right) => right.downstream - left.downstream || right.direct - left.direct || compareIssues(left.issue, right.issue));
  for (const blockers of externalBlockers.values()) blockers.sort(compareKeys);
  return { bottlenecks, externalBlockers };
}

type PathStep = { key: string; previous?: string; weight: number; length: number };

function outranks(candidate: PathStep, current?: PathStep): boolean {
  return !current || candidate.weight > current.weight ||
    (candidate.weight === current.weight && candidate.length > current.length);
}

function longestPath(
  waves: JiraIssue[][], prerequisites: Prerequisites, byKey: ReadonlyMap<string, JiraIssue>, partial: boolean,
): CriticalPath | undefined {
  if (!waves.length) return undefined;
  const issues = waves.flat();
  const unit = issues.every(({ storyPoints }) => storyPoints !== undefined && Number.isFinite(storyPoints) && storyPoints >= 0)
    ? 'sp' : 'issues';
  const steps = new Map<string, PathStep>();
  let best: PathStep | undefined;
  for (const issue of issues) {
    let previous: PathStep | undefined;
    for (const key of prerequisites.get(issue.key) ?? []) {
      const step = steps.get(key);
      if (step && outranks(step, previous)) previous = step;
    }
    const step = {
      key: issue.key, previous: previous?.key,
      weight: (previous?.weight ?? 0) + (unit === 'sp' ? issue.storyPoints! : 1),
      length: (previous?.length ?? 0) + 1,
    };
    steps.set(issue.key, step);
    if (outranks(step, best)) best = step;
  }
  const path: JiraIssue[] = [];
  for (let step = best; step; step = step.previous ? steps.get(step.previous) : undefined) {
    path.push(byKey.get(step.key)!);
  }
  return { issues: path.reverse(), weight: best!.weight, unit, partial };
}
