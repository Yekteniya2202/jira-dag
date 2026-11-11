import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, Filter, LoaderCircle, Search } from 'lucide-react';
import type { JiraEdition, JiraGraph, JiraIssue, JiraProject, JiraProjectFilterOptions, JiraSavedFilter } from '../shared/contracts';
import { request } from './api';
import {
  graphFacets, hasHighlightFilters, issueFacetOptions, jiraFacetClause, manualJiraFacetValue, noFacetValue,
  projectJiraFacetValues, queryIssueFacetOptions, scopeJql, sprintFacetId, sprintFacetLabels,
  type GraphFacet, type GraphFilters, type ProjectFacetValue,
} from './filter-model';
import { usePreferences } from './i18n';
import './filter-controls.css';

type Translation = readonly [ru: string, en: string];

type ListState<T> = { kind: 'loading' | 'failed' } | { kind: 'ready'; items: T[] };
type ProjectOptionsState = { project: string; options?: JiraProjectFilterOptions };
const noIssues: readonly JiraIssue[] = [];

export function GraphProjectFilters({
  connected, edition, projectKey, onProjectChange, graph, queryIssueKeys, storyField, selected, onChange, onApply, projectDetails,
}: {
  connected: boolean;
  edition: JiraEdition;
  projectKey: string;
  onProjectChange(key: string): void;
  graph?: JiraGraph;
  queryIssueKeys?: ReadonlySet<string>;
  storyField?: string;
  selected: GraphFilters['facets'];
  onChange(selected: GraphFilters['facets']): void;
  onApply?(jql: string): void;
  projectDetails?: ReactNode;
}) {
  const { t, language } = usePreferences();
  const [projects, setProjects] = useState<ListState<JiraProject>>({ kind: 'loading' });
  const [projectRetry, setProjectRetry] = useState(0);
  const [metadata, setMetadata] = useState<ProjectOptionsState>();
  const [metadataRetry, setMetadataRetry] = useState(0);
  const [typedProject, setTypedProject] = useState('');
  const projectMetadata = metadata?.project === projectKey ? metadata : undefined;
  const metadataValues = useMemo<Partial<Record<GraphFacet, ProjectFacetValue[]>>>(() =>
    projectMetadata?.options ? projectJiraFacetValues(projectMetadata.options) : {}, [projectMetadata]);
  const observedIssues = useMemo(() => {
    const issues = graph?.issues ?? noIssues;
    return projectKey ? issues.filter(({ project }) => project === projectKey) : issues;
  }, [graph?.issues, projectKey]);
  const loadedOptions = useIssueOptions(observedIssues, true, queryIssueKeys);
  const hasSelection = Object.values(selected).some((values) => values.length);
  const projectOptions = useMemo(() => projects.kind === 'ready'
    ? [...projects.items].sort((left, right) => left.name.localeCompare(right.name, language, { numeric: true }))
    : [], [language, projects]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    setProjects({ kind: 'loading' });
    void request('listProjects', null).then((items) => {
      if (active) setProjects({ kind: 'ready', items });
    }).catch(() => {
      if (active) setProjects({ kind: 'failed' });
    });
    return () => { active = false; };
  }, [connected, projectRetry]);

  useEffect(() => {
    if (!connected || !projectKey) return;
    let active = true;
    setMetadata(undefined);
    void request('getProjectFilterOptions', { project: projectKey }).then((options) => {
      if (active) setMetadata({ project: projectKey, options });
    }).catch(() => {
      if (active) setMetadata({ project: projectKey });
    });
    return () => { active = false; };
  }, [connected, metadataRetry, projectKey]);

  const manualProject = typedProject.trim().toUpperCase();
  const validProject = /^(?:[A-Z][A-Z0-9_]*|\d+)$/.test(manualProject);
  function chooseTypedProject() {
    if (validProject) onProjectChange(manualProject);
  }

  function renderFacet(facet: GraphFacet) {
    const values = selected[facet] ?? [];
    const manual = manualFields[facet];
    const allows = (value: string) => Boolean(jiraFacetClause(facet, [value], edition, storyField));
    const observed = loadedOptions.options(facet, []).filter(({ value }) => allows(value));
    const options = combineChoices(observed, metadataValues[facet] ?? [], values);
    const available = new Map(options.map((option) => [option.value, option]));
    for (const value of [...Object.keys(localValueLabels[facet] ?? {}), noFacetValue, ...values]) {
      if (!available.has(value) && (values.includes(value) || allows(value))) {
        available.set(value, { value, label: loadedOptions.label(facet, value) });
      }
    }
    if (!available.size && !manual) return null;
    const sorted = [...available.values()].sort((left, right) => left.label.localeCompare(right.label, language, { numeric: true }));
    return <Facet key={facet} title={t(...facetTitles[facet])} options={sorted} selected={values} queryCounts
      manual={manual && { label: t(...manual), parse: (input) => manualJiraFacetValue(facet, input) }}
      onChange={(next) => onChange({ ...selected, [facet]: next })} />;
  }

  if (!connected) return null;
  return <section className="project-filters" aria-label={t('Условия выборки Jira', 'Jira query conditions')}>
    <label>{t('Проект Jira', 'Jira project')}
      <select value={projectKey} onChange={(event) => onProjectChange(event.target.value)}>
        <option value="">{t('Все доступные проекты', 'All accessible projects')}</option>
        {projectKey && !projectOptions.some(({ key }) => key === projectKey) && <option value={projectKey}>{projectKey}</option>}
        {projectOptions.map(({ id, key, name }) => <option value={key} key={id}>{name} ({key})</option>)}
      </select>
    </label>
    {projects.kind === 'loading' && <p className="form-hint" role="status">
      <LoaderCircle size={13} className="spin" aria-hidden="true" /> {t('Загрузка проектов Jira…', 'Loading Jira projects…')}
    </p>}
    {(projects.kind === 'failed' || (projects.kind === 'ready' && !projectOptions.length)) && <>
      <p className="form-hint">{projects.kind === 'failed'
        ? t('Список проектов Jira недоступен.', 'The Jira project list is unavailable.')
        : t('Jira не вернула доступные проекты.', 'Jira returned no accessible projects.')}
      </p>
      <div className="facet-manual">
        <label>{t('Ключ проекта Jira', 'Jira project key')}
          <input value={typedProject} placeholder="PROJ" spellCheck={false} onChange={(event) => setTypedProject(event.target.value)}
            onKeyDown={(event) => onEnter(event, chooseTypedProject)} />
        </label>
        <button className="text-button" type="button" onClick={chooseTypedProject} disabled={!validProject}>{t('Выбрать', 'Select')}</button>
      </div>
      {projects.kind === 'failed' && <button type="button" className="text-button project-filter-retry"
        onClick={() => setProjectRetry((previous) => previous + 1)}>{t('Обновить список проектов', 'Retry project list')}</button>}
    </>}
    {projectDetails}
    {projectKey && !projectMetadata && <p className="form-hint" role="status">
      <LoaderCircle size={13} className="spin" aria-hidden="true" /> {t('Загрузка значений проекта…', 'Loading project values…')}
    </p>}
    {projectMetadata && (!projectMetadata.options || Boolean(projectMetadata.options.unavailable?.length)) && <div className="form-hint">
      {t('Часть списков Jira недоступна. Значения можно ввести вручную.', 'Some Jira lists are unavailable. You can enter values manually.')}
      <button type="button" className="text-button" onClick={() => setMetadataRetry((previous) => previous + 1)}>
        {t('Повторить', 'Retry')}
      </button>
    </div>}
    <div className="facet-grid">{primaryFacets.map(renderFacet)}</div>
    <details className="filter-facet project-filter-more">
      <summary><span>{t('Другие условия', 'More conditions')}</span>
        {extraFacets.some((facet) => selected[facet]?.length) && <span className="facet-count">
          {extraFacets.reduce((count, facet) => count + (selected[facet]?.length ?? 0), 0)}
        </span>}
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="facet-grid">{extraFacets.map(renderFacet)}</div>
    </details>
    {hasSelection && <button type="button" className="text-button project-filter-retry" onClick={() => onChange({})}>
      {t('Сбросить условия', 'Reset conditions')}
    </button>}
    {onApply && <FavoriteJiraFilters onApply={onApply} />}
  </section>;
}

function FavoriteJiraFilters({ onApply }: { onApply(jql: string): void }) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ListState<JiraSavedFilter>>({ kind: 'loading' });
  const [value, setValue] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSaved({ kind: 'loading' });
    void request('listSavedFilters', null).then((items) => {
      if (active) setSaved({ kind: 'ready', items });
    }).catch(() => {
      if (active) setSaved({ kind: 'failed' });
    });
    return () => { active = false; };
  }, [open, retry]);

  const clause = scopeJql('saved', value);
  return <details className="filter-facet project-filter-more" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span>{t('Избранные фильтры Jira', 'Favorite Jira filters')}</span><ChevronDown size={14} aria-hidden="true" /></summary>
    <div className="facet-grid">
      {saved.kind === 'loading' && <p className="form-hint" role="status">{t('Загрузка избранного…', 'Loading favorites…')}</p>}
      {saved.kind === 'ready' && saved.items.length > 0 && <label>{t('Фильтр Jira', 'Jira filter')}
        <select value={saved.items.some(({ id }) => id === value) ? value : ''} onChange={(event) => setValue(event.target.value)}>
          <option value="">{t('Выбрать фильтр', 'Choose a filter')}</option>
          {saved.items.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>}
      {saved.kind === 'failed' && <button type="button" className="text-button project-filter-retry" onClick={() => setRetry((previous) => previous + 1)}>
        {t('Повторить загрузку избранного', 'Retry favorite filters')}
      </button>}
      <label>{t('Имя или ID фильтра', 'Filter name or ID')}
        <input value={value} onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => onEnter(event, () => { if (clause) onApply(clause); })} />
      </label>
      <button type="button" className="button secondary full" disabled={!clause} onClick={() => onApply(clause)}>{t('Добавить в JQL', 'Add to JQL')}</button>
    </div>
  </details>;
}

const facetTitles: Record<GraphFacet, Translation> = {
  statusCategory: ['Категория статуса', 'Status category'],
  status: ['Статус Jira', 'Jira status'],
  project: ['Проект', 'Project'],
  key: ['Ключ задачи', 'Issue key'],
  epic: ['Эпик', 'Epic'],
  parent: ['Родительская задача', 'Parent issue'],
  subtaskParent: ['Задача с подзадачами', 'Issue and its subtasks'],
  issueType: ['Тип задачи', 'Issue type'],
  hierarchy: ['Уровень иерархии', 'Hierarchy level'],
  labels: ['Метки', 'Labels'],
  assignee: ['Исполнитель', 'Assignee'],
  priority: ['Приоритет', 'Priority'],
  sprints: ['Спринт', 'Sprint'],
  fixVersions: ['Релиз', 'Release'],
  estimate: ['Оценка в Story Points', 'Story Points estimate'],
  dueDate: ['Срок', 'Due date'],
};

const missingLabels: Partial<Record<GraphFacet, Translation>> = {
  epic: ['Без эпика', 'No epic'],
  parent: ['Без родителя', 'No parent'],
  labels: ['Без меток', 'No labels'],
  assignee: ['Без исполнителя', 'Unassigned'],
  sprints: ['Без спринта', 'No sprint'],
  fixVersions: ['Без релиза', 'No release'],
};

const localValueLabels: Partial<Record<GraphFacet, Record<string, Translation>>> = {
  statusCategory: { new: ['К выполнению', 'To do'], indeterminate: ['В работе', 'In progress'], done: ['Готово', 'Done'] },
  hierarchy: { epic: ['Эпики', 'Epics'], subtask: ['Подзадачи', 'Subtasks'], issue: ['Обычные задачи', 'Standard issues'] },
  estimate: { present: ['С оценкой', 'Estimated'], missing: ['Без оценки', 'Unestimated'] },
  dueDate: { present: ['Со сроком', 'Has due date'], missing: ['Без срока', 'No due date'] },
};

const primaryFacets: readonly GraphFacet[] = ['status', 'sprints', 'issueType', 'fixVersions', 'labels'];
const extraFacets: readonly GraphFacet[] = ['key', 'epic', 'subtaskParent', 'parent', 'assignee', 'priority', 'statusCategory', 'hierarchy', 'dueDate', 'estimate'];

const manualFields: Partial<Record<GraphFacet, Translation>> = {
  key: ['Ключ задачи, например PROJ-123', 'Issue key, e.g. PROJ-123'],
  epic: ['Ключ эпика, например PROJ-123', 'Epic key, e.g. PROJ-123'],
  parent: ['Ключ родительской задачи', 'Parent issue key'],
  subtaskParent: ['Ключ задачи с подзадачами', 'Issue key with subtasks'],
  status: ['Название или ID статуса', 'Status name or ID'],
  issueType: ['Название или ID типа задачи', 'Issue type name or ID'],
  labels: ['Метка Jira', 'Jira label'],
  assignee: ['Имя, email или ID', 'Name, email, or ID'],
  priority: ['Название приоритета', 'Priority name'],
  sprints: ['Название или ID спринта', 'Sprint name or ID'],
  fixVersions: ['Название или ID версии', 'Version name or ID'],
};

interface FacetChoice {
  value: string;
  label: string;
  count?: number;
}

function combineChoices(observed: FacetChoice[], metadata: ProjectFacetValue[], selected: string[]): FacetChoice[] {
  const observedByValue = new Map(observed.map((option) => [option.value, option]));
  const nameCounts = new Map<string, number>();
  for (const { name } of metadata) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const options = metadata.map(({ value, name, label }) => {
    const uniqueName = nameCounts.get(name) === 1;
    const count = observedByValue.get(value)?.count ?? (uniqueName ? observedByValue.get(name)?.count : undefined);
    observedByValue.delete(value);
    if (uniqueName) observedByValue.delete(name);
    const keepManualChoice = uniqueName && selected.includes(name) && !selected.includes(value);
    return { value: keepManualChoice ? name : value, label, count };
  });
  return [...options, ...observedByValue.values()];
}

function onEnter(event: KeyboardEvent<HTMLInputElement>, action: () => void) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
  event.preventDefault();
  action();
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((current) => current !== value) : [...values, value];
}

function Facet({ title, options, selected, onChange, queryCounts, manual }: {
  title: string;
  options: FacetChoice[];
  selected: string[];
  onChange(values: string[]): void;
  queryCounts?: boolean;
  manual?: { label: string; parse(input: string): string };
}) {
  const { t, language } = usePreferences();
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const query = search.trim().toLowerCase();
  const visible = query ? options.filter(({ label }) => label.toLowerCase().includes(query)) : options;
  const parsed = manual?.parse(typed) ?? '';
  function addTypedValue() {
    if (!parsed) return;
    const choice = options.find(({ label }) => label === typed.trim())?.value ?? parsed;
    if (!selected.includes(choice)) onChange([...selected, choice]);
    setTyped('');
    setSearch('');
  }
  return <details className="filter-facet">
    <summary><span>{title}</span>
      {selected.length > 0 && <span className="facet-count">{selected.length}</span>}
      <ChevronDown size={14} />
    </summary>
    {options.length > 8 && <input className="facet-search" type="search" value={search}
      aria-label={t('Найти значение', 'Find a value')} placeholder={t('Найти значение', 'Find a value')}
      onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => onEnter(event, () => {})} />}
    {(options.length > 0 || !manual) && <div className="facet-options">
      {visible.map(({ value, label, count }) => <label className="facet-option" key={value} title={label}>
        <input type="checkbox" checked={selected.includes(value)} onChange={() => onChange(toggle(selected, value))} />
        <span>{label}</span>{count !== undefined && <small title={queryCounts ? t('Задачи в загруженной выборке JQL', 'Issues in the loaded JQL selection') : undefined}>
          {count.toLocaleString(language)}
        </small>}
      </label>)}
      {!visible.length && <span className="facet-empty">{t('Совпадений нет', 'No matches')}</span>}
    </div>}
    {manual && <div className="facet-manual">
      <label>{manual.label}
        <input value={typed} maxLength={200} spellCheck={false} onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => onEnter(event, addTypedValue)} />
      </label>
      <button type="button" className="text-button" onClick={addTypedValue} disabled={!parsed}>{t('Добавить', 'Add')}</button>
    </div>}
  </details>;
}

function useIssueOptions(issues: readonly JiraIssue[], queryOnly = false, queryIssueKeys?: ReadonlySet<string>) {
  const { t, language } = usePreferences();
  const facets = useMemo(() => queryOnly ? queryIssueFacetOptions(issues, queryIssueKeys)
    : issueFacetOptions(issues), [issues, queryIssueKeys, queryOnly]);
  const summaries = useMemo(() => new Map(issues.map(({ key, summary }) => [key, summary])), [issues]);
  const sprintLabels = useMemo(() => sprintFacetLabels(issues), [issues]);

  function optionLabel(facet: GraphFacet, value: string): string {
    if (value === noFacetValue) return t(...(missingLabels[facet] ?? ['Без значения', 'No value']));
    const translated = localValueLabels[facet]?.[value];
    if (translated) return t(...translated);
    if (facet === 'sprints') {
      const id = sprintFacetId(value);
      return sprintLabels.get(value) ?? (id ? t(`Спринт #${id}`, `Sprint #${id}`) : value);
    }
    const id = sprintFacetId(value);
    if (id) return `#${id}`;
    const summary = (facet === 'epic' || facet === 'parent' || facet === 'key' || facet === 'subtaskParent') && summaries.get(value);
    return summary && summary !== value ? `${value} · ${summary}` : value;
  }
  function optionsFor(facet: GraphFacet, selected: string[]) {
    const options = [...facets[facet]];
    for (const value of selected) if (!options.some((option) => option.value === value)) options.push({ value, count: 0 });
    return options.map((option) => ({ ...option, label: optionLabel(facet, option.value) }))
      .sort((left, right) => left.label.localeCompare(right.label, language, { numeric: true }));
  }
  return { options: optionsFor, label: optionLabel };
}

export function GraphFilterPanel({ graph, filters, onChange }: {
  graph: JiraGraph;
  filters: GraphFilters;
  connected?: boolean;
  onChange(filters: GraphFilters): void;
}) {
  const { t } = usePreferences();
  const issueOptions = useIssueOptions(graph.issues);
  const hasSelection = hasHighlightFilters(filters);
  const heading = t('Подсветка задач', 'Highlight issues');
  return <details className="highlight-filters filter-facet">
    <summary><Filter size={14} aria-hidden="true" /><span>{heading}</span>
      {hasSelection && <span className="facet-count">{t('Вкл.', 'On')}</span>}
      <ChevronDown size={14} aria-hidden="true" />
    </summary>
    <section className="filters highlight-fields" aria-label={heading}>
      {hasSelection && <button type="button" className="text-button highlight-reset"
        onClick={() => onChange({ ...filters, search: '', facets: {} })}>
        {t('Сбросить', 'Reset')}
      </button>}
    <label className="graph-filter-search">
      <span><Search size={13} /> {t('Поиск в графе', 'Search in graph')}</span>
      <input type="search" value={filters.search} placeholder={t('Ключ, текст или метка', 'Key, text, or label')}
        onChange={(event) => onChange({ ...filters, search: event.target.value })} />
    </label>
    <div className="facet-grid">
      {graphFacets.filter((facet) => facet !== 'key' && facet !== 'subtaskParent').map((facet) => {
        const selected = filters.facets[facet] ?? [];
        const options = issueOptions.options(facet, selected);
        if (!options.some(({ value }) => value !== noFacetValue) && !selected.length) return null;
        return <Facet key={facet} title={t(...facetTitles[facet])} options={options} selected={selected}
          onChange={(values) => onChange({ ...filters, facets: { ...filters.facets, [facet]: values } })} />;
      })}
    </div>
    </section>
  </details>;
}
