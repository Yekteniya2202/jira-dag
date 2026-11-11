import type { JiraEdge, JiraEdition, JiraGraph, JiraIssue } from '../shared/contracts.js';

export const graphFacets = [
  'statusCategory', 'status', 'project', 'epic', 'parent', 'issueType', 'hierarchy', 'labels',
  'assignee', 'priority', 'sprints', 'fixVersions', 'estimate', 'dueDate',
] as const;

export type GraphFacet = typeof graphFacets[number];

export interface GraphFilters {
  search: string;
  facets: Partial<Record<GraphFacet, string[]>>;
  edgeTypes: string[];
  hideExternal: boolean;
  hideIsolated: boolean;
  crossProject: boolean;
  crossEpic: boolean;
}

export const emptyGraphFilters: GraphFilters = {
  search: '', facets: {}, edgeTypes: [],
  hideExternal: false, hideIsolated: false, crossProject: false, crossEpic: false,
};

export const noFacetValue = '\0';
export const hierarchyEdgeType = 'parent';

export interface FacetOption {
  value: string;
  count: number;
}

export function hasGraphFilters(filters: GraphFilters): boolean {
  return Boolean(filters.search.trim() || filters.edgeTypes.length ||
    Object.values(filters.facets).some((values) => values.length) ||
    filters.hideExternal || filters.hideIsolated || filters.crossProject || filters.crossEpic);
}

function statusCategory(issue: JiraIssue): string {
  const category = issue.statusCategory ?? 'new';
  return category === 'in-progress' ? 'indeterminate' : category;
}

function epicKey(issue: JiraIssue): string | undefined {
  return issue.isEpic ? issue.key : issue.epicKey;
}

export function facetValues(issue: JiraIssue, facet: GraphFacet): string[] {
  switch (facet) {
    case 'statusCategory': return [statusCategory(issue)];
    case 'epic': return [epicKey(issue) ?? noFacetValue];
    case 'parent': return [issue.parentKey ?? noFacetValue];
    case 'hierarchy': return [issue.isSubtask ? 'subtask' : issue.isEpic ? 'epic' : 'issue'];
    case 'estimate': return [issue.storyPoints === undefined ? 'missing' : 'present'];
    case 'dueDate': return [issue.dueDate ? 'present' : 'missing'];
    case 'labels':
    case 'sprints':
    case 'fixVersions': return issue[facet]?.length ? issue[facet] : [noFacetValue];
    default: return [issue[facet] ?? noFacetValue];
  }
}

export function issueFacetOptions(issues: JiraIssue[]): Record<GraphFacet, FacetOption[]> {
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

export function filterGraph(graph: JiraGraph, filters: GraphFilters): JiraGraph {
  if (!hasGraphFilters(filters)) return graph;

  const selectedFacets = graphFacets.flatMap((facet) => {
    const values = filters.facets[facet];
    return values?.length ? [{ facet, values: new Set(values) }] : [];
  });
  const terms = filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const issues = graph.issues.filter((issue) => (!filters.hideExternal || !issue.external) &&
    textMatches(issue, terms) && selectedFacets.every(({ facet, values }) =>
      facetValues(issue, facet).some((value) => values.has(value)),
    ));
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const edgeTypes = new Set(filters.edgeTypes);
  const edges = graph.edges.filter((edge) => {
    const source = byKey.get(edge.source);
    const target = byKey.get(edge.target);
    return source !== undefined && target !== undefined &&
      (!edgeTypes.size || edgeTypes.has(edgeTypeKey(edge))) &&
      (!filters.crossProject || crossesBoundary(edge, source.project, target.project)) &&
      (!filters.crossEpic || crossesBoundary(edge, epicKey(source), epicKey(target)));
  });

  if (!filters.hideIsolated) return { ...graph, issues, edges };
  const connected = new Set(edges.flatMap(({ source, target }) => [source, target]));
  return { ...graph, issues: issues.filter(({ key }) => connected.has(key)), edges };
}

export type ScopePreset =
  'issue' | 'project' | 'epic' | 'subtasks' | 'label' | 'sprint' | 'release' | 'saved' | 'mine' | 'openSprints';

function jqlLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function scopeJql(scope: ScopePreset, value: string, edition: JiraEdition = 'cloud'): string {
  if (scope === 'mine') return 'assignee = currentUser()';
  if (scope === 'openSprints') return 'sprint in openSprints()';
  const input = value.trim();
  if (!input || /[\x00-\x1F\x7F]/.test(input)) return '';

  const quoted = jqlLiteral(input);
  const reference = /^\d+$/.test(input) ? input : quoted;
  switch (scope) {
    case 'issue': return `key = ${quoted}`;
    case 'project': return `project = ${reference}`;
    case 'epic': {
      const field = edition === 'data-center' ? '"Epic Link"' : 'parent';
      return `(key = ${quoted} OR ${field} = ${quoted})`;
    }
    case 'subtasks': return `(key = ${quoted} OR (parent = ${quoted} AND issuetype in subtaskIssueTypes()))`;
    case 'label': return `labels = ${quoted}`;
    case 'sprint': return `sprint = ${reference}`;
    case 'release': return `fixVersion = ${reference}`;
    case 'saved': return `filter = ${reference}`;
  }
}
