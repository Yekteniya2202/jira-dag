import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUpRight, Box, Check, ChevronDown, CircleAlert, CircleDot, Crosshair,
  GitBranch, GitMerge, Layers3, Link2, LoaderCircle, LogOut, Pencil, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import type { JiraConnection, JiraEdge, JiraEdition, JiraGraph, JiraIssue, JiraIssueInput, JiraLinkInput, JiraLogin } from '../shared/contracts';
import { errorMessage, IssueCreationUnconfirmed, openIssue, request, RequestError, restoreDesktopConnection } from './api';
import { makeDemoGraph } from './demo';
import { ConnectionDialog, CreateDialog, Dialog, LinkDialog } from './dialogs';
import { emptyGraphFilters, filterGraph } from './filter-model';
import { GraphFilterPanel, GraphScopePresets } from './filters';
import { GraphCanvas, type CardFields } from './graph-canvas';
import { cyclicBlockingEdges, type GroupMode } from './graph-layout';
import { blockersFor, linkClosesCycle, mergeGraphs, putIssue, statusTone, tracePath, type Direction } from './graph-model';
import { GraphNotes } from './graph-notes';
import { localizeMessage, PreferenceControls, usePreferences } from './i18n';
import { defaultCardFields, GraphViewControls, type FocusMode } from './view-controls';

const emptyGraph: JiraGraph = { issues: [], edges: [], linkTypes: [], storyPointsFields: [], warnings: [] };
const demoQuery = 'project in (MIG, OPS) ORDER BY key ASC';

type Notice = { text: string; error?: boolean; retry?: JiraLinkInput };
type Modal = { kind: 'connection' } | { kind: 'create'; source?: JiraIssue } |
  { kind: 'link'; source: string; target: string } | { kind: 'edit'; issue: JiraIssue } |
  { kind: 'delete'; edge: JiraEdge };

const issueKey = /^[A-Z][A-Z0-9_]*-\d+$/i;

export function App() {
  const { language, t } = usePreferences();
  const [connection, setConnection] = useState<JiraConnection>();
  const [edition, setEdition] = useState<JiraEdition>('cloud');
  const [loadedGraph, setGraph] = useState(emptyGraph);
  const demoGraph = useMemo(() => makeDemoGraph(t), [t]);
  const graph = connection ? loadedGraph : demoGraph;
  const [jql, setJql] = useState(demoQuery);
  const [loadedQuery, setLoadedQuery] = useState('');
  const [includedKeys, setIncludedKeys] = useState<string[]>([]);
  const [depth, setDepth] = useState(1);
  const [storyField, setStoryField] = useState('');
  const [filters, setFilters] = useState(emptyGraphFilters);
  const [groupMode, setGroupMode] = useState<GroupMode>('hierarchy');
  const [fields, setFields] = useState<CardFields>(defaultCardFields);
  const [showEdgePoints, setShowEdgePoints] = useState(false);
  const [focusMode, setFocusMode] = useState<FocusMode>('all');
  const [direction, setDirection] = useState<Direction>('LR');
  const [selectedKey, setSelectedKey] = useState<string | undefined>('MIG-27');
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(window.jiraDag));
  const [notice, setNotice] = useState<Notice>();
  const [modal, setModal] = useState<Modal>();
  const [noteFocus, setNoteFocus] = useState<string>();
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({});

  const cycleIds = useMemo(() => cyclicBlockingEdges(graph), [graph]);
  const cycleExamples = useMemo(() => graph.edges.filter(({ id }) => cycleIds.has(id)).slice(0, 5), [cycleIds, graph.edges]);
  const filtered = useMemo(() => filterGraph(graph, filters), [graph, filters]);
  const shown = useMemo(() => {
    if (!selectedKey || focusMode === 'all' || !filtered.issues.some(({ key }) => key === selectedKey)) return filtered;
    const keys = new Set([selectedKey]);
    if (focusMode !== 'downstream') for (const key of tracePath(filtered.edges, selectedKey, 'up')) keys.add(key);
    if (focusMode !== 'upstream') for (const key of tracePath(filtered.edges, selectedKey, 'down')) keys.add(key);
    return {
      ...filtered, issues: filtered.issues.filter(({ key }) => keys.has(key)),
      edges: filtered.edges.filter(({ source, target }) => keys.has(source) && keys.has(target)),
    };
  }, [filtered, focusMode, selectedKey]);
  const selected = shown.issues.find(({ key }) => key === selectedKey);
  const edge = shown.edges.find(({ id }) => id === selectedEdge);
  const points = shown.issues.reduce((sum, issue) => sum + (issue.storyPoints ?? 0), 0);
  const hasPoints = shown.issues.some(({ storyPoints }) => storyPoints !== undefined);
  const completed = shown.issues.filter((issue) => statusTone(issue) === 'done').length;
  const updateNoteCount = useCallback((key: string, count: number) => {
    setNoteCounts((previous) => previous[key] === count ? previous : { ...previous, [key]: count });
  }, []);
  useEffect(() => {
    if (!connection) setFilters(emptyGraphFilters);
  }, [connection, language]);
  useEffect(() => {
    if (!window.jiraDag) return;
    let mounted = true;
    void restoreDesktopConnection().then((restored) => {
      if (!mounted || !restored) return;
      setConnection(restored.connection);
      setEdition(restored.edition);
      setJql('');
      setSelectedKey(undefined);
    }).catch((cause: unknown) => {
      if (!mounted) return;
      const text = cause instanceof RequestError && cause.status === 401
        ? 'Jira rejected the saved login. Sign in again.'
        : 'Could not restore the saved Jira connection.';
      setNotice({ text, error: true });
    }).finally(() => {
      if (mounted) setRestoring(false);
    });
    return () => { mounted = false; };
  }, []);

  function selectIssue(key?: string) {
    if (key && !filtered.issues.some((issue) => issue.key === key)) setFilters(emptyGraphFilters);
    setSelectedEdge(undefined);
    setSelectedKey(key);
    setNoteFocus(undefined);
    if (!key) setFocusMode('all');
  }
  function selectEdge(id: string) {
    setSelectedKey(undefined);
    setSelectedEdge(id);
    setNoteFocus(undefined);
    setFocusMode('all');
  }
  function resetFilters() {
    setFilters(emptyGraphFilters);
    setFocusMode('all');
  }
  function changeLayout() {
    setDirection((previous) => previous === 'LR' ? 'TB' : 'LR');
    setLayoutGeneration((previous) => previous + 1);
  }

  async function connect(credentials: JiraLogin) {
    const result = await request('connect', credentials);
    setConnection(result);
    setEdition(credentials.edition);
    setModal(undefined);
    setGraph(emptyGraph);
    setNoteCounts({});
    setIncludedKeys([]);
    setLoadedQuery('');
    setJql('');
    setStoryField('');
    resetFilters();
    selectIssue();
    setLayoutGeneration((previous) => previous + 1);
    setNotice(result.rememberFailed
      ? { text: 'Connected. Could not update the saved Jira connection.', error: true }
      : { text: t(`Подключено как ${result.displayName}. Введи JQL или ключ задачи.`, `Connected as ${result.displayName}. Enter JQL or an issue key.`) });
  }
  async function disconnect() {
    setBusy(true);
    try {
      await request('disconnect', null);
      setConnection(undefined);
      setGraph(emptyGraph);
      setNoteCounts({});
      setIncludedKeys([]);
      setLoadedQuery('');
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
      const normalized = issueKey.test(query) ? `key = "${query.toUpperCase()}"` : query;
      const graphOptions = { depth, storyPointsField: storyField.trim() || undefined };
      const pins = normalized === loadedQuery ? includedKeys : [];
      const additional = pins.length
        ? request('loadGraph', { ...graphOptions, jql: `key in (${pins.map((key) => `"${key}"`).join(', ')})` }).catch(() => null)
        : undefined;
      let result = await request('loadGraph', { ...graphOptions, jql: normalized });
      if (additional) {
        const pinned = await additional;
        result = pinned ? mergeGraphs(result, pinned) : {
          ...result, warnings: [...result.warnings, t('Не удалось обновить добавленные вручную задачи.', 'Could not reload the manually included issues.')],
        };
      }
      setLoadedQuery(normalized);
      setIncludedKeys(pins);
      setGraph(result);
      setLayoutGeneration((previous) => previous + 1);
      if (!result.issues.some(({ key }) => key === selectedKey)) selectIssue();
    } catch (cause) { setNotice({ text: errorMessage(cause), error: true }); }
    finally { setBusy(false); }
  }

  async function includeIssue(raw: string) {
    const key = raw.trim().toUpperCase();
    if (!connection || busy) return;
    if (!issueKey.test(key)) throw new Error(t('Введи ключ Jira, например PROJ-123.', 'Enter a Jira key such as PROJ-123.'));
    setBusy(true);
    try {
      const result = await request('loadGraph', { jql: `key = "${key}"`, depth, storyPointsField: storyField || undefined });
      if (!result.issues.some((issue) => issue.key === key)) throw new Error(t('Задача не найдена или недоступна.', 'The issue was not found or is unavailable.'));
      setGraph((previous) => mergeGraphs(previous, result));
      setIncludedKeys((previous) => previous.includes(key) ? previous : [...previous, key]);
      resetFilters();
      selectIssue(key);
      setNotice({ text: t(`${key} добавлена на граф.`, `${key} added to the graph.`) });
    } finally { setBusy(false); }
  }

  async function link(input: JiraLinkInput, data = graph) {
    const type = data.linkTypes.find(({ id }) => id === input.typeId);
    if (!type) throw new Error(t('Тип связи недоступен в Jira.', 'This link type is unavailable in Jira.'));
    if (linkClosesCycle(data, input.source, input.target, type)) {
      throw new Error(t('Эта связь замыкает цикл в загруженном графе.', 'This link creates a cycle in the loaded graph.'));
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
    setFilters((previous) => ({ ...previous, edgeTypes: [] }));
    if (!saved) setNotice({ text: t('Связь сохранена в Jira. Обнови граф, чтобы получить её идентификатор.', 'The link was saved in Jira. Reload the graph to get its ID.') });
  }
  async function create(input: JiraIssueInput, source?: JiraIssue, typeId?: string) {
    let issue: JiraIssue;
    try {
      issue = await request('createIssue', input);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status && cause.status >= 400 && cause.status < 500 &&
          cause.status !== 408 && cause.status !== 409) throw cause;
      throw new IssueCreationUnconfirmed(t('Создание не подтверждено. Проверь в Jira, появилась ли задача, прежде чем повторять.',
        'Creation could not be confirmed. Check whether the issue exists in Jira before retrying.'));
    }
    const parent = input.fields?.parent;
    const parentKey = issue.parentKey ?? (parent && typeof parent === 'object' && 'key' in parent && typeof parent.key === 'string'
      ? parent.key : undefined);
    setGraph((previous) => {
      const next = putIssue(previous, issue);
      if (!parentKey || !next.issues.some(({ key }) => key === parentKey)) return next;
      return { ...next, edges: [...next.edges, {
        id: `parent:${parentKey}:${issue.key}`, source: parentKey, target: issue.key,
        label: 'Родительская задача', kind: 'parent',
      }] };
    });
    selectIssue(issue.key);
    if (issueKey.test(issue.key)) setIncludedKeys((previous) => previous.includes(issue.key) ? previous : [...previous, issue.key]);
    setModal(undefined);
    resetFilters();
    setNotice({ text: t(`Задача ${issue.key} создана в Jira.`, `Issue ${issue.key} created in Jira.`) });
    if (source && typeId) {
      const retry = { source: source.key, target: issue.key, typeId };
      setBusy(true);
      try { await link(retry, putIssue(graph, issue)); }
      catch (cause) {
        const message = localizeMessage(errorMessage(cause), language);
        setNotice({ text: t(`Задача ${issue.key} создана. Связь: ${message}`, `Issue ${issue.key} created. Link: ${message}`), error: true, retry });
      }
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
    if (restoring) return;
    setModal(connection ? { kind: 'create', source } : { kind: 'connection' });
  }
  function launchIssue(issue: JiraIssue) {
    void openIssue(issue).catch((cause: unknown) => setNotice({ text: errorMessage(cause), error: true }));
  }
  const project = selected?.project ?? /\bproject\s*=\s*"?([A-Z][A-Z0-9_]*)/i.exec(jql)?.[1] ?? '';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon"><GitMerge size={21} /></span>
          <div className="brand-wordmark">
            <strong>Jira <span>DAG</span></strong>
            <span className="app-version" title={t('Версия приложения', 'Application version')}>v{__APP_VERSION__}</span>
          </div>
        </div>
        <div className="topbar-divider" />
        <span className="topbar-section">{t('Граф зависимостей', 'Dependency graph')}</span>
        <div className="topbar-actions">
          <PreferenceControls />
          {connection ? <>
            <span className="connection-state" title={connection.url}><i />{connection.displayName}</span>
            <button className="icon-button" title={window.jiraDag
              ? t('Отключить Jira и удалить сохранённый вход', 'Disconnect Jira and clear saved sign-in')
              : t('Отключить Jira', 'Disconnect Jira')} aria-label={t('Отключить Jira', 'Disconnect Jira')} disabled={busy}
              onClick={() => void disconnect()}><LogOut size={17} /></button>
          </> : <>
            <span className="demo-pill"><span /> {t('Демо', 'Demo')}</span>
            <button className="button secondary" disabled={restoring} onClick={() => setModal({ kind: 'connection' })}>
              {restoring ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />}
              {restoring ? t('Восстановление входа', 'Restoring sign-in') : t('Подключить Jira', 'Connect Jira')}
            </button>
          </>}
        </div>
      </header>
      <main className="workspace">
        <aside className="sidebar" aria-label={t('Настройки графа', 'Graph settings')}>
          <div className="sidebar-scroll">
            <form className="scope-form" onSubmit={(event) => void load(event)}>
              <h2><Crosshair size={16} /> {t('Область графа', 'Graph scope')}</h2>
              <GraphScopePresets key={connection?.url ?? 'demo'} connected={Boolean(connection)} edition={edition} onApply={setJql} />
              <label htmlFor="jql">{t('JQL или ключ задачи', 'JQL or issue key')}</label>
              <textarea id="jql" value={jql} onChange={(event) => setJql(event.target.value)}
                placeholder={'project = PROJ ORDER BY key ASC'} rows={3} spellCheck={false} />
              <div className="scope-row">
                <label htmlFor="depth" title={t('Сколько уровней связей догрузить за пределами выборки', 'How far to expand links beyond the query')}>{t('Глубина связей', 'Link depth')}</label>
                <select id="depth" value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                  <option value="0">{t('Только выборка', 'Query only')}</option><option value="1">{t('1 уровень', '1 level')}</option>
                  <option value="2">{t('2 уровня', '2 levels')}</option><option value="3">{t('3 уровня', '3 levels')}</option>
                </select>
              </div>
              {graph.storyPointsFields.length > 1 && <label>{t('Поле оценки', 'Estimation field')}
                <select value={storyField} onChange={(event) => setStoryField(event.target.value)}>
                  <option value="">{t('Определять автоматически', 'Detect automatically')}</option>
                  {graph.storyPointsFields.map(({ id, name }) => <option value={id} key={id}>{name} ({id})</option>)}
                </select>
              </label>}
              <button type={connection ? 'submit' : 'button'} className="button primary full" disabled={busy || restoring || (Boolean(connection) && !jql.trim())}
                onClick={connection ? undefined : () => setModal({ kind: 'connection' })}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <GitBranch size={15} />}
                {connection ? t('Загрузить граф', 'Load graph') : t('Подключить для загрузки', 'Connect to load')}
              </button>
            </form>
            <div className="sidebar-line" />
            <GraphFilterPanel graph={graph} filters={filters} onChange={setFilters} />
          </div>
          <div className="sidebar-foot"><Box size={15} /> {window.jiraDag ? t('Десктоп', 'Desktop') : t('Веб-версия', 'Web')}</div>
        </aside>
        <section className="graph-area" aria-label={t('Граф', 'Graph')}>
          <div className="graph-header">
            <div>
              <h1>{connection ? t('Граф зависимостей', 'Dependency graph') : t('Миграция базы данных', 'Database migration')}</h1>
              <div className="graph-stats">
                <span><Layers3 size={14} /> {t(`Задачи ${shown.issues.length}`, `Issues ${shown.issues.length}`)}</span>
                <span><GitBranch size={14} /> {t(`Связи ${shown.edges.length}`, `Links ${shown.edges.length}`)}</span>
                {hasPoints && <span className="stat-points">{points} SP</span>}
                {shown.issues.length > 0 && <span className="stat-progress" title={t('Выполнено задач', 'Completed issues')}>
                  <Check size={14} /> {completed}/{shown.issues.length}
                </span>}
              </div>
            </div>
            <div className="graph-actions">
              <button className="icon-button outline" title={direction === 'LR'
                ? t('Раскладка сверху вниз', 'Top-to-bottom layout') : t('Раскладка слева направо', 'Left-to-right layout')}
                aria-label={t('Изменить направление раскладки', 'Change layout direction')} onClick={changeLayout}>
                {direction === 'LR' ? <ArrowDown size={18} /> : <ArrowRight size={18} />}
              </button>
              <button className="icon-button outline" title={t('Обновить граф', 'Reload graph')} aria-label={t('Обновить граф', 'Reload graph')}
                disabled={!connection || busy || !jql.trim()} onClick={() => void load()}><RefreshCw size={17} /></button>
              <button className="button primary" disabled={busy || restoring} onClick={() => addTask()}><Plus size={18} /> {t('Новая задача', 'New issue')}</button>
            </div>
          </div>
          <GraphViewControls groupMode={groupMode} onGroupMode={(mode) => {
            setGroupMode(mode);
            setLayoutGeneration((generation) => generation + 1);
          }} fields={fields} onFields={setFields} showEdgePoints={showEdgePoints} onShowEdgePoints={setShowEdgePoints}
          focusMode={focusMode} onFocusMode={setFocusMode} selected={Boolean(selected)}
          connected={Boolean(connection)} busy={busy} onInclude={includeIssue} />
          {graph.warnings.length > 0 && <details className="graph-warning">
            <summary><CircleAlert size={15} /> {t('Граф загружен с ограничениями', 'Graph loaded with limitations')} <ChevronDown size={14} /></summary>
            <ul>{graph.warnings.map((warning) => <li key={warning}>{localizeMessage(warning, language)}</li>)}</ul>
          </details>}
          <div className={cycleIds.size > 0 ? 'graph-warning graph-cycle-warning' : undefined}>
            <div className="graph-cycle-status" role="status">
              {cycleIds.size > 0 && <>
                <CircleAlert size={16} aria-hidden="true" />
                <div>
                  <strong>{t('Обнаружен цикл блокирующих зависимостей.', 'A blocking dependency cycle was detected.')}</strong>{' '}
                  {t(`Связей в циклах — ${cycleIds.size}.`, `Links in cycles: ${cycleIds.size}.`)}
                </div>
              </>}
            </div>
            {cycleIds.size > 0 && <details>
              <summary>{t('Посмотреть связи', 'View affected links')}</summary>
              <ul>{cycleExamples.map(({ id, source, target }) => <li key={id}>{source} → {target}</li>)}</ul>
              {cycleIds.size > cycleExamples.length && <span>{t(
                `Ещё связей в циклах — ${cycleIds.size - cycleExamples.length}.`,
                `More links in cycles: ${cycleIds.size - cycleExamples.length}.`,
              )}</span>}
            </details>}
          </div>
          <GraphCanvas key={layoutGeneration} graph={shown} basis={graph} cycleIds={cycleIds} direction={direction} groupMode={groupMode}
            fields={fields} showEdgePoints={showEdgePoints} connected={Boolean(connection)} noteCounts={noteCounts}
            selectedKey={selected?.key} selectedEdge={edge?.id} editable={Boolean(connection && !busy && graph.linkTypes.length)}
            onSelectIssue={selectIssue} onSelectEdge={selectEdge} onOpenIssue={launchIssue}
            onNoteIssue={(key) => { selectIssue(key); setNoteFocus(key); }}
            onConnect={({ source, target }) => {
              if (source !== target) setModal({ kind: 'link', source, target });
            }} />
          {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
            {notice.error ? <CircleAlert size={17} /> : <Check size={17} />}
            <span>{localizeMessage(notice.text, language)}</span>
            {notice.retry && <button className="text-button" disabled={busy} onClick={() => void retryLink(notice.retry!)}>{t('Повторить связь', 'Retry link')}</button>}
            <button className="icon-button" aria-label={t('Закрыть уведомление', 'Dismiss notification')} onClick={() => setNotice(undefined)}><X size={15} /></button>
          </div>}
        </section>
        {selected && <IssueInspector issue={selected} graph={graph} connected={Boolean(connection)} busy={busy}
          noteFocus={noteFocus === selected.key} onNoteCount={updateNoteCount}
          onClose={() => selectIssue()} onSelect={selectIssue} onAdd={() => addTask(selected)} onEdit={() => editIssue(selected)}
          onOpen={() => launchIssue(selected)} />}
        {edge && <aside className="inspector" aria-label={t('Связь', 'Link')}>
          <div className="inspector-heading"><h2><GitBranch size={16} /> {t('Связь', 'Link')}</h2>
            <button className="icon-button" aria-label={t('Закрыть сведения о связи', 'Close link details')} onClick={() => selectIssue()}><X size={17} /></button></div>
          <div className="inspector-content">
            <div className="edge-detail"><b>{edge.source}</b>
              <span>{edge.kind === 'parent' ? t('Родительская задача', 'Parent issue') : edge.label}</span>
              <ArrowDown size={17} /><b>{edge.target}</b>
            </div>
            {connection && edge.kind === 'link' && !edge.id.startsWith('unconfirmed:') && <button className="button danger full"
              disabled={busy} onClick={() => setModal({ kind: 'delete', edge })}><Trash2 size={16} /> {t('Удалить связь', 'Delete link')}</button>}
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
        setNotice({ text: t(`Задача ${issue.key} обновлена.`, `Issue ${issue.key} updated.`) });
      }} />}
      {modal?.kind === 'delete' && <DeleteDialog edge={modal.edge} onClose={() => setModal(undefined)} onDelete={async () => {
        await request('deleteLink', { id: modal.edge.id });
        setGraph((previous) => ({ ...previous, edges: previous.edges.filter(({ id }) => id !== modal.edge.id) }));
        setSelectedEdge(undefined);
        setModal(undefined);
        setNotice({ text: t('Связь удалена из Jira.', 'Link deleted from Jira.') });
      }} />}
    </div>
  );
}

function IssueInspector({ issue, graph, connected, busy, noteFocus, onNoteCount, onClose, onSelect, onAdd, onEdit, onOpen }: {
  issue: JiraIssue; graph: JiraGraph; connected: boolean; busy: boolean;
  noteFocus: boolean; onNoteCount(key: string, count: number): void;
  onClose(): void; onSelect(key: string): void; onAdd(): void; onEdit(): void; onOpen(): void;
}) {
  const { t } = usePreferences();
  const blockers = blockersFor(graph, issue.key);
  const linked = graph.edges.filter(({ source, target }) => source === issue.key || target === issue.key);
  return <aside className="inspector" aria-label={t('Сведения о задаче', 'Issue details')}>
    <div className="inspector-heading"><h2><Layers3 size={16} /> {t('Задача', 'Issue')}</h2>
      <button className="icon-button" aria-label={t('Закрыть сведения о задаче', 'Close issue details')} onClick={onClose}><X size={17} /></button>
    </div>
    <div className="inspector-content">
      <div className="inspector-key">{issue.key}{issue.external && <span>{t('Вне выборки', 'Outside query')}</span>}</div>
      <h3>{issue.summary}</h3>
      <div className="inspector-metadata">
        <span className={`status ${statusTone(issue)}`}><CircleDot size={11} /> {issue.status}</span>
        {issue.storyPoints !== undefined && <span className="points">{issue.storyPoints} SP</span>}
      </div>
      {issue.assignee && <p className="assignee">{issue.assignee}</p>}
      {!!issue.labels?.length && <p className="assignee">{issue.labels.map((label) => `#${label}`).join(' ')}</p>}
      {issue.description && <p className="issue-description">{issue.description}</p>}
      <section className="inspector-block">
        <h4>{t('Открытые блокеры', 'Open blockers')} <b>{blockers.length}</b></h4>
        {blockers.length ? blockers.map((blocker) => <button className="related" key={blocker.key} onClick={() => onSelect(blocker.key)}>
          <span>{blocker.key}</span><small>{blocker.summary}</small><ArrowUpRight size={13} />
        </button>) : <p>{t('В загруженном графе открытых блокеров нет.', 'No open blockers in the loaded graph.')}</p>}
      </section>
      <section className="inspector-block">
        <h4>{t('Связи', 'Links')} <b>{linked.length}</b></h4>
        {linked.map((link) => {
          const inward = link.target === issue.key;
          const key = inward ? link.source : link.target;
          const label = link.kind === 'parent'
            ? (inward ? t('дочерняя для', 'child of') : t('родительская для', 'parent of'))
            : (inward ? graph.linkTypes.find(({ id }) => id === link.typeId)?.inward ?? link.label : link.label);
          return <button className="related" key={link.id} onClick={() => onSelect(key)}>
            <span>{key}</span><small>{label}</small><ArrowUpRight size={13} />
          </button>;
        })}
      </section>
      {connected && <div className="inspector-actions">
        <button className="button primary full" disabled={busy} onClick={onAdd}><Plus size={16} /> {t('Следующий шаг', 'Next step')}</button>
        {!issue.external && <button className="button secondary full" disabled={busy} onClick={onEdit}>
          <Pencil size={15} /> {t('Изменить задачу', 'Edit issue')}
        </button>}
        <button className="button secondary full" onClick={onOpen}><ArrowUpRight size={15} /> {t('Открыть в Jira', 'Open in Jira')}</button>
      </div>}
      {connected && <GraphNotes key={issue.key} issueKey={issue.key} focus={noteFocus} onCount={onNoteCount} />}
    </div>
  </aside>;
}

function EditDialog({ issue, onSave, onClose }: {
  issue: JiraIssue;
  onSave(input: { key: string; summary: string; description?: string }): Promise<void>;
  onClose(): void;
}) {
  const { language, t } = usePreferences();
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
  return <Dialog title={t(`Изменить ${issue.key}`, `Edit ${issue.key}`)} onClose={onClose} busy={busy}>
    <form className="dialog-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <label>{t('Название', 'Summary')}<input name="summary" defaultValue={issue.summary} required maxLength={255} /></label>
        {!issue.external && <label>{t('Описание', 'Description')}<textarea name="description" defaultValue={issue.description} rows={5} /></label>}
      </fieldset>
      {error && <p className="form-error" role="alert">{localizeMessage(error, language)}</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        <button className="button primary" disabled={busy}>{t('Сохранить в Jira', 'Save to Jira')}</button>
      </div>
    </form>
  </Dialog>;
}

function DeleteDialog({ edge, onDelete, onClose }: { edge: JiraEdge; onDelete(): Promise<void>; onClose(): void }) {
  const { language, t } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title={t('Удалить связь из Jira?', 'Delete this link from Jira?')} onClose={onClose} busy={busy}>
    <div className="dialog-form">
      <p className="form-hint">{edge.source} {edge.label} {edge.target}</p>
      {error && <p className="form-error" role="alert">{localizeMessage(error, language)}</p>}
      <div className="dialog-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        <button className="button danger" disabled={busy} onClick={async () => {
          setBusy(true);
          setError('');
          try { await onDelete(); } catch (cause) { setError(errorMessage(cause)); }
          finally { setBusy(false); }
        }}>{t('Удалить связь', 'Delete link')}</button>
      </div>
    </div>
  </Dialog>;
}
