import { useId, useState, type FormEvent } from 'react';
import { Columns3, Focus, Layers3, Plus, Search } from 'lucide-react';
import type { CardFields } from './graph-canvas';
import type { GroupMode } from './graph-layout';
import { localizeMessage, usePreferences, type Translate } from './i18n';

export type FocusMode = 'all' | 'connected' | 'upstream' | 'downstream';

export const defaultCardFields: CardFields = {
  points: true,
  assignee: true,
  priority: false,
  labels: false,
  dueDate: false,
  estimate: false,
};

interface ViewControlsProps {
  groupMode: GroupMode;
  onGroupMode(value: GroupMode): void;
  fields: CardFields;
  onFields(value: CardFields): void;
  showLinks: boolean;
  onShowLinks(value: boolean): void;
  showEdgePoints: boolean;
  onShowEdgePoints(value: boolean): void;
  focusMode: FocusMode;
  onFocusMode(value: FocusMode): void;
  selected: boolean;
  connected: boolean;
  busy: boolean;
  onInclude(key: string): Promise<void>;
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
  groupMode, onGroupMode, fields, onFields, showLinks, onShowLinks, showEdgePoints, onShowEdgePoints,
  focusMode, onFocusMode, selected, connected, busy, onInclude,
}: ViewControlsProps) {
  const { t, language } = usePreferences();
  const [issueKey, setIssueKey] = useState('');
  const [includeError, setIncludeError] = useState('');
  const [including, setIncluding] = useState(false);
  const includeErrorId = useId();
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

  async function include(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = issueKey.trim().toUpperCase();
    if (busy || including) return;
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
      setIncludeError(t('Введи ключ задачи Jira, например MIG-27.', 'Enter a Jira issue key, for example MIG-27.'));
      return;
    }
    setIncluding(true);
    setIncludeError('');
    try {
      await onInclude(key);
      setIssueKey('');
    } catch (error) {
      setIncludeError(error instanceof Error ? localizeMessage(error.message, language)
        : t('Не удалось добавить задачу.', 'Could not add the issue.'));
    } finally {
      setIncluding(false);
    }
  }

  return <div className="graph-viewbar" role="group" aria-label={t('Вид графа', 'Graph view')}>
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
    <label className="view-switch">
      <input type="checkbox" checked={showLinks} onChange={(event) => onShowLinks(event.target.checked)} />
      {t('Связи между задачами', 'Links between issues')}
    </label>
    <label className="view-control" title={!selected ? t('Выбери карточку для просмотра ветки', 'Select an issue to focus on its branch') : undefined}>
      <Focus size={14} aria-hidden="true" />
      <span>{t('Фокус', 'Focus')}</span>
      <select value={selected ? focusMode : 'all'} disabled={!selected}
        onChange={(event) => onFocusMode(event.target.value as FocusMode)}>
        {Object.entries(focusOptions).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
      </select>
    </label>
    {connected && <form className="graph-search" onSubmit={include}>
      <Search size={14} aria-hidden="true" />
      <input value={issueKey} onChange={(event) => { setIssueKey(event.target.value); setIncludeError(''); }}
        placeholder={t('Ключ задачи Jira', 'Jira issue key')} aria-label={t('Ключ задачи Jira', 'Jira issue key')}
        aria-describedby={includeError ? includeErrorId : undefined} aria-invalid={Boolean(includeError)}
        maxLength={128} spellCheck={false} disabled={busy || including} />
      <button type="submit" className="icon-button outline" title={t('Добавить задачу на граф', 'Add issue to graph')}
        aria-label={t('Добавить задачу на граф', 'Add issue to graph')} disabled={busy || including || !issueKey.trim()}>
        <Plus size={15} aria-hidden="true" />
      </button>
    </form>}
    {includeError && connected && <p id={includeErrorId} className="form-error" role="alert">{includeError}</p>}
  </div>;
}
