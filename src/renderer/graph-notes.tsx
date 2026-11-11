import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, MessageSquareText, Pencil, Plus, Trash2 } from 'lucide-react';
import type { JiraGraphNote } from '../shared/contracts';
import { errorMessage, request, RequestError } from './api';
import { localizeMessage, usePreferences } from './i18n';

export type NoteFocus = 'input' | 'list';
type NoteMutation = 'create' | 'edit' | 'delete';

export function GraphNotes({ issueKey, focus, onNotes }: {
  issueKey: string;
  focus?: NoteFocus;
  onNotes(issueKey: string, notes: readonly JiraGraphNote[]): void;
}) {
  const { language, t } = usePreferences();
  const noteInputId = useId();
  const editInputId = useId();
  const [notes, setNotes] = useState<JiraGraphNote[]>([]);
  const [hasNotesList, setHasNotesList] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<NoteMutation>();
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [editDraft, setEditDraft] = useState<{ id: string; text: string }>();
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [deleteId, setDeleteId] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const editInput = useRef<HTMLTextAreaElement>(null);
  const section = useRef<HTMLElement>(null);
  const mutating = useRef(false);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  const busy = pending !== undefined;
  const mutationDisabled = !hasNotesList || loading || busy || refreshRequired;
  const noteActionsDisabled = mutationDisabled || Boolean(editDraft || deleteId);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    void request('listNotes', { key: issueKey }).then((result) => {
      if (current) {
        setNotes(result);
        setDeleteId((id) => id && result.some((note) => note.id === id) ? id : undefined);
        setHasNotesList(true);
        setRefreshRequired(false);
        onNotes(issueKey, result);
      }
    }).catch((cause: unknown) => {
      if (current) setError(errorMessage(cause));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [issueKey, onNotes, reload]);

  useEffect(() => {
    if (focus === 'input' && input.current) {
      input.current.focus();
      input.current.scrollIntoView({ block: 'nearest' });
    }
    if (focus === 'list') section.current?.scrollIntoView({ block: 'start' });
  }, [focus, issueKey]);

  useEffect(() => { if (editDraft?.id) editInput.current?.focus(); }, [editDraft?.id]);

  function publishNotes(next: JiraGraphNote[]) {
    setNotes(next);
    onNotes(issueKey, next);
  }

  function refresh() {
    if (mutating.current || loading) return;
    setLoading(true);
    setReload((value) => value + 1);
  }

  async function mutate(kind: NoteMutation, operation: () => Promise<void>) {
    if (mutating.current || mutationDisabled) return;
    mutating.current = true;
    setPending(kind);
    setError('');
    try {
      await operation();
    } catch (cause) {
      const status = cause instanceof RequestError ? cause.status : undefined;
      const unconfirmed = !status || status >= 500 || status === 408;
      if (unconfirmed || status === 409) setRefreshRequired(true);
      if (unconfirmed && kind !== 'delete') {
        setError(t('Jira не подтвердила сохранение. Обнови заметки перед повторной попыткой.',
          'Jira did not confirm the save. Refresh notes before trying again.'));
      } else setError(errorMessage(cause));
    } finally {
      mutating.current = false;
      setPending(undefined);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || editDraft || deleteId) return;
    void mutate('create', async () => {
      const note = await request('createNote', { key: issueKey, text });
      publishNotes([...notes, note]);
      setDraft('');
    });
  }

  function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editDraft) return;
    const { id, text } = editDraft;
    const previous = notes.find((note) => note.id === id);
    if (!previous || !text.trim() || previous.text === text.trim()) return;
    void mutate('edit', async () => {
      const updated = await request('updateNote', { key: issueKey, id, text: text.trim() });
      publishNotes(notes.map((note) => note.id === id ? { ...note, text: updated.text } : note));
      setEditDraft(undefined);
    });
  }

  function remove(id: string) {
    void mutate('delete', async () => {
      await request('deleteNote', { key: issueKey, id });
      publishNotes(notes.filter((note) => note.id !== id));
      setDeleteId(undefined);
    });
  }

  const editedNote = editDraft && notes.find((note) => note.id === editDraft.id);
  const editForm = editDraft && <form className="note-form note-edit" onSubmit={saveEdit}>
    <label htmlFor={editInputId}>{t('Текст заметки', 'Note text')}</label>
    <textarea id={editInputId} ref={editInput} rows={4} maxLength={8000} value={editDraft.text} readOnly={busy}
      onChange={(event) => setEditDraft({ ...editDraft, text: event.target.value })} />
    {!editedNote && <p>{t('Эта заметка больше недоступна в Jira.', 'This note is no longer available in Jira.')}</p>}
    <div className="note-actions">
      <button type="button" className="text-button" disabled={busy} onClick={() => setEditDraft(undefined)}>{t('Отмена', 'Cancel')}</button>
      <button className="button secondary" disabled={mutationDisabled || !editedNote || !editDraft.text.trim() || editedNote.text === editDraft.text.trim()}>
        {pending === 'edit' && <LoaderCircle size={13} className="spin" />}
        {t('Сохранить заметку', 'Save note')}
      </button>
    </div>
  </form>;

  return <section ref={section} className="inspector-block graph-notes" aria-label={t('Заметки на графе', 'Graph notes')}>
    <h4><MessageSquareText size={14} /> {t('Заметки на графе', 'Graph notes')} <b>{notes.length}</b></h4>
    {loading && <p role="status">{t('Загрузка заметок…', 'Loading notes…')}</p>}
    {!loading && !error && !notes.length && <p>{t('Заметок пока нет.', 'No notes yet.')}</p>}
    {error && <div className="note-error" role="alert">
      {localizeMessage(error, language)}
      <button type="button" className="text-button" disabled={busy || loading} onClick={refresh}>
        {t('Обновить заметки', 'Refresh notes')}
      </button>
    </div>}
    {notes.map((note) => <article className="graph-note" key={note.id}>
      <div className="note-heading">
        <strong>{note.author || t('Пользователь Jira', 'Jira user')}</strong>
        <div className="note-heading-actions">
          <button type="button" className="icon-button" title={t('Редактировать заметку', 'Edit note')}
            aria-label={t('Редактировать заметку', 'Edit note')} disabled={noteActionsDisabled}
            onClick={() => setEditDraft({ id: note.id, text: note.text })}><Pencil size={13} /></button>
          <button type="button" className="icon-button" title={t('Удалить заметку', 'Delete note')}
            aria-label={t('Удалить заметку', 'Delete note')} disabled={noteActionsDisabled}
            onClick={() => setDeleteId(note.id)}><Trash2 size={13} /></button>
        </div>
      </div>
      {!Number.isNaN(Date.parse(note.createdAt)) && <time dateTime={note.createdAt}>{date.format(new Date(note.createdAt))}</time>}
      {editDraft?.id === note.id ? editForm : <p className="note-body">{note.text}</p>}
      {deleteId === note.id && <div className="note-actions">
        <button type="button" className="text-button" disabled={busy} onClick={() => setDeleteId(undefined)}>{t('Отмена', 'Cancel')}</button>
        <button type="button" className="button danger" disabled={mutationDisabled} onClick={() => remove(note.id)}>
          {t('Удалить из Jira', 'Delete from Jira')}
        </button>
      </div>}
    </article>)}
    {editDraft && !editedNote && editForm}
    <form className="note-form" onSubmit={submit}>
      <label htmlFor={noteInputId}>{t('Добавить заметку', 'Add a note')}</label>
      <textarea id={noteInputId} ref={input} rows={3} maxLength={8000} value={draft} readOnly={busy}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t('Что важно для этого шага?', 'What matters for this step?')} />
      <p>{t('Сохранится как комментарий к задаче Jira.', 'Saved as a comment on the Jira issue.')}</p>
      <button className="button secondary full" disabled={noteActionsDisabled || !draft.trim()}>
        {pending === 'create' ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} {t('Добавить в Jira', 'Add to Jira')}
      </button>
    </form>
  </section>;
}
