import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ChartNoAxesCombined, Columns3, Focus, GitBranch, Layers3, LoaderCircle, Plus, Search, X } from 'lucide-react';
import type { JiraGraph, JiraIssueSuggestion } from '../shared/contracts';
import { request } from './api';
import { edgeFacetOptions, hierarchyEdgeType, type GraphFilters } from './filter-model';
import type { CardFields } from './graph-canvas';
import type { GroupMode } from './graph-layout';
import { localizeMessage, usePreferences, type Translate } from './i18n';
import './filter-controls.css';

export type FocusMode = 'all' | 'connected' | 'upstream' | 'downstream';

export const defaultCardFields: CardFields = {
  points: true,
  assignee: true,
  priority: false,
  labels: false,
  dueDate: false,
  estimate: false,
};

type VisibilityOptions = Pick<GraphFilters, 'hideExternal' | 'hideIsolated' | 'crossProject' | 'crossEpic'>;

interface LinkVisibilityProps {
  graph: JiraGraph;
  linkTypes: string[] | undefined;
  onLinkTypes(value: string[] | undefined): void;
  visibility?: VisibilityOptions;
  onVisibilityChange?(value: VisibilityOptions): void;
}

interface ViewControlsProps extends LinkVisibilityProps {
  groupMode: GroupMode;
  onGroupMode(value: GroupMode): void;
  fields: CardFields;
  onFields(value: CardFields): void;
  showLinks: boolean;
  onShowLinks?(value: boolean): void;
  showEdgePoints: boolean;
  onShowEdgePoints(value: boolean): void;
  focusMode: FocusMode;
  onFocusMode(value: FocusMode): void;
  selected: boolean;
  connected: boolean;
  busy: boolean;
  onInclude(key: string): Promise<void>;
  onAnalyze?(): void;
  onClearAnalysis?(): void;
}

function groupOptions(t: Translate): Record<GroupMode, string> {
  return {
    none: t('Без групп', 'None'),
    hierarchy: t('Эпики и подзадачи', 'Epics and subtasks'),
    project: t('Проект', 'Project'),
    status: t('Статус', 'Status'),
    assignee: t('Исполнитель', 'Assignee'),
    sprint: t('Спринт', 'Sprint'),
    release: t('Релиз', 'Release'),
    priority: t('Приоритет', 'Priority'),
    level: t('Уровень зависимостей', 'Dependency level'),
    'open-level': t('Уровень открытых зависимостей', 'Open dependency level'),
  };
}

export function GraphViewControls({
  groupMode, onGroupMode, fields, onFields, showLinks, showEdgePoints, onShowEdgePoints,
  focusMode, onFocusMode, selected, connected, busy, onInclude, onAnalyze, onClearAnalysis, ...linkVisibility
}: ViewControlsProps) {
  const { t } = usePreferences();
  const fieldOptions: Record<keyof CardFields, string> = {
    points: 'Story Points',
    assignee: t('Исполнитель', 'Assignee'),
    priority: t('Приоритет', 'Priority'),
    labels: t('Метки', 'Labels'),
    dueDate: t('Срок', 'Due date'),
    estimate: t('Оценка времени', 'Time estimate'),
  };
  const focusOptions: Record<FocusMode, string> = {
    all: t('Весь граф', 'Entire graph'),
    connected: t('Связанные ветки', 'Connected branches'),
    upstream: t('Предшественники', 'Predecessors'),
    downstream: t('Последователи', 'Successors'),
  };

  return <div className="graph-viewbar" role="group" aria-label={t('Вид графа', 'Graph view')}>
    <div className="graph-analysis-controls">
      <button type="button" className="button secondary" aria-haspopup="dialog" disabled={busy || !onAnalyze} onClick={onAnalyze}>
        <ChartNoAxesCombined size={15} aria-hidden="true" /> {t('Анализ графа', 'Graph analysis')}
      </button>
      {onClearAnalysis && <button type="button" className="icon-button" title={t('Снять подсветку анализа', 'Clear analysis highlighting')}
        aria-label={t('Снять подсветку анализа', 'Clear analysis highlighting')} onClick={onClearAnalysis}><X size={14} /></button>}
    </div>
    <label className="view-control">
      <Layers3 size={14} aria-hidden="true" />
      <span>{t('Группировка', 'Group by')}</span>
      <select value={groupMode} onChange={(event) => onGroupMode(event.target.value as GroupMode)}>
        {Object.entries(groupOptions(t)).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
      </select>
    </label>
    <details className="view-menu">
      <summary><Columns3 size={14} aria-hidden="true" />{t('Поля', 'Fields')}</summary>
      <div>
        {(Object.entries(fieldOptions) as Array<[keyof CardFields, string]>).map(([field, label]) =>
          <label className="view-switch" key={field}>
            <input type="checkbox" checked={fields[field]}
              onChange={(event) => onFields({ ...fields, [field]: event.target.checked })} />
            {label}
          </label>)}
        <label className="view-switch" title={t('Сумма Story Points уникальных задач дальше по цепочке блокировок',
          'Total Story Points of unique issues downstream in the blocking chain')}>
          <input type="checkbox" checked={showEdgePoints} disabled={!showLinks}
            onChange={(event) => onShowEdgePoints(event.target.checked)} />
          {t('SP на связях', 'SP on links')}
        </label>
      </div>
    </details>
    <LinkVisibility {...linkVisibility} />
    <label className="view-control" title={!selected ? t('Выбери карточку для просмотра ветки', 'Select an issue to focus on its branch') : undefined}>
      <Focus size={14} aria-hidden="true" />
      <span>{t('Фокус', 'Focus')}</span>
      <select value={selected ? focusMode : 'all'} disabled={!selected}
        onChange={(event) => onFocusMode(event.target.value as FocusMode)}>
        {Object.entries(focusOptions).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
      </select>
    </label>
    {connected && <IssueLookup busy={busy} onInclude={onInclude} />}
  </div>;
}

function LinkVisibility({ graph, linkTypes, onLinkTypes, visibility, onVisibilityChange }: LinkVisibilityProps) {
  const { t, language } = usePreferences();
  const options = useMemo(() => edgeFacetOptions(graph).map((option) => ({
    ...option, label: option.value === hierarchyEdgeType ? t('Иерархия задач', 'Issue hierarchy') : option.label,
  })).sort((left, right) => left.label.localeCompare(right.label, language, { numeric: true })), [graph, language, t]);
  const selected = linkTypes === undefined ? undefined : new Set(linkTypes);
  const visibleCount = selected === undefined ? options.length : options.filter(({ value }) => selected.has(value)).length;
  const displayOptions: Record<keyof VisibilityOptions, string> = {
    hideExternal: t('Скрыть задачи вне выборки', 'Hide issues outside the query'),
    hideIsolated: t('Скрыть задачи без видимых связей', 'Hide issues without visible links'),
    crossProject: t('Только связи между проектами', 'Only cross-project links'),
    crossEpic: t('Только связи между эпиками', 'Only cross-epic links'),
  };

  function toggleType(value: string) {
    const next = new Set(linkTypes ?? options.map((option) => option.value));
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onLinkTypes(options.every((option) => next.has(option.value)) ? undefined : [...next]);
  }

  return <details className="view-menu link-type-menu">
    <summary><GitBranch size={14} aria-hidden="true" /> {t('Видимость связей', 'Link visibility')}
      {selected !== undefined && <span className="facet-count">{visibleCount}/{options.length}</span>}
    </summary>
    <div>
      {options.length > 0 ? <>
        <div className="link-type-actions">
          <button type="button" className="text-button" onClick={() => onLinkTypes(undefined)}>{t('Все', 'All')}</button>
          <button type="button" className="text-button" onClick={() => onLinkTypes([])}>{t('Ни одного', 'None')}</button>
        </div>
        <div className="link-type-options">
          {options.map(({ value, label, count }) => <label className="facet-option" key={value} title={label}>
            <input type="checkbox" checked={selected === undefined || selected.has(value)} onChange={() => toggleType(value)} />
            <span>{label}</span><small>{count.toLocaleString(language)}</small>
          </label>)}
        </div>
      </> : <span className="facet-empty">{t('В графе нет связей', 'There are no links in the graph')}</span>}
      {visibility && onVisibilityChange && <div className="link-display-options filter-flags">
        {(Object.entries(displayOptions) as Array<[keyof VisibilityOptions, string]>).map(([field, label]) =>
          <label className="facet-option" key={field}>
            <input type="checkbox" checked={visibility[field]}
              onChange={(event) => onVisibilityChange({ ...visibility, [field]: event.target.checked })} />
            <span>{label}</span>
          </label>)}
      </div>}
    </div>
  </details>;
}

type Suggestions = { query: string; items: JiraIssueSuggestion[]; failed?: boolean };
const issueKeyPattern = /^[A-Z][A-Z0-9_]*-\d+$/;

function IssueLookup({ busy, onInclude }: Pick<ViewControlsProps, 'busy' | 'onInclude'>) {
  const { t, language } = usePreferences();
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestions, setSuggestions] = useState<Suggestions>();
  const [includeError, setIncludeError] = useState('');
  const [including, setIncluding] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const errorId = useId();
  const query = input.trim();
  const popup = open && query.length >= 2 && !busy && !including;
  const current = suggestions?.query === query ? suggestions : undefined;
  const items = current?.items ?? [];

  useEffect(() => {
    if (!popup || current) return;
    let active = true;
    const timer = setTimeout(() => {
      void request('suggestIssues', { query }).then((found) => {
        if (active) setSuggestions({ query, items: found });
      }).catch(() => {
        if (active) setSuggestions({ query, items: [], failed: true });
      });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [current, popup, query]);

  useEffect(() => {
    if (popup && activeIndex >= 0) list.current?.children.item(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, popup]);

  async function include(key: string) {
    if (busy || including) return;
    setIncluding(true);
    setOpen(false);
    setIncludeError('');
    try {
      await onInclude(key);
      setInput('');
      setSuggestions(undefined);
    } catch (error) {
      setIncludeError(error instanceof Error ? localizeMessage(error.message, language)
        : t('Не удалось добавить задачу.', 'Could not add the issue.'));
    } finally {
      setIncluding(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const choice = popup ? items[activeIndex] : undefined;
    const key = choice?.key ?? query.toUpperCase();
    if (issueKeyPattern.test(key)) void include(key);
    else if (items.length === 1) void include(items[0].key);
    else {
      setOpen(true);
      setIncludeError(t('Выбери задачу из подсказок или введи её ключ.', 'Choose an issue from the suggestions or enter its key.'));
    }
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && popup) {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && query.length >= 2) {
      event.preventDefault();
      setOpen(true);
      if (items.length) setActiveIndex((previous) => event.key === 'ArrowDown'
        ? (previous + 1) % items.length
        : (previous <= 0 ? items.length - 1 : previous - 1));
    }
  }

  const label = t('Ключ или название задачи Jira', 'Jira issue key or title');
  return <>
    <form className="graph-search issue-lookup" onSubmit={submit}>
      <Search size={14} aria-hidden="true" />
      <input value={input} onChange={(event) => {
        setInput(event.target.value);
        setOpen(true);
        setActiveIndex(-1);
        setIncludeError('');
      }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={navigate}
        placeholder={label} aria-label={label} role="combobox" aria-autocomplete="list"
        aria-expanded={popup} aria-controls={popup ? listId : undefined}
        aria-activedescendant={popup && items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        aria-describedby={includeError ? errorId : undefined} aria-invalid={Boolean(includeError)}
        maxLength={128} autoComplete="off" spellCheck={false} disabled={busy || including} />
      <button type="submit" className="icon-button outline" title={t('Добавить задачу на граф', 'Add issue to graph')}
        aria-label={t('Добавить задачу на граф', 'Add issue to graph')} disabled={busy || including || !query}
        onMouseDown={(event) => event.preventDefault()}>
        <Plus size={15} aria-hidden="true" />
      </button>
      {popup && <div className="issue-suggestions">
        {!items.length && <div className="suggestion-status" role="status">
          {!current ? <><LoaderCircle size={14} className="spin" aria-hidden="true" /> {t('Поиск в Jira…', 'Searching Jira…')}</>
            : current.failed ? t('Поиск недоступен. Можно ввести ключ задачи.', 'Search is unavailable. You can enter the issue key.')
              : t('Задачи не найдены', 'No issues found')}
        </div>}
        <ul ref={list} id={listId} role="listbox" aria-label={t('Найденные задачи Jira', 'Matching Jira issues')}>
          {items.map(({ key, summary }, index) => <li key={key} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()} onClick={() => void include(key)}>
            <strong>{key}</strong><span>{summary}</span>
          </li>)}
        </ul>
      </div>}
    </form>
    {includeError && <p id={errorId} className="form-error" role="alert">{includeError}</p>}
  </>;
}
