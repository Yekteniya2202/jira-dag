import type { JiraConnection, JiraEdition } from '../shared/contracts.js';
import { graphFacets, type GraphFilters } from './filter-model.js';
import type { GroupMode } from './graph-layout.js';
import type { Direction, GraphPosition } from './graph-model.js';

export const refreshIntervals = [1, 5, 10, 15] as const;
export type RefreshMinutes = typeof refreshIntervals[number];
export type StoredViewport = GraphPosition & { zoom: number };

export interface QueryDraft {
  baseJql: string;
  projectKey: string;
  facets: GraphFilters['facets'];
  depth: number;
  storyField: string;
}

export interface AppliedQuery {
  jql: string;
  depth: number;
  storyField: string;
  sprintIds: string[];
}

export interface TabSnapshot {
  draft: QueryDraft;
  applied?: AppliedQuery;
  includedKeys: string[];
  filters: GraphFilters;
  groupMode: GroupMode;
  fields: Record<'points' | 'assignee' | 'priority' | 'labels' | 'dueDate' | 'estimate', boolean>;
  showEdgePoints: boolean;
  focusMode: 'all' | 'connected' | 'upstream' | 'downstream';
  direction: Direction;
  selectedKey?: string;
  selectedEdge?: string;
  leftWidth: number;
  rightWidth: number;
  leftHidden: boolean;
  rightHidden: boolean;
  viewport?: StoredViewport;
  manualPositions: Record<string, GraphPosition>;
  autoRefresh: boolean;
  refreshMinutes: RefreshMinutes;
}

export type WorkspaceTab = { id: number; query?: string; project?: string; state?: Partial<TabSnapshot> };
export type SavedFilter = { id: string; name: string; draft: QueryDraft };
export type StoredWorkspace = { activeTab: number; tabs: WorkspaceTab[] };
export type LocalStore = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

const groupModes = ['none', 'hierarchy', 'project', 'status', 'assignee', 'sprint', 'release', 'priority', 'level', 'open-level'] as const;
const fieldNames = ['points', 'assignee', 'priority', 'labels', 'dueDate', 'estimate'] as const;
const issueKey = /^[A-Z][A-Z0-9_]*-\d+$/i;

export function workspaceScope(connection: JiraConnection | undefined, edition: JiraEdition): string {
  return connection ? JSON.stringify([edition, connection.url, connection.profileId ?? connection.displayName]) : 'demo';
}

function storageKey(kind: 'workspace' | 'filters', scope: string): string {
  return `jira-dag.${kind}.v1:${scope}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 8192): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function texts(value: unknown, max = 1500): string[] {
  return Array.isArray(value) ? value.slice(0, max).flatMap((item) => text(item, 256) ?? []) : [];
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function oneOf<T extends string | number>(options: readonly T[], value: unknown): T | undefined {
  return options.find((option) => option === value);
}

function facets(value: unknown): GraphFilters['facets'] {
  const data = record(value);
  return Object.fromEntries(graphFacets.flatMap((facet) => {
    const values = texts(data[facet]);
    return values.length ? [[facet, values]] : [];
  }));
}

function queryDraft(value: unknown): QueryDraft | undefined {
  const data = record(value);
  const baseJql = text(data.baseJql);
  if (baseJql === undefined) return undefined;
  return {
    baseJql, projectKey: text(data.projectKey, 128) ?? '', facets: facets(data.facets),
    depth: integer(data.depth, 0, 3) ?? 0, storyField: text(data.storyField, 128) ?? '',
  };
}

function appliedQuery(value: unknown): AppliedQuery | undefined {
  const data = record(value);
  const jql = text(data.jql);
  if (!jql?.trim()) return undefined;
  return {
    jql, depth: integer(data.depth, 0, 3) ?? 0, storyField: text(data.storyField, 128) ?? '',
    sprintIds: texts(data.sprintIds).filter((id) => /^\d+$/.test(id)),
  };
}

function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : undefined;
}

function position(value: unknown): GraphPosition | undefined {
  const data = record(value);
  const x = coordinate(data.x);
  const y = coordinate(data.y);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function tabSnapshot(value: unknown): Partial<TabSnapshot> | undefined {
  const data = record(value);
  const draft = queryDraft(data.draft);
  if (!draft) return undefined;
  const filters = record(data.filters);
  const fields = record(data.fields);
  const viewport = position(data.viewport);
  const zoom = coordinate(record(data.viewport).zoom);
  return {
    draft, applied: appliedQuery(data.applied), includedKeys: texts(data.includedKeys).filter((key) => issueKey.test(key)),
    filters: {
      search: text(filters.search) ?? '', facets: facets(filters.facets),
      edgeTypes: Array.isArray(filters.edgeTypes) ? texts(filters.edgeTypes) : undefined,
      hideExternal: filters.hideExternal === true, hideIsolated: filters.hideIsolated === true,
      crossProject: filters.crossProject === true, crossEpic: filters.crossEpic === true,
    },
    groupMode: oneOf(groupModes, data.groupMode),
    fields: Object.fromEntries(fieldNames.map((field) => [field, fields[field] === true])) as TabSnapshot['fields'],
    showEdgePoints: data.showEdgePoints === true,
    focusMode: oneOf(['all', 'connected', 'upstream', 'downstream'] as const, data.focusMode),
    direction: oneOf(['LR', 'TB'] as const, data.direction),
    selectedKey: text(data.selectedKey, 128), selectedEdge: text(data.selectedEdge, 256),
    leftWidth: integer(data.leftWidth, 170, 560), rightWidth: integer(data.rightWidth, 170, 560),
    leftHidden: data.leftHidden === true, rightHidden: data.rightHidden === true,
    viewport: viewport && zoom !== undefined && zoom >= 0.07 && zoom <= 2 ? { ...viewport, zoom } : undefined,
    manualPositions: Object.fromEntries(Object.entries(record(data.manualPositions)).slice(0, 1500).flatMap(([key, raw]) => {
      const coordinates = position(raw);
      return issueKey.test(key) && coordinates ? [[key, coordinates]] : [];
    })),
    autoRefresh: data.autoRefresh === true,
    refreshMinutes: oneOf(refreshIntervals, data.refreshMinutes),
  };
}

function read(store: LocalStore, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) as unknown : undefined;
  } catch {
    return undefined;
  }
}

export function readWorkspace(store: LocalStore, scope: string): StoredWorkspace {
  const data = record(read(store, storageKey('workspace', scope)));
  const seen = new Set<number>();
  const tabs = (Array.isArray(data.tabs) ? data.tabs.slice(0, 100) : []).flatMap((value): WorkspaceTab[] => {
    const tab = record(value);
    const id = integer(tab.id, 1, 1_000_000);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, query: text(tab.query), project: text(tab.project, 128), state: tabSnapshot(tab.state) }];
  });
  if (!tabs.length) return { activeTab: 1, tabs: [{ id: 1 }] };
  const activeTab = integer(data.activeTab, 1, 1_000_000);
  return { tabs, activeTab: activeTab && seen.has(activeTab) ? activeTab : tabs[0].id };
}

export function readSavedFilters(store: LocalStore, scope: string): SavedFilter[] {
  const data = read(store, storageKey('filters', scope));
  if (!Array.isArray(data)) return [];
  return data.slice(0, 200).flatMap((value) => {
    const row = record(value);
    const id = text(row.id, 128);
    const name = text(row.name, 80);
    const draft = queryDraft(row.draft);
    return id && name?.trim() && draft ? [{ id, name, draft }] : [];
  });
}

export function saveWorkspace(store: LocalStore, scope: string, workspace: StoredWorkspace): boolean {
  return write(store, storageKey('workspace', scope), workspace);
}

export function saveFilters(store: LocalStore, scope: string, filters: SavedFilter[]): boolean {
  return write(store, storageKey('filters', scope), filters);
}

function write(store: LocalStore, key: string, value: unknown): boolean {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspace(store: LocalStore, scope: string): boolean {
  try {
    store.removeItem(storageKey('workspace', scope));
    return true;
  } catch {
    return false;
  }
}
