import { useMemo, useState, type FormEvent } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUpRight, Box, Check, ChevronDown, CircleAlert, CircleDot, Crosshair,
  Filter, GitBranch, GitMerge, Layers3, Link2, LoaderCircle, LogOut, Pencil, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import type { JiraConnection, JiraCredentials, JiraEdge, JiraGraph, JiraIssue, JiraIssueInput, JiraLinkInput } from '../shared/contracts';
import { errorMessage, IssueCreationUnconfirmed, openIssue, request, RequestError } from './api';
import { demoGraph } from './demo';
import { ConnectionDialog, CreateDialog, Dialog, LinkDialog } from './dialogs';
import { GraphCanvas } from './graph-canvas';
import { blockersFor, linkClosesCycle, putIssue, statusTone, type Direction } from './graph-model';

const emptyGraph: JiraGraph = { issues: [], edges: [], linkTypes: [], storyPointsFields: [], warnings: [] };
const demoQuery = 'project = MIG ORDER BY key ASC';

type Notice = { text: string; error?: boolean; retry?: JiraLinkInput };
type Modal = { kind: 'connection' } | { kind: 'create'; source?: JiraIssue } |
  { kind: 'link'; source: string; target: string } | { kind: 'edit'; issue: JiraIssue } |
  { kind: 'delete'; edge: JiraEdge };

const tones = [
  { value: 'waiting', label: 'К выполнению' },
  { value: 'active', label: 'В работе' },
  { value: 'done', label: 'Готово' },
] as const;

export function App() {
  const [connection, setConnection] = useState<JiraConnection>();
  const [graph, setGraph] = useState(demoGraph);
  const [jql, setJql] = useState(demoQuery);
  const [depth, setDepth] = useState(1);
  const [storyField, setStoryField] = useState('');
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [linkFilter, setLinkFilter] = useState('');
  const [direction, setDirection] = useState<Direction>('LR');
  const [selectedKey, setSelectedKey] = useState<string | undefined>('MIG-27');
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [modal, setModal] = useState<Modal>();

  const shown = useMemo(() => {
    const issues = statusFilter.length
      ? graph.issues.filter((issue) => statusFilter.includes(statusTone(issue))) : graph.issues;
    const keys = new Set(issues.map(({ key }) => key));
    const edges = graph.edges.filter((edge) => keys.has(edge.source) && keys.has(edge.target) &&
      (!linkFilter || edge.typeId === linkFilter || (linkFilter === 'parent' && edge.kind === 'parent')));
    return { ...graph, issues, edges };
  }, [graph, statusFilter, linkFilter]);
  const selected = shown.issues.find(({ key }) => key === selectedKey);
  const edge = shown.edges.find(({ id }) => id === selectedEdge);
  const points = shown.issues.reduce((sum, issue) => sum + (issue.storyPoints ?? 0), 0);
  const hasPoints = shown.issues.some(({ storyPoints }) => storyPoints !== undefined);
  const hasFilters = Boolean(linkFilter || statusFilter.length);

  function selectIssue(key?: string) {
    if (key && !shown.issues.some((issue) => issue.key === key)) setStatusFilter([]);
    setSelectedEdge(undefined);
    setSelectedKey(key);
  }
  function selectEdge(id: string) {
    setSelectedKey(undefined);
    setSelectedEdge(id);
  }
  function resetFilters() {
    setStatusFilter([]);
    setLinkFilter('');
  }
  function changeLayout() {
    setDirection((previous) => previous === 'LR' ? 'TB' : 'LR');
    setLayoutGeneration((previous) => previous + 1);
  }

  async function connect(credentials: JiraCredentials) {
    const result = await request('connect', credentials);
    setConnection(result);
    setModal(undefined);
    setGraph(emptyGraph);
    setJql('');
    setStoryField('');
    resetFilters();
    selectIssue();
    setLayoutGeneration((previous) => previous + 1);
    setNotice({ text: `Подключено как ${result.displayName}. Введи JQL или ключ задачи.` });
  }
  async function disconnect() {
    setBusy(true);
    try {
      await request('disconnect', null);
      setConnection(undefined);
      setGraph(demoGraph);
      setJql(demoQuery);
      setStoryField('');
      resetFilters();
      selectIssue('MIG-27');
      setNotice(undefined);
      setLayoutGeneration((previous) => previous + 1);
    } catch (cause) { setNotice({ text: errorMessage(cause), error: true }); }
    finally { setBusy(false); }
  }

  async function load(event?: FormEvent) {
    event?.preventDefault();
    const query = jql.trim();
    if (!connection || !query || busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await request('loadGraph', {
        jql: /^[A-Z][A-Z0-9_]*-\d+$/i.test(query) ? `key = "${query.toUpperCase()}"` : query,
        depth, storyPointsField: storyField.trim() || undefined,
      });
      setGraph(result);
      setLayoutGeneration((previous) => previous + 1);
      resetFilters();
      selectIssue(result.issues.some(({ key }) => key === selectedKey) ? selectedKey : undefined);
    } catch (cause) { setNotice({ text: errorMessage(cause), error: true }); }
    finally { setBusy(false); }
  }

  async function link(input: JiraLinkInput, data = graph) {
    const type = data.linkTypes.find(({ id }) => id === input.typeId);
    if (!type) throw new Error('Тип связи недоступен в Jira.');
    if (linkClosesCycle(data, input.source, input.target, type)) {
      throw new Error('Эта связь замыкает цикл в загруженном графе.');
    }
    const alreadyLinked = data.edges.some(({ source, target, typeId }) =>
      source === input.source && target === input.target && typeId === input.typeId);
    if (alreadyLinked) return;
    const saved = await request('createLink', input);
    const edge = saved ?? {
      id: `unconfirmed:${input.source}:${input.target}:${type.id}`, source: input.source, target: input.target,
      label: type.outward, kind: 'link', typeId: input.typeId,
    } satisfies JiraEdge;
    setGraph((previous) => previous.edges.some(({ id }) => id === edge.id)
      ? previous : { ...previous, edges: [...previous.edges, edge] });
    setLinkFilter('');
    if (!saved) setNotice({ text: 'Связь сохранена в Jira. Обнови граф, чтобы получить её идентификатор.' });
  }
  async function create(input: JiraIssueInput, source?: JiraIssue, typeId?: string) {
    let issue: JiraIssue;
    try {
      issue = await request('createIssue', input);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status && cause.status >= 400 && cause.status < 500 &&
          cause.status !== 408 && cause.status !== 409) throw cause;
      throw new IssueCreationUnconfirmed('Создание не подтверждено. Проверь в Jira, появилась ли задача, прежде чем повторять.');
    }
    const parent = input.fields?.parent;
    const parentKey = parent && typeof parent === 'object' && 'key' in parent && typeof parent.key === 'string'
      ? parent.key : undefined;
    setGraph((previous) => {
      const next = putIssue(previous, issue);
      if (!parentKey || !next.issues.some(({ key }) => key === parentKey)) return next;
      return { ...next, edges: [...next.edges, {
        id: `parent:${parentKey}:${issue.key}`, source: parentKey, target: issue.key,
        label: 'Родительская задача', kind: 'parent',
      }] };
    });
    selectIssue(issue.key);
    setModal(undefined);
    resetFilters();
    setNotice({ text: `Задача ${issue.key} создана в Jira.` });
    if (source && typeId) {
      const retry = { source: source.key, target: issue.key, typeId };
      setBusy(true);
      try { await link(retry, putIssue(graph, issue)); }
      catch (cause) { setNotice({ text: `${issue.key} создана. Связь: ${errorMessage(cause)}`, error: true, retry }); }
      finally { setBusy(false); }
    }
  }
  async function retryLink(input: JiraLinkInput) {
    setBusy(true);
    try {
      setNotice(undefined);
      await link(input);
    } catch (cause) { setNotice({ text: errorMessage(cause), error: true, retry: input }); }
    finally { setBusy(false); }
  }
  function editIssue(issue: JiraIssue) {
    setModal({ kind: 'edit', issue });
  }
  function addTask(source?: JiraIssue) {
    setModal(connection ? { kind: 'create', source } : { kind: 'connection' });
  }
  const project = selected?.project ?? /\bproject\s*=\s*"?([A-Z][A-Z0-9_]*)/i.exec(jql)?.[1] ?? '';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-icon"><GitMerge size={21} /></span><strong>Jira <span>DAG</span></strong></div>
        <div className="topbar-divider" />
        <span className="topbar-section">Граф зависимостей</span>
        <div className="topbar-actions">
          {connection ? <>
            <span className="connection-state" title={connection.url}><i />{connection.displayName}</span>
            <button className="icon-button" title="Отключить Jira" aria-label="Отключить Jira" disabled={busy}
              onClick={() => void disconnect()}><LogOut size={17} /></button>
          </> : <>
            <span className="demo-pill"><span /> Демо</span>
            <button className="button secondary" onClick={() => setModal({ kind: 'connection' })}><Link2 size={16} /> Подключить Jira</button>
          </>}
        </div>
      </header>
      <main className="workspace">
        <aside className="sidebar" aria-label="Настройки графа">
          <div className="sidebar-scroll">
            <form className="scope-form" onSubmit={(event) => void load(event)}>
              <h2><Crosshair size={16} /> Область графа</h2>
              <label htmlFor="jql">JQL или ключ задачи</label>
              <textarea id="jql" value={jql} onChange={(event) => setJql(event.target.value)}
                placeholder={'project = PROJ ORDER BY key ASC'} rows={3} spellCheck={false} />
              <div className="scope-row">
                <label htmlFor="depth" title="Сколько уровней связей догрузить за пределами выборки">Глубина связей</label>
                <select id="depth" value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                  <option value="0">Только выборка</option><option value="1">1 уровень</option>
                  <option value="2">2 уровня</option><option value="3">3 уровня</option>
                </select>
              </div>
              {graph.storyPointsFields.length > 1 && <label>Поле оценки
                <select value={storyField} onChange={(event) => setStoryField(event.target.value)}>
                  <option value="">Определять автоматически</option>
                  {graph.storyPointsFields.map(({ id, name }) => <option value={id} key={id}>{name} ({id})</option>)}
                </select>
              </label>}
              <button type={connection ? 'submit' : 'button'} className="button primary full" disabled={busy || (Boolean(connection) && !jql.trim())}
                onClick={connection ? undefined : () => setModal({ kind: 'connection' })}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <GitBranch size={15} />}
                {connection ? 'Загрузить граф' : 'Подключить для загрузки'}
              </button>
            </form>
            <div className="sidebar-line" />
            <section className="filters" aria-label="Фильтры">
              <div className="filter-heading"><h2><Filter size={16} /> Фильтры</h2>
                {hasFilters && <button className="text-button" onClick={resetFilters}>Сбросить</button>}</div>
              <label>Тип связи
                <select value={linkFilter} onChange={(event) => setLinkFilter(event.target.value)}>
                  <option value="">Все связи</option>
                  {graph.linkTypes.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
                  <option value="parent">Иерархия задач</option>
                </select>
              </label>
              <div className="filter-statuses"><span>Статус</span>
                {tones.map(({ value, label }) => <label className="status-check" key={value}>
                  <input type="checkbox" checked={statusFilter.includes(value)}
                    onChange={() => {
                      selectIssue();
                      setStatusFilter((previous) => previous.includes(value)
                        ? previous.filter((status) => status !== value) : [...previous, value]);
                    }} />
                  <i className={value} /><span>{label}</span><b>{graph.issues.filter((issue) => statusTone(issue) === value).length}</b>
                </label>)}
              </div>
            </section>
          </div>
          <div className="sidebar-foot"><Box size={15} /> {window.jiraDag ? 'Десктоп' : 'Веб-версия'}</div>
        </aside>
        <section className="graph-area" aria-label="Граф">
          <div className="graph-header">
            <div>
              <h1>{connection ? 'Граф зависимостей' : 'Миграция базы данных'}</h1>
              <div className="graph-stats">
                <span><Layers3 size={14} /> {shown.issues.length} задач</span>
                <span><GitBranch size={14} /> {shown.edges.length} связей</span>
                {hasPoints && <span className="stat-points">{points} SP</span>}
              </div>
            </div>
            <div className="graph-actions">
              <button className="icon-button outline" title={direction === 'LR' ? 'Раскладка сверху вниз' : 'Раскладка слева направо'}
                aria-label="Изменить направление раскладки" onClick={changeLayout}>
                {direction === 'LR' ? <ArrowDown size={18} /> : <ArrowRight size={18} />}
              </button>
              <button className="icon-button outline" title="Обновить граф" aria-label="Обновить граф"
                disabled={!connection || busy || !jql.trim()} onClick={() => void load()}><RefreshCw size={17} /></button>
              <button className="button primary" disabled={busy} onClick={() => addTask()}><Plus size={18} /> Новая задача</button>
            </div>
          </div>
          {graph.warnings.length > 0 && <details className="graph-warning">
            <summary><CircleAlert size={15} /> Граф загружен с ограничениями <ChevronDown size={14} /></summary>
            <ul>{graph.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </details>}
          <GraphCanvas key={layoutGeneration} graph={shown} direction={direction}
            selectedKey={selected?.key} selectedEdge={edge?.id} editable={Boolean(connection && !busy && graph.linkTypes.length)}
            onSelectIssue={selectIssue} onSelectEdge={selectEdge}
            onConnect={({ source, target }) => {
              if (source !== target) setModal({ kind: 'link', source, target });
            }} />
          {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
            {notice.error ? <CircleAlert size={17} /> : <Check size={17} />}
            <span>{notice.text}</span>
            {notice.retry && <button className="text-button" disabled={busy} onClick={() => void retryLink(notice.retry!)}>Повторить связь</button>}
            <button className="icon-button" aria-label="Закрыть уведомление" onClick={() => setNotice(undefined)}><X size={15} /></button>
          </div>}
        </section>
        {selected && <IssueInspector issue={selected} graph={graph} connected={Boolean(connection)} busy={busy}
          onClose={() => selectIssue()} onSelect={selectIssue} onAdd={() => addTask(selected)} onEdit={() => editIssue(selected)}
          onOpen={() => void openIssue(selected).catch((cause: unknown) => setNotice({ text: errorMessage(cause), error: true }))} />}
        {edge && <aside className="inspector" aria-label="Связь">
          <div className="inspector-heading"><h2><GitBranch size={16} /> Связь</h2>
            <button className="icon-button" aria-label="Закрыть сведения о связи" onClick={() => selectIssue()}><X size={17} /></button></div>
          <div className="inspector-content">
            <div className="edge-detail"><b>{edge.source}</b><span>{edge.label}</span><ArrowDown size={17} /><b>{edge.target}</b></div>
            {connection && edge.kind === 'link' && !edge.id.startsWith('unconfirmed:') && <button className="button danger full"
              disabled={busy} onClick={() => setModal({ kind: 'delete', edge })}><Trash2 size={16} /> Удалить связь</button>}
          </div>
        </aside>}
      </main>
      {modal?.kind === 'connection' && <ConnectionDialog onConnect={connect} onClose={() => setModal(undefined)} />}
      {modal?.kind === 'create' && <CreateDialog project={modal.source?.project ?? project} source={modal.source} types={graph.linkTypes}
        onCreate={(input, typeId) => create(input, modal.source, typeId)} onClose={() => setModal(undefined)} />}
      {modal?.kind === 'link' && <LinkDialog source={modal.source} target={modal.target} types={graph.linkTypes}
        onLink={async (typeId) => { await link({ source: modal.source, target: modal.target, typeId }); setModal(undefined); }}
        onClose={() => setModal(undefined)} />}
      {modal?.kind === 'edit' && <EditDialog issue={modal.issue} onClose={() => setModal(undefined)} onSave={async (input) => {
        const issue = await request('updateIssue', input);
        setGraph((previous) => ({
          ...previous,
          issues: previous.issues.map((item) => item.key !== input.key ? item : {
            ...item, summary: issue.summary,
            description: input.description === undefined ? item.description : issue.description ?? input.description,
          }),
        }));
        setModal(undefined);
        setNotice({ text: `Задача ${issue.key} обновлена.` });
      }} />}
      {modal?.kind === 'delete' && <DeleteDialog edge={modal.edge} onClose={() => setModal(undefined)} onDelete={async () => {
        await request('deleteLink', { id: modal.edge.id });
        setGraph((previous) => ({ ...previous, edges: previous.edges.filter(({ id }) => id !== modal.edge.id) }));
        setSelectedEdge(undefined);
        setModal(undefined);
        setNotice({ text: 'Связь удалена из Jira.' });
      }} />}
    </div>
  );
}

function IssueInspector({ issue, graph, connected, busy, onClose, onSelect, onAdd, onEdit, onOpen }: {
  issue: JiraIssue; graph: JiraGraph; connected: boolean; busy: boolean;
  onClose(): void; onSelect(key: string): void; onAdd(): void; onEdit(): void; onOpen(): void;
}) {
  const blockers = blockersFor(graph, issue.key);
  const linked = graph.edges.filter(({ source, target }) => source === issue.key || target === issue.key);
  return <aside className="inspector" aria-label="Сведения о задаче">
    <div className="inspector-heading"><h2><Layers3 size={16} /> Задача</h2>
      <button className="icon-button" aria-label="Закрыть сведения о задаче" onClick={onClose}><X size={17} /></button>
    </div>
    <div className="inspector-content">
      <div className="inspector-key">{issue.key}{issue.external && <span>Вне выборки</span>}</div>
      <h3>{issue.summary}</h3>
      <div className="inspector-metadata">
        <span className={`status ${statusTone(issue)}`}><CircleDot size={11} /> {issue.status}</span>
        {issue.storyPoints !== undefined && <span className="points">{issue.storyPoints} SP</span>}
      </div>
      {issue.assignee && <p className="assignee">{issue.assignee}</p>}
      {issue.description && <p className="issue-description">{issue.description}</p>}
      <section className="inspector-block">
        <h4>Открытые блокеры <b>{blockers.length}</b></h4>
        {blockers.length ? blockers.map((blocker) => <button className="related" key={blocker.key} onClick={() => onSelect(blocker.key)}>
          <span>{blocker.key}</span><small>{blocker.summary}</small><ArrowUpRight size={13} />
        </button>) : <p>В загруженном графе открытых блокеров нет.</p>}
      </section>
      <section className="inspector-block">
        <h4>Связи <b>{linked.length}</b></h4>
        {linked.map((link) => {
          const inward = link.target === issue.key;
          const key = inward ? link.source : link.target;
          const label = inward ? (graph.linkTypes.find(({ id }) => id === link.typeId)?.inward ??
            (link.kind === 'parent' ? 'дочерняя для' : link.label)) : link.label;
          return <button className="related" key={link.id} onClick={() => onSelect(key)}>
            <span>{key}</span><small>{label}</small><ArrowUpRight size={13} />
          </button>;
        })}
      </section>
      {connected && <div className="inspector-actions">
        <button className="button primary full" disabled={busy} onClick={onAdd}><Plus size={16} /> Следующий шаг</button>
        {!issue.external && <button className="button secondary full" disabled={busy} onClick={onEdit}>
          <Pencil size={15} /> Изменить задачу
        </button>}
        <button className="button secondary full" onClick={onOpen}><ArrowUpRight size={15} /> Открыть в Jira</button>
      </div>}
    </div>
  </aside>;
}

function EditDialog({ issue, onSave, onClose }: {
  issue: JiraIssue;
  onSave(input: { key: string; summary: string; description?: string }): Promise<void>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const summary = String(form.get('summary') ?? '').trim();
    const description = form.get('description');
    setBusy(true);
    setError('');
    try {
      await onSave({
        key: issue.key, summary,
        description: typeof description === 'string' && description !== (issue.description ?? '') ? description : undefined,
      });
    }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog title={`Изменить ${issue.key}`} onClose={onClose} busy={busy}>
    <form className="dialog-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <label>Название<input name="summary" defaultValue={issue.summary} required maxLength={255} /></label>
        {!issue.external && <label>Описание<textarea name="description" defaultValue={issue.description} rows={5} /></label>}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Отмена</button>
        <button className="button primary" disabled={busy}>Сохранить в Jira</button>
      </div>
    </form>
  </Dialog>;
}

function DeleteDialog({ edge, onDelete, onClose }: { edge: JiraEdge; onDelete(): Promise<void>; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title="Удалить связь из Jira?" onClose={onClose} busy={busy}>
    <div className="dialog-form">
      <p className="form-hint">{edge.source} {edge.label} {edge.target}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>Отмена</button>
        <button className="button danger" disabled={busy} onClick={async () => {
          setBusy(true);
          setError('');
          try { await onDelete(); } catch (cause) { setError(errorMessage(cause)); }
          finally { setBusy(false); }
        }}>Удалить связь</button>
      </div>
    </div>
  </Dialog>;
}
