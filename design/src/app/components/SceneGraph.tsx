import { memo, useMemo } from 'react';
import { Split } from 'lucide-react';
import type { SceneLink } from '../lib/webgal-types';
import type { SceneHeader } from '../lib/webgal-ipc';

// Scene graph layout constants (SVG coordinate space). Nodes are card-style
// (fixed CARD_W × CARD_H) so they read like the pre-refactor worldline cards;
// the BFS-depth row layout and orthogonal edges are kept. The layout box grows
// to fit the widest row, and the wrapper keeps that aspect ratio so it scales to
// the container width — dense graphs shrink to fit instead of clipping.
//
// Edges render in an SVG (mapped 1:1 to the box via the matching aspect ratio);
// nodes are absolutely-positioned HTML cards laid over it using percentage
// coordinates from the same viewBox space. Nodes are deliberately NOT drawn in
// <foreignObject>: inside a scaled SVG, hover repaints misplace foreignObject
// content in Chromium, so the cards visibly jump on hover.
const CARD_W = 120;
const CARD_H = 48;
const NODE_GAP_X = 18;
const ROW_H = 76;
const TOP_PAD = 16;
const BOTTOM_PAD = 16;
const SIDE_PAD = 12;

interface NodePos {
  x: number;
  y: number;
  w: number;
}

interface SceneGraphEdge {
  from: string;
  to: string;
  isChoice: boolean;
  labels: string[];
}

interface SceneGraphLayout {
  positions: Map<string, NodePos>;
  edges: SceneGraphEdge[];
  width: number;
  height: number;
}

/**
 * Lay out scenes by BFS depth from the project's start scene.
 * The root is intentionally NOT the current scene — using the current scene
 * would shift the whole graph whenever the user switches scenes.
 */
function computeSceneGraphLayout(
  scenes: string[],
  linksByScene: Record<string, SceneLink[]>,
  graphWidth: number,
): SceneGraphLayout {
  const positions = new Map<string, NodePos>();
  const edges: SceneGraphEdge[] = [];

  if (scenes.length === 0) {
    return { positions, edges, width: graphWidth, height: TOP_PAD + BOTTOM_PAD };
  }

  // Fixed start so positions are stable regardless of which scene is open.
  const startScene = scenes.includes('start.txt') ? 'start.txt' : scenes[0];

  const depths = new Map<string, number>();
  const byDepth: string[][] = [];
  const queue: { name: string; depth: number }[] = [{ name: startScene, depth: 0 }];
  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    while (byDepth.length <= depth) byDepth.push([]);
    byDepth[depth].push(name);
    for (const link of linksByScene[name] ?? []) {
      if (scenes.includes(link.target) && !depths.has(link.target)) {
        queue.push({ name: link.target, depth: depth + 1 });
      }
    }
  }

  const orphans = scenes.filter((s) => !depths.has(s));
  if (orphans.length > 0) {
    byDepth.push(orphans);
    for (const s of orphans) depths.set(s, byDepth.length - 1);
  }

  // Width grows to fit the widest row of fixed-size cards.
  const maxCount = byDepth.reduce((m, row) => Math.max(m, row.length), 0);
  const widestRow = maxCount * CARD_W + Math.max(0, maxCount - 1) * NODE_GAP_X;
  const width = Math.max(graphWidth, widestRow + 2 * SIDE_PAD);

  byDepth.forEach((row, depth) => {
    const y = TOP_PAD + CARD_H / 2 + depth * ROW_H;
    const count = row.length;
    const totalW = count * CARD_W + (count - 1) * NODE_GAP_X;
    const startX = (width - totalW) / 2;
    row.forEach((name, i) => {
      const x = startX + i * (CARD_W + NODE_GAP_X) + CARD_W / 2;
      positions.set(name, { x, y, w: CARD_W });
    });
  });

  const edgeByKey = new Map<string, SceneGraphEdge>();
  for (const [from, ls] of Object.entries(linksByScene)) {
    if (!positions.has(from)) continue;
    for (const link of ls) {
      if (!positions.has(link.target)) continue;
      const key = `${from}→${link.target}`;
      const label = link.kind === 'choose' ? link.label?.trim() : '';
      const existing = edgeByKey.get(key);
      if (existing) {
        existing.isChoice = existing.isChoice || link.kind === 'choose';
        if (label && !existing.labels.includes(label)) existing.labels.push(label);
      } else {
        edgeByKey.set(key, {
          from,
          to: link.target,
          isChoice: link.kind === 'choose',
          labels: label ? [label] : [],
        });
      }
    }
  }
  edges.push(...edgeByKey.values());

  const height = byDepth.length > 0
    ? TOP_PAD + CARD_H + (byDepth.length - 1) * ROW_H + BOTTOM_PAD
    : TOP_PAD + BOTTOM_PAD;
  return { positions, edges, width, height };
}

/**
 * Build a right-angle (orthogonal) SVG path between two graph nodes.
 * - Direct vertical when source and target share a column
 * - "Elbow" via a mid-row horizontal bus when going down
 * - Routes around the side when going up / sideways (back-edges, cycles)
 */
function buildOrthogonalPath(from: NodePos, to: NodePos, contentWidth: number): string {
  const halfH = CARD_H / 2;
  const startY = from.y + halfH + 1;
  const endY = to.y - halfH - 2;

  if (endY > startY + 4) {
    if (Math.abs(from.x - to.x) < 0.5) {
      return `M ${from.x},${startY} V ${endY}`;
    }
    const midY = (startY + endY) / 2;
    return `M ${from.x},${startY} V ${midY} H ${to.x} V ${endY}`;
  }

  // Same row or back-edge: detour through the side margin
  const exitY = from.y + halfH + 6;
  const enterY = to.y - halfH - 6;
  const sideX = from.x <= to.x ? contentWidth - 4 : 4;
  return `M ${from.x},${startY} V ${exitY} H ${sideX} V ${enterY} H ${to.x} V ${endY}`;
}

function edgeMarkerPosition(from: NodePos, to: NodePos, contentWidth: number): { x: number; y: number } {
  const halfH = CARD_H / 2;
  const startY = from.y + halfH + 1;
  const endY = to.y - halfH - 2;

  if (endY > startY + 4) {
    return { x: to.x, y: Math.max(startY + 12, endY - 14) };
  }

  const exitY = from.y + halfH + 6;
  const enterY = to.y - halfH - 6;
  const sideX = from.x <= to.x ? contentWidth - 18 : 18;
  return { x: sideX, y: (exitY + enterY) / 2 };
}

interface SceneGraphProps {
  scenes: string[];
  currentSceneName?: string;
  /** Saved-on-disk outgoing links per scene. Stable across scene switches & edits;
   *  updated only when a scene is saved (see StoryEditor.handleSave). */
  sceneLinkMap?: Record<string, SceneLink[]>;
  sceneHeaders?: Record<string, SceneHeader>;
  onSwitchScene?: (name: string) => void;
  /** Right-click on a node (used by the full-screen view for rename / delete). */
  onNodeContextMenu?: (name: string, e: React.MouseEvent) => void;
  /** viewBox width — narrow (224) for the side panel, larger for full-screen.
   *  Acts as a minimum: the graph grows wider when a row needs more space. */
  graphWidth?: number;
  /** Fit the whole graph to the container width. Disable in narrow sidebars so
   *  dense projects keep readable card sizes and scroll horizontally instead. */
  fitToWidth?: boolean;
  /** Classes for the scroll container (height, borders, …). */
  className?: string;
}

/**
 * Static, non-draggable scene relationship graph (BFS-depth layout + orthogonal
 * edges). Nodes are rendered as cards (icon + status + chapter title + filename),
 * matching the pre-refactor worldline look. Layout depends only on saved data,
 * so switching scenes / editing nodes never rebuilds it.
 */
export const SceneGraph = memo(function SceneGraph({
  scenes,
  currentSceneName,
  sceneLinkMap,
  sceneHeaders,
  onSwitchScene,
  onNodeContextMenu,
  graphWidth = 224,
  fitToWidth = true,
  className,
}: SceneGraphProps) {
  const layout = useMemo(
    () => computeSceneGraphLayout(scenes, sceneLinkMap ?? {}, graphWidth),
    [scenes, sceneLinkMap, graphWidth],
  );

  // Incoming-edge counts per scene (for the "←N" badge), from saved links.
  const incomingCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const links of Object.values(sceneLinkMap ?? {})) {
      for (const link of links) {
        if (link.target) counts[link.target] = (counts[link.target] ?? 0) + 1;
      }
    }
    return counts;
  }, [sceneLinkMap]);

  if (layout.positions.size === 0) {
    return (
      <div className={`relative overflow-auto overflow-x-hidden ${className ?? ''}`}>
        <div className="py-6 text-center font-mono-family text-[10px] text-muted-foreground/60">
          (无场景)
        </div>
      </div>
    );
  }

  const { width, height } = layout;

  const wrapperStyle = fitToWidth
    ? { aspectRatio: `${width} / ${height}` }
    : { width, height };

  return (
    <div className={`relative overflow-auto ${fitToWidth ? 'overflow-x-hidden' : ''} ${className ?? ''}`}>
      <div
        className={`relative ${fitToWidth ? 'w-full' : 'shrink-0'}`}
        style={wrapperStyle}
      >
        {/* Edges — mapped 1:1 onto the box (matching aspect ratio → uniform scale). */}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <defs>
            <marker id="scene-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="var(--color-primary)" />
            </marker>
          </defs>
          {layout.edges.map((e, i) => {
            const from = layout.positions.get(e.from)!;
            const to = layout.positions.get(e.to)!;
            return (
              <path
                key={`${e.from}->${e.to}-${i}`}
                d={buildOrthogonalPath(from, to, width)}
                fill="none"
                stroke="var(--color-primary)"
                strokeWidth={1.4}
                strokeOpacity={0.85}
                strokeLinejoin="round"
                strokeLinecap="round"
                markerEnd="url(#scene-arrow)"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {layout.edges.filter((edge) => edge.isChoice).map((edge, i) => {
          const from = layout.positions.get(edge.from)!;
          const to = layout.positions.get(edge.to)!;
          const marker = edgeMarkerPosition(from, to, width);
          const labels = edge.labels.length > 0 ? edge.labels : ['选项分支'];
          const title = labels.join('\n');

          return (
            <div
              key={`${edge.from}->${edge.to}-label-${i}`}
              title={title}
              aria-label={title}
              style={{
                left: `${(marker.x / width) * 100}%`,
                top: `${(marker.y / height) * 100}%`,
              }}
              className="group pointer-events-auto absolute z-20 -translate-x-1/2 -translate-y-1/2"
            >
              <div className="flex h-5 min-w-5 items-center justify-center gap-1 rounded-full border border-primary/50 bg-surface-container-high px-1.5 text-primary shadow-sm">
                <Split className="h-3 w-3" />
                {labels.length > 1 && (
                  <span className="font-mono text-[9px] font-semibold leading-none">
                    {labels.length}
                  </span>
                )}
              </div>
              <div className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden -translate-x-1/2 rounded-md border border-outline-variant/40 bg-surface-container-high px-2 py-1 text-[10px] font-medium text-foreground shadow-lg group-hover:block">
                <div className="max-w-[180px] space-y-0.5">
                  {labels.map((label) => (
                    <div key={label} className="truncate whitespace-nowrap">
                      {label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

        {/* Nodes — HTML cards laid over the edges, positioned in viewBox %. */}
        {[...layout.positions.entries()].map(([name, pos]) => {
          const isCurrent = name === currentSceneName;
          const header = sceneHeaders?.[name];
          const outgoing = (sceneLinkMap?.[name] ?? []).filter((l) => l.target);
          const isChoice = !isCurrent && outgoing.length >= 2;
          const isOrphan = !isCurrent && outgoing.length === 0;
          const incoming = incomingCount[name] ?? 0;

          const status = isCurrent
            ? '当前'
            : isChoice
              ? `${outgoing.length}`
              : header?.chapter || '场景';
          const title = header?.chapter?.replace(/[;：:]\s.*$/, '').trim()
            || name.replace(/\.txt$/i, '');

          const borderClass = isCurrent
            ? 'border-primary ring-2 ring-primary/30'
            : isChoice
              ? 'border-primary/40 hover:border-primary'
              : isOrphan
                ? 'border-dashed border-outline-variant/40 opacity-70 hover:opacity-100'
                : 'border-outline-variant/40 hover:border-secondary';

          const titleParts = [name];
          if (header?.chapter) titleParts.push(`章节：${header.chapter}`);
          if (header?.outline) titleParts.push(`大纲：${header.outline}`);

          return (
            <div
              key={name}
              role="button"
              tabIndex={0}
              title={titleParts.join('\n')}
              onClick={() => onSwitchScene?.(name)}
              onContextMenu={onNodeContextMenu ? (ev) => { ev.preventDefault(); onNodeContextMenu(name, ev); } : undefined}
              style={{
                left: `${((pos.x - pos.w / 2) / width) * 100}%`,
                top: `${((pos.y - CARD_H / 2) / height) * 100}%`,
                width: `${(pos.w / width) * 100}%`,
                height: `${(CARD_H / height) * 100}%`,
              }}
              className={`absolute flex cursor-pointer flex-col justify-center overflow-hidden rounded-md border bg-surface-container-lowest px-2 py-1 text-left shadow-sm transition-colors ${borderClass}`}
            >
              <div className="flex items-center gap-1">
                {isChoice && <Split className="h-3 w-3 shrink-0 text-primary" />}
                <span className="truncate font-mono-family text-[9px] uppercase tracking-widest text-on-surface-variant">
                  {status}
                </span>
                {incoming > 0 && (
                  <span className="ml-auto shrink-0 rounded bg-secondary-container/30 px-1 font-mono text-[8px] text-secondary">
                    ←{incoming}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate font-display-family text-[13px] font-semibold leading-tight text-foreground">
                {title}
              </div>
              <div className="truncate text-[8px] leading-tight text-muted-foreground">
                {header?.outline?.trim() || name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
