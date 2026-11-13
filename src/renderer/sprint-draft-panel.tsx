import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, CalendarRange, ChevronDown, CircleAlert, Clock3, ExternalLink, GitBranch, ListFilter,
  LoaderCircle, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, Users, X,
} from 'lucide-react';
import type {
  JiraGraph, JiraIssue, JiraProject, JiraScrumBoard, JiraSprint, JiraSprintMembershipInput, JiraSprintPlan,
  JiraSprintPlanQuery, JiraSprintVelocity, JiraTeamMember,
} from '../shared/contracts';
import { errorMessage, openIssue, request } from './api';
import { analyzeDependencies } from './dependency-analysis';
import { Dialog } from './dialogs';
import { mergeGraphs, statusTone } from './graph-model';
import { localizeMessage, usePreferences, type Translate } from './i18n';
import {
  inferSprintRole, planSprintDraft, type SprintDraftItem, type SprintDraftOverride, type SprintDraftPlan, type SprintRole,
} from './sprint-draft-planning';
import { emptySprintDraftEntry, type SprintDraftEntry, type SprintDraftMember, type SprintDraftState } from './sprint-draft-state';
import './sprint-draft-panel.css';

const roles: SprintRole[] = ['BE', 'FE', 'QA', 'SA'];
const emptyTeam: SprintDraftMember[] = [];
const keyPattern = /^[A-Z][A-Z0-9_]*-\d+$/i;
const fieldPattern = /^customfield_\d+$/;
const initialLimit = 30;
const maximumValue = 100_000;
const defaultReserve = 15;
const membershipBatchSize = 100;
const demoProject: JiraProject = { id: 'demo', key: 'DEMO', name: 'Jira DAG' };
const demoBoard: JiraScrumBoard = { id: 'demo', name: 'Jira DAG' };
const demoSprint: JiraSprint = { id: 'demo', name: 'Demo', state: 'future' };
const demoTeam: SprintDraftMember[] = [
  { id: 'demo:platform', name: 'Platform', roles: ['BE', 'FE', 'SA'], capacity: 15 },
  { id: 'demo:data', name: 'Data', roles: ['BE', 'QA'], capacity: 12, qaCapacity: 10 },
];

type Resource<T> = { key: string; status: 'loading' } | { key: string; status: 'ready'; data: T } |
  { key: string; status: 'failed'; message: string };
type Preview = { input: JiraSprintMembershipInput; sprint: string; remaining: number };
type Pending = 'search' | 'add' | 'apply';
type FormatNumber = (value: number) => string;

const reasonLabels: Record<string, [string, string]> = {
  unestimated: ['Без оценки работы', 'Missing work estimate'],
  'qa-unestimated': ['Без QA-оценки', 'Missing QA estimate'],
  'unknown-role': ['Роль не определена', 'Role is missing'],
  'unknown-assignee': ['Исполнитель вне команды', 'Assignee is outside the team'],
  'role-mismatch': ['Роль исполнителя не подходит', 'Assignee role does not match'],
  'external-blocker': ['Блокер вне выборки', 'Blocker outside the loaded scope'],
  cycle: ['Цикл в зависимостях', 'Dependency cycle'],
  blocked: ['Блокер вне плана', 'Blocker outside the plan'],
  'team-capacity': ['Лимит команды', 'Team capacity'],
  'person-capacity': ['Лимит исполнителя', 'Assignee capacity'],
  'qa-capacity': ['Лимит QA', 'QA capacity'],
  'capacity-unknown': ['Лимит не задан', 'Capacity is missing'],
  'missing-selected': ['Задача недоступна', 'Issue is unavailable'],
  'over-capacity': ['Превышен лимит', 'Capacity exceeded'],
  'graph-incomplete': ['Данные графа неполные', 'Graph data is incomplete'],
  'history-incomplete': ['История неполная', 'Sprint history is incomplete'],
  'subtask-with-parent': ['Оценка подзадачи учтена в родителе', 'Subtask estimate is covered by its parent'],
};

function reasonText(reason: string, t: Translate): string {
  const label = reasonLabels[reason];
  return label ? t(...label) : reason;
}

function useResource<T>(key: string, enabled: boolean, load: () => Promise<T>) {
  const [resource, setResource] = useState<Resource<T>>();
  const [revision, setRevision] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setResource({ key, status: 'loading' });
    void loader.current().then((data) => {
      if (current) setResource({ key, status: 'ready', data });
    }).catch((cause: unknown) => {
      if (current) setResource({ key, status: 'failed', message: errorMessage(cause) });
    });
    return () => { current = false; };
  }, [enabled, key, revision]);
  return {
    resource: enabled && resource?.key === key ? resource : undefined,
    reload: () => {
      if (enabled) setResource({ key, status: 'loading' });
      setRevision((previous) => previous + 1);
    },
  };
}

function sprintStatus(state: JiraSprint['state'], t: Translate): string {
  if (state === 'active') return t('Активный', 'Active');
  if (state === 'closed') return t('Закрытый', 'Closed');
  return t('Будущий', 'Future');
}

function planScope(boardId: string, sprintId: string, entry: SprintDraftEntry): JiraSprintPlanQuery {
  return { boardId, sprintId, storyPointsField: entry.storyPointsField, qaPointsField: entry.qaPointsField };
}

function issueJql(keys: string[]): string {
  return `key in (${keys.map((key) => `"${key}"`).join(', ')})`;
}

function matchesIssue(issue: JiraIssue, term: string): boolean {
  return !term || `${issue.key} ${issue.summary} ${issue.epicKey ?? ''} ${issue.epicSummary ?? ''} ${issue.assignee ?? ''} ${issue.labels?.join(' ') ?? ''}`
    .toLocaleLowerCase().includes(term);
}

export function SprintDraftPanel({ graph, connected, active, projectKey, state, onChange, onFocusIssue, onClose, onBusyChange, onApplied, onOpenGraph }: {
  graph: JiraGraph;
  connected: boolean;
  active: boolean;
  projectKey?: string;
  state: SprintDraftState;
  onChange(state: SprintDraftState): void;
  onFocusIssue?(key: string): void;
  onClose(): void;
  onBusyChange(busy: boolean): void;
  onApplied?(): void;
  onOpenGraph?(keys: readonly string[], title: string): void;
}) {
  const { t, language } = usePreferences();
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [preview, setPreview] = useState<Preview>();
  const [pending, setPending] = useState<Pending>();
  const [quickSearch, setQuickSearch] = useState('');
  const [backlogQuery, setBacklogQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [remoteGraph, setRemoteGraph] = useState<{ scope: string; graph: JiraGraph; keys: string[] }>();
  const stateRef = useRef(state);
  const lock = useRef(false);
  stateRef.current = state;
  const project = connected ? (state.projectKey ?? projectKey ?? '') : demoProject.key;
  const boardId = connected ? (state.boardId ?? '') : demoBoard.id;
  const sprintId = connected ? (state.sprintId ?? '') : demoSprint.id;
  const draftKey = `${boardId}:${sprintId}`;
  const entry = state.drafts[draftKey] ?? emptySprintDraftEntry;
  const configuredTeam = state.teams[boardId] ?? (connected ? emptyTeam : demoTeam);
  const scope = JSON.stringify([project, boardId, sprintId, entry.storyPointsField, entry.qaPointsField]);
  const enabled = connected && active;
  const projects = useResource('projects', enabled, () => request('listProjects', null));
  const boards = useResource(project, enabled && Boolean(project), () => request('listScrumBoards', { project }));
  const sprints = useResource(boardId, enabled && Boolean(boardId), () => request('listBoardSprints', { boardId }));
  const snapshot = useResource(scope, enabled && Boolean(boardId && sprintId), () =>
    request('loadSprintPlan', planScope(boardId, sprintId, entry)));
  const velocityKey = JSON.stringify([boardId, entry.storyPointsField, entry.qaPointsField]);
  const history = useResource(velocityKey, enabled && snapshot.resource?.status === 'ready', () =>
    request('loadSprintVelocity', { boardId, storyPointsField: entry.storyPointsField, qaPointsField: entry.qaPointsField }));
  const projectTeam = useResource(project, enabled && Boolean(project && sprintId), () =>
    request('listProjectTeam', { project }));
  const jiraSnapshot = snapshot.resource?.status === 'ready' ? snapshot.resource.data : undefined;
  const readyHistory = history.resource?.status === 'ready' ? history.resource.data : undefined;
  const format = useMemo<FormatNumber>(() => {
    const number = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
    return (value) => number.format(value);
  }, [language]);

  const demoSnapshot = useMemo<JiraSprintPlan>(() => ({
    sprint: demoSprint,
    graph: { ...graph, issues: graph.issues.map((issue) => ({ ...issue, labels: [...(issue.labels ?? []), 'BE'] })) },
    sprintIssueKeys: graph.issues.filter((issue) => statusTone(issue) === 'active' && !issue.isEpic).map(({ key }) => key),
    backlogIssueKeys: graph.issues.filter((issue) => statusTone(issue) === 'waiting' && !issue.isEpic).map(({ key }) => key),
    membershipComplete: true,
    backlogComplete: true,
  }), [graph]);
  const data = connected ? jiraSnapshot : demoSnapshot;
  const current = data?.sprintIssueKeys;
  const currentKeys = current ?? [];
  const locallyAdded = entry.added.filter((key) => !currentKeys.includes(key));
  const locallyRemoved = entry.removed.filter((key) => currentKeys.includes(key));
  const plannerGraph = useMemo(() => {
    if (!data) return undefined;
    const remote = remoteGraph?.scope === scope ? remoteGraph.graph : undefined;
    const combined = remote ? mergeGraphs(data.graph, remote) : data.graph;
    const eligible = new Set([...data.sprintIssueKeys, ...data.backlogIssueKeys,
      ...(remoteGraph?.scope === scope ? remoteGraph.keys : [])]);
    return { ...combined, issues: combined.issues.map((issue) =>
      eligible.has(issue.key) ? { ...issue, external: false } : { ...issue, external: true }) };
  }, [data, remoteGraph, scope]);
  const selectedKeys = useMemo(() => {
    const added = new Set(entry.added);
    const removed = new Set(entry.removed);
    const selected = new Set([...(current ?? []), ...added].filter((key) => !removed.has(key)));
    for (const { key, isSubtask, parentKey } of plannerGraph?.issues ?? []) {
      if (!isSubtask || !parentKey) continue;
      if (removed.has(parentKey)) selected.delete(key);
      if (added.has(parentKey) && !removed.has(key)) selected.add(key);
    }
    return [...selected];
  }, [current, entry.added, entry.removed, plannerGraph]);
  const dependencyAnalysis = useMemo(() => plannerGraph && analyzeDependencies(plannerGraph), [plannerGraph]);
  const plan = useMemo(() => plannerGraph && planSprintDraft(plannerGraph, {
    selectedKeys,
    backlogKeys: [...(data?.backlogIssueKeys ?? []), ...(remoteGraph?.scope === scope ? remoteGraph.keys : [])]
      .filter((key) => !current?.includes(key)),
    roster: configuredTeam.map((person) => ({ ...person, availabilityPercent: entry.availability[person.id] })),
    epicPriorities: entry.epicPriorities,
    overrides: entry.overrides,
    history: readyHistory?.samples,
    capacity: entry.capacity,
    qaCapacity: entry.qaCapacity,
    reservePercent: entry.reservePercent ?? defaultReserve,
  }, dependencyAnalysis), [plannerGraph, dependencyAnalysis, selectedKeys, data, remoteGraph, scope, current, configuredTeam, entry, readyHistory]);
  const term = quickSearch.trim().toLocaleLowerCase();
  const writeSafe = Boolean(data && connected && data.membershipComplete &&
    (data.sprint.state === 'active' || data.sprint.state === 'future') && !pending);

  function updateEntry(change: (previous: SprintDraftEntry) => SprintDraftEntry) {
    const latest = stateRef.current;
    onChange({ ...latest, drafts: { ...latest.drafts, [draftKey]: change(latest.drafts[draftKey] ?? emptySprintDraftEntry) } });
  }

  useEffect(() => {
    if (!enabled || !jiraSnapshot || !entry.pinnedIssueKeys?.length) return;
    const missing = entry.pinnedIssueKeys.filter((key) => keyPattern.test(key) &&
      !jiraSnapshot.backlogIssueKeys.includes(key) && !jiraSnapshot.sprintIssueKeys.includes(key));
    if (!missing.length) return;
    let currentRequest = true;
    const queryGroups: string[][] = [];
    for (const key of missing) {
      const group = queryGroups.at(-1);
      if (group && issueJql([...group, key]).length < 4000) group.push(key);
      else queryGroups.push([key]);
    }
    void (async () => {
      for (const keys of queryGroups) {
        if (!currentRequest) return;
        try {
          const result = await request('loadSprintPlan', { ...planScope(boardId, sprintId, entry), backlogJql: issueJql(keys) });
          if (currentRequest) appendRemote(result, scope);
        } catch { return; }
      }
    })();
    return () => { currentRequest = false; };
  }, [enabled, jiraSnapshot, scope]);

  function appendRemote(result: JiraSprintPlan, targetScope: string) {
    setRemoteGraph((previous) => previous?.scope === targetScope ? {
      scope: targetScope,
      graph: mergeGraphs(previous.graph, result.graph),
      keys: [...new Set([...previous.keys, ...result.backlogIssueKeys])],
    } : {
      scope: targetScope, graph: result.graph, keys: result.backlogIssueKeys,
    });
  }

  function updateSelection(keys: readonly string[], add: boolean, pin?: string) {
    const baseline = new Set(currentKeys);
    updateEntry((previous) => {
      const added = new Set(previous.added);
      const removed = new Set(previous.removed);
      for (const key of keys) {
        if (add) {
          removed.delete(key);
          if (!baseline.has(key)) added.add(key);
        } else {
          added.delete(key);
          if (baseline.has(key)) removed.add(key);
        }
      }
      return { ...previous, added: [...added], removed: [...removed],
        pinnedIssueKeys: pin ? [...new Set([...(previous.pinnedIssueKeys ?? []), pin])] : previous.pinnedIssueKeys };
    });
  }

  function acceptRecommendations(items: readonly SprintDraftItem[]) {
    const baseline = new Set(currentKeys);
    updateEntry((previous) => {
      const added = new Set(previous.added);
      const removed = new Set(previous.removed);
      const overrides = { ...previous.overrides };
      for (const item of items) {
        if (item.issue.isSubtask) continue;
        const key = item.issue.key;
        removed.delete(key);
        if (!baseline.has(key)) added.add(key);
        const work = item.stages.find((stage) => stage.kind === 'work');
        const qa = item.stages.find((stage) => stage.kind === 'qa');
        overrides[key] = {
          ...overrides[key],
          ...(work?.role ? { role: work.role } : {}),
          ...(work?.assigneeId ? { assigneeId: work.assigneeId } : {}),
          ...(qa?.assigneeId ? { qaAssigneeId: qa.assigneeId } : {}),
        };
      }
      return { ...previous, added: [...added], removed: [...removed], overrides,
        pinnedIssueKeys: [...new Set([...(previous.pinnedIssueKeys ?? []), ...items.filter(({ issue }) => !issue.isSubtask)
          .map(({ issue }) => issue.key).filter((key) => !data?.backlogIssueKeys.includes(key))])] };
    });
  }

  function resetTransient() {
    setQuickSearch('');
    setBacklogQuery('');
    setFilter('all');
    setNotice(undefined);
    setPreview(undefined);
  }

  function selectScope(next: Pick<SprintDraftState, 'projectKey' | 'boardId' | 'sprintId'>) {
    resetTransient();
    onChange({ ...stateRef.current, ...next });
  }

  async function searchBacklog(event?: FormEvent) {
    event?.preventDefault();
    if (!jiraSnapshot || !backlogQuery.trim() || lock.current) return;
    lock.current = true;
    setPending('search');
    setNotice(undefined);
    try {
      const result = await request('loadSprintPlan', { ...planScope(boardId, sprintId, entry), backlogJql: backlogQuery.trim() });
      appendRemote(result, scope);
      setNotice({ text: t(
        `Найдено в бэклоге Jira — ${result.backlogIssueKeys.length}.`,
        `Found in the Jira backlog — ${result.backlogIssueKeys.length}.`,
      ) });
    } catch (cause) { setNotice({ text: localizeMessage(errorMessage(cause), language), error: true }); }
    finally {
      lock.current = false;
      setPending(undefined);
    }
  }

  async function addByKey(raw: string) {
    const key = raw.trim().toUpperCase();
    if (!jiraSnapshot || !keyPattern.test(key) || lock.current) return;
    const knownIssue = plannerGraph?.issues.find((issue) => issue.key === key);
    if (knownIssue?.isSubtask) {
      setNotice({ text: t('Спринт подзадачи меняется вместе с родительской задачей.', 'Subtasks move with their parent issue.'), error: true });
      return;
    }
    if (currentKeys.includes(key) || jiraSnapshot.backlogIssueKeys.includes(key) || remoteGraph?.scope === scope && remoteGraph.keys.includes(key)) {
      updateSelection([key], true, !currentKeys.includes(key) && !jiraSnapshot.backlogIssueKeys.includes(key) ? key : undefined);
      setQuickSearch('');
      return;
    }
    lock.current = true;
    setPending('add');
    setNotice(undefined);
    try {
      const result = await request('loadSprintPlan', { ...planScope(boardId, sprintId, entry), backlogJql: issueJql([key]) });
      if (result.graph.issues.find((issue) => issue.key === key)?.isSubtask) {
        setNotice({ text: t('Спринт подзадачи меняется вместе с родительской задачей.', 'Subtasks move with their parent issue.'), error: true });
        return;
      }
      if (!result.backlogIssueKeys.includes(key) && !result.sprintIssueKeys.includes(key)) {
        setNotice({ text: t('Задачи нет в спринте или бэклоге этой доски.', 'The issue is outside this board’s sprint and backlog.'), error: true });
        return;
      }
      appendRemote(result, scope);
      updateSelection([key], true, key);
      setQuickSearch('');
    } catch (cause) { setNotice({ text: localizeMessage(errorMessage(cause), language), error: true }); }
    finally {
      lock.current = false;
      setPending(undefined);
    }
  }

  function previewChanges() {
    if (!writeSafe || !data || (!locallyAdded.length && !locallyRemoved.length)) return;
    const addIssueKeys = locallyAdded.slice(0, membershipBatchSize);
    const removeIssueKeys = locallyRemoved.slice(0, membershipBatchSize - addIssueKeys.length);
    setPreview({ sprint: data.sprint.name, remaining: locallyAdded.length + locallyRemoved.length - addIssueKeys.length - removeIssueKeys.length, input: {
      boardId, sprintId, expectedIssueKeys: [...currentKeys], addIssueKeys, removeIssueKeys,
    } });
  }

  async function applyChanges() {
    if (!preview || !writeSafe || lock.current) return;
    lock.current = true;
    setPending('apply');
    onBusyChange(true);
    setNotice(undefined);
    try {
      const result = await request('applySprintMembership', preview.input);
      const successful = new Set([...result.added, ...result.removed]);
      updateEntry((previous) => ({
        ...previous,
        added: previous.added.filter((key) => !successful.has(key)),
        removed: previous.removed.filter((key) => !successful.has(key)),
      }));
      const report = t(`Добавлено — ${result.added.length}. Убрано — ${result.removed.length}.`,
        `Added — ${result.added.length}. Removed — ${result.removed.length}.`);
      setNotice({
        text: [report, ...result.failed.map(({ key, reason }) => `${key} — ${localizeMessage(reason, language)}`)].join('\n'),
        error: result.failed.length > 0,
      });
      if (successful.size) onApplied?.();
    } catch (cause) {
      setNotice({ text: localizeMessage(errorMessage(cause), language), error: true });
    } finally {
      setPreview(undefined);
      setRemoteGraph(undefined);
      snapshot.reload();
      lock.current = false;
      setPending(undefined);
      onBusyChange(false);
    }
  }

  const visibleProjects = connected ? resourceItems(projects.resource) : [demoProject];
  const visibleBoards = connected ? resourceItems(boards.resource) : [demoBoard];
  const visibleSprints = connected ? resourceItems(sprints.resource) : [demoSprint];
  const issueByKey = new Map(plannerGraph?.issues.map((issue) => [issue.key, issue]));
  const availableTeam = new Map(resourceItems(projectTeam.resource).map((person) => [person.id, person]));
  for (const { assigneeId, assignee } of plannerGraph?.issues ?? []) {
    if (assigneeId && assignee && !availableTeam.has(assigneeId)) availableTeam.set(assigneeId, { id: assigneeId, name: assignee });
  }
  const planByKey = new Map(plan?.items.map((item) => [item.issue.key, item]));
  const selected = new Set(selectedKeys);
  const backlog = [...new Set([...(data?.backlogIssueKeys ?? []), ...(remoteGraph?.scope === scope ? remoteGraph.keys : []), ...locallyRemoved])]
    .filter((key) => !selected.has(key)).flatMap((key) => issueByKey.get(key) ?? []);
  const selectedIssues = selectedKeys.flatMap((key) => issueByKey.get(key) ?? []);
  const recommendations = plan?.items.filter((item) => item.source === 'recommended' && !item.issue.isSubtask) ?? [];
  const recommendationKeys = new Set(recommendations.map((item) => item.issue.key));
  const skipped = new Map(plan?.skipped.map((entry) => [entry.issue.key, entry]));
  const visibleBacklog = backlog.filter((issue) => matchesIssue(issue, term)
    && (filter === 'all' || filter === 'recommended' && recommendationKeys.has(issue.key)
      || filter === 'blocked' && ['blocked', 'external-blocker', 'cycle'].includes(skipped.get(issue.key)?.reason ?? '')));
  const visibleSelected = selectedIssues.filter((issue) => matchesIssue(issue, term));
  const epicNames = new Map<string, string>();
  for (const issue of [...backlog, ...selectedIssues]) {
    if (issue.epicKey) epicNames.set(issue.epicKey, issue.epicSummary || epicNames.get(issue.epicKey) || issue.epicKey);
  }
  const validKey = connected && keyPattern.test(quickSearch.trim());

  return <section className="sprint-draft" aria-label={t('Черновик спринта', 'Sprint draft')}>
    <header className="sprint-draft-heading">
      <button type="button" className="button secondary" onClick={onClose} disabled={pending === 'apply'}>
        <ArrowLeft size={16} /> {t('К графу', 'Back to graph')}
      </button>
      <h1><CalendarRange size={19} /> {t('Черновик спринта', 'Sprint draft')}</h1>
      <div className="sprint-draft-actions">
        {connected && <button type="button" className="icon-button outline" disabled={Boolean(pending)}
          title={t('Обновить данные Jira', 'Refresh Jira data')} aria-label={t('Обновить данные Jira', 'Refresh Jira data')}
          onClick={() => {
            setRemoteGraph(undefined);
            projects.reload();
            if (project) boards.reload();
            if (boardId) sprints.reload();
            if (sprintId) { snapshot.reload(); history.reload(); projectTeam.reload(); }
          }}>
          <RefreshCw size={16} />
        </button>}
        {onOpenGraph && <button type="button" className="button secondary"
          disabled={Boolean(pending) || !data || selectedKeys.length === 0 || selectedKeys.length > 250}
          title={selectedKeys.length > 250 ? t('До 250 задач в графе спринта', 'Up to 250 issues in the sprint graph') : undefined}
          onClick={() => { if (data) onOpenGraph(selectedKeys, data.sprint.name); }}>
          <GitBranch size={15} /> {t('Граф черновика', 'Draft graph')}
        </button>}
        {connected && <button type="button" className="button primary" onClick={previewChanges}
          disabled={!writeSafe || !locallyAdded.length && !locallyRemoved.length}>
          {t('Проверить изменения в Jira', 'Review Jira changes')}
          {locallyAdded.length + locallyRemoved.length > 0 && <b>{locallyAdded.length + locallyRemoved.length}</b>}
        </button>}
      </div>
    </header>
    <div className="sprint-draft-content">
      <div className="sprint-draft-scope">
        <label>{t('Проект Jira', 'Jira project')}
          <select value={project} disabled={!connected || Boolean(pending)} onChange={(event) =>
            selectScope({ projectKey: event.target.value, boardId: undefined, sprintId: undefined })}>
            <option value="">{t('Выбрать проект', 'Choose a project')}</option>
            {project && !visibleProjects.some(({ key }) => key === project) && <option value={project}>{project}</option>}
            {visibleProjects.map(({ key, name }) => <option key={key} value={key}>{name} ({key})</option>)}
          </select>
        </label>
        <label>{t('Scrum-доска', 'Scrum board')}
          <select value={boardId} disabled={!connected || !project || Boolean(pending)} onChange={(event) =>
            selectScope({ projectKey: project, boardId: event.target.value || undefined, sprintId: undefined })}>
            <option value="">{t('Выбрать доску', 'Choose a board')}</option>
            {boardId && !visibleBoards.some(({ id }) => id === boardId) && <option value={boardId}>{boardId}</option>}
            {visibleBoards.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>{t('Спринт Jira', 'Jira sprint')}
          <select value={sprintId} disabled={!connected || !boardId || Boolean(pending)} onChange={(event) =>
            selectScope({ sprintId: event.target.value || undefined })}>
            <option value="">{t('Выбрать спринт', 'Choose a sprint')}</option>
            {sprintId && !visibleSprints.some(({ id }) => id === sprintId) && <option value={sprintId}>{sprintId}</option>}
            {[...visibleSprints].sort((left, right) => Number(left.state === 'closed') - Number(right.state === 'closed')).map((sprint) =>
              <option key={sprint.id} value={sprint.id}>{sprint.name} · {sprintStatus(sprint.state, t)}</option>)}
          </select>
        </label>
      </div>
      {connected && <div className="sprint-draft-messages">
        <ResourceMessage resource={projects.resource} onRetry={projects.reload} loading={t('Загрузка проектов…', 'Loading projects…')} />
        <ResourceMessage resource={boards.resource} onRetry={boards.reload} loading={t('Загрузка Scrum-досок…', 'Loading Scrum boards…')} />
        <ResourceMessage resource={sprints.resource} onRetry={sprints.reload} loading={t('Загрузка спринтов…', 'Loading sprints…')} />
        <ResourceMessage resource={snapshot.resource} onRetry={snapshot.reload} loading={t('Загрузка спринта и бэклога…', 'Loading sprint and backlog…')} />
        {boards.resource?.status === 'ready' && !visibleBoards.length &&
          <p>{t('У проекта нет доступных Scrum-досок.', 'The project has no accessible Scrum boards.')}</p>}
        {sprints.resource?.status === 'ready' && !visibleSprints.length &&
          <p>{t('На доске нет спринтов. Создай спринт в Jira и обнови список.', 'The board has no sprints. Create a sprint in Jira and refresh the list.')}</p>}
        {!sprintId && <p>{t('Выбери существующий спринт Jira для планирования.', 'Choose an existing Jira sprint to start planning.')}</p>}
      </div>}
      {!connected && <p className="sprint-draft-caption">{t('Демо. Подключи Jira, чтобы выбрать Scrum-доску и спринт.', 'Demo. Connect Jira to select a Scrum board and sprint.')}</p>}
      {notice && <p className={notice.error ? 'sprint-draft-message is-error' : 'sprint-draft-message'} role={notice.error ? 'alert' : 'status'}>
        {notice.text}
      </p>}
      {data && plan && <>
        {connected && (!data.membershipComplete || data.sprint.state === 'closed') && <p className="sprint-draft-message is-warning">
          <CircleAlert size={16} /> {data.sprint.state === 'closed'
            ? t('Спринт закрыт. Доступен локальный черновик.', 'This sprint is closed. You can edit a local draft.')
            : t('Jira вернула неполный состав спринта. Изменения можно сохранить локально.', 'Jira returned incomplete sprint membership. Changes can be saved locally.')}
        </p>}
        <SprintDraftSummary plan={plan} data={data} entry={entry} format={format} t={t} />
        <div className="sprint-draft-toolbar">
          <form className="sprint-draft-quick-search" onSubmit={(event) => { event.preventDefault(); if (validKey) void addByKey(quickSearch); }}>
            <label><Search size={16} /><input type="search" placeholder={t('Ключ, название, эпик, исполнитель', 'Key, title, epic, assignee')}
              aria-label={t('Поиск по задачам спринта и бэклога', 'Search sprint and backlog issues')}
              value={quickSearch} onChange={(event) => setQuickSearch(event.target.value)} /></label>
            {validKey && <button type="submit" className="button secondary" disabled={Boolean(pending)}>
              {pending === 'add' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} {t('Добавить по ключу', 'Add by key')}
            </button>}
          </form>
          <label className="sprint-draft-filter"><ListFilter size={16} /><select value={filter}
            aria-label={t('Фильтр бэклога', 'Backlog filter')} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">{t('Все задачи', 'All issues')}</option>
            <option value="recommended">{t('Рекомендованные', 'Recommended')}</option>
            <option value="blocked">{t('Заблокированные', 'Blocked')}</option>
          </select></label>
          {connected && <details className="sprint-draft-details sprint-draft-backlog-search">
            <summary>{t('Поиск в Jira по JQL', 'Search Jira by JQL')} <ChevronDown size={14} /></summary>
            <form onSubmit={(event) => void searchBacklog(event)}>
              <input aria-label={t('JQL бэклога', 'Backlog JQL')} placeholder='labels = "migration"' maxLength={4000}
                value={backlogQuery} onChange={(event) => setBacklogQuery(event.target.value)} />
              <button type="submit" className="button secondary" disabled={!backlogQuery.trim() || Boolean(pending)}>
                {pending === 'search' ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />} {t('Найти', 'Search')}
              </button>
            </form>
          </details>}
        </div>
        <div className="sprint-draft-grid">
          <DraftColumn title={t('Бэклог', 'Backlog')} count={visibleBacklog.length}
            description={data.backlogComplete ? undefined : t(
              'Загружена часть бэклога. Остальные задачи можно найти по ключу или JQL.',
              'Part of the backlog is loaded. Find other issues by key or JQL.',
            )} action={recommendations.length > 0 && <button type="button" className="button secondary"
              disabled={Boolean(pending)} onClick={() => acceptRecommendations(recommendations)}>
              <Plus size={15} /> {t('Добавить рекомендованные', 'Add recommendations')} <b>{recommendations.length}</b>
            </button>}>
            {(limit) => visibleBacklog.slice(0, limit).map((issue) => <DraftCard key={issue.key} issue={issue} team={configuredTeam}
              item={planByKey.get(issue.key)} skip={skipped.get(issue.key)} override={entry.overrides[issue.key]} t={t} format={format}
              connected={connected} disabled={Boolean(pending)} mode="backlog" onMove={() => updateSelection([issue.key], true,
                data.backlogIssueKeys.includes(issue.key) || currentKeys.includes(issue.key) ? undefined : issue.key)}
              onOverride={(override) => updateEntry((previous) => ({ ...previous, overrides: { ...previous.overrides, [issue.key]: override } }))}
              onFocusIssue={onFocusIssue && graph.issues.some(({ key }) => key === issue.key) ? () => onFocusIssue(issue.key) : undefined} />)}
          </DraftColumn>
          <DraftColumn title={t('В спринте', 'In sprint')} count={visibleSelected.length}
            description={locallyAdded.length || locallyRemoved.length ? t(
              `В черновике: +${locallyAdded.length} / −${locallyRemoved.length}`,
              `Draft changes: +${locallyAdded.length} / −${locallyRemoved.length}`,
            ) : undefined} action={(locallyAdded.length || locallyRemoved.length) > 0 && <button type="button" className="text-button"
              disabled={Boolean(pending)} onClick={() => updateEntry((previous) => ({ ...previous, added: [], removed: [] }))}>
              {t('Сбросить переносы', 'Reset moves')}
            </button>}>
            {(limit) => visibleSelected.slice(0, limit).map((issue) => <DraftCard key={issue.key} issue={issue} team={configuredTeam}
              item={planByKey.get(issue.key)} override={entry.overrides[issue.key]} t={t} format={format} connected={connected}
              disabled={Boolean(pending)} mode="sprint" onMove={() => updateSelection([issue.key], false)}
              onOverride={(override) => updateEntry((previous) => ({ ...previous, overrides: { ...previous.overrides, [issue.key]: override } }))}
              onFocusIssue={onFocusIssue && graph.issues.some(({ key }) => key === issue.key) ? () => onFocusIssue(issue.key) : undefined} />)}
          </DraftColumn>
          <aside className="sprint-draft-settings" aria-label={t('Настройки планирования', 'Planning settings')}>
            <DraftSettings data={data} entry={entry} epicNames={epicNames} format={format} t={t} disabled={Boolean(pending)}
              onChange={(patch) => updateEntry((previous) => ({ ...previous, ...patch }))} />
            <DraftTeam team={configuredTeam} projectTeam={[...availableTeam.values()]} plan={plan}
              entry={entry} format={format} t={t} disabled={Boolean(pending)}
              onTeamChange={(team) => {
                const latest = stateRef.current;
                onChange({ ...latest, teams: { ...latest.teams, [boardId]: team } });
              }}
              onAvailability={(id, value) => updateEntry((previous) => {
                const availability = { ...previous.availability };
                if (value === undefined) delete availability[id];
                else availability[id] = value;
                return { ...previous, availability };
              })} />
            <SprintWaves plan={plan} t={t} />
            <SprintHistory resource={history.resource} history={readyHistory} plan={plan} format={format} t={t} onRetry={history.reload} />
            <SprintRisks plan={plan} t={t} />
          </aside>
        </div>
        {data.graph.warnings.length > 0 && <details className="sprint-draft-details">
          <summary>{t('Ограничения данных Jira', 'Jira data limitations')} <ChevronDown size={14} /></summary>
          <ul>{data.graph.warnings.map((warning) => <li key={warning}>{localizeMessage(warning, language)}</li>)}</ul>
        </details>}
      </>}
    </div>
    {preview && <JiraPreview preview={preview} pending={pending === 'apply'} t={t} onClose={() => setPreview(undefined)}
      onConfirm={() => void applyChanges()} />}
  </section>;
}

function resourceItems<T>(resource?: Resource<T[]>): T[];
function resourceItems(resource?: Resource<{ members: JiraTeamMember[] }>): JiraTeamMember[];
function resourceItems<T>(resource?: Resource<T[] | { members: JiraTeamMember[] }>): T[] | JiraTeamMember[] {
  if (resource?.status !== 'ready') return [];
  return Array.isArray(resource.data) ? resource.data : resource.data.members;
}

function ResourceMessage({ resource, loading, onRetry }: { resource?: Resource<unknown>; loading: string; onRetry(): void }) {
  const { t, language } = usePreferences();
  if (resource?.status === 'loading') return <p className="sprint-draft-caption" role="status"><LoaderCircle className="spin" size={15} /> {loading}</p>;
  if (resource?.status === 'failed') return <div className="sprint-draft-message is-error" role="alert">
    {localizeMessage(resource.message, language)} <button className="text-button" type="button" onClick={onRetry}>{t('Повторить', 'Retry')}</button>
  </div>;
  return null;
}

function SprintDraftSummary({ plan, data, entry, format, t }: {
  plan: SprintDraftPlan; data: JiraSprintPlan; entry: SprintDraftEntry; format: FormatNumber; t: Translate;
}) {
  const selected = plan.items.filter(({ source }) => source === 'selected');
  const recommendations = plan.items.filter(({ source }) => source === 'recommended');
  const totals = selected.flatMap(({ stages }) => stages).reduce((summary, stage) => {
    if (stage.kind === 'work') summary.work += stage.points ?? 0;
    else summary.qa += stage.points ?? 0;
    return summary;
  }, { work: 0, qa: 0 });
  const blockers = new Set(selected.flatMap(({ blockers }) => blockers));
  const waveCount = Math.max(0, ...selected.flatMap(({ stages }) => stages.map(({ wave }) => wave ?? 0)));
  const goal = entry.goal ?? data.sprint.goal;
  return <section className="sprint-draft-summary" aria-label={t('Сводка спринта', 'Sprint summary')}>
    <div className="sprint-summary-intro">
      <div><h2>{data.sprint.name}</h2><span className="sprint-draft-chip">{sprintStatus(data.sprint.state, t)}</span></div>
      {goal && <p title={goal}>{goal}</p>}
    </div>
    <dl className="sprint-summary-metrics">
      <div><dt>{t('В черновике', 'In draft')}</dt><dd>{selected.length}</dd></div>
      <div><dt>{t('Работа, SP', 'Work, SP')}</dt><dd>{format(totals.work)}{plan.capacity !== undefined && <small> / {format(plan.capacity)}</small>}</dd></div>
      <div><dt>{t('Тестирование, QA', 'Testing, QA')}</dt><dd>{format(totals.qa)}{plan.qaCapacity !== undefined && <small> / {format(plan.qaCapacity)}</small>}</dd></div>
      <div><dt>{t('Рекомендации', 'Recommendations')}</dt><dd>{recommendations.length}</dd></div>
      <div><dt>{t('Волны', 'Waves')}</dt><dd>{waveCount}</dd></div>
      <div><dt>{t('Блокеры', 'Blockers')}</dt><dd className={blockers.size ? 'has-risk' : undefined}>{blockers.size}</dd></div>
    </dl>
  </section>;
}

function DraftColumn({ title, count, action, description, children }: {
  title: string; count: number; action?: ReactNode; description?: string; children(limit: number): ReactNode;
}) {
  const { t } = usePreferences();
  const [limit, setLimit] = useState(initialLimit);
  return <section className="sprint-draft-column" aria-label={title}>
    <header>
      <div><h2>{title} <b>{count}</b></h2>{description && <p className="sprint-draft-caption">{description}</p>}</div>
      {action}
    </header>
    {count > 0 ? <ul className="sprint-card-list">{children(limit)}</ul>
      : <p className="sprint-draft-caption sprint-draft-empty">{t('Подходящих задач нет.', 'No matching issues.')}</p>}
    {count > limit && <button type="button" className="button secondary sprint-draft-more" onClick={() => setLimit(limit + initialLimit)}>
      {t('Показать ещё', 'Show more')} ({count - limit})
    </button>}
  </section>;
}

function DraftCard({ issue, team, item, skip, override, t, format, connected, disabled, mode, onMove, onOverride, onFocusIssue }: {
  issue: JiraIssue; team: SprintDraftMember[]; item?: SprintDraftItem; skip?: SprintDraftPlan['skipped'][number];
  override?: SprintDraftOverride; t: Translate; format: FormatNumber; connected: boolean; disabled: boolean;
  mode: 'backlog' | 'sprint'; onMove(): void; onOverride(override: SprintDraftOverride): void; onFocusIssue?(): void;
}) {
  const { language } = usePreferences();
  const [openError, setOpenError] = useState('');
  const role = override?.role ?? inferSprintRole(issue);
  const qaStage = item?.stages.find(({ kind }) => kind === 'qa');
  const workStage = item?.stages.find(({ kind }) => kind === 'work');
  const workPoints = override?.estimate ?? issue.storyPoints;
  const qaPoints = override?.qaEstimate ?? issue.qaPoints;
  const blockers = item?.blockers ?? skip?.blockers;
  const tone = statusTone(issue);
  const moveLabel = mode === 'backlog' ? t(`Добавить ${issue.key} в спринт`, `Add ${issue.key} to sprint`)
    : t(`Убрать ${issue.key} из спринта`, `Remove ${issue.key} from sprint`);
  const jiraAssignee = issue.assigneeId
    ? team.find(({ id }) => id === issue.assigneeId)?.name ?? issue.assignee
    : issue.assignee;
  const selectedWork = override?.assigneeId ?? '';
  const selectedQa = override?.qaAssigneeId ?? '';
  function patchOverride(patch: SprintDraftOverride) {
    onOverride({ ...override, ...patch });
  }
  return <li className="sprint-draft-card" data-status={tone} data-recommended={item?.source === 'recommended' || undefined}>
    <header>
      <div className="sprint-card-key">
        {onFocusIssue ? <button type="button" className="text-button" onClick={onFocusIssue} title={t('Открыть на графе', 'Open on graph')}>{issue.key}</button>
          : <strong>{issue.key}</strong>}
        {connected && <button type="button" className="icon-button" aria-label={t(`Открыть ${issue.key} в Jira`, `Open ${issue.key} in Jira`)}
          title={t('Открыть в Jira', 'Open in Jira')} onClick={() => {
            setOpenError('');
            void openIssue(issue).catch((cause: unknown) => setOpenError(localizeMessage(errorMessage(cause), language)));
          }}><ExternalLink size={13} /></button>}
      </div>
      <button type="button" className="icon-button outline sprint-card-move" disabled={disabled || issue.isSubtask}
        aria-label={moveLabel} title={issue.isSubtask
          ? t('Спринт подзадачи меняется вместе с родителем', 'Subtasks move with their parent issue') : moveLabel}
        onClick={onMove}>{mode === 'backlog' ? <Plus size={17} /> : <X size={17} />}</button>
    </header>
    <p className="sprint-card-title">{issue.summary}</p>
    <div className="sprint-card-tags">
      <span className={`status ${tone}`}>{issue.status}</span>
      {role && <span className="sprint-draft-chip">{role}</span>}
      {role !== 'QA' && workPoints !== undefined && <span className="sprint-draft-chip">{format(workPoints)} SP</span>}
      {qaPoints !== undefined && <span className="sprint-draft-chip">{format(qaPoints)} QA</span>}
      {issue.epicKey && <span className="sprint-draft-chip" title={issue.epicSummary}>{issue.epicKey}</span>}
      {issue.isSubtask && <span className="sprint-draft-chip" title={t(
        'Спринт подзадачи меняется вместе с родителем', 'Subtasks move with their parent issue',
      )}>{t('Подзадача', 'Subtask')}{issue.parentKey && ` · ${issue.parentKey}`}</span>}
      {item?.source === 'recommended' && <span className="sprint-draft-chip is-recommended">{t('Рекомендация', 'Recommended')}</span>}
    </div>
    {(workStage?.assignee || qaStage?.assignee || jiraAssignee) && <p className="sprint-draft-caption sprint-card-people">
      {workStage?.assignee && <span>{workStage.role ?? t('Работа', 'Work')} · {workStage.assignee}{workStage.wave ? ` · ${t('волна', 'wave')} ${workStage.wave}` : ''}</span>}
      {qaStage?.assignee && <span>QA · {qaStage.assignee}{qaStage.wave ? ` · ${t('волна', 'wave')} ${qaStage.wave}` : ''}</span>}
      {!workStage?.assignee && !qaStage?.assignee && <span>{jiraAssignee}</span>}
    </p>}
    {blockers && blockers.length > 0 && <p className="sprint-card-risk"><CircleAlert size={13} />
      {t('Блокеры', 'Blockers')} · {blockers.join(', ')}
    </p>}
    {skip && !blockers?.length && <p className="sprint-draft-caption">{reasonText(skip.reason, t)}</p>}
    {item?.coveredBy && <p className="sprint-draft-caption">{t(
      `Оценка учтена в ${item.coveredBy}`, `Estimate included in ${item.coveredBy}`,
    )}</p>}
    {openError && <p className="sprint-card-risk" role="alert">{openError}</p>}
    {!issue.isEpic && tone !== 'done' && <details className="sprint-draft-details sprint-card-edit">
      <summary>{t('Роль, исполнитель и оценка', 'Role, assignee and estimates')} <ChevronDown size={13} /></summary>
      <fieldset disabled={disabled} className="sprint-card-fields">
        <label>{t('Роль задачи', 'Issue role')}
          <select value={override?.role ?? ''} onChange={(event) => patchOverride({ role: event.target.value as SprintRole || undefined })}>
            <option value="">{t('Из меток', 'From labels')}{inferSprintRole(issue) ? ` · ${inferSprintRole(issue)}` : ''}</option>
            {roles.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label>{t('Исполнитель работы', 'Work assignee')}
          <select value={selectedWork} disabled={role === 'QA'} onChange={(event) => patchOverride({ assigneeId: event.target.value || undefined })}>
            <option value="">{jiraAssignee ?? t('Из команды', 'From team')}</option>
            {selectedWork && !team.some(({ id }) => id === selectedWork) && <option value={selectedWork}>{selectedWork}</option>}
            {team.filter((person) => !role || person.roles.includes(role) || person.id === selectedWork).map(({ id, name }) =>
              <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <NumberField label={t('Оценка работы, SP', 'Work estimate, SP')} value={override?.estimate} placeholder={issue.storyPoints}
          disabled={role === 'QA'} onChange={(estimate) => patchOverride({ estimate })} />
        <NumberField label={t('Оценка тестирования, QA', 'Testing estimate, QA')} value={override?.qaEstimate} placeholder={issue.qaPoints}
          onChange={(qaEstimate) => patchOverride({ qaEstimate })} />
        <label>{t('Исполнитель QA', 'QA assignee')}
          <select value={selectedQa} onChange={(event) => patchOverride({ qaAssigneeId: event.target.value || undefined })}>
            <option value="">{t('Из команды', 'From team')}</option>
            {selectedQa && !team.some(({ id }) => id === selectedQa) && <option value={selectedQa}>{selectedQa}</option>}
            {team.filter((person) => person.roles.includes('QA') || person.id === selectedQa).map(({ id, name }) =>
              <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>{t('Нужна проверка QA', 'QA verification')}
          <select value={override?.qaRequired === undefined ? '' : String(override.qaRequired)} disabled={role === 'QA'}
            onChange={(event) => patchOverride({ qaRequired: event.target.value === '' ? undefined : event.target.value === 'true' })}>
            <option value="">{t('По оценке и меткам', 'From estimate and labels')}</option>
            <option value="true">{t('Да', 'Yes')}</option>
            <option value="false">{t('Нет', 'No')}</option>
          </select>
        </label>
      </fieldset>
    </details>}
  </li>;
}

function NumberField({ label, value, placeholder, disabled, max = maximumValue, onChange }: {
  label: string; value?: number; placeholder?: number; disabled?: boolean; max?: number; onChange(value: number | undefined): void;
}) {
  return <label>{label}
    <input type="number" inputMode="decimal" min="0" max={max} step="any" value={value ?? ''} disabled={disabled}
      placeholder={placeholder === undefined ? undefined : String(placeholder)} onChange={(event) => {
        if (event.target.validity.badInput) return;
        if (event.target.value === '') onChange(undefined);
        else if (event.target.validity.valid && Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber);
      }} />
  </label>;
}

function DraftSettings({ data, entry, epicNames, format, t, disabled, onChange }: {
  data: JiraSprintPlan; entry: SprintDraftEntry; epicNames: Map<string, string>; format: FormatNumber; t: Translate;
  disabled: boolean; onChange(patch: Partial<SprintDraftEntry>): void;
}) {
  const [epic, setEpic] = useState('');
  const reserve = entry.reservePercent ?? defaultReserve;
  const chosen = new Set(entry.epicPriorities);
  const available = [...epicNames].filter(([key]) => !chosen.has(key)).sort(([, left], [, right]) => left.localeCompare(right, undefined, { numeric: true }));
  function moveEpic(index: number, shift: number) {
    const priorities = [...entry.epicPriorities];
    [priorities[index], priorities[index + shift]] = [priorities[index + shift], priorities[index]];
    onChange({ epicPriorities: priorities });
  }
  return <details className="sprint-draft-details sprint-settings-section" open>
    <summary><SlidersHorizontal size={16} /> {t('Цель и лимиты', 'Goal and capacity')} <ChevronDown size={15} /></summary>
    <fieldset disabled={disabled}>
      <label>{t('Цель спринта', 'Sprint goal')}
        <textarea rows={2} maxLength={1000} value={entry.goal ?? data.sprint.goal ?? ''}
          placeholder={t('Какой результат нужен к концу спринта?', 'What should be true by the end of the sprint?')}
          onChange={(event) => onChange({ goal: event.target.value })} />
      </label>
      <div className="sprint-settings-pairs">
        <NumberField label={t('Командный лимит, SP', 'Team capacity, SP')} value={entry.capacity} onChange={(capacity) => onChange({ capacity })} />
        <NumberField label={t('Командный лимит, QA', 'Team capacity, QA')} value={entry.qaCapacity} onChange={(qaCapacity) => onChange({ qaCapacity })} />
      </div>
      <NumberField label={t('Резерв, %', 'Reserve, %')} value={entry.reservePercent} max={100} placeholder={defaultReserve}
        onChange={(reservePercent) => onChange({ reservePercent })} />
      <p className="sprint-draft-caption">{reserve ? t(
        `Резерв ${format(reserve)}% вычитается из обоих командных лимитов.`,
        `A ${format(reserve)}% reserve is held back from both team limits.`,
      ) : t('Пустой лимит берётся из истории или доступности команды.', 'An empty limit uses history or team availability.')}</p>
    </fieldset>
    <details className="sprint-draft-details sprint-draft-subsection">
      <summary>{t('Поля оценок Jira', 'Jira estimate fields')} <ChevronDown size={14} /></summary>
      <fieldset disabled={disabled}>
        <FieldSelect label={t('Поле Story Points', 'Story Points field')} value={entry.storyPointsField} options={data.graph.storyPointsFields}
          empty={t('Автоопределение', 'Detect automatically')} onChange={(storyPointsField) => onChange({ storyPointsField })} />
        <FieldSelect label={t('Поле QA-оценки', 'QA estimate field')} value={entry.qaPointsField} options={data.graph.qaPointsFields ?? []}
          empty={t('Автоопределение', 'Detect automatically')} onChange={(qaPointsField) => onChange({ qaPointsField })} />
      </fieldset>
    </details>
    <details className="sprint-draft-details sprint-draft-subsection" open={entry.epicPriorities.length > 0}>
      <summary>{t('Приоритеты эпиков', 'Epic priorities')} {entry.epicPriorities.length > 0 && <b>{entry.epicPriorities.length}</b>}<ChevronDown size={14} /></summary>
      <fieldset disabled={disabled}>
        {entry.epicPriorities.length > 0 && <ol className="sprint-epic-list">{entry.epicPriorities.map((key, index) => <li key={key}>
          <span title={epicNames.get(key)}>{index + 1}. {key}{epicNames.get(key) && epicNames.get(key) !== key ? ` · ${epicNames.get(key)}` : ''}</span>
          <button type="button" className="text-button" disabled={index === 0} onClick={() => moveEpic(index, -1)}
            aria-label={t(`Поднять ${key}`, `Move ${key} up`)}>↑</button>
          <button type="button" className="text-button" disabled={index === entry.epicPriorities.length - 1} onClick={() => moveEpic(index, 1)}
            aria-label={t(`Опустить ${key}`, `Move ${key} down`)}>↓</button>
          <button type="button" className="icon-button" aria-label={t(`Убрать приоритет ${key}`, `Remove priority for ${key}`)}
            onClick={() => onChange({ epicPriorities: entry.epicPriorities.filter((value) => value !== key) })}><Trash2 size={14} /></button>
        </li>)}</ol>}
        <div className="sprint-draft-add">
          <select aria-label={t('Эпик для приоритета', 'Epic to prioritise')} value={available.some(([key]) => key === epic) ? epic : ''}
            onChange={(event) => setEpic(event.target.value)}>
            <option value="">{t('Выбрать эпик', 'Choose an epic')}</option>
            {available.map(([key, name]) => <option value={key} key={key}>{name === key ? key : `${key} · ${name}`}</option>)}
          </select>
          <button type="button" className="icon-button outline" aria-label={t('Добавить приоритет эпика', 'Add epic priority')}
            disabled={!available.some(([key]) => key === epic)} onClick={() => {
              onChange({ epicPriorities: [...entry.epicPriorities, epic] });
              setEpic('');
            }}><Plus size={16} /></button>
        </div>
      </fieldset>
    </details>
  </details>;
}

function FieldSelect({ label, options, value, empty, onChange }: {
  label: string; options: { id: string; name: string }[]; value?: string; empty: string; onChange(value?: string): void;
}) {
  const existing = options.filter(({ id }) => fieldPattern.test(id));
  return <label>{label}<select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
    <option value="">{empty}</option>
    {value && !existing.some(({ id }) => id === value) && <option value={value}>{value}</option>}
    {existing.map(({ id, name }) => <option key={id} value={id}>{name} ({id})</option>)}
  </select></label>;
}

function DraftTeam({ team, projectTeam, plan, entry, format, t, disabled, onTeamChange, onAvailability }: {
  team: SprintDraftMember[]; projectTeam: JiraTeamMember[]; plan: SprintDraftPlan; entry: SprintDraftEntry; format: FormatNumber;
  t: Translate; disabled: boolean; onTeamChange(team: SprintDraftMember[]): void; onAvailability(id: string, value?: number): void;
}) {
  const [member, setMember] = useState('');
  const [manual, setManual] = useState('');
  const members = new Set(team.map(({ id }) => id));
  const available = projectTeam.filter(({ id }) => !members.has(id));
  const selected = available.find(({ id }) => id === member);
  const name = manual.trim();
  const manualId = `manual:${name.toLocaleLowerCase()}`;
  const canAddManual = Boolean(name) && !members.has(manualId) && ![...team, ...projectTeam].some((person) =>
    person.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  function addMember(person: JiraTeamMember) {
    onTeamChange([...team, { ...person, roles: [] }]);
    setMember('');
    setManual('');
  }
  function patchMember(id: string, patch: Partial<SprintDraftMember>) {
    onTeamChange(team.map((person) => person.id === id ? { ...person, ...patch } : person));
  }
  const loads = new Map(plan.loads.map((load) => [load.id, load]));
  return <details className="sprint-draft-details sprint-settings-section" open>
    <summary><Users size={16} /> {t('Команда и доступность', 'Team and availability')} <b>{team.length}</b><ChevronDown size={15} /></summary>
    <fieldset disabled={disabled}>
      {team.length === 0 && <p className="sprint-draft-caption">{t(
        'Добавь участников и отметь их роли, чтобы получить распределение задач.',
        'Add team members and their roles to receive assignment suggestions.',
      )}</p>}
      {team.length > 0 && <ul className="sprint-team-list">{team.map((person) => {
        const load = loads.get(person.id);
        const history = plan.velocity.people.get(person.id);
        return <li key={person.id}>
          <div className="sprint-team-member">
            <strong>{person.name}</strong>
            <button type="button" className="icon-button" aria-label={t(`Убрать ${person.name} из команды`, `Remove ${person.name} from team`)}
              onClick={() => onTeamChange(team.filter(({ id }) => id !== person.id))}><Trash2 size={14} /></button>
          </div>
          <div className="sprint-team-roles" aria-label={t(`Роли ${person.name}`, `Roles for ${person.name}`)}>
            {roles.map((role) => <button type="button" key={role} aria-pressed={person.roles.includes(role)} onClick={() =>
              patchMember(person.id, { roles: person.roles.includes(role) ? person.roles.filter((value) => value !== role) : [...person.roles, role] })}>{role}</button>)}
          </div>
          <div className="sprint-settings-pairs team-capacities">
            <NumberField label="SP" value={person.capacity} placeholder={history?.averagePoints} onChange={(capacity) => patchMember(person.id, { capacity })} />
            <NumberField label="QA" value={person.qaCapacity} placeholder={history?.averageQaPoints} onChange={(qaCapacity) => patchMember(person.id, { qaCapacity })} />
            <NumberField label={t('Доступность, %', 'Availability, %')} value={entry.availability[person.id]} placeholder={100} max={100}
              onChange={(value) => onAvailability(person.id, value)} />
          </div>
          {history?.averagePoints !== undefined && <p className="sprint-draft-caption">{t(
            `Среднее по истории — ${format(history.averagePoints)} SP`, `Historical average — ${format(history.averagePoints)} SP`,
          )}</p>}
          {load && <p className="sprint-draft-caption">{t('План', 'Plan')} · {format(load.used)}{load.capacity !== undefined ? ` / ${format(load.capacity)}` : ''} SP
            {' · '}{format(load.qaUsed)}{load.qaCapacity !== undefined ? ` / ${format(load.qaCapacity)}` : ''} QA</p>}
        </li>;
      })}</ul>}
      {available.length > 0 && <div className="sprint-draft-add">
        <select aria-label={t('Участник проекта Jira', 'Jira project member')} value={selected?.id ?? ''} onChange={(event) => setMember(event.target.value)}>
          <option value="">{t('Участник Jira', 'Jira member')}</option>
          {available.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button type="button" className="icon-button outline" aria-label={t('Добавить участника Jira', 'Add Jira member')}
          disabled={!selected} onClick={() => { if (selected) addMember(selected); }}><Plus size={16} /></button>
      </div>}
      <div className="sprint-draft-add">
        <input placeholder={t('Имя нового участника', 'Name of new member')} aria-label={t('Имя нового участника', 'Name of new member')}
          value={manual} maxLength={120} onChange={(event) => setManual(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && canAddManual) addMember({ id: manualId, name }); }} />
        <button type="button" className="icon-button outline" aria-label={t('Добавить участника вручную', 'Add member manually')}
          disabled={!canAddManual} onClick={() => addMember({ id: manualId, name })}><Plus size={16} /></button>
      </div>
      <p className="sprint-draft-caption">{t(
        'Состав сохраняется для доски. Доступность задаётся отдельно для спринта.',
        'The team is saved for this board. Availability is set per sprint.',
      )}</p>
    </fieldset>
  </details>;
}

function SprintWaves({ plan, t }: { plan: SprintDraftPlan; t: Translate }) {
  const waves = new Map<number, { key: string; role?: SprintRole; assignee?: string; proposed: boolean }[]>();
  for (const { issue, source, stages } of plan.items) {
    for (const { wave, role, assignee } of stages) {
      if (wave === undefined) continue;
      const row = waves.get(wave) ?? [];
      row.push({ key: issue.key, role, assignee, proposed: source === 'recommended' });
      waves.set(wave, row);
    }
  }
  if (!waves.size) return null;
  return <details className="sprint-draft-details sprint-settings-section">
    <summary><GitBranch size={16} /> {t('Параллельная работа', 'Parallel work')} <b>{waves.size}</b><ChevronDown size={15} /></summary>
    <p className="sprint-draft-caption">{t(
      'Задачи в одной волне можно вести параллельно. Волны показывают порядок, а длительность зависит от оценок и команды.',
      'Issues in the same wave can run in parallel. Waves show order. Timing depends on the estimates and team.',
    )}</p>
    <ol className="sprint-wave-list">{[...waves].sort(([left], [right]) => left - right).map(([wave, entries]) => <li key={wave}>
      <strong>{t(`Волна ${wave}`, `Wave ${wave}`)}</strong>
      <ul>{entries.map(({ key, role, assignee, proposed }) => <li key={`${key}:${role ?? ''}`}>
        <span className={`sprint-draft-chip${proposed ? ' is-recommended' : ''}`}>{key}</span>
        {role && <span>{role}</span>}
        {assignee && <span>{assignee}</span>}
      </li>)}</ul>
    </li>)}</ol>
  </details>;
}

function SprintHistory({ resource, history, plan, format, t, onRetry }: {
  resource?: Resource<JiraSprintVelocity>; history?: JiraSprintVelocity; plan: SprintDraftPlan; format: FormatNumber; t: Translate; onRetry(): void;
}) {
  const { language } = usePreferences();
  const average = plan.velocity;
  const averageText = (value: number | undefined) => value === undefined ? '—' : format(value);
  return <details className="sprint-draft-details sprint-settings-section">
    <summary><Clock3 size={16} /> {t('История последних трёх спринтов', 'Last three sprints')} <ChevronDown size={15} /></summary>
    <ResourceMessage resource={resource} loading={t('Загрузка истории…', 'Loading history…')} onRetry={onRetry} />
    {!resource || resource.status === 'ready' && !history?.samples.length ? <p className="sprint-draft-caption">{t(
      'История закрытых спринтов недоступна.',
      'No completed sprint history is available.',
    )}</p> : null}
    {history && history.samples.length > 0 && <>
      <p className="sprint-draft-caption">{t(
        `Среднее по полным спринтам (${average.sampleCount}) — ${averageText(average.averagePoints)} SP · ${averageText(average.averageQaPoints)} QA.`,
        `Average across complete sprints (${average.sampleCount}) — ${averageText(average.averagePoints)} SP · ${averageText(average.averageQaPoints)} QA.`,
      )}</p>
      <ul className="sprint-history-list">{history.samples.map((sample) => <li key={sample.sprint.id}>
        <strong>{sample.sprint.name}</strong>
        <span>{averageText(sample.completedStoryPoints)} SP · {averageText(sample.completedQaPoints)} QA</span>
        {(!sample.complete || sample.storyPointsComplete === false || sample.qaPointsComplete === false || sample.peopleComplete === false) &&
          <small>{t('Данные неполные', 'Incomplete data')}</small>}
      </li>)}</ul>
      <p className="sprint-draft-caption">{t(
        'Оценки и исполнители на момент закрытия спринта по доступной истории Jira.',
        'Estimates and assignees at sprint closure, based on the available Jira history.',
      )}</p>
      {history.warnings.length > 0 && <ul className="sprint-draft-caption sprint-history-warnings">
        {history.warnings.map((warning) => <li key={warning}>{localizeMessage(warning, language)}</li>)}
      </ul>}
    </>}
  </details>;
}

function SprintRisks({ plan, t }: { plan: SprintDraftPlan; t: Translate }) {
  const roleLoads = plan.roleLoads.filter((load) => load.people || load.used || load.qaUsed);
  return <>
    {roleLoads.length > 0 && <details className="sprint-draft-details sprint-settings-section">
      <summary><GitBranch size={16} /> {t('План по ролям', 'Plan by role')} <ChevronDown size={15} /></summary>
      <ul className="sprint-role-loads">{roleLoads.map(({ role, used, qaUsed, people }) => <li key={role}>
        <strong>{role}</strong><span>{role === 'QA' ? `${qaUsed} QA` : `${used} SP`}</span><small>{t(`Участников — ${people}`, `Members — ${people}`)}</small>
      </li>)}</ul>
    </details>}
    {plan.risks.length > 0 && <details className="sprint-draft-details sprint-settings-section">
      <summary><CircleAlert size={16} /> {t('Риски и блокеры', 'Risks and blockers')} <b>{plan.risks.length}</b><ChevronDown size={15} /></summary>
      <ul className="sprint-risk-list">{plan.risks.map((risk, index) => <li key={`${risk.kind}-${risk.issueKey ?? ''}-${index}`}>
        {risk.issueKey && <strong>{risk.issueKey} · </strong>}{reasonText(risk.kind, t)}
        {risk.blockers?.length ? <span> · {risk.blockers.join(', ')}</span> : null}
      </li>)}</ul>
    </details>}
  </>;
}

function JiraPreview({ preview, pending, t, onClose, onConfirm }: {
  preview: Preview; pending: boolean; t: Translate; onClose(): void; onConfirm(): void;
}) {
  const { addIssueKeys, removeIssueKeys } = preview.input;
  return <Dialog title={t('Изменения состава спринта Jira', 'Jira sprint membership changes')} onClose={onClose} busy={pending}
    className="sprint-draft-preview">
    <div className="sprint-preview-content">
      <strong>{preview.sprint}</strong>
      {addIssueKeys.length > 0 && <div><h3>{t('Добавить в спринт', 'Add to sprint')} ({addIssueKeys.length})</h3>
        <p>{addIssueKeys.join(', ')}</p></div>}
      {removeIssueKeys.length > 0 && <div><h3>{t('Вернуть в бэклог', 'Return to backlog')} ({removeIssueKeys.length})</h3>
        <p>{removeIssueKeys.join(', ')}</p></div>}
      {preview.remaining > 0 && <p className="sprint-draft-message is-warning">{t(
        `За один раз применяются до ${membershipBatchSize} изменений. В черновике останется ещё ${preview.remaining}.`,
        `Each batch applies up to ${membershipBatchSize} changes. Another ${preview.remaining} will stay in the draft.`,
      )}</p>}
      <p className="sprint-draft-caption">{t(
        'В Jira изменится состав спринта. Подзадачи переместятся вместе с родителями. Цель, оценки, роли и распределение сохранятся в локальном черновике.',
        'Jira will update sprint membership. Subtasks move with their parents. The goal, estimates, roles and assignments stay in the local draft.',
      )}</p>
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={onClose} disabled={pending}>{t('Отмена', 'Cancel')}</button>
        <button type="button" className="button primary" onClick={onConfirm} disabled={pending}>
          {pending ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />} {t('Применить в Jira', 'Apply in Jira')}
        </button>
      </div>
    </div>
  </Dialog>;
}
