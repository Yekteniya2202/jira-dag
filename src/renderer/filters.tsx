import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Filter, LoaderCircle, Search } from 'lucide-react';
import type { JiraEdition, JiraGraph, JiraProject, JiraSavedFilter } from '../shared/contracts';
import { request } from './api';
import {
  graphFacets, hasHighlightFilters, issueFacetOptions, jiraFacetClause, noFacetValue, queryIssueFacetOptions, scopeJql,
  sprintFacetId, sprintFacetLabels,
  type FacetOption, type GraphFacet, type GraphFilters, type ScopePreset,
} from './filter-model';
import { usePreferences } from './i18n';
import './filter-controls.css';

type Translation = readonly [ru: string, en: string];

const scopeOptions: Array<{ id: ScopePreset; label: Translation; prompt?: Translation; example?: string }> = [
  { id: 'issue', label: ['Задача', 'Issue'], prompt: ['Ключ задачи', 'Issue key'], example: 'PROJ-123' },
  { id: 'project', label: ['Проект', 'Project'], prompt: ['Ключ или название проекта', 'Project key or name'], example: 'PROJ' },
  { id: 'epic', label: ['Эпик', 'Epic'], prompt: ['Ключ эпика', 'Epic key'], example: 'PROJ-10' },
  { id: 'subtasks', label: ['Подзадачи', 'Subtasks'], prompt: ['Ключ родительской задачи', 'Parent issue key'], example: 'PROJ-123' },
  { id: 'label', label: ['Метка', 'Label'], prompt: ['Метка Jira', 'Jira label'], example: 'deprecation-cleanup' },
  { id: 'sprint', label: ['Спринт', 'Sprint'], prompt: ['Название или ID спринта', 'Sprint name or ID'], example: 'Sprint 24' },
  { id: 'release', label: ['Релиз', 'Release'], prompt: ['Название или ID версии', 'Version name or ID'], example: '1.0.0' },
  { id: 'saved', label: ['Сохранённый фильтр', 'Saved filter'], prompt: ['Название или ID фильтра', 'Filter name or ID'], example: '10001' },
  { id: 'mine', label: ['Мои задачи', 'My issues'] },
  { id: 'openSprints', label: ['Активные спринты', 'Active sprints'] },
];

type ListState<T> = { kind: 'loading' | 'failed' } | { kind: 'ready'; items: T[] };

export function GraphScopePresets({ connected, edition, projectKey, onProjectChange, onApply }: {
  connected: boolean;
  edition?: JiraEdition;
  projectKey: string;
  onProjectChange(key: string): void;
  onApply(jql: string): void;
}) {
  const { t, language } = usePreferences();
  const [presetId, setPresetId] = useState<ScopePreset | ''>('');
  const [value, setValue] = useState('');
  const [projects, setProjects] = useState<ListState<JiraProject>>({ kind: 'loading' });
  const [projectRetry, setProjectRetry] = useState(0);
  const [saved, setSaved] = useState<ListState<JiraSavedFilter>>();
  const [retry, setRetry] = useState(0);
  const preset = scopeOptions.find(({ id }) => id === presetId);
  const jql = preset ? scopeJql(preset.id, value, edition) : '';
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
    if (!connected || presetId !== 'saved') return;
    let active = true;
    setSaved({ kind: 'loading' });
    void request('listSavedFilters', null).then((items) => {
      if (active) setSaved({ kind: 'ready', items });
    }).catch(() => {
      if (active) setSaved({ kind: 'failed' });
    });
    return () => { active = false; };
  }, [connected, presetId, retry]);

  function applyOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (jql) onApply(jql);
  }

  return <section className="scope-presets" aria-label={t('Шаблоны JQL', 'JQL presets')}>
    {connected && <>
      <label>{t('Проект Jira', 'Jira project')}
        <select value={projectKey} onChange={(event) => onProjectChange(event.target.value)}>
          <option value="">{t('Все доступные проекты', 'All accessible projects')}</option>
          {projectKey && !projectOptions.some(({ key }) => key === projectKey) && <option value={projectKey}>{projectKey}</option>}
          {projectOptions.map(({ id, key, name }) => <option value={key} key={id}>{name} ({key})</option>)}
        </select>
      </label>
      {projects.kind === 'loading' && <p className="form-hint" role="status">
        <LoaderCircle size={13} className="spin" /> {t('Загрузка проектов Jira…', 'Loading Jira projects…')}
      </p>}
      {projects.kind === 'ready' && projects.items.length === 0 && <p className="form-hint">
        {t('Нет доступных проектов. Ключ можно ввести в JQL.', 'No accessible projects. You can enter a key in JQL.')}
      </p>}
      {projects.kind === 'failed' && <p className="form-hint">
        {t('Список проектов Jira недоступен.', 'The Jira project list is unavailable.')}
        <button type="button" className="text-button" onClick={() => setProjectRetry((previous) => previous + 1)}>
          {t('Повторить', 'Retry')}
        </button>
      </p>}
    </>}
    <label>{t('Шаблон выборки', 'Scope preset')}
      <select value={presetId} onChange={(event) => {
        setPresetId(event.target.value as ScopePreset | '');
        setValue('');
        setSaved(undefined);
      }}>
        <option value="">{t('Выбрать шаблон', 'Choose a preset')}</option>
        {scopeOptions.map(({ id, label }) => <option key={id} value={id}>{t(...label)}</option>)}
      </select>
    </label>
    {preset && <div className="preset-values">
      {preset.id === 'saved' && connected && <>
        {saved?.kind === 'loading' && <p className="form-hint" role="status">
          <LoaderCircle size={13} className="spin" /> {t('Загрузка избранных фильтров…', 'Loading favorite filters…')}
        </p>}
        {saved?.kind === 'ready' && saved.items.length > 0 && <label>
          {t('Избранные фильтры Jira', 'Favorite Jira filters')}
          <select value={saved.items.some(({ id }) => id === value) ? value : ''} onChange={(event) => setValue(event.target.value)}>
            <option value="">{t('Выбрать фильтр', 'Choose a filter')}</option>
            {saved.items.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
          </select>
        </label>}
        {saved?.kind === 'ready' && saved.items.length === 0 && <p className="form-hint">
          {t('Избранных фильтров нет. Можно ввести название или ID.', 'There are no favorite filters. You can enter a name or ID.')}
        </p>}
        {saved?.kind === 'failed' && <p className="form-hint">
          {t('Избранные фильтры недоступны.', 'Favorite filters are unavailable.')}
          <button type="button" className="text-button" onClick={() => setRetry((previous) => previous + 1)}>
            {t('Повторить', 'Retry')}
          </button>
        </p>}
      </>}
      {preset.prompt && <label>{t(...preset.prompt)}
        <input value={value} placeholder={preset.example} onChange={(event) => setValue(event.target.value)} onKeyDown={applyOnEnter} />
      </label>}
      <button type="button" className="button secondary full" disabled={!jql} onClick={() => onApply(jql)}>
        {t('Добавить в JQL', 'Add to JQL')}
      </button>
    </div>}
  </section>;
}

const facetTitles: Record<GraphFacet, Translation> = {
  statusCategory: ['Категория статуса', 'Status category'],
  status: ['Статус Jira', 'Jira status'],
  project: ['Проект', 'Project'],
  epic: ['Эпик', 'Epic'],
  parent: ['Родительская задача', 'Parent issue'],
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

function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((current) => current !== value) : [...values, value];
}

function Facet({ title, options, selected, onChange, queryCounts }: {
  title: string;
  options: Array<FacetOption & { label: string }>;
  selected: string[];
  onChange(values: string[]): void;
  queryCounts?: boolean;
}) {
  const { t, language } = usePreferences();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const visible = query ? options.filter(({ label }) => label.toLowerCase().includes(query)) : options;
  return <details className="filter-facet">
    <summary><span>{title}</span>
      {selected.length > 0 && <span className="facet-count">{selected.length}</span>}
      <ChevronDown size={14} />
    </summary>
    {options.length > 8 && <input className="facet-search" type="search" value={search}
      aria-label={t('Найти значение', 'Find a value')} placeholder={t('Найти значение', 'Find a value')}
      onChange={(event) => setSearch(event.target.value)} />}
    <div className="facet-options">
      {visible.map(({ value, label, count }) => <label className="facet-option" key={value} title={label}>
        <input type="checkbox" checked={selected.includes(value)} onChange={() => onChange(toggle(selected, value))} />
        <span>{label}</span><small title={queryCounts ? t('Задачи в загруженной выборке JQL', 'Issues in the loaded JQL selection') : undefined}>
          {count.toLocaleString(language)}
        </small>
      </label>)}
      {!visible.length && <span className="facet-empty">{t('Совпадений нет', 'No matches')}</span>}
    </div>
  </details>;
}

function useIssueOptions(graph: JiraGraph, queryOnly = false, queryIssueKeys?: ReadonlySet<string>) {
  const { t, language } = usePreferences();
  const facets = useMemo(() => queryOnly ? queryIssueFacetOptions(graph.issues, queryIssueKeys)
    : issueFacetOptions(graph.issues), [graph.issues, queryIssueKeys, queryOnly]);
  const summaries = useMemo(() => new Map(graph.issues.map(({ key, summary }) => [key, summary])), [graph.issues]);
  const sprintLabels = useMemo(() => sprintFacetLabels(graph.issues), [graph.issues]);

  function optionLabel(facet: GraphFacet, value: string): string {
    if (value === noFacetValue) return t(...(missingLabels[facet] ?? ['Без значения', 'No value']));
    const translated = localValueLabels[facet]?.[value];
    if (translated) return t(...translated);
    if (facet === 'sprints') {
      const id = sprintFacetId(value);
      return sprintLabels.get(value) ?? (id ? t(`Спринт #${id}`, `Sprint #${id}`) : value);
    }
    const summary = (facet === 'epic' || facet === 'parent') && summaries.get(value);
    return summary && summary !== value ? `${value} · ${summary}` : value;
  }
  return (facet: GraphFacet, selected: string[]) => {
    const options = [...facets[facet]];
    for (const value of selected) if (!options.some((option) => option.value === value)) options.push({ value, count: 0 });
    return options.map((option) => ({ ...option, label: optionLabel(facet, option.value) }))
      .sort((left, right) => left.label.localeCompare(right.label, language, { numeric: true }));
  };
}

export function GraphJqlFilters({ graph, edition, storyField, queryIssueKeys, selected, onChange }: {
  graph: JiraGraph;
  edition: JiraEdition;
  storyField?: string;
  queryIssueKeys?: ReadonlySet<string>;
  selected: GraphFilters['facets'];
  onChange(selected: GraphFilters['facets']): void;
}) {
  const { t } = usePreferences();
  const issueOptions = useIssueOptions(graph, true, queryIssueKeys);
  const hasSelection = Object.values(selected).some((values) => values.length);

  if (!graph.issues.length && !hasSelection) return null;
  return <section className="filters" aria-label={t('Фильтры Jira в JQL', 'Jira filters in JQL')}>
    <div className="filter-heading">
      <h2><Filter size={16} /> {t('Выборка Jira', 'Jira selection')}</h2>
      {hasSelection && <button type="button" className="text-button" onClick={() => onChange({})}>
        {t('Сбросить', 'Reset')}
      </button>}
    </div>
    <p className="form-hint">{t('Счётчики относятся к загруженной выборке JQL. Чтобы применить новый запрос, загрузи граф.',
      'Counts refer to the loaded JQL selection. Load the graph to apply the new query.')}</p>
    <div className="facet-grid">
      {graphFacets.filter((facet) => facet !== 'project').map((facet) => {
        const values = selected[facet] ?? [];
        const options = issueOptions(facet, values).filter(({ value }) => jiraFacetClause(facet, [value], edition, storyField));
        if (!options.some(({ value }) => value !== noFacetValue) && !values.length) return null;
        return <Facet key={facet} title={t(...facetTitles[facet])} options={options} selected={values} queryCounts
          onChange={(next) => onChange({ ...selected, [facet]: next })} />;
      })}
    </div>
  </section>;
}

export function GraphFilterPanel({ graph, filters, onChange }: {
  graph: JiraGraph;
  filters: GraphFilters;
  connected?: boolean;
  onChange(filters: GraphFilters): void;
}) {
  const { t } = usePreferences();
  const issueOptions = useIssueOptions(graph);
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
      {graphFacets.map((facet) => {
        const selected = filters.facets[facet] ?? [];
        const options = issueOptions(facet, selected);
        if (!options.some(({ value }) => value !== noFacetValue) && !selected.length) return null;
        return <Facet key={facet} title={t(...facetTitles[facet])} options={options} selected={selected}
          onChange={(values) => onChange({ ...filters, facets: { ...filters.facets, [facet]: values } })} />;
      })}
    </div>
    </section>
  </details>;
}
