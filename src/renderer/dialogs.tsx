import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, CircleHelp, GitBranch, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import type {
  JiraCreateField, JiraCreateOptions, JiraEdition, JiraIssue, JiraIssueInput, JiraLinkType, JiraLogin,
} from '../shared/contracts';
import { errorMessage, IssueCreationUnconfirmed, request } from './api';
import { isBlockingType } from './graph-model';
import { localizeMessage, usePreferences, type Translate } from './i18n';

interface DialogProps {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  className?: string;
}

export function Dialog({ title, children, onClose, busy, className }: DialogProps) {
  const { t } = usePreferences();
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className={className ? `dialog ${className}` : 'dialog'} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label={t('Закрыть', 'Close')} disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      {children}
    </dialog>
  );
}

export function ConnectionDialog({ onConnect, onClose }: {
  onConnect(credentials: JiraLogin): Promise<void>;
  onClose(): void;
}) {
  const { t, language } = usePreferences();
  const [edition, setEdition] = useState<JiraEdition>('cloud');
  const [scopedToken, setScopedToken] = useState(false);
  const [remember, setRemember] = useState(true);
  const desktop = Boolean(window.jiraDag);
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
        remember: desktop ? remember : undefined,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t('Подключить Jira', 'Connect to Jira')} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="dialog-form" autoComplete="off">
        <fieldset disabled={busy}>
          <label>{t('Редакция Jira', 'Jira edition')}
            <select value={edition} onChange={(event) => setEdition(event.target.value as JiraEdition)}>
              <option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option>
            </select>
          </label>
          <label>{t('Адрес Jira', 'Jira URL')}
            <input name="url" type="url" placeholder={edition === 'cloud' ? 'https://team.atlassian.net' : 'https://jira.example.org'} required />
          </label>
          <div className="form-row">
            <label>{t('Пользователь', 'Username')} <span>{t('необязательно', 'optional')}</span>
              <input name="username" placeholder={t('Имя для отображения', 'Display name')} />
            </label>
            <label>Email {edition === 'data-center' && <span>{t('необязательно', 'optional')}</span>}
              <input name="email" type="email" placeholder="name@example.org" required={edition === 'cloud'} />
            </label>
          </div>
          <label>{edition === 'cloud' ? t('API-токен', 'API token') : 'Personal Access Token'}
            <input name="token" type="password" autoComplete="new-password" placeholder={t('Вставь токен Jira', 'Paste a Jira token')} required />
          </label>
          {edition === 'cloud' && <label className="checkbox">
            <input type="checkbox" checked={scopedToken} onChange={(event) => setScopedToken(event.target.checked)} />
            {t('Токен с заданными разрешениями (scoped)', 'Scoped API token')}
          </label>}
          {desktop && <label className="checkbox">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            {t('Запомнить подключение', 'Remember this connection')}
          </label>}
          <p className="form-hint"><LockKeyhole size={14} /> {desktop && remember
            ? t('Данные подключения шифруются средствами системы.', 'Connection details are encrypted using system storage.')
            : t('Токен хранится в памяти до завершения сессии.', 'The token stays in memory for the session.')}</p>
        </fieldset>
        {error && <p className="form-error" role="alert">{localizeMessage(error, language)}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />} {t('Подключиться', 'Connect')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function requiredValue(field: JiraCreateField, raw: string, t: Translate): unknown {
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
      catch { throw new Error(t(`Укажи корректный JSON для поля «${field.name}».`, `Enter valid JSON for “${field.name}”.`)); }
    default: return raw;
  }
}

function RequiredField({ field }: { field: JiraCreateField }) {
  const { t } = usePreferences();
  let control: ReactNode;
  if (field.options?.length || field.schemaType === 'boolean') {
    const options = field.options?.length ? field.options : [
      { id: 'true', name: t('Да', 'Yes') }, { id: 'false', name: t('Нет', 'No') },
    ];
    control = <select name={field.id} required defaultValue="">
      <option value="" disabled>{t('Выбери значение', 'Select a value')}</option>
      {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>;
  } else {
    const type = field.schemaType === 'number' ? 'number' : field.schemaType === 'date' ? 'date' : 'text';
    const placeholder = field.id === 'parent' ? 'PROJ-123'
      : field.schemaType === 'array' ? t('["значение"]', '["value"]')
        : ['object', 'user', 'option', 'issuelink', 'priority', 'version', 'component'].includes(field.schemaType ?? '') ? '{"id":"10000"}' : undefined;
    control = <input name={field.id} type={type} step={type === 'number' ? 'any' : undefined} required placeholder={placeholder} />;
  }
  return <label>{field.name}{control}</label>;
}

const standardFields = new Set(['project', 'issuetype', 'summary', 'description', 'reporter']);

export function CreateDialog({ project, source, types, currentUser, onCreate, onClose }: {
  project: string;
  source?: JiraIssue;
  types: JiraLinkType[];
  currentUser?: string;
  onCreate(input: JiraIssueInput, linkTypeId?: string): Promise<void>;
  onClose(): void;
}) {
  const { t, language } = usePreferences();
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
        } catch { throw new Error(t('Дополнительные поля должны быть объектом JSON.', 'Additional fields must be a JSON object.')); }
      }
      for (const field of required) fields[field.id] = requiredValue(field, read(field.id), t);
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
    <Dialog title={source ? t('Добавить следующий шаг', 'Add next step') : t('Новая задача Jira', 'New Jira issue')} onClose={onClose} busy={busy}>
      <form className="dialog-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          {source && <p className="form-hint"><GitBranch size={15} /> {t('Связать с', 'Link to')} {source.key}</p>}
          <div className="form-row">
            <label>{t('Ключ проекта', 'Project key')}<input required value={projectKey} onChange={(event) => setProjectKey(event.target.value)} placeholder="PROJ" /></label>
            <label>{t('Тип задачи', 'Issue type')}
              <select required value={typeId} onChange={(event) => setTypeId(event.target.value)} disabled={!options?.issueTypes.length}>
                <option value="">{loadingTypes ? t('Загрузка…', 'Loading…') : t('Выбери тип', 'Select a type')}</option>
                {options?.issueTypes.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          </div>
          {metadataError && <p className="form-error" role="alert">{localizeMessage(metadataError, language)}</p>}
          {options && !options.issueTypes.length && <p className="form-hint">{t('В проекте нет доступных типов задач.', 'This project has no available issue types.')}</p>}
          <label>{t('Название', 'Summary')}<input name="summary" placeholder={t('Например, удалить старую колонку', 'For example, remove the old column')} required maxLength={255} /></label>
          <label>{t('Описание', 'Description')}<textarea name="description" rows={3} placeholder={t('Что нужно сделать', 'What needs to be done')} required={requiresDescription} /></label>
          {currentUser && fieldOptions?.fields.some(({ id }) => id === 'reporter') && <div className="create-reporter">
            <span>{t('Автор', 'Reporter')}</span><strong>{currentUser}</strong>
          </div>}
          {fieldsError && <p className="form-error" role="alert">{localizeMessage(fieldsError, language)}</p>}
          {required.map((field) => <RequiredField field={field} key={field.id} />)}
          {source && <label>{t('Тип связи', 'Link type')}
            <select name="linkTypeId" defaultValue={suggestedLinkType}>
              <option value="">{t('Без связи', 'No link')}</option>
              {types.map(({ id, outward }) => <option key={id} value={id}>{source.key} {outward} {t('новую задачу', 'new issue')}</option>)}
            </select>
          </label>}
          <details className="advanced-fields">
            <summary><CircleHelp size={15} /> {t('Дополнительные поля Jira', 'Additional Jira fields')}</summary>
            <label>{t('Объект JSON', 'JSON object')}<textarea name="extra" rows={3} placeholder={'{"labels":["migration"]}'} /></label>
          </details>
        </fieldset>
        {error && <p className="form-error" role="alert">{localizeMessage(error, language)}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
          <button className="button primary" disabled={busy || unconfirmed || loadingTypes || loadingFields || !typeId || !fieldOptions}>
            {busy && <LoaderCircle size={16} className="spin" />} {t('Создать в Jira', 'Create in Jira')}
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
  const { t, language } = usePreferences();
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
    <Dialog title={t('Добавить связь', 'Add link')} onClose={onClose} busy={busy}>
      <form className="dialog-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>{t('Направление связи', 'Link direction')}
            <select name="typeId" required defaultValue={types.find(isBlockingType)?.id ?? types[0]?.id ?? ''}>
              {types.map(({ id, outward }) => <option key={id} value={id}>{source} {outward} {target}</option>)}
            </select>
          </label>
        </fieldset>
        {error && <p className="form-error" role="alert">{localizeMessage(error, language)}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
          <button className="button primary" disabled={busy || !types.length}>{t('Сохранить связь', 'Save link')}</button>
        </div>
      </form>
    </Dialog>
  );
}
