import type { JiraEdge, JiraEdition, JiraGraph, JiraIssue, JiraOption, JiraProjectFilterOptions } from '../shared/contracts.js';

export const graphFacets = [
  'statusCategory', 'status', 'project', 'key', 'epic', 'parent', 'subtaskParent', 'issueType', 'hierarchy', 'labels',
  'assignee', 'priority', 'sprints', 'fixVersions', 'estimate', 'dueDate',
] as const;

export type GraphFacet = typeof graphFacets[number];

export interface GraphFilters {
  search: string;
  facets: Partial<Record<GraphFacet, string[]>>;
  edgeTypes: string[] | undefined;
  hideExternal: boolean;
  hideIsolated: boolean;
  crossProject: boolean;
  crossEpic: boolean;
}

export const emptyGraphFilters: GraphFilters = {
  search: '', facets: {}, edgeTypes: undefined,
  hideExternal: false, hideIsolated: false, crossProject: false, crossEpic: false,
};

export const noFacetValue = '\0';
export const hierarchyEdgeType = 'parent';

export interface FacetOption {
  value: string;
  count: number;
}

type HighlightFilters = Pick<GraphFilters, 'search' | 'facets'>;
type VisibilityFilters = Omit<GraphFilters, keyof HighlightFilters>;

export function hasHighlightFilters(filters: HighlightFilters): boolean {
  return Boolean(filters.search.trim() || Object.values(filters.facets).some((values) => values.length));
}

function statusCategory(issue: JiraIssue): string {
  const category = issue.statusCategory ?? 'new';
  return category === 'in-progress' ? 'indeterminate' : category;
}

function epicKey(issue: JiraIssue): string | undefined {
  return issue.isEpic ? issue.key : issue.epicKey;
}

export function sprintFacetId(value: string): string | undefined {
  return /^id:(\d+)$/.exec(value)?.[1];
}

export function selectedSprintIds(values: readonly string[], issues: readonly JiraIssue[]): string[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const value of values) {
    const id = sprintFacetId(value);
    if (id) ids.add(id);
    else names.add(value.toLowerCase());
  }
  if (names.size) for (const { sprintDetails } of issues) {
    for (const sprint of sprintDetails ?? []) if (names.has(sprint.name.toLowerCase())) ids.add(sprint.id);
  }
  return [...ids];
}

const idJiraFacets = new Set<GraphFacet>(['status', 'issueType', 'sprints', 'fixVersions']);

export function manualJiraFacetValue(facet: GraphFacet, input: string): string {
  const value = input.trim();
  if (!value || /[\x00-\x1F\x7F]/.test(value)) return '';
  if (facet === 'key' || facet === 'epic' || facet === 'parent' || facet === 'subtaskParent') {
    return /^[A-Z][A-Z0-9_]*-\d+$/i.test(value) ? value.toUpperCase() : '';
  }
  return idJiraFacets.has(facet) && /^\d+$/.test(value) ? `id:${value}` : value;
}

export interface ProjectFacetValue {
  value: string;
  name: string;
  label: string;
}

function projectFacetValues(facet: GraphFacet, options: readonly JiraOption[]): ProjectFacetValue[] {
  const names = new Map<string, number>();
  for (const { name } of options) names.set(name, (names.get(name) ?? 0) + 1);
  return options.map(({ id, name }) => {
    const hasNumericId = /^\d+$/.test(id);
    const value = hasNumericId ? `id:${id}` : name;
    const showId = hasNumericId && (facet === 'sprints' || (names.get(name) ?? 0) > 1);
    return { value, name, label: showId ? `${name} · #${id}` : name };
  });
}

export function projectJiraFacetValues(metadata: JiraProjectFilterOptions): Partial<Record<GraphFacet, ProjectFacetValue[]>> {
  return {
    status: projectFacetValues('status', metadata.statuses),
    issueType: projectFacetValues('issueType', metadata.issueTypes),
    fixVersions: projectFacetValues('fixVersions', metadata.versions),
    sprints: projectFacetValues('sprints', metadata.sprints),
  };
}

export function sprintFacetLabels(issues: readonly JiraIssue[]): Map<string, string> {
  return new Map(issues.flatMap(({ sprintDetails }) => (sprintDetails ?? []).map(({ id, name }) => [`id:${id}`, `${name} · #${id}`])));
}

function sprintFacetValues(issue: JiraIssue): string[] {
  const details = issue.sprintDetails ?? [];
  const namesWithIds = new Set(details.map(({ name }) => name));
  return [...details.map(({ id }) => `id:${id}`), ...(issue.sprints ?? []).filter((name) => !namesWithIds.has(name))];
}

export function facetValues(issue: JiraIssue, facet: GraphFacet): string[] {
  switch (facet) {
    case 'statusCategory': return [statusCategory(issue)];
    case 'epic': return [epicKey(issue) ?? noFacetValue];
    case 'parent': return [issue.parentKey ?? noFacetValue];
    case 'subtaskParent': return [issue.isSubtask ? issue.parentKey ?? noFacetValue : noFacetValue];
    case 'hierarchy': return [issue.isSubtask ? 'subtask' : issue.isEpic ? 'epic' : 'issue'];
    case 'estimate': return [issue.storyPoints === undefined ? 'missing' : 'present'];
    case 'dueDate': return [issue.dueDate ? 'present' : 'missing'];
    case 'sprints': {
      const values = sprintFacetValues(issue);
      return values.length ? values : [noFacetValue];
    }
    case 'labels':
    case 'fixVersions': return issue[facet]?.length ? issue[facet] : [noFacetValue];
    default: return [issue[facet] ?? noFacetValue];
  }
}

export function issueFacetOptions(issues: readonly JiraIssue[]): Record<GraphFacet, FacetOption[]> {
  return Object.fromEntries(graphFacets.map((facet) => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      for (const value of new Set(facetValues(issue, facet))) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return [facet, [...counts].map(([value, count]) => ({ value, count }))];
  })) as Record<GraphFacet, FacetOption[]>;
}

export function queryIssueFacetOptions(issues: readonly JiraIssue[], queryIssueKeys?: ReadonlySet<string>): Record<GraphFacet, FacetOption[]> {
  return issueFacetOptions(issues.filter((issue) => queryIssueKeys ? queryIssueKeys.has(issue.key) : !issue.external));
}

export function edgeTypeKey(edge: JiraEdge): string {
  return edge.kind === 'parent' ? hierarchyEdgeType : edge.typeId ?? `label:${edge.label}`;
}

export function edgeFacetOptions(graph: JiraGraph): Array<FacetOption & { label: string }> {
  const types = new Map(graph.linkTypes.map(({ id, name }) => [id, name]));
  const counts = new Map<string, FacetOption & { label: string }>();
  for (const edge of graph.edges) {
    const value = edgeTypeKey(edge);
    const prior = counts.get(value);
    if (prior) {
      prior.count++;
    } else {
      counts.set(value, { value, count: 1, label: types.get(value) ?? edge.label });
    }
  }
  return [...counts.values()];
}

function textMatches(issue: JiraIssue, terms: string[]): boolean {
  if (!terms.length) return true;
  const text = [issue.key, issue.summary, issue.description, ...(issue.labels ?? [])]
    .join(' ').toLowerCase();
  return terms.every((term) => text.includes(term));
}

function crossesBoundary(edge: JiraEdge, first: string | undefined, second: string | undefined): boolean {
  return edge.kind === 'link' && Boolean(first && second && first !== second);
}

export function highlightedIssueKeys(graph: JiraGraph, filters: HighlightFilters): Set<string> | undefined {
  if (!hasHighlightFilters(filters)) return undefined;
  const selectedFacets = graphFacets.flatMap((facet) => {
    const values = filters.facets[facet];
    return values?.length ? [{ facet, values: new Set(values) }] : [];
  });
  const terms = filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = graph.issues.filter((issue) => textMatches(issue, terms) && selectedFacets.every(({ facet, values }) =>
    facetValues(issue, facet).some((value) => values.has(value))));
  return new Set(matching.map(({ key }) => key));
}

export function filterGraph(graph: JiraGraph, filters: VisibilityFilters, alwaysVisible?: ReadonlySet<string>): JiraGraph {
  if (filters.edgeTypes === undefined && !filters.hideExternal && !filters.hideIsolated && !filters.crossProject && !filters.crossEpic) {
    return graph;
  }
  const issues = filters.hideExternal ? graph.issues.filter(({ external, key }) => !external || alwaysVisible?.has(key)) : graph.issues;
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const edgeTypes = filters.edgeTypes && new Set(filters.edgeTypes);
  const edges = graph.edges.filter((edge) => {
    const source = byKey.get(edge.source);
    const target = byKey.get(edge.target);
    return source !== undefined && target !== undefined &&
      (!edgeTypes || edgeTypes.has(edgeTypeKey(edge))) &&
      (!filters.crossProject || crossesBoundary(edge, source.project, target.project)) &&
      (!filters.crossEpic || crossesBoundary(edge, epicKey(source), epicKey(target)));
  });

  if (!filters.hideIsolated) return { ...graph, issues, edges };
  const connected = new Set(edges.flatMap(({ source, target }) => [source, target]));
  return { ...graph, issues: issues.filter(({ key }) => connected.has(key) || alwaysVisible?.has(key)), edges };
}

function jqlLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function splitJqlOrder(query: string): [where: string, orderBy: string] {
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let index = 0; index < query.length; index++) {
    const character = query[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
    } else if (depth === 0 && (character === 'O' || character === 'o') &&
      (index === 0 || /[\s)]/.test(query[index - 1])) && /^order\s+by\b/i.test(query.slice(index))) {
      return [query.slice(0, index).trimEnd(), query.slice(index)];
    }
  }
  return [query, ''];
}

export function appendJqlClauses(jql: string, clauses: readonly string[]): string {
  const additions = clauses.filter(Boolean);
  if (!additions.length) return jql;
  const [where, orderBy] = splitJqlOrder(jql.trim());
  const base = /^[A-Z][A-Z0-9_]*-\d+$/i.test(where) ? `key = ${jqlLiteral(where.toUpperCase())}` : where;
  const body = [...(base ? [`(${base})`] : []), ...additions].join(' AND ');
  return orderBy ? `${body} ${orderBy}` : body;
}

function epicField(edition: JiraEdition): string {
  return edition === 'data-center' ? '"Epic Link"' : 'parentEpic';
}

export function scopeJql(scope: 'project' | 'saved', value: string): string {
  const input = value.trim();
  if (!input || /[\x00-\x1F\x7F]/.test(input)) return '';
  const reference = /^\d+$/.test(input) ? input : jqlLiteral(input);
  return `${scope === 'project' ? 'project' : 'filter'} = ${reference}`;
}

const jiraFields: Partial<Record<GraphFacet, string>> = {
  statusCategory: 'statusCategory', status: 'status', project: 'project', key: 'key', parent: 'parent', issueType: 'issuetype',
  labels: 'labels', assignee: 'assignee', priority: 'priority', sprints: 'sprint', fixVersions: 'fixVersion',
};

const emptyJiraFields = new Set<GraphFacet>(['labels', 'assignee', 'sprints', 'fixVersions']);
const categoryNames: Readonly<Record<string, string | undefined>> = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' };
const hierarchyLevels: Readonly<Record<string, string | undefined>> = { epic: '1', issue: '0', subtask: '-1' };

function anyOf(clauses: string[]): string {
  return clauses.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0] ?? '';
}

function matchJiraValues(field: string, values: string[]): string {
  if (values.length === 1) return `${field} = ${values[0]}`;
  return values.length ? `${field} in (${values.join(', ')})` : '';
}

export function jiraFacetClause(facet: GraphFacet, selected: readonly string[], edition: JiraEdition, storyField?: string): string {
  const values = [...new Set(selected)].filter((value) => value && !/[\x00-\x1F\x7F]/.test(value));
  if (facet === 'dueDate' || facet === 'estimate') {
    const fieldId = /^customfield_(\d+)$/.exec(storyField ?? '')?.[1];
    const field = facet === 'dueDate' ? 'due' : fieldId && `cf[${fieldId}]`;
    if (!field) return '';
    return anyOf(values.flatMap((value) => {
      if (value === 'present') return [`${field} IS NOT EMPTY`];
      return value === 'missing' ? [`${field} IS EMPTY`] : [];
    }));
  }
  if (facet === 'hierarchy') {
    if (edition === 'data-center') return values.includes('subtask') ? 'issuetype in subtaskIssueTypes()' : '';
    return matchJiraValues('hierarchyLevel', values.flatMap((value) => Object.hasOwn(hierarchyLevels, value) ? [hierarchyLevels[value]!] : []));
  }
  if (facet === 'epic') {
    const keys = values.map(jqlLiteral);
    return anyOf([matchJiraValues('key', keys), ...keys.map((key) => `${epicField(edition)} = ${key}`)].filter(Boolean));
  }
  if (facet === 'subtaskParent') {
    const keys = values.map(jqlLiteral);
    return keys.length ? `(${matchJiraValues('key', keys)} OR (${matchJiraValues('parent', keys)} AND issuetype in subtaskIssueTypes()))` : '';
  }
  const field = jiraFields[facet];
  if (!field) return '';
  const references = values.flatMap((value) => {
    if (facet === 'statusCategory') return Object.hasOwn(categoryNames, value) ? [jqlLiteral(categoryNames[value]!)] : [];
    if (idJiraFacets.has(facet)) return [sprintFacetId(value) ?? jqlLiteral(value)];
    return [jqlLiteral(value)];
  });
  const missing = emptyJiraFields.has(facet) && selected.includes(noFacetValue) ? `${field} IS EMPTY` : '';
  return anyOf([matchJiraValues(field, references), missing].filter(Boolean));
}
