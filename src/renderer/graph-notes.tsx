import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, MessageSquareText, Plus, Trash2 } from 'lucide-react';
import type { JiraGraphNote } from '../shared/contracts';
import { errorMessage, request, RequestError } from './api';
import { localizeMessage, usePreferences } from './i18n';

export function GraphNotes({ issueKey, focus, onCount }: {
  issueKey: string;
  focus: boolean;
  onCount(issueKey: string, count: number): void;
}) {
  const { language, t } = usePreferences();
  const noteInputId = useId();
  const [notes, setNotes] = useState<JiraGraphNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [deleteId, setDeleteId] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    void request('listNotes', { key: issueKey }).then((result) => {
      if (current) {
        setNotes(result);
        setRefreshRequired(false);
      }
    }).catch((cause: unknown) => {
      if (current) setError(errorMessage(cause));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [issueKey, reload]);

  useEffect(() => {
    if (focus && input.current) {
      input.current.focus();
      input.current.scrollIntoView({ block: 'nearest' });
    }
  }, [focus, issueKey]);

  useEffect(() => {
    if (!loading && !error) onCount(issueKey, notes.length);
  }, [error, issueKey, loading, notes.length, onCount]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || loading || refreshRequired || !draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const note = await request('createNote', { key: issueKey, text: draft.trim() });
      setNotes((current) => [...current, note]);
      setDraft('');
    } catch (cause) {
      const status = cause instanceof RequestError ? cause.status : undefined;
      if (!status || status >= 500 || status === 408 || status === 409) {
        setRefreshRequired(true);
        setError(t('Jira не подтвердила сохранение. Обнови заметки перед повторной попыткой.',
          'Jira did not confirm the save. Refresh notes before trying again.'));
      } else setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (loading || busy) return;
    setBusy(true);
    setError('');
    try {
      await request('deleteNote', { key: issueKey, id });
      setNotes((current) => current.filter((note) => note.id !== id));
      setDeleteId(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="inspector-block graph-notes" aria-label={t('Заметки на графе', 'Graph notes')}>
    <h4><MessageSquareText size={14} /> {t('Заметки на графе', 'Graph notes')} <b>{notes.length}</b></h4>
    {loading && <p role="status">{t('Загрузка заметок…', 'Loading notes…')}</p>}
    {!loading && !error && !notes.length && <p>{t('Заметок пока нет.', 'No notes yet.')}</p>}
    {error && <div className="note-error" role="alert">
      {localizeMessage(error, language)}
      <button type="button" className="text-button" disabled={busy || loading} onClick={() => setReload((value) => value + 1)}>
        {t('Обновить заметки', 'Refresh notes')}
      </button>
    </div>}
    {notes.map((note) => <article className="graph-note" key={note.id}>
      <div className="note-heading">
        <strong>{note.author || t('Пользователь Jira', 'Jira user')}</strong>
        <button type="button" className="icon-button" aria-label={t('Удалить заметку', 'Delete note')} disabled={busy || loading}
          onClick={() => setDeleteId(note.id)}><Trash2 size={13} /></button>
      </div>
      {!Number.isNaN(Date.parse(note.createdAt)) && <time dateTime={note.createdAt}>{date.format(new Date(note.createdAt))}</time>}
      <p className="note-body">{note.text}</p>
      {deleteId === note.id && <div className="note-actions">
        <button type="button" className="text-button" disabled={busy} onClick={() => setDeleteId(undefined)}>{t('Отмена', 'Cancel')}</button>
        <button type="button" className="button danger" disabled={busy || loading} onClick={() => void remove(note.id)}>
          {t('Удалить из Jira', 'Delete from Jira')}
        </button>
      </div>}
    </article>)}
    <form className="note-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={noteInputId}>{t('Добавить заметку', 'Add a note')}</label>
      <textarea id={noteInputId} ref={input} rows={3} maxLength={8000} value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t('Что важно для этого шага?', 'What matters for this step?')} />
      <p>{t('Сохранится как комментарий к задаче Jira.', 'Saved as a comment on the Jira issue.')}</p>
      <button className="button secondary full" disabled={busy || loading || refreshRequired || !draft.trim()}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} {t('Добавить в Jira', 'Add to Jira')}
      </button>
    </form>
  </section>;
}
