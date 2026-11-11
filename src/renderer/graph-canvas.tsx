import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap,
  Position, ReactFlow, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeHandle, type NodeProps, type OnConnect, type OnNodesChange, type Viewport,
} from '@xyflow/react';
import {
  ArrowRight, ArrowUpRight, CalendarDays, CalendarX2, CheckSquare2, CircleDot, ClipboardList, Flag,
  FolderKanban, GitBranch, Layers3, Link2, ListTree, MessageSquarePlus, Package, Plus, StickyNote, UserRound,
} from 'lucide-react';
import type { JiraGraph, JiraGraphNote, JiraIssue } from '../shared/contracts';
import { downstreamPoints, layoutWorkspace, NOTE_HEIGHT, NOTE_WIDTH, notePosition, type GraphZone, type GroupMode } from './graph-layout';
import { assigneeInitials, blockingEdges, CARD_HEIGHT, CARD_WIDTH, statusTone, tracePath, type Direction, type GraphPosition } from './graph-model';
import { usePreferences } from './i18n';
import './graph-canvas.css';

export interface CardFields {
  points: boolean;
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
  onOpen?: (issue: JiraIssue) => void;
  onNote?: (key: string, focusInput: boolean) => void;
  onCreateRelated?: (issue: JiraIssue) => void;
}, 'issue'>;
type Zone = Node<{
  zone: GraphZone;
  epic?: JiraIssue;
  onSelect?: (key: string) => void;
  onOpen?: (issue: JiraIssue) => void;
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
type Link = Edge<{ offset: number; hierarchy: boolean; active: boolean; muted: boolean; cycle: boolean; analysisMatch?: boolean; points?: number }, 'jiraLink'>;

function IssueCard({ data, selected }: NodeProps<Card>) {
  const { language, t } = usePreferences();
  const { issue, direction, muted, highlighted, analysisMatch, fields, onOpen, onNote, noteCount, onCreateRelated } = data;
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
      data-filter-match={highlighted} data-analysis-match={analysisMatch}>
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
      <div className="issue-card-meta">
        <span className={`status ${statusTone(issue)}`} title={issue.status}><CircleDot size={11} /> {issue.status}</span>
        {fields.points && issue.storyPoints !== undefined && <span className="points" title="Story points">{issue.storyPoints} SP</span>}
      </div>
      {assignee && <div className="issue-card-assignee" title={`${t('Исполнитель', 'Assignee')}: ${assignee}`}>
        <span className="issue-card-avatar" aria-hidden="true">{assigneeInitials(assignee)}</span><span>{assignee}</span>
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

function GroupZone({ data: { zone, epic, onSelect, onOpen, onCreateRelated, selected, analysisMatch } }: NodeProps<Zone>) {
  const { t } = usePreferences();
  const GroupIcon = zone.appearance ? groupIcons[zone.appearance.variant] : zone.kind === 'nested' ? ClipboardList : Layers3;
  const title = <><GroupIcon size={15} aria-hidden="true" /><span>{zone.title}</span></>;
  return <div className={`graph-zone ${zone.kind}${selected ? ' is-selected' : ''}`} data-export-zone={zone.id}
    data-group-variant={zone.appearance?.variant} data-group-color={zone.appearance?.color} data-analysis-match={analysisMatch}>
    <div className="graph-zone-heading">
      {epic && onSelect
        ? <button type="button" className="graph-zone-title graph-zone-action nodrag nopan" title={zone.title}
          aria-label={`${t('Открыть сведения об эпике', 'View epic details')} ${zone.title}`}
          onClick={(event) => { event.stopPropagation(); onSelect(epic.key); }}>{title}</button>
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

function JiraLink({ id, source, target, data, sourceX, sourceY, targetX, targetY, sourcePosition, markerEnd, label, selected }: EdgeProps<Link>) {
  const { t } = usePreferences();
  const across = sourcePosition === Position.Right;
  const offset = data?.offset ?? 0;
  const horizontal = across ? Math.max(42, Math.abs(targetX - sourceX) * 0.48) : 0;
  const vertical = across ? 0 : Math.max(42, Math.abs(targetY - sourceY) * 0.48);
  const dx = across ? 0 : offset;
  const dy = across ? offset : 0;
  const self = source === target;
  const returnsLeft = across && !self && sourceX > targetX;
  const returnY = Math.min(sourceY, targetY) - 128 + offset * 0.55;
  const path = self
    ? across
      ? `M ${sourceX},${sourceY} C ${sourceX + 95},${sourceY - 165} ${targetX - 95},${targetY - 165} ${targetX},${targetY}`
      : `M ${sourceX},${sourceY} C ${sourceX - 200},${sourceY + 70} ${targetX - 200},${targetY - 70} ${targetX},${targetY}`
    : returnsLeft
      ? `M ${sourceX},${sourceY} C ${sourceX + 28},${sourceY} ${sourceX + 28},${returnY} ${sourceX},${returnY} L ${targetX},${returnY} C ${targetX - 28},${returnY} ${targetX - 28},${targetY} ${targetX},${targetY}`
      : `M ${sourceX},${sourceY} C ${sourceX + horizontal + dx},${sourceY + vertical + dy} ${targetX - horizontal + dx},${targetY - vertical + dy} ${targetX},${targetY}`;
  const labelX = (sourceX + targetX) / 2 + (self && !across ? -150 : dx * 0.75);
  const labelY = returnsLeft ? returnY : (sourceY + targetY) / 2 + (self && across ? -124 : dy * 0.75);
  const active = selected || data?.active;
  const muted = data?.muted && !selected;
  return (
    <>
      <BaseEdge
        id={id} path={path} markerEnd={markerEnd}
        style={{
          stroke: data?.cycle ? 'var(--edge-cycle)' : data?.analysisMatch ? 'var(--green)' : active ? 'var(--edge-active)' : data?.hierarchy ? 'var(--edge-hierarchy)' : 'var(--edge-default)',
          strokeWidth: active || data?.analysisMatch ? 2.3 : 1.6,
          strokeDasharray: data?.hierarchy || data?.cycle ? '6 5' : undefined,
          opacity: muted ? 0.28 : 1,
        }}
      />
      <EdgeLabelRenderer>
        <div className={`edge-label ${active ? 'is-active' : ''} ${muted ? 'is-muted' : ''} ${data?.cycle ? 'is-cycle' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>
          {data?.cycle && '↻ '}{data?.hierarchy ? t('Родительская задача', 'Parent issue') : label}
          {data?.points !== undefined && <small className="graph-points-edge" title={t('Сумма SP по дальнейшей цепочке блокировок', 'Story points downstream of this blocker')}>{data.points} SP</small>}
        </div>
      </EdgeLabelRenderer>
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
  preferredSprintIds?: readonly string[];
  onSelectIssue(key?: string): void;
  onSelectEdge(id: string): void;
  onOpenIssue(issue: JiraIssue): void;
  onNoteIssue(key: string, focusInput: boolean): void;
  onCreateRelated?(issue: JiraIssue): void;
  onManualPositionsChange(positions: Record<string, GraphPosition>): void;
  onViewportChange(viewport: Viewport): void;
  onAnalysisNavigationEnd(keys: readonly string[]): void;
  onConnect: OnConnect;
}

export function GraphCanvas({ flowId, graph, layoutGraph = graph, basis, cycleIds, direction, groupMode, fields, showLinks, showEdgePoints, selectedKey, selectedEdge, connected, editable,
  notesByIssue, manualPositions, viewport, highlightedKeys, analysisKeys, analysisNavigation, preferredSprintIds,
  onSelectIssue, onSelectEdge, onOpenIssue, onNoteIssue, onCreateRelated, onManualPositionsChange,
  onViewportChange, onAnalysisNavigationEnd, onConnect }: Props) {
  const { theme, t } = usePreferences();
  const flow = useReactFlow<CanvasNode, Link>();
  const [dragPositions, setDragPositions] = useState<Record<string, GraphPosition>>({});
  const userMovedViewport = useRef(false);
  const cardHeight = CARD_HEIGHT + (fields.assignee ? 22 : 0) + (fields.priority || fields.labels || fields.dueDate || fields.estimate ? 19 : 0);
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
      ids.forEach((id, index) => offsets.set(id, (index - (ids.length - 1) / 2) * 28));
    }
    return offsets;
  }, [layout.visibleEdges]);
  const trace = useMemo(() => selectedKey ? {
    upstream: tracePath(graph.edges, selectedKey, 'up'),
    downstream: tracePath(graph.edges, selectedKey, 'down'),
  } : undefined, [graph.edges, selectedKey]);
  const cards: Card[] = graph.issues.flatMap((issue) => {
    const position = layout.positions.get(issue.key);
    if (!position) return [];
    return [{
      id: issue.key, type: 'issue',
      position: (groupMode === 'none' ? dragPositions[issue.key] ?? manualPositions[issue.key] : undefined) ?? position,
      width: CARD_WIDTH, height: cardHeight, zIndex: 2,
      measured: { width: CARD_WIDTH, height: cardHeight }, handles,
      selected: issue.key === selectedKey,
      ariaLabel: `${issue.key} ${issue.summary}`,
      data: {
        issue, direction, fields, noteCount: notesByIssue[issue.key]?.length, highlighted: highlightedKeys?.has(issue.key),
        analysisMatch: analysisKeys?.has(issue.key),
        onOpen: connected ? onOpenIssue : undefined, onNote: connected ? onNoteIssue : undefined, onCreateRelated,
        muted: !highlightedKeys?.has(issue.key) && Boolean(trace && !trace.upstream.has(issue.key) && !trace.downstream.has(issue.key)),
      },
    }];
  });
  const zones: Zone[] = layout.zones.map((zone) => ({
    id: zone.id, type: 'zone', position: { x: zone.x, y: zone.y },
    data: {
      zone, epic: zone.epicKey ? basisIssues.get(zone.epicKey) : undefined,
      selected: Boolean(zone.epicKey && zone.epicKey === selectedKey), onSelect: onSelectIssue,
      analysisMatch: zone.epicKey ? analysisKeys?.has(zone.epicKey) : undefined,
      onOpen: connected ? onOpenIssue : undefined, onCreateRelated,
    },
    width: zone.width, height: zone.height, zIndex: zone.kind === 'nested' ? -1 : -2,
    measured: { width: zone.width, height: zone.height },
    selectable: false, focusable: false, draggable: false, connectable: false, style: { pointerEvents: 'none' },
  }));
  function sticker(issueKey: string, anchor: GraphPosition & { width: number; height: number }, placement: Direction): Sticky | undefined {
    const notes = notesByIssue[issueKey];
    if (!notes?.length) return;
    const note = notes.reduce((latest, entry) => (Date.parse(entry.createdAt) || 0) >= (Date.parse(latest.createdAt) || 0) ? entry : latest);
    return {
      id: `note:${issueKey}`, type: 'note', position: notePosition(anchor, placement), zIndex: 3,
      width: NOTE_WIDTH, height: NOTE_HEIGHT, measured: { width: NOTE_WIDTH, height: NOTE_HEIGHT },
      data: { issueKey, note, count: notes.length, direction: placement, onOpen: onNoteIssue },
      selectable: false, focusable: false, draggable: false, connectable: false,
    };
  }
  const stickers = [
    ...cards.map(({ id, position }) => sticker(id, { ...position, width: CARD_WIDTH, height: cardHeight }, direction)),
    ...layout.zones.map((zone) => zone.epicKey ? sticker(zone.epicKey, zone, 'TB') : undefined),
  ].filter((item) => item !== undefined);
  const visibleKeys = new Set(cards.map(({ id }) => id));
  const edges: Link[] = showLinks ? displayedEdges.map((edge) => {
    const active = Boolean(trace && (
      (trace.upstream.has(edge.source) && trace.upstream.has(edge.target)) ||
      (trace.downstream.has(edge.source) && trace.downstream.has(edge.target))
    ));
    const cycle = cycleIds.has(edge.id);
    const analysisMatch = highlightedEdges?.has(edge.id);
    const color = cycle ? '#dc5265' : analysisMatch ? (theme === 'light' ? '#176747' : '#71dfb8')
      : active ? (theme === 'light' ? '#684bc5' : '#ab99ff') : (theme === 'light' ? '#697389' : '#9094b0');
    return {
      id: edge.id, source: edge.source, target: edge.target, label: edge.label, zIndex: 1,
      type: 'jiraLink', selected: edge.id === selectedEdge,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      data: { offset: lanes.get(edge.id) ?? 0, hierarchy: edge.kind === 'parent', active,
        muted: Boolean(trace && !active && !analysisMatch), cycle, analysisMatch, points: estimates?.get(edge.id) },
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
    if (moved.length && groupMode === 'none') {
      const next = Object.fromEntries(moved.flatMap(({ id, position }) => position ? [[id, position]] : []));
      if (moved.some(({ dragging }) => dragging)) setDragPositions(next);
      else {
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
    <div className="canvas" data-show-links={showLinks}
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
        nodesDraggable={groupMode === 'none'} nodesConnectable={editable && showLinks} onConnect={onConnect}
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
