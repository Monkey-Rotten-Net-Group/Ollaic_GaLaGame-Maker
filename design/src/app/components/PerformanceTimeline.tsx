import { useMemo } from 'react';
import { MessageCircle } from 'lucide-react';
import type { WebGalNode } from '../lib/webgal-types';
import { isMetadataComment } from '../lib/webgal-types';

interface PerformanceTimelineProps {
  nodes: WebGalNode[];
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
}

const MARKER_DEFS: Array<{
  types: ReadonlyArray<WebGalNode['type']>;
  tone: string;
  label: (node: WebGalNode) => string;
}> = [
  { types: ['changeBg'], tone: 'bg-secondary', label: (n) => n.asset || n.content || '背景' },
  { types: ['bgm'], tone: 'bg-tertiary', label: (n) => n.asset || n.content || 'BGM' },
  { types: ['changeFigure', 'setAnimation', 'playEffect'], tone: 'bg-primary', label: (n) => n.asset || n.content || n.type },
];

const EVENT_TYPES = new Set(MARKER_DEFS.flatMap((d) => d.types));

function toneForType(type: WebGalNode['type']) {
  for (const def of MARKER_DEFS) {
    if (def.types.includes(type)) return def.tone;
  }
  return 'bg-outline-variant';
}

function markerLabel(node: WebGalNode) {
  for (const def of MARKER_DEFS) {
    if (def.types.includes(node.type)) return def.label(node);
  }
  return node.type;
}

function estimateDuration(node: WebGalNode): number {
  if (isMetadataComment(node)) return 0.4;
  switch (node.type) {
    case 'changeBg':
    case 'bgm':
      return 3.0;
    case 'changeFigure':
    case 'setAnimation':
    case 'playEffect':
      return 2.0;
    default:
      return 0.6;
  }
}

export function PerformanceTimeline({
  nodes,
  selectedNodeId,
  onSelectNode,
}: PerformanceTimelineProps) {
  const { markers, totalDuration } = useMemo(() => {
    const result: Array<{ node: WebGalNode; index: number; position: number; tone: string; label: string }> = [];
    let cursor = 0;
    nodes.forEach((node, index) => {
      const dur = estimateDuration(node);
      if (EVENT_TYPES.has(node.type)) {
        result.push({
          node,
          index,
          position: cursor,
          tone: toneForType(node.type),
          label: markerLabel(node),
        });
      }
      cursor += dur;
    });
    return { markers: result, totalDuration: cursor || 1 };
  }, [nodes]);

  if (markers.length === 0) {
    return (
      <div className="flex h-7 shrink-0 items-center border-t border-outline-variant/30 bg-surface-container-low px-4 text-[10px] text-muted-foreground">
        <MessageCircle className="mr-1.5 h-3 w-3 opacity-40" />
        暂无演出事件 — 添加背景/BGM/立绘指令后将自动显示时间线标记
      </div>
    );
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-outline-variant/30 bg-surface-container-low px-3">
      <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="inline-flex gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-secondary/70" title="背景" />
          <span className="inline-block h-2 w-2 rounded-full bg-tertiary/70" title="BGM" />
          <span className="inline-block h-2 w-2 rounded-full bg-primary/70" title="立绘/演出" />
        </span>
        <span className="font-mono-family">{markers.length}</span>
      </div>

      <div className="relative h-full flex-1">
        {markers.map((m) => {
          const left = (m.position / totalDuration) * 100;
          const isSelected = selectedNodeId === m.node.id;
          return (
            <button
              key={m.node.id}
              type="button"
              onClick={() => onSelectNode?.(m.node.id)}
              title={`#${m.index + 1} ${m.label}`}
              className={`absolute top-0 h-full w-1 cursor-pointer rounded-full transition-opacity hover:opacity-100 ${
                m.tone
              } ${isSelected ? 'opacity-100 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-story)_35%,transparent)]' : 'opacity-60'}`}
              style={{ left: `${Math.min(left, 99)}%` }}
            />
          );
        })}

        {/* tick marks at 1/4 intervals */}
        {[25, 50, 75].map((pct) => (
          <div
            key={pct}
            className="pointer-events-none absolute top-0 h-full w-px bg-outline-variant/20"
            style={{ left: `${pct}%` }}
          />
        ))}
      </div>
    </div>
  );
}
