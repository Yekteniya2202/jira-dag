import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MiniMap,
  Position, ReactFlow, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeHandle, type NodeProps, type OnConnect, type OnNodesChange, type Viewport,
} from '@xyflow/react';
import {
  ArrowRight, ArrowUpRight, CalendarDays, CalendarX2, CheckSquare2, CircleDot, ClipboardList, Flag,
  FolderKanban, GitBranch, Layers3, Link2, ListTree, MessageSquarePlus, Package, Plus, StickyNote, UserRound,
} from 'lucide-react';
import type { JiraGraph, JiraGraphNote, JiraIssue } from '../shared/contracts';
import { epicColors, epicColorStyle } from './epic-color';
import { routeEdges, type RoutedEdge, type RouteObstacle } from './edge-routing';
import { downstreamPoints, fitMovedZones, layoutWorkspace, NOTE_HEIGHT, NOTE_WIDTH, notePosition, type GraphZone, type GroupMode } from './graph-layout';
import { blockingEdges, CARD_HEIGHT, CARD_WIDTH, statusTone, tracePath, type Direction, type GraphPosition } from './graph-model';
import { usePreferences } from './i18n';
import { PersonAvatar } from './project-team';
import './graph-canvas.css';

export interface CardFields {
  points: boolean;
  qaPoints?: boolean;
  assignee: boolean;
  priority: boolean;
  labels: boolean;
  dueDate: boolean;
  estimate: boolean;
}

type Card = Node<{
  issue: JiraIssue;
  direction: Direction;
  muted: boolean;
  highlighted?: boolean;
  analysisMatch?: boolean;
  fields: CardFields;
  noteCount?: number;
  avatar?: string;
  epic?: { key: string; summary?: string; color?: string };
  onOpen?: (issue: JiraIssue) => void;
  onOpenEpic?: (key: string, summary?: string) => void;
  onNote?: (key: string, focusInput: boolean) => void;
  onCreateRelated?: (issue: JiraIssue) => void;
}, 'issue'>;
type Zone = Node<{
  zone: GraphZone;
  epic?: JiraIssue;
  epicColor?: string;
  onSelect?: (key: string) => void;
  onOpen?: (issue: JiraIssue) => void;
  onOpenEpic?: (key: string, summary?: string) => void;
  onCreateRelated?: (issue: JiraIssue) => void;
  selected: boolean;
  analysisMatch?: boolean;
}, 'zone'>;
type Sticky = Node<{
  issueKey: string;
  note: JiraGraphNote;
  count: number;
  direction: Direction;
  onOpen(key: string, focusInput: boolean): void;
}, 'note'>;
type CanvasNode = Card | Zone | Sticky;
type Link = Edge<{
  route?: RoutedEdge;
  labelWidth: number;
  hierarchy: boolean;
  active: boolean;
  muted: boolean;
  cycle: boolean;
  analysisMatch?: boolean;
  points?: number;
  onSelect(id: string): void;
}, 'jiraLink'>;

const maximumLabelWidth = 184;
const labelHeight = 23;
const pointsLabelHeight = 37;

function arrowhead(route: RoutedEdge): string | undefined {
  const { arrowTip: tip, points } = route;
  const previous = route.arrowFrom ?? points.at(-2);
  if (!previous) return undefined;
  const length = Math.hypot(tip.x - previous.x, tip.y - previous.y);
  if (!length) return undefined;
  const dx = (tip.x - previous.x) / length;
  const dy = (tip.y - previous.y) / length;
  const headLength = Math.min(11, length);
  const halfWidth = Math.min(5, headLength / 2);
  const x = tip.x - headLength * dx;
  const y = tip.y - headLength * dy;
  return `M ${tip.x} ${tip.y} L ${x + halfWidth * dy} ${y - halfWidth * dx} L ${x - halfWidth * dy} ${y + halfWidth * dx} Z`;
}

function IssueCard({ data, selected }: NodeProps<Card>) {
  const { language, t } = usePreferences();
  const { issue, direction, muted, highlighted, analysisMatch, fields, onOpen, onNote, noteCount, onCreateRelated, avatar, epic, onOpenEpic } = data;
  const across = direction === 'LR';
  const hours = issue.remainingEstimateSeconds ?? issue.originalEstimateSeconds;
  const assignee = fields.assignee && issue.assignee?.trim();
  const details = [
    fields.priority && issue.priority,
    fields.labels && issue.labels?.slice(0, 3).map((label) => `#${label}`).join(' '),
    fields.dueDate && issue.dueDate,
    fields.estimate && hours !== undefined && `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(hours / 3600)} ${t('ч', 'h')}`,
  ].filter(Boolean).join(' · ');
  return (
    <div className={`issue-card tone-${statusTone(issue)} ${selected ? 'is-selected' : ''} ${muted ? 'is-muted' : ''} ${issue.external ? 'is-external' : ''}`}
      data-filter-match={highlighted} data-analysis-match={analysisMatch} style={issue.isEpic ? epicColorStyle(issue.epicColor) : undefined}>
      <Handle type="target" position={across ? Position.Left : Position.Top} aria-label={t('Входящая зависимость', 'Incoming dependency')} />
      <div className="issue-card-key">
        <CheckSquare2 size={14} /><span>{issue.key}</span>
        {onNote && <button type="button" className="issue-card-note nodrag nopan" title={t('Заметки на графе', 'Graph notes')} data-export-ignore
          aria-label={`${t('Заметки на графе', 'Graph notes')} ${issue.key}`}
          onClick={(event) => { event.stopPropagation(); onNote(issue.key, true); }}>
          <MessageSquarePlus size={13} />{noteCount ? <span>{noteCount}</span> : null}
        </button>}
        {onOpen && issue.url && <button type="button" className="issue-card-open nodrag nopan" title={t('Открыть в Jira', 'Open in Jira')} data-export-ignore
          aria-label={`${t('Открыть в Jira', 'Open in Jira')} ${issue.key}`}
          onClick={(event) => { event.stopPropagation(); onOpen(issue); }}><ArrowUpRight size={15} /></button>}
        {onCreateRelated && <RelatedIssueButton issue={issue} onCreate={onCreateRelated} />}
      </div>
      <div className="issue-card-title" title={issue.summary}>{issue.summary}</div>
      {epic && onOpenEpic && <button type="button" className="issue-card-epic epic-color-label nodrag nopan" style={epicColorStyle(epic.color)}
        aria-label={t(`Открыть граф эпика ${epic.key}`, `Open epic graph ${epic.key}`)}
        title={epic.summary ? `${epic.key} · ${epic.summary}` : epic.key}
        onClick={(event) => { event.stopPropagation(); onOpenEpic(epic.key, epic.summary); }}>
        <Layers3 size={11} aria-hidden="true" /><span>{epic.summary ?? epic.key}</span>
      </button>}
      <div className="issue-card-meta">
        <span className={`status ${statusTone(issue)}`} title={issue.status}><CircleDot size={11} /> {issue.status}</span>
        {fields.points && issue.storyPoints !== undefined && <span className="points" title="Story points">{issue.storyPoints} SP</span>}
        {fields.qaPoints !== false && issue.qaPoints !== undefined && <span className="points qa-points"
          title={t('Оценка тестирования', 'QA estimate')}>{issue.qaPoints} QA</span>}
      </div>
      {assignee && <div className="issue-card-assignee" title={`${t('Исполнитель', 'Assignee')}: ${assignee}`}>
        <PersonAvatar name={assignee} src={avatar} /><span>{assignee}</span>
      </div>}
      {details && <div className="issue-card-details" title={details}>{details}</div>}
      <Handle type="source" position={across ? Position.Right : Position.Bottom} aria-label={t('Исходящая зависимость', 'Outgoing dependency')} />
    </div>
  );
}

function RelatedIssueButton({ issue, onCreate }: { issue: JiraIssue; onCreate(issue: JiraIssue): void }) {
  const { t } = usePreferences();
  const label = t(`Создать задачу со связью с ${issue.key}`, `Create an issue linked to ${issue.key}`);
  return <button type="button" className="issue-card-create nodrag nopan" title={label} aria-label={label} data-export-ignore
    onClick={(event) => { event.stopPropagation(); onCreate(issue); }}><Plus size={15} aria-hidden="true" /></button>;
}

const groupIcons = {
  project: FolderKanban, status: CircleDot, assignee: UserRound, sprint: CalendarDays, release: Package, priority: Flag,
  level: ListTree, 'open-level': ListTree, 'sprint-unscheduled': CalendarX2, 'sprint-external': Link2,
};

function GroupZone({ data: { zone, epic, epicColor, onSelect, onOpen, onOpenEpic, onCreateRelated, selected, analysisMatch } }: NodeProps<Zone>) {
  const { t } = usePreferences();
  const GroupIcon = zone.appearance ? groupIcons[zone.appearance.variant] : zone.kind === 'nested' ? ClipboardList : Layers3;
  const colorStyle = epicColorStyle(epicColor);
  const title = <>{colorStyle ? <span className="epic-color-swatch" style={colorStyle} aria-hidden="true" />
    : <GroupIcon size={15} aria-hidden="true" />}<span>{zone.title}</span></>;
  const key = zone.epicKey;
  const openEpic = key && onOpenEpic ? () => onOpenEpic(key, epic?.summary ?? (zone.title.slice(key.length + 3) || undefined)) : undefined;
  return <div className={`graph-zone ${zone.kind}${selected ? ' is-selected' : ''}`} data-export-zone={zone.id}
    style={colorStyle}
    data-export-members={JSON.stringify(zone.members)}
    data-group-variant={zone.appearance?.variant} data-group-color={zone.appearance?.color} data-analysis-match={analysisMatch}>
    <div className="graph-zone-heading">
      {epic && onSelect
        ? <button type="button" className="graph-zone-title graph-zone-action nodrag nopan" title={zone.title}
          aria-label={`${t('Открыть сведения об эпике', 'View epic details')} ${zone.title}`}
          onClick={(event) => { event.stopPropagation(); onSelect(epic.key); }}>{title}</button>
        : openEpic && key
          ? <button type="button" className="graph-zone-title graph-zone-action nodrag nopan" title={zone.title}
            aria-label={t(`Открыть граф эпика ${key}`, `Open epic graph ${key}`)}
            onClick={(event) => { event.stopPropagation(); openEpic(); }}>{title}</button>
          : <div className="graph-zone-title" title={zone.title}>{title}</div>}
      {epic?.url && onOpen && <button type="button" className="graph-zone-open graph-zone-action nodrag nopan" data-export-ignore
        title={t('Открыть в Jira', 'Open in Jira')} aria-label={`${t('Открыть в Jira', 'Open in Jira')} ${epic.key}`}
        onClick={(event) => { event.stopPropagation(); onOpen(epic); }}><ArrowUpRight size={15} /></button>}
      {epic && onCreateRelated && <RelatedIssueButton issue={epic} onCreate={onCreateRelated} />}
    </div>
    <div className="graph-zone-meta" title={t('Выполнено задач / всего', 'Completed issues / total')}>
      {zone.done}/{zone.issues}{zone.points !== undefined && <> · {zone.points} SP</>}
    </div>
  </div>;
}

function NoteSticker({ data: { issueKey, note, count, direction, onOpen } }: NodeProps<Sticky>) {
  const { t } = usePreferences();
  const label = t(`Открыть заметки к ${issueKey}`, `Open notes for ${issueKey}`);
  return <button type="button" className="graph-note-sticker nodrag nopan" data-export-note={issueKey} data-direction={direction}
    aria-label={label} aria-description={note.text.slice(0, 240)} title={label}
    onClick={(event) => { event.stopPropagation(); onOpen(issueKey, false); }}>
    <span className="graph-note-sticker-heading"><StickyNote size={13} aria-hidden="true" />
      <span>{note.author || t('Заметка', 'Note')}</span>{count > 1 && <b>{count}</b>}
    </span>
    <span className="graph-note-sticker-text">{note.text}</span>
  </button>;
}

function JiraLink({ id, data, label, selected }: EdgeProps<Link>) {
  const { t } = usePreferences();
  if (!data?.route?.path) return null;
  const { route, cycle, hierarchy, analysisMatch, points } = data;
  const active = selected || data.active;
  const muted = data.muted && !selected;
  const color = cycle ? 'var(--edge-cycle)' : analysisMatch ? 'var(--green)'
    : active ? 'var(--edge-active)' : hierarchy ? 'var(--edge-hierarchy)' : 'var(--edge-default)';
  const opacity = muted ? 0.45 : 1;
  const tip = arrowhead(route);
  const title = `${cycle ? '↻ ' : ''}${String(label ?? '')}`;
  return (
    <>
      <title>{title}</title>
      <BaseEdge
        id={id} path={route.path} interactionWidth={16}
        style={{
          stroke: color, strokeWidth: active || analysisMatch ? 2.6 : 1.9, strokeLinejoin: 'round',
          strokeDasharray: hierarchy || cycle ? '6 5' : undefined, opacity,
        }}
      />
      {tip && <path className="graph-edge-arrow" d={tip} style={{ fill: color, opacity }} />}
      {route.label && route.labelLeader && <line className="graph-edge-label-leader"
        x1={route.label.x} y1={route.label.y} x2={route.labelLeader.x} y2={route.labelLeader.y}
        style={{ stroke: color, opacity }} />}
      {route.label && <EdgeLabelRenderer>
        <button type="button" tabIndex={-1} title={title}
          className={`edge-label nodrag nopan ${active ? 'is-active' : ''} ${muted ? 'is-muted' : ''} ${cycle ? 'is-cycle' : ''}`}
          style={{ left: route.label.x, top: route.label.y, width: data.labelWidth }}
          onClick={(event) => { event.stopPropagation(); data.onSelect(id); }}>
          <span>{title}</span>
          {points !== undefined && <small className="graph-points-edge"
            title={t('Сумма SP по дальнейшей цепочке блокировок', 'Story points downstream of this blocker')}>{points} SP</small>}
        </button>
      </EdgeLabelRenderer>}
    </>
  );
}

const nodeTypes = { issue: IssueCard, zone: GroupZone, note: NoteSticker };
const edgeTypes = { jiraLink: JiraLink };

interface Props {
  flowId: string;
  graph: JiraGraph;
  layoutGraph?: JiraGraph;
  basis: JiraGraph;
  cycleIds: ReadonlySet<string>;
  direction: Direction;
  groupMode: GroupMode;
  fields: CardFields;
  showLinks: boolean;
  showEdgePoints: boolean;
  selectedKey?: string;
  selectedEdge?: string;
  connected: boolean;
  editable: boolean;
  notesByIssue: Readonly<Record<string, readonly JiraGraphNote[]>>;
  manualPositions: Readonly<Record<string, GraphPosition>>;
  viewport?: Viewport;
  highlightedKeys?: ReadonlySet<string>;
  analysisKeys?: ReadonlySet<string>;
  analysisNavigation?: readonly string[];
  avatars?: Readonly<Record<string, string>>;
  preferredSprintIds?: readonly string[];
  onSelectIssue(key?: string): void;
  onSelectEdge(id: string): void;
  onOpenIssue(issue: JiraIssue): void;
  onOpenEpic?(key: string, summary?: string): void;
  onNoteIssue(key: string, focusInput: boolean): void;
  onCreateRelated?(issue: JiraIssue): void;
  onManualPositionsChange(positions: Record<string, GraphPosition>): void;
  onViewportChange(viewport: Viewport): void;
  onAnalysisNavigationEnd(keys: readonly string[]): void;
  onConnect: OnConnect;
}

export function GraphCanvas({ flowId, graph, layoutGraph = graph, basis, cycleIds, direction, groupMode, fields, showLinks, showEdgePoints, selectedKey, selectedEdge, connected, editable,
  notesByIssue, manualPositions, viewport, highlightedKeys, analysisKeys, analysisNavigation, preferredSprintIds, avatars,
  onSelectIssue, onSelectEdge, onOpenIssue, onOpenEpic, onNoteIssue, onCreateRelated, onManualPositionsChange,
  onViewportChange, onAnalysisNavigationEnd, onConnect }: Props) {
  const { theme, graphFont, t } = usePreferences();
  const flow = useReactFlow<CanvasNode, Link>();
  const [dragPositions, setDragPositions] = useState<Record<string, GraphPosition>>({});
  const [fontRevision, setFontRevision] = useState(0);
  const dragFrame = useRef<number | undefined>(undefined);
  const pendingDrag = useRef<Record<string, GraphPosition>>({});
  const userMovedViewport = useRef(false);
  useEffect(() => {
    const update = () => setFontRevision((revision) => revision + 1);
    document.fonts.addEventListener('loadingdone', update);
    return () => document.fonts.removeEventListener('loadingdone', update);
  }, []);
  useEffect(() => () => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
  }, []);
  const showEpicBadges = groupMode !== 'hierarchy' && Boolean(onOpenEpic);
  const cardHeight = CARD_HEIGHT + (fields.assignee ? 22 : 0) + (fields.priority || fields.labels || fields.dueDate || fields.estimate ? 19 : 0)
    + (showEpicBadges && layoutGraph.issues.some(({ key, epicKey }) => epicKey && epicKey !== key) ? 24 : 0);
  const across = direction === 'LR';
  // The cards have fixed dimensions. Keep edge anchors available even before the DOM observer runs.
  const handles: NodeHandle[] = [
    { id: null, type: 'target', position: across ? Position.Left : Position.Top,
      x: across ? 0 : CARD_WIDTH / 2, y: across ? cardHeight / 2 : 0, width: 0, height: 0 },
    { id: null, type: 'source', position: across ? Position.Right : Position.Bottom,
      x: across ? CARD_WIDTH : CARD_WIDTH / 2, y: across ? cardHeight / 2 : cardHeight, width: 0, height: 0 },
  ];
  const noteSignature = Object.keys(notesByIssue).filter((key) => notesByIssue[key].length > 0).sort().join(',');
  const noteKeys = useMemo(() => new Set(noteSignature ? noteSignature.split(',') : []), [noteSignature]);
  const layout = useMemo(() => layoutWorkspace(layoutGraph, direction, groupMode, {
    component: t('Связанный фрагмент', 'Connected component'),
    emptyGroup: t('Без значения', 'Unassigned'),
    unscheduledSprint: t('Без спринта', 'No sprint'),
    externalSprint: t('Внешние задачи без спринта', 'External issues without a sprint'),
    level: t('Уровень', 'Level'),
    cycle: t('Заблокировано циклом', 'Blocked by a cycle'),
    done: t('Выполнено', 'Done'),
  }, cardHeight, basis, { preferredSprintIds, noteKeys }), [basis, cardHeight, direction, layoutGraph, groupMode, noteKeys, preferredSprintIds, t]);
  const displayedEdges = useMemo(() => {
    if (layoutGraph === graph) return layout.visibleEdges;
    const edgeIds = new Set(graph.edges.map(({ id }) => id));
    return layout.visibleEdges.filter(({ id }) => edgeIds.has(id));
  }, [graph, layout.visibleEdges, layoutGraph]);
  const estimates = useMemo(() => showLinks && showEdgePoints ? downstreamPoints(graph) : undefined, [graph, showLinks, showEdgePoints]);
  const highlightedEdges = useMemo(() => analysisKeys && new Set(blockingEdges(graph)
    .filter(({ source, target }) => analysisKeys.has(source) && analysisKeys.has(target)).map(({ id }) => id)), [analysisKeys, graph]);
  const basisIssues = useMemo(() => new Map(basis.issues.map((issue) => [issue.key, issue])), [basis.issues]);
  const colorsByEpic = useMemo(() => epicColors(basis.issues), [basis.issues]);
  const lanes = useMemo(() => {
    const groups = new Map<string, string[]>();
    const offsets = new Map<string, number>();
    for (const edge of layout.visibleEdges) {
      const key = [edge.source, edge.target].sort().join('|');
      const ids = groups.get(key) ?? [];
      ids.push(edge.id);
      groups.set(key, ids);
    }
    for (const ids of groups.values()) {
      ids.forEach((id, index) => offsets.set(id, index - (ids.length - 1) / 2));
    }
    return offsets;
  }, [layout.visibleEdges]);
  const trace = useMemo(() => selectedKey ? {
    upstream: tracePath(graph.edges, selectedKey, 'up'),
    downstream: tracePath(graph.edges, selectedKey, 'down'),
  } : undefined, [graph.edges, selectedKey]);
  const moved = useMemo(() => ({ ...manualPositions, ...dragPositions }), [dragPositions, manualPositions]);
  const cardPositions = useMemo(() => new Map([...layout.positions].map(([key, position]) => [key, moved[key] ?? position])),
    [layout.positions, moved]);
  const arrangedZones = useMemo(() => fitMovedZones(layout.zones, moved, cardHeight, direction, noteKeys),
    [layout.zones, moved, cardHeight, direction, noteKeys]);
  const notePlacements = useMemo(() => [
    ...[...cardPositions].flatMap(([key, position]) => noteKeys.has(key)
      ? [{ key, position: notePosition({ ...position, width: CARD_WIDTH, height: cardHeight }, direction), direction }] : []),
    ...arrangedZones.flatMap((zone) => zone.epicKey && noteKeys.has(zone.epicKey)
      ? [{ key: zone.epicKey, position: notePosition(zone, 'TB'), direction: 'TB' as const }] : []),
  ], [cardHeight, cardPositions, direction, arrangedZones, noteKeys]);
  const edgeLabels = useMemo(() => {
    const measure = showLinks && displayedEdges.length ? document.createElement('canvas').getContext('2d') : null;
    return new Map(displayedEdges.map((edge) => {
      const label = edge.kind === 'parent' ? t('Родительская задача', 'Parent issue') : edge.label;
      const caption = cycleIds.has(edge.id) ? `↻ ${label}` : label;
      const points = estimates?.get(edge.id);
      const estimate = points === undefined ? '' : `${points} SP`;
      let textWidth = Math.max(caption.length, estimate.length) * 11;
      if (measure) {
        measure.font = `600 11px ${graphFont}`;
        textWidth = measure.measureText(caption).width;
        measure.font = `650 10px ${graphFont}`;
        textWidth = Math.max(textWidth, measure.measureText(estimate).width);
      }
      return [edge.id, {
        label, width: Math.min(maximumLabelWidth, Math.ceil(textWidth + 18)),
        height: points === undefined ? labelHeight : pointsLabelHeight,
      }];
    }));
  }, [cycleIds, displayedEdges, estimates, fontRevision, graphFont, showLinks, t]);
  const routes = useMemo(() => {
    if (!showLinks || !displayedEdges.length) return undefined;
    const obstacles: RouteObstacle[] = [
      ...[...cardPositions].map(([id, position]) => ({ id, ...position, width: CARD_WIDTH, height: cardHeight })),
      ...notePlacements.map(({ key, position }) => ({ id: `note:${key}`, ...position, width: NOTE_WIDTH, height: NOTE_HEIGHT })),
      ...arrangedZones.map(({ id, x, y, width }) => ({ id: `heading:${id}`, x, y, width, height: 36, labelOnly: true })),
    ];
    return routeEdges(direction, obstacles, displayedEdges.flatMap(({ id, source, target }) => {
      const from = cardPositions.get(source);
      const to = cardPositions.get(target);
      if (!from || !to) return [];
      const label = edgeLabels.get(id);
      return [{
        id, source, target, lane: lanes.get(id),
        sourcePoint: { x: from.x + (across ? CARD_WIDTH : CARD_WIDTH / 2), y: from.y + (across ? cardHeight / 2 : cardHeight) },
        targetPoint: { x: to.x + (across ? 0 : CARD_WIDTH / 2), y: to.y + (across ? cardHeight / 2 : 0) },
        labelWidth: label?.width ?? maximumLabelWidth, labelHeight: label?.height ?? labelHeight,
      }];
    }));
  }, [across, cardHeight, cardPositions, direction, displayedEdges, edgeLabels, lanes, arrangedZones, notePlacements, showLinks]);
  const cards: Card[] = graph.issues.flatMap((issue) => {
    const position = cardPositions.get(issue.key);
    if (!position) return [];
    const epic = showEpicBadges && issue.epicKey && issue.epicKey !== issue.key
      ? { key: issue.epicKey, summary: issue.epicSummary ?? basisIssues.get(issue.epicKey)?.summary,
        color: colorsByEpic.get(issue.epicKey) } : undefined;
    return [{
      id: issue.key, type: 'issue',
      position,
      width: CARD_WIDTH, height: cardHeight, zIndex: 3,
      measured: { width: CARD_WIDTH, height: cardHeight }, handles,
      selected: issue.key === selectedKey,
      ariaLabel: `${issue.key} ${issue.summary}`,
      data: {
        issue, direction, fields, noteCount: notesByIssue[issue.key]?.length, highlighted: highlightedKeys?.has(issue.key),
        avatar: avatars?.[issue.key], epic, onOpenEpic,
        analysisMatch: analysisKeys?.has(issue.key),
        onOpen: connected ? onOpenIssue : undefined, onNote: connected ? onNoteIssue : undefined, onCreateRelated,
        muted: !highlightedKeys?.has(issue.key) && Boolean(trace && !trace.upstream.has(issue.key) && !trace.downstream.has(issue.key)),
      },
    }];
  });
  const zones: Zone[] = arrangedZones.map((zone) => ({
    id: zone.id, type: 'zone', position: { x: zone.x, y: zone.y },
    data: {
      zone, epic: zone.epicKey ? basisIssues.get(zone.epicKey) : undefined,
      epicColor: zone.epicKey ? colorsByEpic.get(zone.epicKey) : undefined,
      selected: Boolean(zone.epicKey && zone.epicKey === selectedKey), onSelect: onSelectIssue,
      onOpenEpic,
      analysisMatch: zone.epicKey ? analysisKeys?.has(zone.epicKey) : undefined,
      onOpen: connected ? onOpenIssue : undefined, onCreateRelated,
    },
    width: zone.width, height: zone.height, zIndex: zone.kind === 'nested' ? -1 : -2,
    measured: { width: zone.width, height: zone.height },
    selectable: false, focusable: false, draggable: false, connectable: false, style: { pointerEvents: 'none' },
  }));
  const stickers: Sticky[] = notePlacements.map(({ key, position, direction }) => {
    const notes = notesByIssue[key];
    const note = notes.reduce((latest, entry) => (Date.parse(entry.createdAt) || 0) >= (Date.parse(latest.createdAt) || 0) ? entry : latest);
    return {
      id: `note:${key}`, type: 'note', position, zIndex: 4,
      width: NOTE_WIDTH, height: NOTE_HEIGHT, measured: { width: NOTE_WIDTH, height: NOTE_HEIGHT },
      data: { issueKey: key, note, count: notes.length, direction, onOpen: onNoteIssue },
      selectable: false, focusable: false, draggable: false, connectable: false,
    };
  });
  const visibleKeys = new Set(cards.map(({ id }) => id));
  const edges: Link[] = showLinks ? displayedEdges.map((edge) => {
    const active = Boolean(trace && (
      (trace.upstream.has(edge.source) && trace.upstream.has(edge.target)) ||
      (trace.downstream.has(edge.source) && trace.downstream.has(edge.target))
    ));
    const cycle = cycleIds.has(edge.id);
    const analysisMatch = highlightedEdges?.has(edge.id);
    const label = edgeLabels.get(edge.id);
    return {
      id: edge.id, source: edge.source, target: edge.target, label: label?.label ?? edge.label,
      zIndex: active || cycle || analysisMatch || edge.id === selectedEdge ? 2 : 1,
      type: 'jiraLink', selected: edge.id === selectedEdge,
      data: { route: routes?.get(edge.id), labelWidth: label?.width ?? maximumLabelWidth, hierarchy: edge.kind === 'parent', active,
        muted: Boolean(trace && !active && !analysisMatch), cycle, analysisMatch, points: estimates?.get(edge.id), onSelect: onSelectEdge },
    };
  }) : [];

  useEffect(() => {
    if (viewport || analysisNavigation) return;
    const id = requestAnimationFrame(() => void flow.fitView({ padding: 0.14, maxZoom: 1.05, duration: 240 }));
    return () => cancelAnimationFrame(id);
  }, [flow, layout, viewport, analysisNavigation]);

  useEffect(() => {
    if (!analysisNavigation?.length) return;
    let current = true;
    const frame = requestAnimationFrame(() => {
      const keys = new Set(analysisNavigation);
      const nodes = flow.getNodes().filter((node) => (node.type === 'issue' && keys.has(node.id)) ||
        (node.type === 'zone' && node.data.zone.epicKey && keys.has(node.data.zone.epicKey)));
      if (!nodes.length) {
        onAnalysisNavigationEnd(analysisNavigation);
        return;
      }
      void flow.fitView({ nodes, padding: 0.22, maxZoom: 1.05, duration: 220 }).then((fitted) => {
        if (!current) return;
        if (fitted) onViewportChange(flow.getViewport());
        onAnalysisNavigationEnd(analysisNavigation);
      });
    });
    return () => { current = false; cancelAnimationFrame(frame); };
  }, [analysisNavigation, flow, onAnalysisNavigationEnd, onViewportChange]);

  const onNodesChange: OnNodesChange<CanvasNode> = (changes) => {
    const selection = changes.find((change) => change.type === 'select' && change.selected);
    if (selection?.type === 'select' && visibleKeys.has(selection.id)) onSelectIssue(selection.id);
    const moved = changes.filter((change) => change.type === 'position').filter(({ id, position }) => position && visibleKeys.has(id));
    if (moved.length) {
      const next = Object.fromEntries(moved.flatMap(({ id, position }) => position ? [[id, position]] : []));
      if (moved.some(({ dragging }) => dragging)) {
        Object.assign(pendingDrag.current, next);
        if (dragFrame.current === undefined) {
          dragFrame.current = requestAnimationFrame(() => {
            dragFrame.current = undefined;
            const positions = pendingDrag.current;
            pendingDrag.current = {};
            setDragPositions((previous) => ({ ...previous, ...positions }));
          });
        }
      } else {
        if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
        dragFrame.current = undefined;
        pendingDrag.current = {};
        setDragPositions({});
        onManualPositionsChange({ ...manualPositions, ...next });
      }
    }
  };

  function markMinimapMove(target: EventTarget) {
    if (target instanceof Element && target.closest('.react-flow__minimap')) userMovedViewport.current = true;
  }

  function markControlMove() {
    userMovedViewport.current = true;
  }

  return (
    <div className="canvas" data-show-links={showLinks} data-can-connect={editable && showLinks}
      onPointerDownCapture={(event) => markMinimapMove(event.target)} onWheelCapture={(event) => markMinimapMove(event.target)}>
      {cards.length === 0 && zones.length === 0 ? <div className="empty-canvas">
        <GitBranch size={26} /><h2>{t('Задачи не найдены', 'No issues found')}</h2>
        <p>{t('Измени JQL или сбрось фильтры.', 'Change the JQL query or clear the filters.')}</p>
      </div> : <ReactFlow<CanvasNode, Link>
        id={flowId} colorMode={theme} nodes={[...zones, ...cards, ...stickers]} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onEdgesChange={(changes) => {
          const selection = changes.find((change) => change.type === 'select' && change.selected);
          if (selection?.type === 'select') onSelectEdge(selection.id);
        }}
        nodesDraggable nodesConnectable={editable && showLinks} onConnect={onConnect}
        onNodeClick={(_, node) => { if (node.type === 'issue') onSelectIssue(node.id); }}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onMoveEnd={(event, next) => {
          if (event) userMovedViewport.current = true;
          if (userMovedViewport.current) onViewportChange(next);
        }}
        onPaneClick={() => onSelectIssue()} deleteKeyCode={null} minZoom={0.07} maxZoom={2}
        defaultViewport={viewport} fitView={!viewport} fitViewOptions={{ padding: 0.14, maxZoom: 1.05 }}
        ariaLabelConfig={{
          'controls.ariaLabel': t('Управление масштабом', 'Zoom controls'),
          'controls.zoomIn.ariaLabel': t('Увеличить', 'Zoom in'),
          'controls.zoomOut.ariaLabel': t('Уменьшить', 'Zoom out'),
          'controls.fitView.ariaLabel': t('Показать весь граф', 'Fit graph to view'),
          'minimap.ariaLabel': t('Мини-карта', 'Minimap'),
        }}
      >
        <Background gap={23} size={1.25} color="var(--canvas-dot)" />
        <Controls position="bottom-left" showInteractive={false}
          onZoomIn={markControlMove} onZoomOut={markControlMove} onFitView={markControlMove} />
        <MiniMap<CanvasNode>
          position="bottom-right"
          nodeColor={(node) => node.type === 'issue' ? `var(--minimap-${statusTone(node.data.issue) === 'done' ? 'done' : 'node'})` : 'transparent'}
          maskColor="var(--minimap-mask)" pannable zoomable
        />
      </ReactFlow>}
      <div className="canvas-legend" data-export-ignore>{showLinks ? <><ArrowRight size={14} /> {t('Связь Jira', 'Jira link')}</>
        : <span>{t('Связи скрыты', 'Links hidden')}</span>} <Layers3 size={13} /> {t('Иерархия', 'Hierarchy')}
        {layout.parts > 1 && <span>· {t('Частей', 'Components')}: {layout.parts}</span>}
        {edges.some(({ data }) => data?.cycle) && <span className="legend-cycle">↻ {t('Связь в цикле', 'Link in a cycle')}</span>}
      </div>
    </div>
  );
}
