import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, CircleHelp, GitBranch, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import type {
  JiraCreateField, JiraCreateOptions, JiraCredentials, JiraEdition, JiraIssue, JiraIssueInput, JiraLinkType,
} from '../shared/contracts';
import { errorMessage, IssueCreationUnconfirmed, request } from './api';
import { isBlockingType } from './graph-model';

interface DialogProps {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
}

export function Dialog({ title, children, onClose, busy }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="dialog-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button type="button" className="icon-button" aria-label="Закрыть" disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      {children}
    </dialog>
  );
}

export function ConnectionDialog({ onConnect, onClose }: {
  onConnect(credentials: JiraCredentials): Promise<void>;
  onClose(): void;
}) {
  const [edition, setEdition] = useState<JiraEdition>('cloud');
  const [scopedToken, setScopedToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const value = (name: string) => String(fields.get(name) ?? '').trim();
    setBusy(true);
    setError('');
    try {
      await onConnect({
        edition, scopedToken: edition === 'cloud' && scopedToken,
        url: value('url'), username: value('username'), email: value('email'), token: value('token'),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Подключить Jira" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="dialog-form" autoComplete="off">
        <fieldset disabled={busy}>
          <label>Редакция Jira
            <select value={edition} onChange={(event) => setEdition(event.target.value as JiraEdition)}>
              <option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option>
            </select>
          </label>
          <label>Адрес Jira
            <input name="url" type="url" placeholder={edition === 'cloud' ? 'https://team.atlassian.net' : 'https://jira.example.org'} required />
          </label>
          <div className="form-row">
            <label>Пользователь <span>необязательно</span><input name="username" placeholder="Имя для отображения" /></label>
            <label>Email {edition === 'data-center' && <span>необязательно</span>}
              <input name="email" type="email" placeholder="name@example.org" required={edition === 'cloud'} />
            </label>
          </div>
          <label>{edition === 'cloud' ? 'API-токен' : 'Personal Access Token'}
            <input name="token" type="password" autoComplete="new-password" placeholder="Вставь токен Jira" required />
          </label>
          {edition === 'cloud' && <label className="checkbox">
            <input type="checkbox" checked={scopedToken} onChange={(event) => setScopedToken(event.target.checked)} /> Токен с заданными разрешениями (scoped)
          </label>}
          <p className="form-hint"><LockKeyhole size={14} /> Токен хранится в памяти до завершения сессии.</p>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Отмена</button>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />} Подключиться
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function requiredValue(field: JiraCreateField, raw: string): unknown {
  if (field.id === 'parent') return { key: raw.trim() };
  if (field.options?.length) {
    const option = { id: raw };
    return field.schemaType === 'array' ? [option] : option;
  }
  switch (field.schemaType) {
    case 'number': return Number(raw);
    case 'boolean': return raw === 'true';
    case 'array':
    case 'object':
    case 'user':
    case 'option':
    case 'issuelink':
    case 'priority':
    case 'version':
    case 'component':
      try { return JSON.parse(raw) as unknown; }
      catch { throw new Error(`Укажи корректный JSON для поля «${field.name}».`); }
    default: return raw;
  }
}

function RequiredField({ field }: { field: JiraCreateField }) {
  let control: ReactNode;
  if (field.options?.length || field.schemaType === 'boolean') {
    const options = field.options?.length ? field.options : [{ id: 'true', name: 'Да' }, { id: 'false', name: 'Нет' }];
    control = <select name={field.id} required defaultValue="">
      <option value="" disabled>Выбери значение</option>
      {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>;
  } else {
    const type = field.schemaType === 'number' ? 'number' : field.schemaType === 'date' ? 'date' : 'text';
    const placeholder = field.id === 'parent' ? 'PROJ-123'
      : field.schemaType === 'array' ? '["значение"]'
        : ['object', 'user', 'option', 'issuelink', 'priority', 'version', 'component'].includes(field.schemaType ?? '') ? '{"id":"10000"}' : undefined;
    control = <input name={field.id} type={type} step={type === 'number' ? 'any' : undefined} required placeholder={placeholder} />;
  }
  return <label>{field.name}{control}</label>;
}

const standardFields = new Set(['project', 'issuetype', 'summary', 'description']);

export function CreateDialog({ project, source, types, onCreate, onClose }: {
  project: string;
  source?: JiraIssue;
  types: JiraLinkType[];
  onCreate(input: JiraIssueInput, linkTypeId?: string): Promise<void>;
  onClose(): void;
}) {
  const [projectKey, setProjectKey] = useState(project);
  const [typeId, setTypeId] = useState('');
  const [options, setOptions] = useState<JiraCreateOptions>();
  const [fieldOptions, setFieldOptions] = useState<JiraCreateOptions>();
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [fieldsError, setFieldsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const suggestedLinkType = types.find(isBlockingType)?.id ?? types[0]?.id ?? '';

  useEffect(() => {
    let current = true;
    setOptions(undefined);
    setFieldOptions(undefined);
    setMetadataError('');
    setTypeId('');
    if (!projectKey.trim()) { setLoadingTypes(false); return; }
    setLoadingTypes(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await request('getCreateOptions', { projectKey: projectKey.trim() });
        if (!current) return;
        setOptions(result);
        setTypeId(result.issueTypes.find(({ name }) => /^(task|задача)$/i.test(name))?.id ?? result.issueTypes[0]?.id ?? '');
      } catch (cause) {
        if (current) setMetadataError(errorMessage(cause));
      } finally {
        if (current) setLoadingTypes(false);
      }
    }, 260);
    return () => { current = false; window.clearTimeout(timer); };
  }, [projectKey]);

  useEffect(() => {
    let current = true;
    setFieldOptions(undefined);
    setFieldsError('');
    if (!typeId || !options?.issueTypes.some(({ id }) => id === typeId)) {
      setLoadingFields(false);
      return;
    }
    setLoadingFields(true);
    void request('getCreateOptions', { projectKey: projectKey.trim(), issueTypeId: typeId })
      .then((result) => { if (current) setFieldOptions(result); })
      .catch((cause: unknown) => { if (current) setFieldsError(errorMessage(cause)); })
      .finally(() => { if (current) setLoadingFields(false); });
    return () => { current = false; };
  }, [options, projectKey, typeId]);

  const required = fieldOptions?.fields.filter(({ id, required, hasDefaultValue }) =>
    required && !hasDefaultValue && !standardFields.has(id)) ?? [];
  const requiresDescription = fieldOptions?.fields.some(({ id, required }) => id === 'description' && required);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: string) => String(form.get(key) ?? '');
    setBusy(true);
    setError('');
    try {
      const extraFields = read('extra').trim();
      let fields: Record<string, unknown> = {};
      if (extraFields) {
        try {
          const value: unknown = JSON.parse(extraFields);
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          fields = value as Record<string, unknown>;
        } catch { throw new Error('Дополнительные поля должны быть объектом JSON.'); }
      }
      for (const field of required) fields[field.id] = requiredValue(field, read(field.id));
      await onCreate({
        projectKey: projectKey.trim(), typeId, summary: read('summary').trim(),
        description: read('description').trim() || undefined, fields,
      }, read('linkTypeId') || undefined);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof IssueCreationUnconfirmed) setUnconfirmed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={source ? 'Добавить следующий шаг' : 'Новая задача Jira'} onClose={onClose} busy={busy}>
      <form className="dialog-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          {source && <p className="form-hint"><GitBranch size={15} /> Связать с {source.key}</p>}
          <div className="form-row">
            <label>Ключ проекта<input required value={projectKey} onChange={(event) => setProjectKey(event.target.value)} placeholder="PROJ" /></label>
            <label>Тип задачи
              <select required value={typeId} onChange={(event) => setTypeId(event.target.value)} disabled={!options?.issueTypes.length}>
                <option value="">{loadingTypes ? 'Загрузка…' : 'Выбери тип'}</option>
                {options?.issueTypes.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          </div>
          {metadataError && <p className="form-error" role="alert">{metadataError}</p>}
          {options && !options.issueTypes.length && <p className="form-hint">В проекте нет доступных типов задач.</p>}
          <label>Название<input name="summary" placeholder="Например, удалить старую колонку" required maxLength={255} /></label>
          <label>Описание<textarea name="description" rows={3} placeholder="Что нужно сделать" required={requiresDescription} /></label>
          {fieldsError && <p className="form-error" role="alert">{fieldsError}</p>}
          {required.map((field) => <RequiredField field={field} key={field.id} />)}
          {source && <label>Тип связи
            <select name="linkTypeId" defaultValue={suggestedLinkType}>
              <option value="">Без связи</option>
              {types.map(({ id, outward }) => <option key={id} value={id}>{source.key} {outward} новую задачу</option>)}
            </select>
          </label>}
          <details className="advanced-fields">
            <summary><CircleHelp size={15} /> Дополнительные поля Jira</summary>
            <label>Объект JSON<textarea name="extra" rows={3} placeholder={'{"labels":["migration"]}'} /></label>
          </details>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Отмена</button>
          <button className="button primary" disabled={busy || unconfirmed || loadingTypes || loadingFields || !typeId || !fieldOptions}>
            {busy && <LoaderCircle size={16} className="spin" />} Создать в Jira
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function LinkDialog({ source, target, types, onLink, onClose }: {
  source: string; target: string; types: JiraLinkType[];
  onLink(typeId: string): Promise<void>; onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typeId = String(new FormData(event.currentTarget).get('typeId'));
    setBusy(true);
    setError('');
    try { await onLink(typeId); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog title="Добавить связь" onClose={onClose} busy={busy}>
      <form className="dialog-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>Направление связи
            <select name="typeId" required defaultValue={types.find(isBlockingType)?.id ?? types[0]?.id ?? ''}>
              {types.map(({ id, outward }) => <option key={id} value={id}>{source} {outward} {target}</option>)}
            </select>
          </label>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Отмена</button>
          <button className="button primary" disabled={busy || !types.length}>Сохранить связь</button>
        </div>
      </form>
    </Dialog>
  );
}
