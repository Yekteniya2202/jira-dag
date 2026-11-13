import { sprintRoles, type SprintDraftOverride, type SprintRole } from './sprint-draft-planning.js';
import type { LocalStore } from './workspace-state.js';

export interface SprintDraftMember {
  id: string;
  name: string;
  roles: SprintRole[];
  capacity?: number;
  qaCapacity?: number;
}

export interface SprintDraftEntry {
  added: string[];
  removed: string[];
  overrides: Record<string, SprintDraftOverride>;
  epicPriorities: string[];
  availability: Record<string, number>;
  capacity?: number;
  qaCapacity?: number;
  reservePercent?: number;
  goal?: string;
  storyPointsField?: string;
  qaPointsField?: string;
  pinnedIssueKeys?: string[];
}

export interface SprintDraftState {
  projectKey?: string;
  boardId?: string;
  sprintId?: string;
  teams: Record<string, SprintDraftMember[]>;
  drafts: Record<string, SprintDraftEntry>;
}

export const emptySprintDraftState: SprintDraftState = { teams: {}, drafts: {} };
export const emptySprintDraftEntry: SprintDraftEntry = {
  added: [], removed: [], overrides: {}, epicPriorities: [], availability: {},
};

const issueKey = /^[A-Z][A-Z0-9_]*-\d+$/;
const agileId = /^[1-9]\d{0,15}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 320): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined;
}

function id(value: unknown): string | undefined {
  const result = text(value, 16);
  return result && (result === 'demo' || (agileId.test(result) && Number.isSafeInteger(Number(result)))) ? result : undefined;
}

function number(value: unknown, max = 100_000): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

function keys(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.slice(0, 1500)
    .filter((item): item is string => typeof item === 'string' && item.length <= 128 && issueKey.test(item)))] : [];
}

function role(value: unknown): SprintRole | undefined {
  return sprintRoles.find((item) => item === value);
}

function members(value: unknown): SprintDraftMember[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 250).flatMap((item) => {
    const row = record(item);
    const id = text(row.id);
    const name = text(row.name, 256);
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, roles: Array.isArray(row.roles) ? [...new Set(row.roles.flatMap((value) => role(value) ?? []))] : [],
      capacity: number(row.capacity), qaCapacity: number(row.qaCapacity) }];
  });
}

function entry(value: unknown): SprintDraftEntry {
  const row = record(value);
  const removed = keys(row.removed);
  const removing = new Set(removed);
  const overrides = Object.fromEntries(Object.entries(record(row.overrides)).slice(0, 1500).flatMap(([key, value]) => {
    if (!issueKey.test(key)) return [];
    const fields = record(value);
    const override: SprintDraftOverride = {
      role: role(fields.role), assigneeId: text(fields.assigneeId), qaAssigneeId: text(fields.qaAssigneeId),
      estimate: number(fields.estimate), qaEstimate: number(fields.qaEstimate),
      qaRequired: typeof fields.qaRequired === 'boolean' ? fields.qaRequired : undefined,
    };
    return Object.values(override).some((field) => field !== undefined) ? [[key, override]] : [];
  }));
  return {
    added: keys(row.added).filter((key) => !removing.has(key)), removed, overrides,
    epicPriorities: keys(row.epicPriorities), pinnedIssueKeys: keys(row.pinnedIssueKeys),
    availability: Object.fromEntries(Object.entries(record(row.availability)).slice(0, 250).flatMap(([id, value]) => {
      const percentage = number(value, 100);
      return text(id) && percentage !== undefined ? [[id, percentage]] : [];
    })),
    capacity: number(row.capacity), qaCapacity: number(row.qaCapacity), reservePercent: number(row.reservePercent, 100),
    goal: typeof row.goal === 'string' && row.goal.length <= 1000 ? row.goal : undefined,
    storyPointsField: text(row.storyPointsField, 128), qaPointsField: text(row.qaPointsField, 128),
  };
}

function storageKey(scope: string): string {
  return `jira-dag.sprint-drafts.v1:${scope}`;
}

export function readSprintDraftState(store: LocalStore, scope: string): SprintDraftState {
  try {
    const stored = store.getItem(storageKey(scope));
    const data = record(stored ? JSON.parse(stored) : undefined);
    const boardId = id(data.boardId);
    return {
      projectKey: text(data.projectKey, 128), boardId, sprintId: boardId ? id(data.sprintId) : undefined,
      teams: Object.fromEntries(Object.entries(record(data.teams)).slice(-100)
        .flatMap(([key, value]) => id(key) ? [[key, members(value)]] : [])),
      drafts: Object.fromEntries(Object.entries(record(data.drafts)).slice(-100)
        .flatMap(([key, value]) => key.split(':').length === 2 && key.split(':').every(id) ? [[key, entry(value)]] : [])),
    };
  } catch {
    return emptySprintDraftState;
  }
}

export function saveSprintDraftState(store: LocalStore, scope: string, value: SprintDraftState): boolean {
  try {
    store.setItem(storageKey(scope), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
