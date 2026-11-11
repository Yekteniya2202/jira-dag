import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Filter, LoaderCircle, Search } from 'lucide-react';
import type { JiraEdition, JiraGraph, JiraSavedFilter } from '../shared/contracts';
import { request } from './api';
import {
  edgeFacetOptions, emptyGraphFilters, graphFacets, hasGraphFilters, hierarchyEdgeType,
  issueFacetOptions, noFacetValue, scopeJql,
  type FacetOption, type GraphFacet, type GraphFilters, type ScopePreset,
} from './filter-model';
import { usePreferences } from './i18n';

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

type SavedState = { kind: 'loading' | 'failed' } | { kind: 'ready'; items: JiraSavedFilter[] };

export function GraphScopePresets({ connected, edition, onApply }: {
  connected: boolean;
  edition?: JiraEdition;
  onApply(jql: string): void;
}) {
  const { t } = usePreferences();
  const [presetId, setPresetId] = useState<ScopePreset | ''>('');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<SavedState>();
  const [retry, setRetry] = useState(0);
  const preset = scopeOptions.find(({ id }) => id === presetId);
  const jql = preset ? scopeJql(preset.id, value, edition) : '';

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
        {t('Подставить в JQL', 'Use in JQL')}
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

function Facet({ title, options, selected, onChange }: {
  title: string;
  options: Array<FacetOption & { label: string }>;
  selected: string[];
  onChange(values: string[]): void;
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
        <span>{label}</span><small>{count.toLocaleString(language)}</small>
      </label>)}
      {!visible.length && <span className="facet-empty">{t('Совпадений нет', 'No matches')}</span>}
    </div>
  </details>;
}

const flags: Array<{
  field: 'hideExternal' | 'hideIsolated' | 'crossProject' | 'crossEpic';
  label: Translation;
}> = [
  { field: 'hideExternal', label: ['Скрыть задачи вне выборки', 'Hide issues outside the query'] },
  { field: 'hideIsolated', label: ['Скрыть задачи без видимых связей', 'Hide issues without visible links'] },
  { field: 'crossProject', label: ['Только связи между проектами', 'Only cross-project links'] },
  { field: 'crossEpic', label: ['Только связи между эпиками', 'Only cross-epic links'] },
];

export function GraphFilterPanel({ graph, filters, onChange }: {
  graph: JiraGraph;
  filters: GraphFilters;
  onChange(filters: GraphFilters): void;
}) {
  const { t, language } = usePreferences();
  const facets = useMemo(() => issueFacetOptions(graph.issues), [graph.issues]);
  const edgeTypes = useMemo(() => edgeFacetOptions(graph), [graph]);
  const summaries = useMemo(() => new Map(graph.issues.map(({ key, summary }) => [key, summary])), [graph.issues]);
  const sorted = (options: Array<FacetOption & { label: string }>) =>
    options.sort((left, right) => left.label.localeCompare(right.label, language, { numeric: true }));

  function optionLabel(facet: GraphFacet, value: string): string {
    if (value === noFacetValue) return t(...(missingLabels[facet] ?? ['Без значения', 'No value']));
    const translated = localValueLabels[facet]?.[value];
    if (translated) return t(...translated);
    const summary = (facet === 'epic' || facet === 'parent') && summaries.get(value);
    return summary && summary !== value ? `${value} · ${summary}` : value;
  }

  return <section className="filters" aria-label={t('Фильтры графа', 'Graph filters')}>
    <div className="filter-heading">
      <h2><Filter size={16} /> {t('Фильтры графа', 'Graph filters')}</h2>
      {hasGraphFilters(filters) && <button type="button" className="text-button" onClick={() => onChange(emptyGraphFilters)}>
        {t('Сбросить', 'Reset')}
      </button>}
    </div>
    <label className="graph-filter-search">
      <span><Search size={13} /> {t('Поиск в графе', 'Search in graph')}</span>
      <input type="search" value={filters.search} placeholder={t('Ключ, текст или метка', 'Key, text, or label')}
        onChange={(event) => onChange({ ...filters, search: event.target.value })} />
    </label>
    <div className="facet-grid">
      {edgeTypes.length > 0 && <Facet title={t('Тип связи', 'Link type')}
        options={sorted(edgeTypes.map((option) => ({
          ...option, label: option.value === hierarchyEdgeType ? t('Иерархия задач', 'Issue hierarchy') : option.label,
        })))}
        selected={filters.edgeTypes} onChange={(values) => onChange({ ...filters, edgeTypes: values })} />}
      {graphFacets.map((facet) => {
        const options = facets[facet];
        if (!options.some(({ value }) => value !== noFacetValue) && !filters.facets[facet]?.length) return null;
        return <Facet key={facet} title={t(...facetTitles[facet])}
          options={sorted(options.map((option) => ({ ...option, label: optionLabel(facet, option.value) })))}
          selected={filters.facets[facet] ?? []}
          onChange={(values) => onChange({ ...filters, facets: { ...filters.facets, [facet]: values } })} />;
      })}
    </div>
    <div className="filter-flags">
      {flags.map(({ field, label }) => <label className="facet-option" key={field}>
        <input type="checkbox" checked={filters[field]} onChange={(event) => onChange({ ...filters, [field]: event.target.checked })} />
        <span>{t(...label)}</span>
      </label>)}
    </div>
  </section>;
}
