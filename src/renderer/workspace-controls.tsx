import { useState } from 'react';
import { Bookmark, ChevronDown, Trash2 } from 'lucide-react';
import { usePreferences } from './i18n';
import { refreshIntervals, type QueryDraft, type RefreshMinutes, type SavedFilter } from './workspace-state';

export function SavedFilters({ filters, draft, canSave, onApply, onChange }: {
  filters: SavedFilter[];
  draft: QueryDraft;
  canSave: boolean;
  onApply(draft: QueryDraft): void;
  onChange(filters: SavedFilter[]): boolean;
}) {
  const { t } = usePreferences();
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const selected = filters.find(({ id }) => id === selectedId);
  const matching = filters.find((filter) => filter.name.toLowerCase() === name.trim().toLowerCase());

  function save() {
    const title = name.trim();
    if (!title || !canSave) return;
    const filter = { id: matching?.id ?? title.toLowerCase(), name: title, draft };
    if (onChange(matching ? filters.map((item) => item.id === filter.id ? filter : item) : [...filters, filter])) {
      setSelectedId(filter.id);
    }
  }

  return <details className="saved-filters">
    <summary><Bookmark size={14} /> {t('Сохранённые фильтры', 'Saved filters')} <ChevronDown size={13} /></summary>
    <div>
      {filters.length > 0 && <>
        <label>{t('Сохранённый фильтр', 'Saved filter')}
          <select value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">{t('Выбрать фильтр', 'Select a filter')}</option>
            {filters.map((filter) => <option key={filter.id} value={filter.id}>{filter.name}</option>)}
          </select>
        </label>
        <div className="saved-filter-actions">
          <button type="button" className="button secondary" disabled={!selected}
            onClick={() => { if (selected) onApply(selected.draft); }}>{t('Применить фильтр', 'Apply filter')}</button>
          <button type="button" className="icon-button outline" disabled={!selected}
            aria-label={t('Удалить сохранённый фильтр', 'Delete saved filter')} title={t('Удалить сохранённый фильтр', 'Delete saved filter')}
            onClick={() => {
              if (selected && onChange(filters.filter(({ id }) => id !== selected.id))) setSelectedId('');
            }}><Trash2 size={15} /></button>
        </div>
      </>}
      <label>{t('Имя фильтра', 'Filter name')}
        <input maxLength={80} value={name} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
      </label>
      <button type="button" className="button secondary full" disabled={!name.trim() || !canSave}
        onClick={save}>{matching ? t('Перезаписать фильтр', 'Overwrite filter') : t('Сохранить фильтр', 'Save filter')}</button>
    </div>
  </details>;
}

export function RefreshMenu({ enabled, minutes, onEnabledChange, onMinutesChange }: {
  enabled: boolean;
  minutes: RefreshMinutes;
  onEnabledChange(value: boolean): void;
  onMinutesChange(value: RefreshMinutes): void;
}) {
  const { t } = usePreferences();
  const label = t('Автообновление', 'Auto-refresh');
  return <details className="view-menu refresh-menu">
    <summary aria-label={label} title={label}>
      {enabled && <span>{t(`${minutes} мин`, `${minutes} min`)}</span>}<ChevronDown size={13} />
    </summary>
    <div>
      <label className="view-switch">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        {t('Обновлять автоматически', 'Refresh automatically')}
      </label>
      <label>{t('Интервал обновления', 'Refresh interval')}
        <select value={minutes} onChange={(event) => {
          const next = refreshIntervals.find((value) => value === Number(event.target.value));
          if (next) onMinutesChange(next);
        }}>
          {refreshIntervals.map((value) => <option key={value} value={value}>{t(`${value} мин`, `${value} min`)}</option>)}
        </select>
      </label>
    </div>
  </details>;
}
