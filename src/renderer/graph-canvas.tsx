import { useEffect, useMemo, useState } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap,
  Position, ReactFlow, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type OnConnect, type OnNodesChange,
} from '@xyflow/react';
import { ArrowRight, ArrowUpRight, CheckSquare2, CircleDot, GitBranch, Layers3, MessageSquarePlus } from 'lucide-react';
import type { JiraGraph, JiraIssue } from '../shared/contracts';
import { cyclicBlockingEdges, downstreamPoints, layoutWorkspace, type GraphZone, type GroupMode } from './graph-layout';
import { CARD_HEIGHT, CARD_WIDTH, statusTone, tracePath, type Direction, type GraphPosition } from './graph-model';
import { usePreferences } from './i18n';

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
  fields: CardFields;
  noteCount?: number;
  onOpen?: (issue: JiraIssue) => void;
  onNote?: (key: string) => void;
}, 'issue'>;
type Zone = Node<{ zone: GraphZone }, 'zone'>;
type CanvasNode = Card | Zone;
type Link = Edge<{ offset: number; hierarchy: boolean; active: boolean; muted: boolean; cycle: boolean; points?: number }, 'jiraLink'>;

function IssueCard({ data, selected }: NodeProps<Card>) {
  const { language, t } = usePreferences();
  const { issue, direction, muted, fields, onOpen, onNote, noteCount } = data;
  const across = direction === 'LR';
  const hours = issue.remainingEstimateSeconds ?? issue.originalEstimateSeconds;
  const details = [
    fields.assignee && issue.assignee,
    fields.priority && issue.priority,
    fields.labels && issue.labels?.slice(0, 3).map((label) => `#${label}`).join(' '),
    fields.dueDate && issue.dueDate,
    fields.estimate && hours !== undefined && `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(hours / 3600)} ${t('ч', 'h')}`,
  ].filter(Boolean).join(' · ');
  return (
    <div className={`issue-card tone-${statusTone(issue)} ${selected ? 'is-selected' : ''} ${muted ? 'is-muted' : ''} ${issue.external ? 'is-external' : ''}`}>
      <Handle type="target" position={across ? Position.Left : Position.Top} aria-label={t('Входящая зависимость', 'Incoming dependency')} />
      <div className="issue-card-key">
        <CheckSquare2 size={14} /><span>{issue.key}</span>
        {onNote && <button type="button" className="issue-card-note nodrag nopan" title={t('Заметки на графе', 'Graph notes')}
          aria-label={`${t('Заметки на графе', 'Graph notes')} ${issue.key}`}
          onClick={(event) => { event.stopPropagation(); onNote(issue.key); }}>
          <MessageSquarePlus size={13} />{noteCount ? <span>{noteCount}</span> : null}
        </button>}
        {onOpen && issue.url && <button type="button" className="issue-card-open nodrag nopan" title={t('Открыть в Jira', 'Open in Jira')}
          aria-label={`${t('Открыть в Jira', 'Open in Jira')} ${issue.key}`}
          onClick={(event) => { event.stopPropagation(); onOpen(issue); }}><ArrowUpRight size={15} /></button>}
      </div>
      <div className="issue-card-title" title={issue.summary}>{issue.summary}</div>
      <div className="issue-card-meta">
        <span className={`status ${statusTone(issue)}`} title={issue.status}><CircleDot size={11} /> {issue.status}</span>
        {fields.points && issue.storyPoints !== undefined && <span className="points" title="Story points">{issue.storyPoints} SP</span>}
      </div>
      {details && <div className="issue-card-details" title={details}>{details}</div>}
      <Handle type="source" position={across ? Position.Right : Position.Bottom} aria-label={t('Исходящая зависимость', 'Outgoing dependency')} />
    </div>
  );
}

function GroupZone({ data: { zone } }: NodeProps<Zone>) {
  const { t } = usePreferences();
  return <div className={`graph-zone ${zone.kind}`}>
    <div className="graph-zone-title" title={zone.title}><Layers3 size={15} /><span>{zone.title}</span></div>
    <div className="graph-zone-meta" title={t('Выполнено задач / всего', 'Completed issues / total')}>
      {zone.done}/{zone.issues}{zone.points !== undefined && <> · {zone.points} SP</>}
    </div>
  </div>;
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
  const path = self
    ? across
      ? `M ${sourceX},${sourceY} C ${sourceX + 95},${sourceY - 165} ${targetX - 95},${targetY - 165} ${targetX},${targetY}`
      : `M ${sourceX},${sourceY} C ${sourceX - 200},${sourceY + 70} ${targetX - 200},${targetY - 70} ${targetX},${targetY}`
    : `M ${sourceX},${sourceY} C ${sourceX + horizontal + dx},${sourceY + vertical + dy} ${targetX - horizontal + dx},${targetY - vertical + dy} ${targetX},${targetY}`;
  const labelX = (sourceX + targetX) / 2 + (self && !across ? -150 : dx * 0.75);
  const labelY = (sourceY + targetY) / 2 + (self && across ? -124 : dy * 0.75);
  const active = selected || data?.active;
  const muted = data?.muted && !selected;
  return (
    <>
      <BaseEdge
        id={id} path={path} markerEnd={markerEnd}
        style={{
          stroke: data?.cycle ? 'var(--edge-cycle)' : active ? 'var(--edge-active)' : data?.hierarchy ? 'var(--edge-hierarchy)' : 'var(--edge-default)',
          strokeWidth: active ? 2.3 : 1.6,
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

const nodeTypes = { issue: IssueCard, zone: GroupZone };
const edgeTypes = { jiraLink: JiraLink };

interface Props {
  graph: JiraGraph;
  basis: JiraGraph;
  direction: Direction;
  groupMode: GroupMode;
  fields: CardFields;
  showEdgePoints: boolean;
  selectedKey?: string;
  selectedEdge?: string;
  connected: boolean;
  editable: boolean;
  noteCounts: Readonly<Record<string, number>>;
  onSelectIssue(key?: string): void;
  onSelectEdge(id: string): void;
  onOpenIssue(issue: JiraIssue): void;
  onNoteIssue(key: string): void;
  onConnect: OnConnect;
}

export function GraphCanvas({ graph, basis, direction, groupMode, fields, showEdgePoints, selectedKey, selectedEdge, connected, editable,
  noteCounts, onSelectIssue, onSelectEdge, onOpenIssue, onNoteIssue, onConnect }: Props) {
  const { theme, t } = usePreferences();
  const flow = useReactFlow<CanvasNode, Link>();
  const [positions, setPositions] = useState<Record<string, GraphPosition>>({});
  const cardHeight = CARD_HEIGHT + (fields.assignee || fields.priority || fields.labels || fields.dueDate || fields.estimate ? 21 : 0);
  const layout = useMemo(() => layoutWorkspace(graph, direction, groupMode, {
    component: t('Связанный фрагмент', 'Connected component'),
    emptyGroup: t('Без значения', 'Unassigned'),
    level: t('Уровень', 'Level'),
    cycle: t('Заблокировано циклом', 'Blocked by a cycle'),
    done: t('Выполнено', 'Done'),
  }, cardHeight, basis), [basis, cardHeight, direction, graph, groupMode, t]);
  const cycles = useMemo(() => {
    const cycleIds = cyclicBlockingEdges(basis);
    return new Set(graph.edges.filter(({ id }) => cycleIds.has(id)).map(({ id }) => id));
  }, [basis, graph.edges]);
  const estimates = useMemo(() => showEdgePoints ? downstreamPoints(graph) : undefined, [graph, showEdgePoints]);
  const lanes = useMemo(() => {
    const groups = new Map<string, string[]>();
    const offsets = new Map<string, number>();
    for (const edge of graph.edges) {
      const key = [edge.source, edge.target].sort().join('|');
      const ids = groups.get(key) ?? [];
      ids.push(edge.id);
      groups.set(key, ids);
    }
    for (const ids of groups.values()) {
      ids.forEach((id, index) => offsets.set(id, (index - (ids.length - 1) / 2) * 28));
    }
    return offsets;
  }, [graph.edges]);
  const trace = useMemo(() => selectedKey ? {
    upstream: tracePath(graph.edges, selectedKey, 'up'),
    downstream: tracePath(graph.edges, selectedKey, 'down'),
  } : undefined, [graph.edges, selectedKey]);
  const cards: Card[] = graph.issues.map((issue) => ({
    id: issue.key, type: 'issue',
    position: (groupMode === 'none' ? positions[issue.key] : undefined) ?? layout.positions.get(issue.key) ?? { x: 0, y: 0 },
    width: CARD_WIDTH, height: cardHeight, zIndex: 2,
    selected: issue.key === selectedKey,
    ariaLabel: `${issue.key} ${issue.summary}`,
    data: {
      issue, direction, fields, noteCount: noteCounts[issue.key],
      onOpen: connected ? onOpenIssue : undefined, onNote: connected ? onNoteIssue : undefined,
      muted: Boolean(trace && !trace.upstream.has(issue.key) && !trace.downstream.has(issue.key)),
    },
  }));
  const zones: Zone[] = layout.zones.map((zone) => ({
    id: zone.id, type: 'zone', data: { zone }, position: { x: zone.x, y: zone.y },
    width: zone.width, height: zone.height, zIndex: zone.kind === 'nested' ? -1 : -2,
    selectable: false, focusable: false, draggable: false, connectable: false, style: { pointerEvents: 'none' },
  }));
  const visibleKeys = new Set(cards.map(({ id }) => id));
  const edges: Link[] = graph.edges.filter(({ source, target }) => visibleKeys.has(source) && visibleKeys.has(target)).map((edge) => {
    const active = Boolean(trace && (
      (trace.upstream.has(edge.source) && trace.upstream.has(edge.target)) ||
      (trace.downstream.has(edge.source) && trace.downstream.has(edge.target))
    ));
    const cycle = cycles.has(edge.id);
    const color = cycle ? '#dc5265' : active ? (theme === 'light' ? '#684bc5' : '#ab99ff') : (theme === 'light' ? '#697389' : '#9094b0');
    return {
      id: edge.id, source: edge.source, target: edge.target, label: edge.label, zIndex: 1,
      type: 'jiraLink', selected: edge.id === selectedEdge,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      data: { offset: lanes.get(edge.id) ?? 0, hierarchy: edge.kind === 'parent', active,
        muted: Boolean(trace && !active), cycle, points: estimates?.get(edge.id) },
    };
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => void flow.fitView({ padding: 0.14, maxZoom: 1.05, duration: 240 }));
    return () => cancelAnimationFrame(id);
  }, [flow, layout]);

  const onNodesChange: OnNodesChange<CanvasNode> = (changes) => {
    const selection = changes.find((change) => change.type === 'select' && change.selected);
    if (selection?.type === 'select' && visibleKeys.has(selection.id)) onSelectIssue(selection.id);
    const moved = changes.filter((change) => change.type === 'position');
    if (moved.length && groupMode === 'none') {
      setPositions((previous) => {
        const next = { ...previous };
        for (const change of moved) if (change.position) next[change.id] = change.position;
        return next;
      });
    }
  };

  return (
    <div className="canvas">
      {cards.length === 0 ? <div className="empty-canvas">
        <GitBranch size={26} /><h2>{t('Задачи не найдены', 'No issues found')}</h2>
        <p>{t('Измени JQL или сбрось фильтры.', 'Change the JQL query or clear the filters.')}</p>
      </div> : <ReactFlow<CanvasNode, Link>
        colorMode={theme} nodes={[...zones, ...cards]} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onEdgesChange={(changes) => {
          const selection = changes.find((change) => change.type === 'select' && change.selected);
          if (selection?.type === 'select') onSelectEdge(selection.id);
        }}
        nodesDraggable={groupMode === 'none'} nodesConnectable={editable} onConnect={onConnect}
        onNodeClick={(_, node) => { if (node.type === 'issue') onSelectIssue(node.id); }}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => onSelectIssue()} deleteKeyCode={null} minZoom={0.07} maxZoom={2}
        fitView fitViewOptions={{ padding: 0.14, maxZoom: 1.05 }}
        ariaLabelConfig={{
          'controls.ariaLabel': t('Управление масштабом', 'Zoom controls'),
          'controls.zoomIn.ariaLabel': t('Увеличить', 'Zoom in'),
          'controls.zoomOut.ariaLabel': t('Уменьшить', 'Zoom out'),
          'controls.fitView.ariaLabel': t('Показать весь граф', 'Fit graph to view'),
          'minimap.ariaLabel': t('Мини-карта', 'Minimap'),
        }}
      >
        <Background gap={23} size={1.25} color="var(--canvas-dot)" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap<CanvasNode>
          position="bottom-right"
          nodeColor={(node) => node.type === 'zone' ? 'transparent' : `var(--minimap-${statusTone(node.data.issue) === 'done' ? 'done' : 'node'})`}
          maskColor="var(--minimap-mask)" pannable zoomable
        />
      </ReactFlow>}
      <div className="canvas-legend"><ArrowRight size={14} /> {t('Связь Jira', 'Jira link')} <Layers3 size={13} /> {t('Иерархия', 'Hierarchy')}
        {layout.parts > 1 && <span>· {t('Частей', 'Components')}: {layout.parts}</span>}
        {cycles.size > 0 && <span className="legend-cycle">↻ {t('Циклические связи', 'Cyclic links')}: {cycles.size}</span>}
      </div>
    </div>
  );
}
