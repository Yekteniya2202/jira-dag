import { useRef, useState, type FormEvent } from 'react';
import { CalendarClock, LoaderCircle, Play } from 'lucide-react';
import type { JiraSprint } from '../shared/contracts';
import { errorMessage, request } from './api';
import { Dialog } from './dialogs';
import { localizeMessage, usePreferences } from './i18n';

interface StartSprintProps {
  boardId: string;
  sprint: JiraSprint;
  expectedIssueKeys: readonly string[];
  hasChanges: boolean;
  disabled: boolean;
  goal?: string;
  onStarted(sprint: JiraSprint): void;
  onBusyChange(busy: boolean): void;
}

function localInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initialDates(sprint: JiraSprint) {
  const plannedStart = Date.parse(sprint.startDate ?? '');
  const plannedEnd = Date.parse(sprint.endDate ?? '');
  const start = new Date(Number.isFinite(plannedStart) ? plannedStart : Date.now());
  const fallbackEnd = new Date(start);
  fallbackEnd.setDate(start.getDate() + 14);
  const end = Number.isFinite(plannedEnd) && plannedEnd > start.getTime() ? new Date(plannedEnd) : fallbackEnd;
  return { start: localInputValue(start), end: localInputValue(end) };
}

export function StartSprintButton(props: StartSprintProps) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(false);
  const { sprint, disabled, hasChanges } = props;
  const canStart = !disabled && !hasChanges;
  if (sprint.state !== 'future') return null;
  const label = t('Начать спринт', 'Start sprint');
  return <>
    <button type="button" className="button secondary" aria-haspopup="dialog" disabled={!canStart}
      title={hasChanges ? t('Сначала примени переносы задач в Jira.', 'Apply the task moves in Jira first.') : label}
      onClick={() => setOpen(true)}><Play size={15} aria-hidden="true" />{label}</button>
    {open && <StartSprintDialog key={`${props.boardId}:${sprint.id}`} {...props}
      disabled={!canStart} onClose={() => setOpen(false)}
      onStarted={(updated) => { setOpen(false); props.onStarted(updated); }} />}
  </>;
}

function StartSprintDialog({ boardId, sprint, expectedIssueKeys, goal, disabled, onBusyChange, onStarted, onClose }: StartSprintProps & {
  onClose(): void;
}) {
  const { language, t } = usePreferences();
  const [dates] = useState(() => initialDates(sprint));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || disabled) return;
    const fields = new FormData(event.currentTarget);
    const startValue = String(fields.get('start') ?? '');
    const endValue = String(fields.get('end') ?? '');
    const start = new Date(startValue);
    const end = new Date(endValue);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
      localInputValue(start) !== startValue || localInputValue(end) !== endValue || start >= end) {
      setError(t('Укажи корректные даты. Окончание должно быть позже начала.', 'Enter valid dates with the end after the start.'));
      return;
    }
    const nextGoal = String(fields.get('goal') ?? '');
    const previousGoal = (sprint.goal ?? '').replace(/\r\n?/g, '\n');
    lock.current = true;
    setBusy(true);
    setError('');
    onBusyChange(true);
    try {
      const updated = await request('startSprint', {
        boardId, sprintId: sprint.id, expectedIssueKeys: [...expectedIssueKeys],
        startDate: start.toISOString(), endDate: end.toISOString(),
        ...(nextGoal !== previousGoal ? { goal: nextGoal } : {}),
      });
      onStarted(updated);
    } catch (cause) {
      setError(localizeMessage(errorMessage(cause), language));
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return <Dialog title={t('Начать спринт в Jira', 'Start sprint in Jira')} onClose={onClose} busy={busy}>
    <form className="dialog-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy}>
        <strong>{sprint.name}</strong>
        <div className="form-row">
          <label>{t('Начало', 'Start date and time')}
            <input name="start" type="datetime-local" defaultValue={dates.start} required />
          </label>
          <label>{t('Окончание', 'End date and time')}
            <input name="end" type="datetime-local" defaultValue={dates.end} required />
          </label>
        </div>
        <label>{t('Цель спринта', 'Sprint goal')}
          <textarea name="goal" rows={3} maxLength={1000} defaultValue={goal ?? sprint.goal ?? ''} />
        </label>
        <p className="form-hint"><CalendarClock size={15} aria-hidden="true" />{t(
          `Задач в Jira — ${expectedIssueKeys.length}. Даты указаны в часовом поясе устройства.`,
          `Issues in Jira: ${expectedIssueKeys.length}. Dates use the device’s time zone.`,
        )}</p>
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>{t('Отмена', 'Cancel')}</button>
        <button type="submit" className="button primary" disabled={busy || disabled}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
          {t('Начать в Jira', 'Start in Jira')}
        </button>
      </div>
    </form>
  </Dialog>;
}
