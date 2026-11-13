import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Pin, PinOff, Plus, X } from 'lucide-react';
import { usePreferences } from './i18n';
import type { WorkspaceTab } from './workspace-state';

export const graphTabId = (id: number) => `graph-tab-${id}`;
export const graphPanelId = (id: number) => `graph-panel-${id}`;

const dragType = 'application/x-jira-dag-workspace-tab';
type TabDrop = { id: number; side: 'before' | 'after' };

export function WorkspaceTabs({ tabs, activeId, disabled, canClose, onSelect, onAdd, onClose, onPin, onMove }: {
  tabs: WorkspaceTab[];
  activeId: number;
  disabled: boolean;
  canClose: boolean;
  onSelect(id: number): void;
  onAdd(): void;
  onClose(): void;
  onPin(id: number, pinned: boolean): void;
  onMove(id: number, target: number, side: TabDrop['side']): void;
}) {
  const { t } = usePreferences();
  const dragged = useRef<number | undefined>(undefined);
  const [drop, setDrop] = useState<TabDrop>();
  const active = tabs.find(({ id }) => id === activeId);
  const pinLabel = active?.pinned ? t('Открепить вкладку', 'Unpin graph tab') : t('Закрепить вкладку', 'Pin graph tab');

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction && event.shiftKey) {
      event.preventDefault();
      const tab = tabs[index];
      const neighbor = tabs[index + direction];
      if (!disabled && neighbor) onMove(tab.id, neighbor.id, direction > 0 ? 'after' : 'before');
      return;
    }
    const next = direction ? tabs[(index + direction + tabs.length) % tabs.length]
      : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : undefined;
    if (!next) return;
    event.preventDefault();
    onSelect(next.id);
    document.getElementById(graphTabId(next.id))?.focus();
  }

  function dropAt(event: DragEvent<HTMLButtonElement>, tab: WorkspaceTab): TabDrop | undefined {
    const source = tabs.find(({ id }) => id === dragged.current);
    if (!source || source.id === tab.id || Boolean(source.pinned) !== Boolean(tab.pinned)) return undefined;
    const { left, width } = event.currentTarget.getBoundingClientRect();
    return { id: tab.id, side: event.clientX < left + width / 2 ? 'before' : 'after' };
  }

  function stopDrag() {
    dragged.current = undefined;
    setDrop(undefined);
  }

  return <div className="workspace-tabs">
    <div className="workspace-tablist" role="tablist" aria-label={t('Графы', 'Graphs')}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDrop(undefined);
      }}>
      {tabs.map((tab, index) => {
        const label = tab.label ?? (tab.epicKey ? t(`Эпик ${tab.epicKey}`, `Epic ${tab.epicKey}`) : t(`Граф ${tab.id}`, `Graph ${tab.id}`));
        const suffix = tab.epicKey ? (tab.epicTitle === tab.epicKey ? undefined : tab.epicTitle) : tab.label ? undefined : tab.project;
        return <button key={tab.id} type="button" id={graphTabId(tab.id)}
          role="tab" aria-selected={activeId === tab.id} aria-controls={graphPanelId(tab.id)}
          aria-description={tab.pinned ? t('Закреплена', 'Pinned') : undefined}
          aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight"
          tabIndex={activeId === tab.id ? 0 : -1} title={[label, suffix, tab.query].filter(Boolean).join(' · ')}
          data-pinned={tab.pinned || undefined} data-drop={drop?.id === tab.id ? drop.side : undefined}
          draggable={!disabled && tabs.length > 1}
          onClick={() => onSelect(tab.id)} onKeyDown={(event) => navigate(event, index)}
          onDragStart={(event) => {
            dragged.current = tab.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(dragType, String(tab.id));
          }}
          onDragOver={(event) => {
            const target = dropAt(event, tab);
            if (target) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
            setDrop((previous) => previous?.id === target?.id && previous?.side === target?.side ? previous : target);
          }}
          onDrop={(event) => {
            const target = dropAt(event, tab);
            const id = dragged.current;
            if (target && id !== undefined && event.dataTransfer.getData(dragType) === String(id)) {
              event.preventDefault();
              onMove(id, target.id, target.side);
            }
            stopDrag();
          }}
          onDragEnd={stopDrag}>
          {tab.pinned && <Pin size={13} aria-hidden="true" />}
          <span>{label}{suffix && ` · ${suffix}`}</span>
        </button>;
      })}
    </div>
    <button className="icon-button" type="button" aria-label={t('Новая вкладка', 'New graph tab')}
      title={t('Новая вкладка', 'New graph tab')} disabled={disabled} onClick={onAdd}><Plus size={16} /></button>
    <button className="icon-button" type="button" aria-label={pinLabel} title={pinLabel} disabled={disabled || !active}
      onClick={() => {
        if (!active) return;
        onPin(active.id, !active.pinned);
        requestAnimationFrame(() => document.getElementById(graphTabId(active.id))?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      }}>{active?.pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
    {tabs.length > 1 && <button className="icon-button" type="button" aria-label={t('Закрыть вкладку', 'Close graph tab')}
      title={t('Закрыть вкладку', 'Close graph tab')} disabled={!canClose} onClick={onClose}><X size={15} /></button>}
  </div>;
}
