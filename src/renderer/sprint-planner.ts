import type { JiraIssue } from '../shared/contracts.js';
import type { DependencyAnalysis } from './dependency-analysis.js';
import { statusTone } from './graph-model.js';

export type SprintStrategy = 'unblock' | 'priority' | 'fit';

export interface SprintPerson {
  id: string;
  name: string;
  capacity?: number;
}

export interface SprintPlanOptions {
  capacity: number;
  people: readonly SprintPerson[];
  strategy?: SprintStrategy;
}

export interface PlannedIssue {
  issue: JiraIssue;
  points: number;
  wave: number;
  assigneeId?: string;
  assignee?: string;
  suggested: boolean;
}

export interface SkippedIssue {
  issue: JiraIssue;
  reason: 'unestimated' | 'external-blocker' | 'cycle' | 'blocked' | 'team-capacity' | 'person-capacity';
  blockers?: readonly string[];
}

export interface SprintLoad {
  id?: string;
  name?: string;
  points: number;
  count: number;
  capacity?: number;
}

export interface SprintPlan {
  planned: PlannedIssue[];
  skipped: SkippedIssue[];
  loads: SprintLoad[];
  capacity: number;
  used: number;
  remaining: number;
  waveCount: number;
}

type EstimatedIssue = { issue: JiraIssue; points: number; assignee?: { id: string; name: string } };
type PersonLoad = SprintLoad & { waves: Set<number>; fixedDemand: number };

const alphabetical = new Intl.Collator('en', { numeric: true });
const compareKeys = (left: string, right: string) => alphabetical.compare(left, right) || left.localeCompare(right);

function assigneeIdentity(issue: JiraIssue): { id: string; name: string } | undefined {
  const name = issue.assignee?.trim();
  const id = issue.assigneeId?.trim() || (name ? `name:${name}` : undefined);
  return id ? { id, name: name || id } : undefined;
}

export function sprintRoster(issues: readonly JiraIssue[]): Array<{ id: string; name: string }> {
  const people = new Map<string, string>();
  for (const issue of issues) {
    const person = assigneeIdentity(issue);
    if (person) people.set(person.id, person.name);
  }
  return [...people].map(([id, name]) => ({ id, name })).sort(comparePeople);
}

function comparePeople(left: { id?: string; name?: string }, right: { id?: string; name?: string }): number {
  return compareKeys(left.name ?? '', right.name ?? '') || compareKeys(left.id ?? '', right.id ?? '');
}

function validPoints(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function fits(used: number, points: number, capacity: number | undefined): boolean {
  const total = used + points;
  if (!Number.isFinite(total)) return false;
  if (capacity === undefined || total <= capacity) return true;
  return total - capacity <= Number.EPSILON * Math.max(total, capacity) * 4;
}

function priority(issue: JiraIssue): number {
  const name = issue.priority?.trim().toLowerCase();
  if (!name) return 2;
  if (/^(highest|blocker|critical|наивысший|критический|блокирующий)$/u.test(name)) return 4;
  if (/^(high|major|высокий)$/u.test(name)) return 3;
  if (/^(lowest|trivial|наименьший|минимальный)$/u.test(name)) return 0;
  if (/^(low|minor|низкий)$/u.test(name)) return 1;
  return 2;
}

function firstAvailableWave(load: PersonLoad, first: number): number {
  let wave = first;
  while (load.waves.has(wave)) wave++;
  return wave;
}

function choosePerson(people: readonly PersonLoad[], points: number, first: number): { load: PersonLoad; wave: number } | undefined {
  const options = people.filter((load) => fits(load.points, points, load.capacity))
    .map((load) => ({
      load, wave: firstAvailableWave(load, first),
      displaced: Math.max(0, points - Math.max(0, (load.capacity ?? Infinity) - load.points - load.fixedDemand)),
    }));
  options.sort((left, right) => left.displaced - right.displaced || left.wave - right.wave
    || left.load.points - right.load.points || comparePeople(left.load, right.load));
  return options[0];
}

export function planSprint(analysis: DependencyAnalysis, options: SprintPlanOptions): SprintPlan {
  const capacity = validPoints(options.capacity) ? options.capacity : 0;
  const candidates = analysis.openIssues.filter(({ external, isEpic }) => !external && !isEpic);
  const cycles = new Set([...analysis.cycleGroups.flat(), ...analysis.blockedByCycle.map(({ key }) => key)]);
  const impact = new Map(analysis.bottlenecks.map(({ issue, downstream }) => [issue.key, downstream]));
  const loads = new Map<string | undefined, PersonLoad>();
  for (const { id, name, capacity: limit } of options.people) {
    if (id && name && !loads.has(id)) {
      loads.set(id, { id, name, capacity: limit === undefined || validPoints(limit) ? limit : 0,
        points: 0, count: 0, waves: new Set(), fixedDemand: 0 });
    }
  }
  const configuredPeople = [...loads.values()];
  const selected = new Map<string, PlannedIssue>();
  const skipped = new Map<string, SkippedIssue>();
  const unresolved = new Map<string, number>();
  const dependents = new Map<string, EstimatedIssue[]>();
  const ready: EstimatedIssue[] = [];
  let used = 0;

  for (const issue of candidates) {
    const blockers = analysis.prerequisites.get(issue.key) ?? [];
    const externalBlockers = analysis.externalBlockers.get(issue.key);
    if (cycles.has(issue.key)) skipped.set(issue.key, { issue, reason: 'cycle', blockers });
    else if (externalBlockers) skipped.set(issue.key, { issue, reason: 'external-blocker', blockers: externalBlockers });
    else if (!validPoints(issue.storyPoints)) skipped.set(issue.key, { issue, reason: 'unestimated' });
    else {
      const assignee = assigneeIdentity(issue);
      const estimate = { issue, points: issue.storyPoints, assignee };
      const load = assignee && loads.get(assignee.id);
      if (load?.capacity !== undefined && fits(0, estimate.points, load.capacity) && fits(0, estimate.points, capacity)) {
        load.fixedDemand += estimate.points;
      }
      unresolved.set(issue.key, blockers.length);
      if (!blockers.length) ready.push(estimate);
      for (const blocker of blockers) {
        const waiting = dependents.get(blocker) ?? [];
        waiting.push(estimate);
        dependents.set(blocker, waiting);
      }
    }
  }

  // Pop the first choice from the end. Only tasks whose prerequisites were planned enter this queue.
  function compare(left: EstimatedIssue, right: EstimatedIssue): number {
    const byImpact = (impact.get(left.issue.key) ?? 0) - (impact.get(right.issue.key) ?? 0);
    const byPriority = priority(left.issue) - priority(right.issue);
    const byOngoing = Number(statusTone(left.issue) === 'active') - Number(statusTone(right.issue) === 'active');
    const byPoints = left.points - right.points;
    const byKey = compareKeys(right.issue.key, left.issue.key);
    if (options.strategy === 'fit') return byPoints || byImpact || byPriority || byOngoing || byKey;
    if (options.strategy === 'priority') return byPriority || byImpact || byOngoing || -byPoints || byKey;
    return byImpact || byPriority || byOngoing || -byPoints || byKey;
  }

  ready.sort(compare);
  while (ready.length) {
    const { issue, points, assignee } = ready.pop()!;
    let load = loads.get(assignee?.id);
    if (load?.capacity !== undefined && fits(0, points, load.capacity) && fits(0, points, capacity)) {
      load.fixedDemand = Math.max(0, load.fixedDemand - points);
    }
    if (!fits(used, points, capacity)) {
      skipped.set(issue.key, { issue, reason: 'team-capacity' });
      continue;
    }
    const blockers = analysis.prerequisites.get(issue.key) ?? [];
    const firstWave = blockers.reduce((wave, key) => Math.max(wave, selected.get(key)!.wave + 1), 1);
    let wave = firstWave;
    if (assignee) {
      load ??= { ...assignee, points: 0, count: 0, waves: new Set(), fixedDemand: 0 };
      if (!fits(load.points, points, load.capacity)) {
        skipped.set(issue.key, { issue, reason: 'person-capacity' });
        continue;
      }
      wave = firstAvailableWave(load, firstWave);
    } else if (configuredPeople.length) {
      const choice = choosePerson(configuredPeople, points, firstWave);
      if (!choice) {
        skipped.set(issue.key, { issue, reason: 'person-capacity' });
        continue;
      }
      ({ load, wave } = choice);
    } else {
      load ??= { points: 0, count: 0, waves: new Set(), fixedDemand: 0 };
    }
    load.points += points;
    load.count++;
    load.waves.add(wave);
    loads.set(load.id, load);
    used += points;
    selected.set(issue.key, { issue, points, wave, assigneeId: load.id, assignee: assignee?.name ?? load.name, suggested: !assignee && Boolean(load.id) });
    let changed = false;
    for (const dependent of dependents.get(issue.key) ?? []) {
      const key = dependent.issue.key;
      const pending = unresolved.get(key)! - 1;
      unresolved.set(key, pending);
      if (pending === 0) {
        ready.push(dependent);
        changed = true;
      }
    }
    if (changed) ready.sort(compare);
  }

  for (const issue of candidates) {
    if (selected.has(issue.key) || skipped.has(issue.key)) continue;
    const blockers = (analysis.prerequisites.get(issue.key) ?? []).filter((key) => !selected.has(key));
    skipped.set(issue.key, { issue, reason: 'blocked', blockers });
  }

  const planned = [...selected.values()].sort((left, right) => left.wave - right.wave);
  const people = [...loads.values()].sort((left, right) => Number(!left.id) - Number(!right.id) || comparePeople(left, right));
  return {
    planned, skipped: [...skipped.values()].sort((left, right) => compareKeys(left.issue.key, right.issue.key)),
    loads: people.map(({ id, name, points, count, capacity: limit }) => ({ id, name, points, count, capacity: limit })),
    capacity, used, remaining: Math.max(0, capacity - used), waveCount: planned.at(-1)?.wave ?? 0,
  };
}
