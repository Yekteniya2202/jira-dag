import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import {
  ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleAlert, CircleDot, Crosshair, Download, FileText,
  GitBranch, GitMerge, Layers3, Link2, LoaderCircle, LogOut, PanelLeft, PanelRight, Pencil, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import type { JiraConnection, JiraEdge, JiraEdition, JiraGraph, JiraGraphNote, JiraIssue, JiraIssueInput, JiraLinkInput, JiraLogin } from '../shared/contracts';
import { errorMessage, IssueCreationUnconfirmed, openIssue, request, RequestError, restoreDesktopConnection } from './api';
import { makeDemoGraph } from './demo';
import { ConnectionDialog, CreateDialog, Dialog, LinkDialog } from './dialogs';
import { appendJqlClauses, emptyGraphFilters, filterGraph, graphFacets, highlightedIssueKeys, jiraFacetClause, scopeJql, sprintFacetId, type GraphFilters } from './filter-model';
import { GraphFilterPanel, GraphJqlFilters, GraphScopePresets } from './filters';
import { GraphCanvas, type CardFields } from './graph-canvas';
import { exportGraph, type GraphExportFormat } from './graph-export';
import { cyclicBlockingEdges, type GroupMode } from './graph-layout';
import { assigneeInitials, blockersFor, linkClosesCycle, mergeGraphs, putIssue, statusTone, tracePath, type Direction } from './graph-model';
import { GraphNotes, type NoteFocus } from './graph-notes';
import { localizeMessage, PreferenceControls, usePreferences } from './i18n';
import { PanelSplitter } from './panel-splitter';
import { defaultCardFields, GraphViewControls, type FocusMode } from './view-controls';

const emptyGraph: JiraGraph = { issues: [], edges: [], linkTypes: [], storyPointsFields: [], warnings: [] };
const demoQuery = 'project in (MIG, OPS) ORDER BY key ASC';
const DescriptionDialog = lazy(() => import('./description-dialog'));

type Notice = { text: string; error?: boolean; retry?: JiraLinkInput };
type Modal = { kind: 'create'; source?: JiraIssue } |
  { kind: 'link'; source: string; target: string } | { kind: 'edit'; issue: JiraIssue } |
  { kind: 'description'; issue: JiraIssue } | { kind: 'delete'; edge: JiraEdge };

const issueKey = /^[A-Z][A-Z0-9_]*-\d+$/i;

function restrictGraph(graph: JiraGraph, keys: ReadonlySet<string>): JiraGraph {
  return {
    ...graph,
    issues: graph.issues.filter(({ key }) => keys.has(key)),
    edges: graph.edges.filter(({ source, target }) => keys.has(source) && keys.has(target)),
  };
}

type GraphTab = { id: number; query?: string; project?: string };
const initialTabs: GraphTab[] = [{ id: 1 }];
const graphTabId = (id: number) => `graph-tab-${id}`;
const graphPanelId = (id: number) => `graph-panel-${id}`;

export function App() {
  const { t } = usePreferences();
  const [connection, setConnection] = useState<JiraConnection>();
  const [edition, setEdition] = useState<JiraEdition>('cloud');
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTab, setActiveTab] = useState(1);
  const nextTabId = useRef(2);
  const [busyTabs, setBusyTabs] = useState<number[]>([]);
  const [disconnecting, setDisconnecting] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(window.jiraDag));
  const [connectionDialog, setConnectionDialog] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<Notice>();

  useEffect(() => {
    if (!window.jiraDag) return;
    let mounted = true;
    void restoreDesktopConnection().then((restored) => {
      if (!mounted || !restored) return;
      setConnection(restored.connection);
      setEdition(restored.edition);
      setTabs(initialTabs);
      setActiveTab(1);
      nextTabId.current = 2;
    }).catch((cause: unknown) => {
      if (!mounted) return;
      const text = cause instanceof RequestError && cause.status === 401
        ? 'Jira rejected the saved login. Sign in again.'
        : 'Could not restore the saved Jira connection.';
      setSessionNotice({ text, error: true });
    }).finally(() => {
      if (mounted) setRestoring(false);
    });
    return () => { mounted = false; };
  }, []);

  function resetTabs() {
    setTabs(initialTabs);
    setActiveTab(1);
    nextTabId.current = 2;
  }

  async function connect(credentials: JiraLogin) {
    const result = await request('connect', credentials);
    setConnection(result);
    setEdition(credentials.edition);
    setConnectionDialog(false);
    resetTabs();
    setSessionNotice(result.rememberFailed
      ? { text: 'Connected. Could not update the saved Jira connection.', error: true }
      : { text: t(`Подключено как ${result.displayName}. Введи JQL или ключ задачи.`, `Connected as ${result.displayName}. Enter JQL or an issue key.`) });
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      await request('disconnect', null);
      setConnection(undefined);
      resetTabs();
      setSessionNotice(undefined);
    } catch (cause) {
      setSessionNotice({ text: errorMessage(cause), error: true });
    } finally {
      setDisconnecting(false);
    }
  }

  function openTab() {
    const id = nextTabId.current++;
    setTabs((previous) => [...previous, { id }]);
    setActiveTab(id);
    requestAnimationFrame(() => document.getElementById(graphTabId(id))?.focus());
  }

  function closeTab() {
    const index = tabs.findIndex(({ id }) => id === activeTab);
    const next = tabs[index + 1] ?? tabs[index - 1];
    if (!next || busyTabs.includes(activeTab)) return;
    setTabs((previous) => previous.filter(({ id }) => id !== activeTab));
    setActiveTab(next.id);
    requestAnimationFrame(() => document.getElementById(graphTabId(next.id))?.focus());
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1 : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = tabs[nextIndex].id;
    setActiveTab(next);
    document.getElementById(graphTabId(next))?.focus();
  }

  function tabBusy(id: number, value: boolean) {
    setBusyTabs((previous) => {
      if (value === previous.includes(id)) return previous;
      return value ? [...previous, id] : previous.filter((tabId) => tabId !== id);
    });
  }

  return <div className="app">
    <header className="topbar">
      <div className="brand">
        <span className="brand-icon"><GitMerge size={21} /></span>
        <div className="brand-wordmark">
          <strong>Jira <span>DAG</span></strong>
          <span className="app-version" title={t('Версия приложения', 'Application version')}>v{__APP_VERSION__}</span>
        </div>
      </div>
      <div className="workspace-tabs">
        <div className="workspace-tablist" role="tablist" aria-label={t('Графы', 'Graphs')}>
          {tabs.map((tab, index) => <button key={tab.id} type="button" id={graphTabId(tab.id)}
            role="tab" aria-selected={activeTab === tab.id} aria-controls={graphPanelId(tab.id)}
            tabIndex={activeTab === tab.id ? 0 : -1} title={tab.query}
            onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => navigateTabs(event, index)}>
            {t(`Граф ${tab.id}`, `Graph ${tab.id}`)}{tab.project && ` · ${tab.project}`}
          </button>)}
        </div>
        <button className="icon-button" type="button" aria-label={t('Новая вкладка', 'New graph tab')}
          title={t('Новая вкладка', 'New graph tab')} disabled={restoring || disconnecting} onClick={openTab}><Plus size={16} /></button>
        {tabs.length > 1 && <button className="icon-button" type="button" aria-label={t('Закрыть вкладку', 'Close graph tab')}
          title={t('Закрыть вкладку', 'Close graph tab')} disabled={busyTabs.includes(activeTab)} onClick={closeTab}><X size={15} /></button>}
      </div>
      <div className="topbar-actions">
        <PreferenceControls />
        {connection ? <>
          <span className="connection-state" title={connection.url}><i />{connection.displayName}</span>
          <button className="icon-button" title={window.jiraDag
            ? t('Отключить Jira и удалить сохранённый вход', 'Disconnect Jira and clear saved sign-in')
            : t('Отключить Jira', 'Disconnect Jira')} aria-label={t('Отключить Jira', 'Disconnect Jira')}
            disabled={disconnecting || busyTabs.length > 0} onClick={() => void disconnect()}><LogOut size={17} /></button>
        </> : <>
          <span className="demo-pill"><span /> {t('Демо', 'Demo')}</span>
          <button className="button secondary" disabled={restoring} onClick={() => setConnectionDialog(true)}>
            {restoring ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />}
            {restoring ? t('Восстановление входа', 'Restoring sign-in') : t('Подключить Jira', 'Connect Jira')}
          </button>
        </>}
      </div>
    </header>
    <main className="workspace-deck">
      {tabs.map((tab) => <ReactFlowProvider key={`${connection?.url ?? 'demo'}:${tab.id}`}>
        <GraphWorkspace tabId={tab.id} active={activeTab === tab.id} connection={connection} edition={edition}
          sessionBusy={restoring || disconnecting} sessionNotice={sessionNotice}
          onRequestConnection={() => setConnectionDialog(true)} onDismissSessionNotice={() => setSessionNotice(undefined)}
          onBusyChange={(value) => tabBusy(tab.id, value)}
          onLoad={(query, project) => setTabs((previous) => previous.map((item) =>
            item.id === tab.id ? { ...item, query, project } : item))} />
      </ReactFlowProvider>)}
    </main>
    {connectionDialog && <ConnectionDialog onConnect={connect} onClose={() => setConnectionDialog(false)} />}
  </div>;
}

function GraphWorkspace({
  tabId, active, connection, edition, sessionBusy, sessionNotice, onRequestConnection, onDismissSessionNotice, onBusyChange, onLoad,
}: {
  tabId: number;
  active: boolean;
  connection?: JiraConnection;
  edition: JiraEdition;
  sessionBusy: boolean;
  sessionNotice?: Notice;
  onRequestConnection(): void;
  onDismissSessionNotice(): void;
  onBusyChange(value: boolean): void;
  onLoad(query: string, project?: string): void;
}) {
  const { language, t } = usePreferences();
  const formId = useId();
  const graphArea = useRef<HTMLElement>(null);
  const flow = useReactFlow();
  const [loadedGraph, setGraph] = useState(emptyGraph);
  const demoGraph = useMemo(() => makeDemoGraph(t), [t]);
  const graph = connection ? loadedGraph : demoGraph;
  const [baseJql, setBaseJql] = useState(connection ? '' : demoQuery);
  const [projectKey, setProjectKey] = useState('');
  const [jiraFacets, setJiraFacets] = useState<GraphFilters['facets']>({});
  const [loadedQuery, setLoadedQuery] = useState('');
  const [queryIssueKeys, setQueryIssueKeys] = useState<ReadonlySet<string>>(new Set());
  const [loadedSprintIds, setLoadedSprintIds] = useState<string[]>([]);
  const [includedKeys, setIncludedKeys] = useState<string[]>([]);
  const [depth, setDepth] = useState(0);
  const [storyField, setStoryField] = useState('');
  const [filters, setFilters] = useState(emptyGraphFilters);
  const [groupMode, setGroupMode] = useState<GroupMode>('hierarchy');
  const [fields, setFields] = useState<CardFields>(defaultCardFields);
  const [showEdgePoints, setShowEdgePoints] = useState(false);
  const [focusMode, setFocusMode] = useState<FocusMode>('all');
  const [direction, setDirection] = useState<Direction>('LR');
  const [selectedKey, setSelectedKey] = useState<string | undefined>(connection ? undefined : 'MIG-27');
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const busy = sessionBusy || workspaceBusy;
  const [notice, setNotice] = useState<Notice>();
  const [modal, setModal] = useState<Modal>();
  const [noteFocus, setNoteFocus] = useState<{ key: string; mode: NoteFocus }>();
  const [notesByIssue, setNotesByIssue] = useState<Record<string, readonly JiraGraphNote[]>>({});
  const noteVersions = useRef(new Map<string, number>());
  const [noteRefresh, setNoteRefresh] = useState(0);
  const [leftWidth, setLeftWidth] = useState(237);
  const [rightWidth, setRightWidth] = useState(259);
  const [leftHidden, setLeftHidden] = useState(false);
  const [rightHidden, setRightHidden] = useState(false);
  const [exporting, setExporting] = useState(false);
  const visibleNotice = notice ?? sessionNotice;

  const filterStoryField = storyField || (graph.storyPointsFields.length === 1 ? graph.storyPointsFields[0].id : undefined);
  const jiraClauses = useMemo(() => graphFacets.map((facet) =>
    jiraFacetClause(facet, jiraFacets[facet] ?? [], edition, filterStoryField)), [edition, filterStoryField, jiraFacets]);
  const jql = appendJqlClauses(baseJql, [scopeJql('project', projectKey), ...jiraClauses]);
  const cycleIds = useMemo(() => cyclicBlockingEdges(graph), [graph]);
  const cycleExamples = useMemo(() => graph.edges.filter(({ id }) => cycleIds.has(id)).slice(0, 5), [cycleIds, graph.edges]);
  const { search, facets, edgeTypes, hideExternal, hideIsolated, crossProject, crossEpic } = filters;
  const visibility = useMemo(() => ({ edgeTypes, hideExternal, hideIsolated, crossProject, crossEpic }),
    [edgeTypes, hideExternal, hideIsolated, crossProject, crossEpic]);
  const filtered = useMemo(() => filterGraph(graph, visibility), [graph, visibility]);
  const highlighted = useMemo(() => highlightedIssueKeys(graph, { search, facets }), [graph, search, facets]);
  const showLinks = edgeTypes?.length !== 0;
  const shown = useMemo(() => {
    if (!selectedKey || focusMode === 'all' || !filtered.issues.some(({ key }) => key === selectedKey)) return filtered;
    const keys = new Set([selectedKey]);
    if (focusMode !== 'downstream') for (const key of tracePath(filtered.edges, selectedKey, 'up')) keys.add(key);
    if (focusMode !== 'upstream') for (const key of tracePath(filtered.edges, selectedKey, 'down')) keys.add(key);
    return restrictGraph(filtered, keys);
  }, [filtered, focusMode, selectedKey]);
  const visibleIssueKeys = shown.issues.map(({ key }) => key).join(',');
  const layoutGraph = useMemo(() => restrictGraph(graph, new Set(visibleIssueKeys.split(','))), [graph, visibleIssueKeys]);
  const selected = graph.issues.find(({ key }) => key === selectedKey);
  const edge = shown.edges.find(({ id }) => id === selectedEdge);
  const points = shown.issues.reduce((sum, issue) => sum + (issue.storyPoints ?? 0), 0);
  const hasPoints = shown.issues.some(({ storyPoints }) => storyPoints !== undefined);
  const completed = shown.issues.filter((issue) => statusTone(issue) === 'done').length;
  const updateNotes = useCallback((key: string, notes: readonly JiraGraphNote[]) => {
    noteVersions.current.set(key, (noteVersions.current.get(key) ?? 0) + 1);
    setNotesByIssue((previous) => ({ ...previous, [key]: notes }));
  }, []);
  const noteKeyList = useMemo(() => graph.issues.map(({ key }) => key).join(','), [graph.issues]);
  useEffect(() => {
    if (!active || !connection || !noteKeyList) return;
    let current = true;
    const versions = new Map(noteVersions.current);
    void request('listGraphNotes', { keys: noteKeyList.split(',') }).then((discovered) => {
      if (!current) return;
      setNotesByIssue((previous) => {
        const next = { ...previous };
        for (const [key, notes] of Object.entries(discovered)) {
          if (versions.get(key) === noteVersions.current.get(key)) next[key] = notes;
        }
        return next;
      });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [active, connection, noteKeyList, noteRefresh]);
  useEffect(() => {
    if (!connection) setFilters(emptyGraphFilters);
  }, [connection, language]);

  function setBusy(value: boolean) {
    setWorkspaceBusy(value);
    onBusyChange(value);
  }

  function selectIssue(key?: string) {
    setSelectedEdge(undefined);
    setSelectedKey(key);
    setNoteFocus(undefined);
    if (!key) setFocusMode('all');
  }
  function selectEdge(id: string) {
    setRightHidden(false);
    setSelectedKey(undefined);
    setSelectedEdge(id);
    setNoteFocus(undefined);
    setFocusMode('all');
  }
  function editJql(value: string) {
    setBaseJql(value);
    setProjectKey('');
    setJiraFacets({});
  }
  function changeLayout() {
    setDirection((previous) => previous === 'LR' ? 'TB' : 'LR');
    setLayoutGeneration((previous) => previous + 1);
  }

  async function load(event?: FormEvent) {
    event?.preventDefault();
    const query = jql.trim();
    if (!connection || !query || busy) return;
    setBusy(true);
    setNotice(undefined);
    onDismissSessionNotice();
    try {
      const normalized = issueKey.test(query) ? `key = "${query.toUpperCase()}"` : query;
      const graphOptions = { depth, storyPointsField: storyField.trim() || undefined };
      const pins = normalized === loadedQuery ? includedKeys : [];
      const additional = pins.length
        ? request('loadGraph', { ...graphOptions, depth: Math.max(1, depth), jql: `key in (${pins.map((key) => `"${key}"`).join(', ')})` }).catch(() => null)
        : undefined;
      let result = await request('loadGraph', { ...graphOptions, jql: normalized });
      const roots = result.issues.filter(({ external }) => !external);
      if (additional) {
        const pinned = await additional;
        result = pinned ? mergeGraphs(result, depth === 0 ? restrictGraph(pinned, new Set([...result.issues.map(({ key }) => key), ...pins])) : pinned) : {
          ...result, warnings: [...result.warnings, t('Не удалось обновить добавленные вручную задачи.', 'Could not reload the manually included issues.')],
        };
      }
      setLoadedQuery(normalized);
      setQueryIssueKeys(new Set(roots.map(({ key }) => key)));
      setLoadedSprintIds((jiraFacets.sprints ?? []).flatMap((value) => sprintFacetId(value) ?? []));
      const projects = new Set(roots.flatMap(({ project }) => project ? [project] : []));
      onLoad(normalized, projectKey || (projects.size === 1 ? projects.values().next().value : undefined));
      setIncludedKeys(pins);
      setGraph(result);
      setNoteRefresh((previous) => previous + 1);
      setLayoutGeneration((previous) => previous + 1);
      if (!result.issues.some(({ key }) => key === selectedKey)) selectIssue();
    } catch (cause) { setNotice({ text: errorMessage(cause), error: true }); }
    finally { setBusy(false); }
  }

  async function includeIssue(raw: string) {
    const key = raw.trim().toUpperCase();
    if (!connection || busy) return;
    if (!issueKey.test(key)) throw new Error(t('Введи ключ Jira, например PROJ-123.', 'Enter a Jira key such as PROJ-123.'));
    if (graph.issues.some((issue) => issue.key === key)) {
      selectIssue(key);
      setRightHidden(false);
      setFocusMode('all');
      const node = flow.getNode(key);
      if (node) void flow.setCenter(node.position.x + (node.width ?? 0) / 2, node.position.y + (node.height ?? 0) / 2,
        { zoom: Math.max(flow.getZoom(), 0.75), duration: 220 });
      return;
    }
    setBusy(true);
    try {
      const result = await request('loadGraph', { jql: `key = "${key}"`, depth: Math.max(1, depth), storyPointsField: storyField || undefined });
      if (!result.issues.some((issue) => issue.key === key)) throw new Error(t('Задача не найдена или недоступна.', 'The issue was not found or is unavailable.'));
      setGraph((previous) => mergeGraphs(previous, depth === 0 ? restrictGraph(result, new Set([...previous.issues.map((issue) => issue.key), key])) : result));
      setIncludedKeys((previous) => previous.includes(key) ? previous : [...previous, key]);
      setFocusMode('all');
      setRightHidden(false);
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
    setFocusMode('all');
    setRightHidden(false);
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
    if (busy) return;
    if (connection) setModal({ kind: 'create', source });
    else onRequestConnection();
  }
  function launchIssue(issue: JiraIssue) {
    void openIssue(issue).catch((cause: unknown) => setNotice({ text: errorMessage(cause), error: true }));
  }
  async function saveGraph(format: GraphExportFormat) {
    const canvas = graphArea.current?.querySelector<HTMLElement>('.canvas');
    if (!canvas || exporting) return;
    setExporting(true);
    try {
      await exportGraph(canvas, format, `jira-dag-graph-${tabId}`, direction, shown.edges, t('Родительская задача', 'Parent issue'));
    } catch {
      setNotice({ text: t('Не удалось экспортировать граф.', 'Could not export the graph.'), error: true });
    } finally {
      setExporting(false);
    }
  }
  const project = selected?.project ?? (projectKey || /\bproject\s*=\s*"?([A-Z][A-Z0-9_]*)/i.exec(jql)?.[1] || '');

  return (
    <section className={active ? 'workspace' : 'workspace workspace-inactive'} role="tabpanel"
      style={{ '--left-panel-width': `${leftWidth}px`, '--right-panel-width': `${rightWidth}px` } as CSSProperties}
      id={graphPanelId(tabId)} aria-labelledby={graphTabId(tabId)} aria-hidden={!active} inert={!active}>
        <aside className="sidebar" hidden={leftHidden} aria-label={t('Настройки графа', 'Graph settings')}>
          <div className="sidebar-scroll">
            <form className="scope-form" onSubmit={(event) => void load(event)}>
              <h2><Crosshair size={16} /> {t('Область графа', 'Graph scope')}</h2>
              <GraphScopePresets key={connection?.url ?? 'demo'} connected={Boolean(connection)} edition={edition}
                projectKey={projectKey} onProjectChange={setProjectKey}
                onApply={(clause) => setBaseJql((query) => appendJqlClauses(query, [clause]))} />
              <label htmlFor={`${formId}-jql`}>{t('JQL или ключ задачи', 'JQL or issue key')}</label>
              <textarea id={`${formId}-jql`} value={jql} onChange={(event) => editJql(event.target.value)}
                placeholder="project = PROJ ORDER BY key ASC" rows={5} spellCheck={false} />
              {loadedQuery && loadedQuery !== jql.trim() && <div className="applied-jql">
                <span>{t('JQL загруженного графа', 'JQL of the loaded graph')}</span>
                <code>{loadedQuery}</code>
              </div>}
              <div className="scope-row">
                <label htmlFor={`${formId}-depth`} title={t('Сколько уровней связей догрузить за пределами выборки', 'How far to expand links beyond the query')}>{t('Глубина связей', 'Link depth')}</label>
                <select id={`${formId}-depth`} value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
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
              <button type={connection ? 'submit' : 'button'} className="button primary full" disabled={busy || (Boolean(connection) && !jql.trim())}
                onClick={connection ? undefined : onRequestConnection}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <GitBranch size={15} />}
                {connection ? t('Загрузить граф', 'Load graph') : t('Подключить для загрузки', 'Connect to load')}
              </button>
              {connection && <GraphJqlFilters graph={graph} edition={edition}
                storyField={filterStoryField} selected={jiraFacets} onChange={setJiraFacets} queryIssueKeys={queryIssueKeys} />}
            </form>
            <div className="sidebar-line" />
            <GraphFilterPanel graph={graph} filters={filters} connected={Boolean(connection)} onChange={setFilters} />
          </div>
        </aside>
        {!leftHidden && <PanelSplitter side="left" width={leftWidth} onWidthChange={setLeftWidth} />}
        <section className="graph-area" ref={graphArea} aria-label={t('Граф', 'Graph')}>
          <div className="graph-header">
            <div>
              <button className="icon-button" type="button" aria-label={t('Панель фильтров', 'Filters panel')}
                title={leftHidden ? t('Показать фильтры', 'Show filters') : t('Скрыть фильтры', 'Hide filters')}
                aria-expanded={!leftHidden} onClick={() => setLeftHidden(!leftHidden)}><PanelLeft size={17} /></button>
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
              <details className="view-menu graph-export-menu">
                <summary><Download size={15} aria-hidden="true" /> {t('Экспорт', 'Export')}</summary>
                <div>
                  {(['pdf', 'png', 'mermaid'] as const).map((format) => <button type="button" className="button secondary"
                    key={format} disabled={exporting || !shown.issues.length} onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      void saveGraph(format);
                    }}>{format === 'mermaid' ? 'Mermaid' : format.toUpperCase()}</button>)}
                </div>
              </details>
              <button className="button primary" disabled={busy} onClick={() => addTask()}><Plus size={18} /> {t('Новая задача', 'New issue')}</button>
              {(selected || edge) && <button className="icon-button" type="button" aria-label={t('Панель сведений', 'Details panel')}
                title={rightHidden ? t('Показать сведения', 'Show details') : t('Скрыть сведения', 'Hide details')}
                aria-expanded={!rightHidden} onClick={() => setRightHidden(!rightHidden)}><PanelRight size={17} /></button>}
            </div>
          </div>
          <GraphViewControls groupMode={groupMode} onGroupMode={(mode) => {
            setGroupMode(mode);
            setLayoutGeneration((generation) => generation + 1);
          }} fields={fields} onFields={setFields} showEdgePoints={showEdgePoints} onShowEdgePoints={setShowEdgePoints}
          graph={graph} showLinks={showLinks} linkTypes={edgeTypes}
          onLinkTypes={(value) => {
            setFilters((previous) => ({ ...previous, edgeTypes: value }));
            setSelectedEdge(undefined);
          }}
          visibility={visibility} onVisibilityChange={(value) => setFilters((previous) => ({ ...previous, ...value }))}
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
          <GraphCanvas key={layoutGeneration} flowId={`graph-canvas-${tabId}`} graph={shown} layoutGraph={layoutGraph} basis={graph} cycleIds={cycleIds}
            direction={direction} groupMode={groupMode}
            fields={fields} showLinks={showLinks} showEdgePoints={showEdgePoints} connected={Boolean(connection)} notesByIssue={notesByIssue}
            preferredSprintIds={loadedSprintIds} highlightedKeys={highlighted}
            selectedKey={selected?.key} selectedEdge={edge?.id} editable={Boolean(connection && !busy && graph.linkTypes.length)}
            onSelectIssue={selectIssue} onSelectEdge={selectEdge} onOpenIssue={launchIssue}
            onCreateRelated={busy ? undefined : addTask}
            onNoteIssue={(key, focusInput) => {
              selectIssue(key);
              setRightHidden(false);
              setNoteFocus({ key, mode: focusInput ? 'input' : 'list' });
            }}
            onConnect={({ source, target }) => {
              if (source !== target) setModal({ kind: 'link', source, target });
            }} />
          {active && visibleNotice && <div className={`toast ${visibleNotice.error ? 'error' : ''}`} role={visibleNotice.error ? 'alert' : 'status'}>
            {visibleNotice.error ? <CircleAlert size={17} /> : <Check size={17} />}
            <span>{localizeMessage(visibleNotice.text, language)}</span>
            {visibleNotice.retry && <button className="text-button" disabled={busy} onClick={() => void retryLink(visibleNotice.retry!)}>{t('Повторить связь', 'Retry link')}</button>}
            <button className="icon-button" aria-label={t('Закрыть уведомление', 'Dismiss notification')} onClick={() =>
              notice ? setNotice(undefined) : onDismissSessionNotice()}><X size={15} /></button>
          </div>}
        </section>
        {(selected || edge) && !rightHidden && <PanelSplitter side="right" width={rightWidth} onWidthChange={setRightWidth} />}
        {selected && <IssueInspector key={selected.key} issue={selected} graph={graph} connected={Boolean(connection)} active={active && !rightHidden}
          hidden={rightHidden} busy={busy} noteFocus={noteFocus?.key === selected.key ? noteFocus.mode : undefined} onNotes={updateNotes}
          onClose={() => selectIssue()} onSelect={selectIssue} onAdd={() => addTask(selected)} onEdit={() => editIssue(selected)}
          onDescription={() => setModal({ kind: 'description', issue: selected })}
          onOpen={() => launchIssue(selected)} />}
        {edge && <aside className="inspector" hidden={rightHidden} aria-label={t('Связь', 'Link')}>
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
      {modal?.kind === 'create' && <CreateDialog project={modal.source?.project ?? project} source={modal.source} types={graph.linkTypes}
        currentUser={connection?.displayName}
        onCreate={(input, typeId) => create(input, modal.source, typeId)} onClose={() => setModal(undefined)} />}
      {modal?.kind === 'description' && <Suspense>
        <DescriptionDialog issue={modal.issue} onClose={() => setModal(undefined)} />
      </Suspense>}
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
            descriptionMarkdown: input.description === undefined ? item.descriptionMarkdown : issue.descriptionMarkdown,
            descriptionReadOnly: input.description === undefined ? item.descriptionReadOnly : issue.descriptionReadOnly,
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
    </section>
  );
}

function IssueInspector({ issue, graph, connected, active, hidden, busy, noteFocus, onNotes, onClose, onSelect, onAdd, onEdit, onDescription, onOpen }: {
  issue: JiraIssue; graph: JiraGraph; connected: boolean; active: boolean; hidden: boolean; busy: boolean;
  noteFocus?: NoteFocus; onNotes(key: string, notes: readonly JiraGraphNote[]): void;
  onClose(): void; onSelect(key: string): void; onAdd(): void; onEdit(): void; onDescription(): void; onOpen(): void;
}) {
  const { t } = usePreferences();
  const { assignee, key } = issue;
  const [avatar, setAvatar] = useState<{ name: string; url: string | null }>();
  useEffect(() => {
    if (!active || !connected || !assignee || avatar?.name === assignee) return;
    let current = true;
    void request('getAssigneeAvatar', { key }).catch(() => null).then((url) => {
      if (current) setAvatar({ name: assignee, url });
    });
    return () => { current = false; };
  }, [active, connected, key, assignee, avatar]);
  const avatarUrl = avatar?.name === assignee ? avatar?.url : undefined;
  const blockers = blockersFor(graph, issue.key);
  const linked = graph.edges.filter(({ source, target }) => source === issue.key || target === issue.key);
  return <aside className="inspector" hidden={hidden} aria-label={t('Сведения о задаче', 'Issue details')}>
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
      {assignee && <div className="inspector-assignee" aria-label={t(`Исполнитель: ${assignee}`, `Assignee: ${assignee}`)}>
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <span aria-hidden="true">{assigneeInitials(assignee)}</span>}
        <div><small>{t('Исполнитель', 'Assignee')}</small>{assignee}</div>
      </div>}
      {!!issue.labels?.length && <p className="assignee">{issue.labels.map((label) => `#${label}`).join(' ')}</p>}
      {(issue.descriptionMarkdown || issue.description) && <button type="button" className="button secondary full issue-description-button"
        onClick={onDescription}><FileText size={15} /> {t('Открыть описание', 'View description')}</button>}
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
      {connected && <GraphNotes key={issue.key} issueKey={issue.key} focus={noteFocus} onNotes={onNotes} />}
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
      {!issue.external && (issue.descriptionReadOnly
        ? <p className="form-hint">{t('Форматированное описание можно редактировать в Jira.', 'Edit the rich description in Jira.')}</p>
        : <label>{t('Описание', 'Description')}<textarea name="description" defaultValue={issue.description} rows={5} /></label>)}
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
