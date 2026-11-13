import type { JiraGraph, JiraIssue, JiraSprintVelocitySample } from '../shared/contracts.js';
import { analyzeDependencies, type DependencyAnalysis } from './dependency-analysis.js';
import { statusTone } from './graph-model.js';

export const sprintRoles = ['BE', 'FE', 'QA', 'SA'] as const;
export type SprintRole = typeof sprintRoles[number];

export interface SprintDraftPerson {
  id: string;
  name: string;
  roles: readonly SprintRole[];
  capacity?: number;
  qaCapacity?: number;
  availabilityPercent?: number;
}

export interface SprintDraftOverride {
  role?: SprintRole;
  assigneeId?: string;
  estimate?: number;
  qaEstimate?: number;
  qaAssigneeId?: string;
  qaRequired?: boolean;
}

export interface SprintDraftOptions {
  selectedKeys: readonly string[];
  backlogKeys?: readonly string[];
  roster: readonly SprintDraftPerson[];
  epicPriorities?: readonly string[];
  overrides?: Readonly<Record<string, SprintDraftOverride>>;
  history?: readonly JiraSprintVelocitySample[];
  capacity?: number;
  qaCapacity?: number;
  reservePercent?: number;
}

export interface SprintDraftStage {
  kind: 'work' | 'qa';
  role?: SprintRole;
  points?: number;
  assigneeId?: string;
  assignee?: string;
  wave?: number;
}

export interface SprintDraftItem {
  issue: JiraIssue;
  source: 'selected' | 'recommended';
  stages: SprintDraftStage[];
  blockers: string[];
  coveredBy?: string;
}

export type SprintDraftSkipReason = 'unestimated' | 'qa-unestimated' | 'unknown-role' | 'unknown-assignee' | 'role-mismatch' |
  'external-blocker' | 'cycle' | 'blocked' | 'team-capacity' | 'person-capacity' | 'qa-capacity' | 'capacity-unknown';

export interface SprintDraftSkipped {
  issue: JiraIssue;
  reason: SprintDraftSkipReason;
  blockers?: readonly string[];
}

export interface SprintDraftRisk {
  kind: SprintDraftSkipReason | 'missing-selected' | 'over-capacity' | 'graph-incomplete' | 'history-incomplete' | 'subtask-with-parent';
  issueKey?: string;
  assigneeId?: string;
  blockers?: readonly string[];
  role?: SprintRole;
}

export interface SprintDraftLoad {
  id: string;
  name: string;
  roles: readonly SprintRole[];
  capacity?: number;
  qaCapacity?: number;
  used: number;
  qaUsed: number;
  remaining?: number;
  qaRemaining?: number;
}

export interface SprintDraftRoleLoad {
  role: SprintRole;
  people: number;
  used: number;
  qaUsed: number;
  capacity?: number;
  qaCapacity?: number;
}

type VelocityAverage = { averagePoints?: number; averageQaPoints?: number };
export interface SprintDraftVelocity extends VelocityAverage {
  sampleCount: number;
  people: ReadonlyMap<string, VelocityAverage>;
}

export interface SprintDraftPlan {
  items: SprintDraftItem[];
  skipped: SprintDraftSkipped[];
  loads: SprintDraftLoad[];
  roleLoads: SprintDraftRoleLoad[];
  risks: SprintDraftRisk[];
  velocity: SprintDraftVelocity;
  capacity?: number;
  qaCapacity?: number;
  used: number;
  qaUsed: number;
  remaining?: number;
  qaRemaining?: number;
}

type Person = SprintDraftPerson & { availability: number };
type Demand = SprintDraftStage & { fixedId?: string; fixedName?: string };
type Entry = { item: SprintDraftItem; demands: Demand[] };
type StageResult = { stage: SprintDraftStage; reason?: SprintDraftSkipReason };
type Workload = { work: number; qa: number; count: number };
type PlanLoad = { work: number; qa: number; people: Map<string, Workload> };
type BlockerIssue = Pick<SprintDraftSkipped, 'reason' | 'blockers'>;
type Prerequisites = ReadonlyMap<string, readonly string[]>;

const alphabetical = new Intl.Collator('en', { numeric: true });
const compareKeys = (left: string, right: string) => alphabetical.compare(left, right) || left.localeCompare(right, 'en');
const roleAliases: Record<SprintRole, readonly string[]> = {
  BE: ['be', 'backend', 'back-end', 'бэкенд', 'бэкэнд'],
  FE: ['fe', 'frontend', 'front-end', 'фронтенд', 'фронтэнд'],
  QA: ['qa', 'test', 'testing', 'тестирование'],
  SA: ['sa', 'system-analyst', 'system-analysis', 'analysis', 'аналитика'],
};

function roleToken(value: string): string {
  return value.trim().toLowerCase().replace(/^(?:role|роль)[-_: /]+/u, '').replace(/[ _]+/gu, '-');
}

export function inferSprintRole(issue: JiraIssue): SprintRole | undefined {
  const tags = (issue.labels ?? []).map(roleToken);
  const roles = sprintRoles.filter((role) => roleAliases[role].some((alias) => tags.includes(alias)));
  if (roles.length === 1) return roles[0];
  if (roles.length > 1) return undefined;
  const prefix = /^\s*\[([^\]]+)\]/u.exec(issue.summary)?.[1];
  return prefix ? sprintRoles.find((role) => roleAliases[role].includes(roleToken(prefix))) : undefined;
}

function validPoints(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function percent(value: number | undefined, fallback: number): number {
  return Math.min(100, validPoints(value) ?? fallback) / 100;
}

function average(values: readonly (number | undefined)[]): number | undefined {
  const known = values.flatMap((value) => validPoints(value) ?? []);
  if (known.length) return known.reduce((sum, value) => sum + value / known.length, 0);
}

export function sprintDraftVelocity(history: readonly JiraSprintVelocitySample[]): SprintDraftVelocity {
  const unique = [...new Map(history.map((sample) => [sample.sprint.id, sample])).values()];
  const date = ({ sprint }: JiraSprintVelocitySample) => Date.parse(sprint.completeDate ?? '');
  if (unique.every((sample) => Number.isFinite(date(sample)))) unique.sort((left, right) => date(right) - date(left));
  const recent = unique.slice(0, 3);
  const samples = recent.filter(({ complete }) => complete);
  const personSamples = new Map<string, Array<{ storyPoints?: number; qaPoints?: number }>>();
  for (const sample of samples) {
    if (sample.peopleComplete === false) continue;
    for (const person of new Map((sample.people ?? []).map((person) => [person.id, person])).values()) {
      const rows = personSamples.get(person.id) ?? [];
      rows.push({
        storyPoints: sample.storyPointsComplete === false ? undefined : person.storyPoints,
        qaPoints: sample.qaPointsComplete === false ? undefined : person.qaPoints,
      });
      personSamples.set(person.id, rows);
    }
  }
  return {
    sampleCount: samples.length,
    averagePoints: average(samples.map(({ completedStoryPoints, storyPointsComplete }) =>
      storyPointsComplete === false ? undefined : completedStoryPoints)),
    averageQaPoints: average(samples.map(({ completedQaPoints, qaPointsComplete }) =>
      qaPointsComplete === false ? undefined : completedQaPoints)),
    people: new Map([...personSamples].map(([id, rows]) => [id, {
      averagePoints: average(rows.map(({ storyPoints }) => storyPoints)),
      averageQaPoints: average(rows.map(({ qaPoints }) => qaPoints)),
    }])),
  };
}

function rosterWithAvailability(roster: readonly SprintDraftPerson[], velocity: SprintDraftVelocity): Person[] {
  return [...new Map(roster.filter(({ id, name }) => id && name).map((person) => [person.id, person])).values()].map((person) => {
    const evidence = velocity.people.get(person.id);
    const availability = percent(person.availabilityPercent, 100);
    const work = validPoints(person.capacity) ?? evidence?.averagePoints;
    const qa = validPoints(person.qaCapacity) ?? evidence?.averageQaPoints;
    return {
      ...person,
      roles: sprintRoles.filter((role) => person.roles.includes(role)),
      availability,
      capacity: availability === 0 ? 0 : work === undefined ? undefined : work * availability,
      qaCapacity: availability === 0 ? 0 : qa === undefined ? undefined : qa * availability,
    };
  });
}

function sumCapacities(people: readonly Person[], kind: Demand['kind']): number | undefined {
  const limits = people.map((person) => kind === 'qa' ? person.qaCapacity : person.capacity);
  if (limits.length && limits.every((limit) => limit !== undefined)) {
    return validPoints(limits.reduce((sum, limit) => sum + limit!, 0));
  }
}

function effectiveCapacity(explicit: number | undefined, observed: number | undefined, available: number | undefined, reserve: number) {
  const baseline = validPoints(explicit) ?? observed ?? available;
  if (baseline === undefined) return undefined;
  return Math.min(baseline * reserve, available ?? Infinity);
}

function demandFor(issue: JiraIssue, override: SprintDraftOverride | undefined, roster: readonly Person[]): Demand[] {
  if (issue.isEpic || statusTone(issue) === 'done') return [];
  const jiraPerson = issue.assigneeId || (issue.assignee && roster.find(({ name }) => name === issue.assignee &&
    roster.filter((person) => person.name === name).length === 1)?.id);
  const workId = override?.assigneeId || jiraPerson || undefined;
  const assignee = roster.find(({ id }) => id === workId);
  const role = override?.role ?? inferSprintRole(issue) ?? (assignee?.roles.length === 1 ? assignee.roles[0] : undefined);
  const qaPoints = validPoints(override?.qaEstimate ?? issue.qaPoints);
  if (role === 'QA') {
    return [{
      kind: 'qa', role, points: qaPoints, fixedId: override?.qaAssigneeId || workId, fixedName: issue.assignee,
    }];
  }
  const stages: Demand[] = [{
    kind: 'work', role, points: validPoints(override?.estimate ?? issue.storyPoints), fixedId: workId, fixedName: issue.assignee,
  }];
  const qaRequired = override?.qaRequired ?? (qaPoints !== undefined ||
    (issue.labels ?? []).some((label) => /^(?:needs-qa|qa-required|requires-qa)$/u.test(roleToken(label))));
  if (qaRequired) stages.push({ kind: 'qa', role: 'QA', points: qaPoints, fixedId: override?.qaAssigneeId });
  return stages;
}

function assignmentProblem(demand: Demand, roster: readonly Person[]): SprintDraftSkipReason | undefined {
  const { kind, role, points, fixedId, fixedName } = demand;
  if (!role) return 'unknown-role';
  if (points === undefined) return kind === 'qa' ? 'qa-unestimated' : 'unestimated';
  if (fixedId || fixedName) {
    const fixed = roster.find(({ id }) => id === fixedId);
    if (!fixed) return 'unknown-assignee';
    if (!fixed.roles.includes(role)) return 'role-mismatch';
  } else if (!roster.some(({ roles }) => roles.includes(role))) {
    return 'unknown-assignee';
  }
}

function fits(used: number, points: number, limit: number): boolean {
  const total = used + points;
  return Number.isFinite(total) && (total <= limit || total - limit <= Number.EPSILON * Math.max(total, limit) * 4);
}

const blankWorkload: Workload = { work: 0, qa: 0, count: 0 };

function assignStage(demand: Demand, roster: readonly Person[], load: PlanLoad, limit?: number): StageResult {
  const { kind, role, points, fixedId, fixedName } = demand;
  const stage = { kind, role, points, assigneeId: fixedId, assignee: fixedName };
  const fixed = fixedId ? roster.find(({ id }) => id === fixedId) : undefined;
  if (fixed) stage.assignee = fixed.name;
  const problem = assignmentProblem(demand, roster);
  if (problem) return { stage, reason: problem };
  const matching = fixed ? [fixed] : roster.filter(({ roles }) => roles.includes(role!));
  const effort = points!;
  if (limit === undefined) return { stage, reason: 'capacity-unknown' };
  if (!fits(load[kind], effort, limit)) return { stage, reason: kind === 'qa' ? 'qa-capacity' : 'team-capacity' };
  const available = matching.map((person) => {
    const usage = load.people.get(person.id) ?? blankWorkload;
    const personalLimit = kind === 'qa' ? person.qaCapacity : person.capacity;
    return { person, usage, limit: personalLimit ?? (person.availability === 1 ? limit : undefined) };
  });
  const choices = available.filter((row) => row.person.availability > 0 && row.limit !== undefined &&
    fits(row.usage[kind], effort, row.limit));
  choices.sort((left, right) => left.usage.count - right.usage.count ||
    left.usage[kind] / (left.limit || 1) - right.usage[kind] / (right.limit || 1) ||
    compareKeys(left.person.name, right.person.name) || compareKeys(left.person.id, right.person.id));
  const person = choices[0]?.person;
  if (person) return { stage: { ...stage, assigneeId: person.id, assignee: person.name } };
  const reason = available.some((row) => row.person.availability > 0 && row.limit === undefined)
    ? 'capacity-unknown' : kind === 'qa' ? 'qa-capacity' : 'person-capacity';
  return { stage, reason };
}

function countStage(load: PlanLoad, stage: SprintDraftStage) {
  const { kind, points, assigneeId } = stage;
  load[kind] += points ?? 0;
  if (!assigneeId) return;
  const person = load.people.get(assigneeId) ?? blankWorkload;
  load.people.set(assigneeId, { ...person, [kind]: person[kind] + (points ?? 0), count: person.count + 1 });
}

function priority(issue: JiraIssue): number {
  const name = issue.priority?.trim().toLowerCase() ?? '';
  if (/^(highest|blocker|critical|наивысший|критический|блокирующий)$/u.test(name)) return 4;
  if (/^(high|major|высокий)$/u.test(name)) return 3;
  if (/^(low|minor|низкий)$/u.test(name)) return 1;
  if (/^(lowest|trivial|наименьший|минимальный)$/u.test(name)) return 0;
  return 2;
}

function candidateOrder(epicPriorities: readonly string[], impact: ReadonlyMap<string, number>) {
  const ranks = new Map(epicPriorities.map((key, index) => [key, index]));
  return (left: JiraIssue, right: JiraIssue) => {
    const byEpic = (ranks.get(left.epicKey ?? '') ?? ranks.size) - (ranks.get(right.epicKey ?? '') ?? ranks.size);
    const byPriority = priority(right) - priority(left);
    const byImpact = (impact.get(right.key) ?? 0) - (impact.get(left.key) ?? 0);
    return byEpic || byPriority || byImpact || Number(statusTone(right) === 'active') - Number(statusTone(left) === 'active') ||
      compareKeys(left.key, right.key);
  };
}

function structuralRisks(analysis: DependencyAnalysis, entries: ReadonlyMap<string, Entry>) {
  const cycles = new Set([...analysis.cycleGroups.flat(), ...analysis.blockedByCycle.map(({ key }) => key)]);
  const blockers = new Map<string, BlockerIssue>();
  for (const key of entries.keys()) {
    const external = analysis.externalBlockers.get(key);
    if (cycles.has(key)) blockers.set(key, { reason: 'cycle', blockers: analysis.prerequisites.get(key) });
    else if (external?.length) blockers.set(key, { reason: 'external-blocker', blockers: external });
  }
  return {
    blockers,
    prerequisites: analysis.prerequisites,
    impact: new Map(analysis.bottlenecks.map(({ issue, downstream }) => [issue.key, downstream])),
  };
}

function dependencyPackage(
  root: string, entries: ReadonlyMap<string, Entry>, selected: ReadonlySet<string>, completed: ReadonlySet<string>,
  prerequisites: Prerequisites, invalid: ReadonlyMap<string, BlockerIssue>,
): { keys: string[]; failure?: BlockerIssue } {
  const pending = [root];
  const visited = new Set<string>();
  const keys: string[] = [];
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key) || completed.has(key)) continue;
    visited.add(key);
    const reason = invalid.get(key);
    if (reason) return { keys: [], failure: key === root ? reason : { reason: 'blocked', blockers: [key] } };
    const entry = entries.get(key);
    if (!entry || (!entry.demands.length && !entry.item.coveredBy)) return { keys: [], failure: { reason: 'blocked', blockers: [key] } };
    if (!selected.has(key)) keys.push(key);
    pending.push(...(prerequisites.get(key) ?? []));
  }
  return { keys };
}

function schedule(items: readonly SprintDraftItem[], prerequisites: Prerequisites, invalid: ReadonlyMap<string, BlockerIssue>) {
  const scheduled = new Map<string, number>();
  const waiting = new Map(items.filter(({ stages, coveredBy, issue }) => (stages.length || coveredBy) && !invalid.has(issue.key))
    .map((item) => [item.issue.key, item]));
  const availability = new Map<string, Set<number>>();
  const blocked = new Map<string, string[]>();
  let progressed = true;
  while (progressed && waiting.size) {
    progressed = false;
    for (const [key, item] of waiting) {
      const blockers = (prerequisites.get(key) ?? []).filter((blocker) => !scheduled.has(blocker));
      if (blockers.length) {
        blocked.set(key, blockers);
        continue;
      }
      let wave = Math.max(0, ...(prerequisites.get(key) ?? []).map((blocker) => scheduled.get(blocker)!));
      for (const stage of item.stages) {
        const occupied = stage.assigneeId ? availability.get(stage.assigneeId) ?? new Set<number>() : new Set<number>();
        wave++;
        while (occupied.has(wave)) wave++;
        occupied.add(wave);
        if (stage.assigneeId) availability.set(stage.assigneeId, occupied);
        stage.wave = wave;
      }
      scheduled.set(key, wave);
      waiting.delete(key);
      blocked.delete(key);
      progressed = true;
    }
  }
  for (const item of items) {
    item.blockers = [...(invalid.get(item.issue.key)?.blockers ?? blocked.get(item.issue.key) ?? [])];
  }
  return blocked;
}

function remaining(limit: number | undefined, used: number): number | undefined {
  return limit === undefined ? undefined : Math.max(0, limit - used);
}

export function planSprintDraft(graph: JiraGraph, options: SprintDraftOptions, analysis = analyzeDependencies(graph)): SprintDraftPlan {
  const velocity = sprintDraftVelocity(options.history ?? []);
  const roster = rosterWithAvailability(options.roster, velocity);
  const reserve = 1 - percent(options.reservePercent, 0);
  const workPeople = roster.filter(({ roles }) => roles.some((role) => role !== 'QA'));
  const qaPeople = roster.filter(({ roles }) => roles.includes('QA'));
  const capacity = effectiveCapacity(options.capacity, velocity.averagePoints, sumCapacities(workPeople, 'work'), reserve);
  const qaCapacity = effectiveCapacity(options.qaCapacity, velocity.averageQaPoints, sumCapacities(qaPeople, 'qa'), reserve);
  const limits = { work: capacity, qa: qaCapacity };
  const selectedKeys = new Set(options.selectedKeys);
  const backlogKeys = options.backlogKeys && new Set(options.backlogKeys);
  const allIssues = new Map(graph.issues.map((issue) => [issue.key, issue]));
  const entries = new Map<string, Entry>();
  for (const issue of allIssues.values()) {
    const selected = selectedKeys.has(issue.key);
    if (!selected && (issue.external || issue.isEpic || issue.isSubtask || statusTone(issue) === 'done' ||
      (backlogKeys && !backlogKeys.has(issue.key)))) continue;
    entries.set(issue.key, {
      item: { issue, source: selected ? 'selected' : 'recommended', stages: [], blockers: [] },
      demands: demandFor(issue, options.overrides?.[issue.key], roster),
    });
  }
  const risks: SprintDraftRisk[] = [];
  if (graph.warnings.length) risks.push({ kind: 'graph-incomplete' });
  if (options.history && velocity.sampleCount < 3) risks.push({ kind: 'history-incomplete' });
  for (const key of selectedKeys) {
    if (!entries.has(key)) risks.push({ kind: 'missing-selected', issueKey: key });
  }
  for (const { item, demands } of entries.values()) {
    const { issue } = item;
    if (!issue.isSubtask || !issue.parentKey || !selectedKeys.has(issue.parentKey) || !demands.length) continue;
    const parent = entries.get(issue.parentKey);
    const override = options.overrides?.[issue.key];
    if (!parent || override?.estimate !== undefined || override?.qaEstimate !== undefined ||
      !demands.every(({ kind }) => parent.demands.some((stage) => stage.kind === kind && stage.points !== undefined))) continue;
    item.coveredBy = issue.parentKey;
    demands.length = 0;
    risks.push({ kind: 'subtask-with-parent', issueKey: issue.key, blockers: [issue.parentKey] });
  }
  const { blockers: invalid, prerequisites, impact } = structuralRisks(analysis, entries);
  for (const [key, { item, demands }] of entries) {
    if (item.source === 'selected' || invalid.has(key)) continue;
    const reason = demands.map((demand) => assignmentProblem(demand, roster)).find(Boolean);
    if (reason) invalid.set(key, { reason });
  }
  const compare = candidateOrder(options.epicPriorities ?? [], impact);
  const ordered = [...entries.values()].sort((left, right) => compare(left.item.issue, right.item.issue));
  const items = ordered.filter(({ item }) => item.source === 'selected').map(({ item }) => item);
  let load: PlanLoad = { work: 0, qa: 0, people: new Map() };
  const skipped = new Map<string, SprintDraftSkipped>();
  const included = new Set(items.map(({ issue }) => issue.key));
  const done = new Set([...allIssues.values()].filter((issue) => statusTone(issue) === 'done').map(({ key }) => key));

  const selectedDemands = items.flatMap((item) => (entries.get(item.issue.key)?.demands ?? []).map((demand, index) =>
    ({ item, demand, index }))).sort((left, right) => Number(Boolean(right.demand.fixedId)) - Number(Boolean(left.demand.fixedId)));
  for (const { item, demand, index } of selectedDemands) {
    const { stage, reason } = assignStage(demand, roster, load, limits[demand.kind]);
    item.stages[index] = stage;
    countStage(load, stage);
    if (reason) {
      const issueKey = item.issue.key;
      risks.push({ kind: reason, issueKey, assigneeId: stage.assigneeId, role: stage.role });
      if (!invalid.has(issueKey)) invalid.set(issueKey, { reason });
    }
  }
  if ((capacity !== undefined && !fits(0, load.work, capacity)) ||
    (qaCapacity !== undefined && !fits(0, load.qa, qaCapacity))) risks.push({ kind: 'over-capacity' });

  function recommend(key: string): BlockerIssue | undefined {
    const { keys, failure } = dependencyPackage(key, entries, included, done, prerequisites, invalid);
    if (failure || !keys.length) return failure;
    const proposed = keys.map((candidate) => entries.get(candidate)!);
    const trial = { ...load, people: new Map(load.people) };
    const stages = new Map(proposed.map(({ item }) => [item.issue.key, [] as SprintDraftStage[]]));
    const demands = proposed.flatMap((entry) => entry.demands.map((demand, index) => ({ entry, demand, index })))
      .sort((left, right) => Number(Boolean(right.demand.fixedId)) - Number(Boolean(left.demand.fixedId)));
    for (const { entry, demand, index } of demands) {
      const result = assignStage(demand, roster, trial, limits[demand.kind]);
      if (result.reason) return entry.item.issue.key === key ? { reason: result.reason } :
        { reason: 'blocked', blockers: [entry.item.issue.key] };
      stages.get(entry.item.issue.key)![index] = result.stage;
      countStage(trial, result.stage);
    }
    load = trial;
    for (const { item } of proposed) {
      included.add(item.issue.key);
      item.stages = stages.get(item.issue.key)!;
      items.push(item);
      skipped.delete(item.issue.key);
    }
  }

  for (const { issue } of items.slice()) recommend(issue.key);
  for (const { item } of ordered) {
    const key = item.issue.key;
    if (included.has(key)) continue;
    const failure = recommend(key);
    if (failure) skipped.set(key, { issue: item.issue, ...failure });
  }
  items.sort((left, right) => compare(left.issue, right.issue));
  const unscheduled = schedule(items, prerequisites, invalid);
  for (const item of items) {
    if (item.source !== 'selected') continue;
    const issueKey = item.issue.key;
    const problem = invalid.get(issueKey);
    if (problem?.blockers) risks.push({ kind: problem.reason, issueKey, blockers: problem.blockers });
    else if (unscheduled.has(issueKey)) risks.push({ kind: 'blocked', issueKey, blockers: item.blockers });
  }
  const loads = roster.map(({ id, name, roles, capacity, qaCapacity }): SprintDraftLoad => {
    const usage = load.people.get(id) ?? blankWorkload;
    return { id, name, roles, capacity, qaCapacity, used: usage.work, qaUsed: usage.qa,
      remaining: remaining(capacity, usage.work), qaRemaining: remaining(qaCapacity, usage.qa) };
  });
  const roleLoads = sprintRoles.map((role): SprintDraftRoleLoad => {
    const people = roster.filter(({ roles }) => roles.includes(role));
    const stages = items.flatMap((item) => item.stages.filter((stage) => stage.role === role));
    const used = stages.reduce((sum, stage) => sum + (stage.kind === 'work' ? stage.points ?? 0 : 0), 0);
    const qaUsed = stages.reduce((sum, stage) => sum + (stage.kind === 'qa' ? stage.points ?? 0 : 0), 0);
    return { role, people: people.length, used, qaUsed,
      capacity: role === 'QA' ? undefined : sumCapacities(people, 'work'),
      qaCapacity: role === 'QA' ? sumCapacities(people, 'qa') : undefined };
  });
  return {
    items, skipped: [...skipped.values()], risks, velocity, loads, roleLoads, capacity, qaCapacity, used: load.work, qaUsed: load.qa,
    remaining: remaining(capacity, load.work), qaRemaining: remaining(qaCapacity, load.qa),
  };
}
