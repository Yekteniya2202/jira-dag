import { useEffect, useMemo, type CSSProperties } from 'react';
import {
  Background, BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import { ArrowRight, CircleAlert, ClipboardList, GitBranch, Minus, Plus, Users } from 'lucide-react';
import { routeEdges, type RoutedEdge } from './edge-routing';
import { epicColors, epicColorStyle } from './epic-color';
import { statusTone } from './graph-model';
import { usePreferences, type Translate } from './i18n';
import {
  sprintCardHeight, sprintCardWidth, type SprintColumn, type SprintGraphCard, type SprintGraphLayout, type SprintNodeKind,
} from './sprint-plan-graph-model';
import './sprint-plan-graph.css';

type TaskNode = Node<{
  card: SprintGraphCard;
  focused: boolean;
  matches: boolean;
  format: (points: number) => string;
  epicColor?: string;
  onSelect(key: string): void;
  onMove?: () => void;
}, 'sprintTask'>;
type GuideNode = Node<{
  variant: 'lane' | 'column';
  label: string;
  roles?: readonly string[];
}, 'sprintGuide'>;
type GraphNode = TaskNode | GuideNode;
type SprintEdge = Edge<{ route?: RoutedEdge }, 'sprintEdge'>;

const linkKinds: Record<SprintNodeKind, [string, string]> = {
  selected: ['В спринте', 'In sprint'],
  recommended: ['Рекомендовано', 'Recommended'],
  backlog: ['Бэклог', 'Backlog'],
  blocker: ['Внешний блокер', 'External blocker'],
};

function TaskCard({ data }: NodeProps<TaskNode>) {
  const { t } = usePreferences();
  const { card, focused, matches, format, epicColor, onSelect, onMove } = data;
  const { issue, key, stage, kind, blocked, role, primary } = card;
  const caption = issue?.summary ?? t('Задача вне загруженной выборки', 'Issue outside the loaded scope');
  const epic = issue?.epicKey ?? (issue?.isEpic ? issue.key : undefined);
  const tone = issue && statusTone(issue);
  const moveLabel = kind === 'selected' ? t(`Убрать ${key} из спринта`, `Remove ${key} from sprint`)
    : t(`Добавить ${key} в спринт`, `Add ${key} to sprint`);
  const effort = stage?.points ?? (stage?.kind === 'qa' || role === 'QA' ? issue?.qaPoints : issue?.storyPoints);
  const unit = stage?.kind === 'qa' || role === 'QA' ? 'QA' : 'SP';
  return <div className="sprint-plan-node" data-kind={kind} data-tone={tone} data-focused={focused || undefined}
    data-matches={matches || undefined} data-blocked={blocked || undefined} data-issue-key={key} data-stage={stage?.kind}
    style={epicColorStyle(epicColor)}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <Handle type="source" position={Position.Right} isConnectable={false} />
    <button type="button" className="sprint-plan-node-body nodrag" onClick={() => onSelect(key)}
      aria-pressed={focused} aria-label={stage?.kind === 'qa' ? `${key} · QA · ${caption}` : `${key} · ${caption}`} title={caption}>
      <div className="sprint-plan-node-line">
        <strong>{key}</strong>
        <span className="sprint-plan-stage">{stage?.kind === 'qa' ? 'QA' : role}</span>
        {effort !== undefined && <small>{format(effort)} {unit}</small>}
        {blocked && <CircleAlert size={13} aria-label={t('Есть блокеры', 'Has blockers')} />}
      </div>
      <span className="sprint-plan-node-title">{caption}</span>
      <div className="sprint-plan-node-line sprint-plan-node-meta">
        <span className="sprint-plan-kind">{t(...linkKinds[kind])}</span>
        {epic && <span className="sprint-plan-epic epic-color-label" style={epicColorStyle(epicColor)} title={issue?.epicSummary}>{epic}</span>}
      </div>
    </button>
    {onMove && primary && <button type="button" className="icon-button sprint-plan-node-move nodrag" onClick={onMove}
      aria-label={moveLabel} title={moveLabel}>{kind === 'selected' ? <Minus size={16} /> : <Plus size={16} />}</button>}
  </div>;
}

function Guide({ data }: NodeProps<GuideNode>) {
  return <div className={`sprint-plan-guide is-${data.variant}`} aria-hidden="true">
    <strong>{data.label}</strong>
    {data.roles?.length ? <span>{data.roles.join(' · ')}</span> : null}
  </div>;
}

const nodeTypes = { sprintTask: TaskCard, sprintGuide: Guide };
const edgeTypes = { sprintEdge: SprintLink };

function SprintLink({ id, data, label, labelStyle, labelBgStyle, labelBgPadding, markerEnd, style }: EdgeProps<SprintEdge>) {
  const route = data?.route;
  if (!route) return null;
  return <BaseEdge id={id} path={route.path} label={label} labelX={route.label?.x} labelY={route.label?.y}
    labelStyle={labelStyle} labelBgStyle={labelBgStyle} labelBgPadding={labelBgPadding} markerEnd={markerEnd} style={style} />;
}

function linkId(source: string, target: string, kind: string) {
  return JSON.stringify([source, target, kind]);
}

function columnName(column: SprintColumn, t: Translate): string {
  if (typeof column === 'number') return t(`Волна ${column}`, `Wave ${column}`);
  if (column === 'outside') return t('Внешние блокеры', 'External blockers');
  if (column === 'backlog') return t('Бэклог', 'Backlog');
  return t('Без волны', 'Unscheduled');
}

function laneName(lane: SprintGraphLayout['lanes'][number], t: Translate): string {
  if (lane.name) return lane.name;
  if (lane.kind === 'outside') return t('Внешние задачи', 'External issues');
  return t('Без исполнителя', 'Unassigned');
}

export interface SprintPlanGraphProps {
  layout: SprintGraphLayout;
  focusedKey?: string;
  locate?: { key: string; at: number };
  matches?: ReadonlySet<string>;
  format(points: number): string;
  onSelect(key: string): void;
  onMove?(card: SprintGraphCard): void;
  canMove(card: SprintGraphCard): boolean;
}

export function SprintPlanGraph(props: SprintPlanGraphProps) {
  return <ReactFlowProvider><SprintPlanCanvas {...props} /></ReactFlowProvider>;
}

function SprintPlanCanvas({ layout, focusedKey, locate, matches, format, onSelect, onMove, canMove }: SprintPlanGraphProps) {
  const { t, theme } = usePreferences();
  const flow = useReactFlow<GraphNode, SprintEdge>();
  const colors = useMemo(() => epicColors(layout.cards.flatMap(({ issue }) => issue ? [issue] : [])), [layout]);
  const routes = useMemo(() => {
    const positions = new Map(layout.cards.map((card) => [card.id, card]));
    return routeEdges('LR', layout.cards.map(({ id, x, y }) => ({ id, x, y, width: sprintCardWidth, height: sprintCardHeight })),
      layout.links.flatMap(({ source, target, kind }) => {
        const from = positions.get(source);
        const to = positions.get(target);
        if (!from || !to) return [];
        return [{ id: linkId(source, target, kind), source, target,
          sourcePoint: { x: from.x + sprintCardWidth, y: from.y + sprintCardHeight / 2 },
          targetPoint: { x: to.x, y: to.y + sprintCardHeight / 2 },
          labelWidth: kind === 'qa' ? 96 : 0, labelHeight: kind === 'qa' ? 19 : 0 }];
      }));
  }, [layout]);
  const nodes = useMemo<GraphNode[]>(() => [
    ...layout.lanes.map((lane): GuideNode => ({
      id: `lane:${lane.id}`, type: 'sprintGuide', position: { x: 0, y: lane.y }, width: layout.width, height: lane.height,
      data: { variant: 'lane', label: laneName(lane, t), roles: lane.kind === 'person' ? lane.roles : undefined },
      selectable: false, draggable: false, focusable: false, zIndex: -1,
    })),
    ...layout.columns.map(({ id, x }): GuideNode => ({
      id: `column:${id}`, type: 'sprintGuide', position: { x, y: 6 }, width: sprintCardWidth, height: 32,
      data: { variant: 'column', label: columnName(id, t) },
      selectable: false, draggable: false, focusable: false, zIndex: -1,
    })),
    ...layout.cards.map((card): TaskNode => ({
      id: card.id, type: 'sprintTask', position: { x: card.x, y: card.y }, width: sprintCardWidth, height: sprintCardHeight,
      measured: { width: sprintCardWidth, height: sprintCardHeight },
      data: { card, focused: card.key === focusedKey, matches: Boolean(matches?.has(card.key)), format, onSelect,
        epicColor: card.issue?.epicColor ?? colors.get(card.issue?.epicKey ?? card.key),
        onMove: onMove && canMove(card) ? () => onMove(card) : undefined },
      selectable: false, draggable: false, focusable: false, zIndex: 1,
    })),
  ], [layout, focusedKey, matches, format, onSelect, onMove, canMove, t, colors]);
  const edges = useMemo<SprintEdge[]>(() => {
    const focusedIds = new Set(layout.cards.filter(({ key }) => key === focusedKey).map(({ id }) => id));
    return layout.links.map(({ source, target, kind, blocked }) => {
      const focused = focusedIds.has(source) || focusedIds.has(target);
      const color = kind === 'qa' ? 'var(--accent)' : blocked ? 'var(--red)' : focused ? 'var(--edge-active)' : 'var(--edge-default)';
      const id = linkId(source, target, kind);
      return {
        id, source, target, type: 'sprintEdge', zIndex: 0, data: { route: routes.get(id) },
        label: kind === 'qa' ? t('Работа → QA', 'Work → QA') : undefined,
        selectable: false, focusable: false, animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
        style: { stroke: color, strokeWidth: focused ? 2.6 : 1.7, strokeDasharray: blocked ? '5 4' : undefined },
        labelStyle: { fill: color, fontWeight: 650, fontSize: 11 },
        labelBgStyle: { fill: 'var(--surface)' },
        labelBgPadding: [5, 3],
      };
    });
  }, [layout, focusedKey, t, routes]);

  useEffect(() => {
    if (!locate) return;
    const id = requestAnimationFrame(() => {
      const target = flow.getNodes().find(({ type, data }) => type === 'sprintTask' && 'card' in data && data.card.key === locate.key);
      if (target) void flow.setCenter(target.position.x + sprintCardWidth / 2, target.position.y + sprintCardHeight / 2,
        { zoom: Math.max(flow.getZoom(), 0.72), duration: 220 });
    });
    return () => cancelAnimationFrame(id);
  }, [flow, locate]);

  if (!layout.cards.length) return <div className="sprint-plan-empty">
    <GitBranch size={24} />
    <p>{t('На графе пока нет задач. Открой бэклог или найди задачу по ключу.', 'There are no issues on the graph yet. Show the backlog or find an issue by key.')}</p>
  </div>;

  return <div className="sprint-plan-canvas" role="region" aria-label={t('Граф планирования спринта', 'Sprint planning graph')}>
    <ReactFlow<GraphNode, SprintEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode={theme}
      fitView fitViewOptions={{ padding: 0.13, maxZoom: 0.94 }} minZoom={0.08} maxZoom={1.6} nodesConnectable={false}
      nodesDraggable={false} elementsSelectable={false} deleteKeyCode={null} multiSelectionKeyCode={null}
      zoomOnDoubleClick={false} zoomOnScroll={false} preventScrolling={false} onlyRenderVisibleElements
      ariaLabelConfig={{
        'controls.ariaLabel': t('Масштаб графа спринта', 'Sprint graph zoom'),
        'controls.zoomIn.ariaLabel': t('Увеличить', 'Zoom in'),
        'controls.zoomOut.ariaLabel': t('Уменьшить', 'Zoom out'),
        'controls.fitView.ariaLabel': t('Показать весь граф спринта', 'Fit sprint graph to view'),
      }}>
      <Background gap={22} size={1.2} color="var(--canvas-dot)" />
      <Controls position="bottom-left" showInteractive={false} />
    </ReactFlow>
  </div>;
}

export function SprintPlanLegend({ style }: { style?: CSSProperties }) {
  const { t } = usePreferences();
  return <ul className="sprint-plan-legend" style={style} aria-label={t('Обозначения графа', 'Graph legend')}>
    {(['selected', 'recommended', 'backlog'] as const).map((kind) => <li key={kind} data-kind={kind}>
      <i aria-hidden="true" /> {t(...linkKinds[kind])}
    </li>)}
    <li data-kind="blocker"><CircleAlert size={13} /> {t('Блокеры', 'Blockers')}</li>
    <li><ArrowRight size={14} /> {t('Зависимость', 'Dependency')}</li>
    <li className="sprint-plan-legend-qa"><ArrowRight size={14} /> {t('Передача в QA', 'QA handoff')}</li>
    <li><Users size={14} /> {t('Строки по людям и ролям', 'Rows by person and role')}</li>
    <li><ClipboardList size={13} /> {t('Волны по порядку работ', 'Waves in work order')}</li>
  </ul>;
}
