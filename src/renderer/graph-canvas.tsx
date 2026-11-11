import { useEffect, useMemo, useState } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap,
  Position, ReactFlow, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type OnConnect, type OnNodesChange,
} from '@xyflow/react';
import { ArrowRight, CheckSquare2, CircleDot, GitBranch, Layers3 } from 'lucide-react';
import type { JiraGraph, JiraIssue } from '../shared/contracts';
import { CARD_HEIGHT, CARD_WIDTH, layoutGraph, statusTone, tracePath, type Direction, type GraphPosition } from './graph-model';

type Card = Node<{ issue: JiraIssue; direction: Direction; muted: boolean }, 'issue'>;
type Link = Edge<{ offset: number; hierarchy: boolean; active: boolean; muted: boolean }, 'jiraLink'>;

function IssueCard({ data, selected }: NodeProps<Card>) {
  const { issue, direction, muted } = data;
  const across = direction === 'LR';
  return (
    <div className={`issue-card ${selected ? 'is-selected' : ''} ${muted ? 'is-muted' : ''} ${issue.external ? 'is-external' : ''}`}>
      <Handle type="target" position={across ? Position.Left : Position.Top} aria-label="Входящая зависимость" />
      <div className="issue-card-key"><CheckSquare2 size={14} /> {issue.key}</div>
      <div className="issue-card-title" title={issue.summary}>{issue.summary}</div>
      <div className="issue-card-meta">
        <span className={`status ${statusTone(issue)}`} title={issue.status}><CircleDot size={11} /> {issue.status}</span>
        {issue.storyPoints !== undefined && <span className="points" title="Story points">{issue.storyPoints} SP</span>}
      </div>
      <Handle type="source" position={across ? Position.Right : Position.Bottom} aria-label="Исходящая зависимость" />
    </div>
  );
}

function JiraLink({ id, data, sourceX, sourceY, targetX, targetY, sourcePosition, markerEnd, label, selected }: EdgeProps<Link>) {
  const across = sourcePosition === Position.Right;
  const offset = data?.offset ?? 0;
  const horizontal = across ? Math.max(42, Math.abs(targetX - sourceX) * 0.48) : 0;
  const vertical = across ? 0 : Math.max(42, Math.abs(targetY - sourceY) * 0.48);
  const dx = across ? 0 : offset;
  const dy = across ? offset : 0;
  const path = `M ${sourceX},${sourceY} C ${sourceX + horizontal + dx},${sourceY + vertical + dy} ${targetX - horizontal + dx},${targetY - vertical + dy} ${targetX},${targetY}`;
  const labelX = (sourceX + targetX) / 2 + dx * 0.75;
  const labelY = (sourceY + targetY) / 2 + dy * 0.75;
  const active = selected || data?.active;
  const muted = data?.muted && !selected;
  return (
    <>
      <BaseEdge
        id={id} path={path} markerEnd={markerEnd}
        style={{
          stroke: active ? '#ab99ff' : data?.hierarchy ? '#758194' : '#626581',
          strokeWidth: active ? 2.3 : 1.6,
          strokeDasharray: data?.hierarchy ? '6 5' : undefined,
          opacity: muted ? 0.28 : 1,
        }}
      />
      <EdgeLabelRenderer>
        <div className={`edge-label ${active ? 'is-active' : ''} ${muted ? 'is-muted' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { issue: IssueCard };
const edgeTypes = { jiraLink: JiraLink };

interface Props {
  graph: JiraGraph;
  direction: Direction;
  selectedKey?: string;
  selectedEdge?: string;
  editable: boolean;
  onSelectIssue(key?: string): void;
  onSelectEdge(id: string): void;
  onConnect: OnConnect;
}

export function GraphCanvas({ graph, direction, selectedKey, selectedEdge, editable, onSelectIssue, onSelectEdge, onConnect }: Props) {
  const flow = useReactFlow<Card, Link>();
  const [positions, setPositions] = useState<Record<string, GraphPosition>>({});
  const layout = useMemo(() => layoutGraph(graph, direction), [graph, direction]);
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
  const nodes: Card[] = graph.issues.map((issue) => ({
    id: issue.key, type: 'issue',
    position: positions[issue.key] ?? layout.get(issue.key) ?? { x: 0, y: 0 },
    width: CARD_WIDTH, height: CARD_HEIGHT,
    selected: issue.key === selectedKey,
    ariaLabel: `${issue.key} ${issue.summary}`,
    data: {
      issue, direction,
      muted: Boolean(trace && !trace.upstream.has(issue.key) && !trace.downstream.has(issue.key)),
    },
  }));
  const visibleKeys = new Set(nodes.map(({ id }) => id));
  const edges: Link[] = graph.edges.filter(({ source, target }) => visibleKeys.has(source) && visibleKeys.has(target)).map((edge) => {
    const active = Boolean(trace && (
      (trace.upstream.has(edge.source) && trace.upstream.has(edge.target)) ||
      (trace.downstream.has(edge.source) && trace.downstream.has(edge.target))
    ));
    return {
      id: edge.id, source: edge.source, target: edge.target, label: edge.label,
      type: 'jiraLink', selected: edge.id === selectedEdge,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: active ? '#ab99ff' : '#7a7c99' },
      data: { offset: lanes.get(edge.id) ?? 0, hierarchy: edge.kind === 'parent', active, muted: Boolean(trace && !active) },
    };
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => void flow.fitView({ padding: 0.14, maxZoom: 1.05, duration: 240 }));
    return () => cancelAnimationFrame(id);
  }, [flow, layout]);

  const onNodesChange: OnNodesChange<Card> = (changes) => {
    const selection = changes.find((change) => change.type === 'select' && change.selected);
    if (selection?.type === 'select') onSelectIssue(selection.id);
    const moved = changes.filter((change) => change.type === 'position');
    if (moved.length) {
      setPositions((previous) => {
        const next = { ...previous };
        for (const change of moved) if (change.position) next[change.id] = change.position;
        return next;
      });
    }
  };

  return (
    <div className="canvas">
      {nodes.length === 0 ? <div className="empty-canvas">
        <GitBranch size={26} /><h2>Задачи не найдены</h2><p>Измени JQL или сбрось фильтры.</p>
      </div> : <ReactFlow<Card, Link>
        colorMode="dark" nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onEdgesChange={(changes) => {
          const selection = changes.find((change) => change.type === 'select' && change.selected);
          if (selection?.type === 'select') onSelectEdge(selection.id);
        }}
        nodesConnectable={editable} onConnect={onConnect}
        onNodeClick={(_, node) => onSelectIssue(node.id)} onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => onSelectIssue()} deleteKeyCode={null} minZoom={0.12} maxZoom={2}
        fitView fitViewOptions={{ padding: 0.14, maxZoom: 1.05 }} proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{ 'controls.ariaLabel': 'Управление масштабом', 'minimap.ariaLabel': 'Мини-карта' }}
      >
        <Background gap={23} size={1.25} color="#3b4057" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap<Card>
          position="bottom-right" nodeColor={(node) => node.data.issue.statusCategory === 'done' ? '#46c9a0' : '#8067ce'}
          maskColor="#151826bb" pannable zoomable
        />
      </ReactFlow>}
      <div className="canvas-legend"><ArrowRight size={14} /> Связь Jira <Layers3 size={13} /> Иерархия</div>
    </div>
  );
}
