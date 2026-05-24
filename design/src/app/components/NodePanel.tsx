import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDrag, useDrop } from 'react-dnd';
import {
  MessageCircle, GitBranch, Image as ImageIcon, User, Music, Film, Tag,
  ArrowRight, Type, Monitor, Variable, Keyboard, Wand2, Move, Award,
  Play, Plus, GripVertical, Copy, Scissors, Trash2, Clipboard,
} from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from '../lib/webgal-types';
import { commandCategories, commandLabels, categoryLabels } from '../lib/webgal-types';
import { isTerminalNode } from '../lib/scene-editing';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';

const DND_LIST_ITEM = 'flow-node';

interface NodePanelProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  /** Insert a node at a specific position (0 = before first, nodes.length = append). */
  onInsertNode?: (type: WebGalCommandType, atIndex: number) => void;
  /** Reorder nodes by drag. */
  onReorderNodes?: (fromIndex: number, toIndex: number) => void;
  characterColors?: Record<string, string>;
  /** Called when the user clicks "执行到此句" on the node at `index` (0-based). */
  onJumpToIndex?: (index: number) => void;
  onDeleteNode?: (id: string) => void;
  onCopyNode?: (node: WebGalNode) => void;
  onCutNode?: (node: WebGalNode) => void;
  onPasteNode?: (atIndex: number) => void;
  clipboardNode?: WebGalNode | null;
}

const commandIcons: Partial<Record<WebGalCommandType, typeof MessageCircle>> = {
  dialogue: MessageCircle,
  narrator: Type,
  intro: Monitor,
  choose: GitBranch,
  changeBg: ImageIcon,
  changeFigure: User,
  miniAvatar: User,
  changeScene: ArrowRight,
  callScene: ArrowRight,
  end: ArrowRight,
  bgm: Music,
  playEffect: Music,
  playVideo: Film,
  label: Tag,
  jumpLabel: Tag,
  setVar: Variable,
  setTextbox: Monitor,
  getUserInput: Keyboard,
  setAnimation: Wand2,
  setTransform: Move,
  unlockCg: Award,
  unlockBgm: Award,
  comment: Type,
};

const typeColorMap: Partial<Record<WebGalCommandType, string>> = {
  dialogue: 'text-accent',
  narrator: 'text-accent',
  intro: 'text-accent',
  choose: 'text-primary',
  changeBg: 'text-chart-5',
  changeFigure: 'text-chart-5',
  miniAvatar: 'text-chart-5',
  changeScene: 'text-blue-400',
  callScene: 'text-blue-400',
  end: 'text-blue-400',
  bgm: 'text-purple-400',
  playEffect: 'text-purple-400',
  playVideo: 'text-purple-400',
  label: 'text-yellow-400',
  jumpLabel: 'text-yellow-400',
  setVar: 'text-yellow-400',
  comment: 'text-muted-foreground',
};

const categoryColors: Record<string, string> = {
  story: 'hover:border-accent hover:bg-accent/10',
  scene: 'hover:border-chart-5 hover:bg-chart-5/10',
  audio: 'hover:border-purple-400 hover:bg-purple-400/10',
  control: 'hover:border-yellow-400 hover:bg-yellow-400/10',
  effects: 'hover:border-primary hover:bg-primary/10',
};

/** Saturated background color for the minimap blocks (one swatch per type). */
const miniBgClass: Partial<Record<WebGalCommandType, string>> = {
  dialogue: 'bg-accent',
  narrator: 'bg-accent/70',
  intro: 'bg-accent/55',
  choose: 'bg-primary',
  changeBg: 'bg-chart-5',
  changeFigure: 'bg-chart-5/80',
  miniAvatar: 'bg-chart-5/60',
  changeScene: 'bg-blue-400',
  callScene: 'bg-blue-400/75',
  end: 'bg-blue-400/55',
  bgm: 'bg-purple-400',
  playEffect: 'bg-purple-400/75',
  playVideo: 'bg-purple-400/55',
  label: 'bg-yellow-400',
  jumpLabel: 'bg-yellow-400/75',
  setVar: 'bg-yellow-400/55',
  setTextbox: 'bg-yellow-400/40',
  getUserInput: 'bg-yellow-400/40',
  setAnimation: 'bg-primary/75',
  setTransform: 'bg-primary/60',
  unlockCg: 'bg-primary/45',
  unlockBgm: 'bg-primary/45',
  comment: 'bg-muted-foreground/30',
};

function getNodeSummary(node: WebGalNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.character ? `${node.character}: ${node.content}` : node.content;
    case 'narrator':
      return node.content;
    case 'changeBg':
    case 'changeFigure':
    case 'miniAvatar':
      return node.asset || node.content;
    case 'choose':
      return node.choices?.map(c => c.text).join(' / ') || node.content;
    case 'changeScene':
    case 'callScene':
      return node.targetScene || node.content;
    case 'label':
    case 'jumpLabel':
      return node.labelName || node.content;
    case 'setVar':
      return node.varName ? `${node.varName} = ${node.varValue}` : node.content;
    case 'intro':
      return node.introLines?.join(' | ') || node.content;
    case 'bgm':
    case 'playEffect':
    case 'playVideo':
      return node.asset || node.content;
    case 'setAnimation':
      return node.animationName || node.content;
    case 'comment':
      return node.content;
    default:
      return node.content || '—';
  }
}

interface FlowMinimapProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelect: (node: WebGalNode) => void;
}

function FlowMinimap({ nodes, selectedNode, onSelect }: FlowMinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selectedRef.current && containerRef.current) {
      const block = selectedRef.current;
      const container = containerRef.current;
      const blockTop = block.offsetTop;
      const blockBot = blockTop + block.offsetHeight;
      const viewTop = container.scrollTop;
      const viewBot = viewTop + container.clientHeight;
      if (blockTop < viewTop || blockBot > viewBot) {
        container.scrollTop = blockTop - container.clientHeight / 2 + block.offsetHeight / 2;
      }
    }
  }, [selectedNode?.id]);

  return (
    <div className="p-3 border-b border-border">
      <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-2 font-mono-family flex items-center justify-between">
        <span>场景缩略</span>
        <span className="text-[10px] normal-case tracking-normal opacity-60">
          {nodes.length}
        </span>
      </h3>
      <div
        ref={containerRef}
        className="relative max-h-56 overflow-y-auto overflow-x-hidden"
      >
        {nodes.length === 0 ? (
          <div className="text-[10px] text-muted-foreground/60 py-3 text-center font-mono-family">
            (空场景)
          </div>
        ) : (
          <div className="flex flex-col items-center py-1">
            {nodes.map((node, i) => {
              const prev = i > 0 ? nodes[i - 1] : null;
              const prevTerminal = prev ? isTerminalNode(prev.type) : false;
              const isSelected = selectedNode?.id === node.id;
              const bg = miniBgClass[node.type] ?? 'bg-muted-foreground/40';
              const isChoose = node.type === 'choose';
              const choiceCount = isChoose ? Math.min(node.choices?.length ?? 0, 6) : 0;

              return (
                <Fragment key={node.id}>
                  {prev && (
                    prevTerminal ? (
                      <span className="block h-2 w-px" aria-hidden="true" />
                    ) : (
                      <span className="block h-2 w-px bg-border" aria-hidden="true" />
                    )
                  )}
                  <button
                    ref={isSelected ? selectedRef : undefined}
                    type="button"
                    onClick={() => onSelect(node)}
                    title={commandLabels[node.type]}
                    className={`
                      block rounded-sm transition-all
                      ${bg}
                      ${isChoose ? 'w-8 h-2' : 'w-6 h-1.5'}
                      ${isSelected
                        ? 'ring-1 ring-primary ring-offset-1 ring-offset-card scale-110'
                        : 'opacity-80 hover:opacity-100 hover:scale-110'
                      }
                    `}
                  />
                  {isChoose && choiceCount > 0 && (
                    <span className="flex items-center gap-0.5 mt-0.5" aria-hidden="true">
                      {Array.from({ length: choiceCount }).map((_, idx) => (
                        <span
                          key={idx}
                          className="block w-1 h-1 rounded-full bg-primary/80"
                        />
                      ))}
                    </span>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function InsertZone({
  atIndex,
  onInsert,
  append = false,
}: {
  atIndex: number;
  onInsert: (type: WebGalCommandType, atIndex: number) => void;
  append?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`在位置 ${atIndex + 1} 插入指令`}
          data-insert-zone="true"
          data-insert-index={atIndex}
          className={`group/zone relative w-full flex items-center justify-center cursor-pointer transition-all overflow-visible ${
            append
              ? 'h-20'
              : open ? 'h-7' : 'h-1.5 hover:h-7'
          }`}
        >
          <div
            className={`absolute inset-x-2 top-1/2 -translate-y-1/2 h-px bg-border transition-opacity ${
              append || open ? 'opacity-100' : 'opacity-0 group-hover/zone:opacity-100'
            }`}
          />
          <div
            className={`relative z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/40 text-[10px] transition-opacity ${
              append || open ? 'opacity-100' : 'opacity-0 group-hover/zone:opacity-100'
            }`}
          >
            <Plus className="w-3 h-3" />
            <span className="font-mono-family">{append ? '新增指令' : '插入'}</span>
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        className="w-72 p-2"
      >
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2 px-1 font-mono-family">
          在 #{atIndex + 1} 处插入
        </div>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {Object.entries(commandCategories).map(([catKey, types]) => (
            <div key={catKey}>
              <div className="text-[10px] text-muted-foreground px-1 mb-1 font-mono-family">
                {categoryLabels[catKey]}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {types.map((type) => {
                  const Icon = commandIcons[type] || Type;
                  return (
                    <button
                      key={type}
                      onClick={() => {
                        onInsert(type, atIndex);
                        setOpen(false);
                      }}
                      className={`p-1.5 rounded border border-border transition-all flex items-center gap-1.5 group text-xs ${categoryColors[catKey]}`}
                      aria-label={`插入 ${commandLabels[type]}`}
                    >
                      <Icon className="w-3 h-3 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                      <span className="truncate">{commandLabels[type]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface NodeListItemProps {
  node: WebGalNode;
  index: number;
  isSelected: boolean;
  characterColors?: Record<string, string>;
  onSelect: (node: WebGalNode) => void;
  onJump?: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  canPaste?: boolean;
}

function NodeListItem({
  node, index, isSelected, characterColors, onSelect, onJump, onReorder,
  onDelete, onCopy, onCut, onPaste, canPaste,
}: NodeListItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLSpanElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const Icon = commandIcons[node.type] || Type;
  const color = typeColorMap[node.type] || 'text-muted-foreground';

  const [, drop] = useDrop<{ index: number }>({
    accept: DND_LIST_ITEM,
    hover(item, monitor) {
      if (!onReorder || !ref.current) return;
      const dragIndex = item.index;
      const hoverIndex = index;
      if (dragIndex === hoverIndex) return;
      const rect = ref.current.getBoundingClientRect();
      const mid = (rect.bottom - rect.top) / 2;
      const offset = monitor.getClientOffset();
      if (!offset) return;
      const y = offset.y - rect.top;
      if (dragIndex < hoverIndex && y < mid) return;
      if (dragIndex > hoverIndex && y > mid) return;
      onReorder(dragIndex, hoverIndex);
      item.index = hoverIndex;
    },
  });

  const [{ isDragging }, drag, dragPreview] = useDrag({
    type: DND_LIST_ITEM,
    item: () => ({ index }),
    canDrag: () => Boolean(onReorder),
    collect: (m) => ({ isDragging: m.isDragging() }),
  });

  drag(gripRef);
  dragPreview(drop(ref));

  const contextMenuItems = (
    <>
      <ContextMenuItem onClick={onCopy} className="gap-2 text-xs">
        <Copy className="w-3.5 h-3.5" /> 复制
      </ContextMenuItem>
      <ContextMenuItem onClick={onCut} className="gap-2 text-xs">
        <Scissors className="w-3.5 h-3.5" /> 剪切
      </ContextMenuItem>
      <ContextMenuItem onClick={onPaste} disabled={!canPaste} className="gap-2 text-xs">
        <Clipboard className="w-3.5 h-3.5" /> 粘贴
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onDelete} className="gap-2 text-xs text-destructive focus:text-destructive">
        <Trash2 className="w-3.5 h-3.5" /> 删除
      </ContextMenuItem>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          data-node-item="true"
          role="button"
          tabIndex={0}
          onClick={() => onSelect(node)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(node);
            }
          }}
          className={`
            group relative w-full px-2 py-2 rounded border transition-all text-left
            ${isDragging ? 'opacity-30' : 'opacity-100'}
            ${isSelected
              ? 'border-primary bg-primary/10 shadow-[0_0_12px_rgba(212,165,116,0.15)]'
              : 'border-transparent hover:border-border hover:bg-secondary/30'
            }
          `}
        >
          <div className="flex items-start gap-1.5">
            {onReorder && (
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <span
                    ref={gripRef}
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(true); }}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity -ml-1 mt-0.5 text-muted-foreground cursor-grab active:cursor-grabbing shrink-0"
                    title="拖动调整顺序，单击打开菜单"
                    aria-label="节点操作"
                  >
                    <GripVertical className="w-3 h-3" />
                  </span>
                </PopoverTrigger>
                <PopoverContent align="start" side="right" sideOffset={4} className="w-32 p-1">
                  <button type="button" onClick={(e) => { e.stopPropagation(); onCopy?.(); setMenuOpen(false); }}
                    className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors flex items-center gap-2">
                    <Copy className="w-3.5 h-3.5 shrink-0" /><span>复制</span>
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onCut?.(); setMenuOpen(false); }}
                    className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors flex items-center gap-2">
                    <Scissors className="w-3.5 h-3.5 shrink-0" /><span>剪切</span>
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onPaste?.(); setMenuOpen(false); }}
                    disabled={!canPaste}
                    className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
                    <Clipboard className="w-3.5 h-3.5 shrink-0" /><span>粘贴</span>
                  </button>
                  <div className="my-1 border-t border-border" />
                  <button type="button" onClick={(e) => { e.stopPropagation(); onDelete?.(); setMenuOpen(false); }}
                    className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-destructive/20 text-destructive transition-colors flex items-center gap-2">
                    <Trash2 className="w-3.5 h-3.5 shrink-0" /><span>删除</span>
                  </button>
                </PopoverContent>
              </Popover>
            )}
            <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${color}`} />
            {node.type === 'dialogue' && node.character && characterColors?.[node.character] && (
              <span
                className="w-2 h-2 rounded-full mt-1 shrink-0"
                style={{ backgroundColor: characterColors[node.character] }}
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5 font-mono-family flex items-center gap-1.5">
                <span className="opacity-50">{index + 1}</span>
                <span>{commandLabels[node.type]}</span>
              </div>
              <div className="text-xs text-foreground/80 truncate">
                {getNodeSummary(node) || '(空)'}
              </div>
            </div>
            {onJump && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onJump(index);
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-primary/20 text-muted-foreground hover:text-primary shrink-0"
                title="执行到此句"
                aria-label="执行到此句"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-32">
        {contextMenuItems}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function NodePanel({ nodes, selectedNode, onSelectNode, onInsertNode, onReorderNodes, characterColors, onJumpToIndex, onDeleteNode, onCopyNode, onCutNode, onPasteNode, clipboardNode }: NodePanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [areaMenu, setAreaMenu] = useState<{ x: number; y: number; atIndex: number } | null>(null);

  useEffect(() => {
    if (!areaMenu) return;
    const close = () => setAreaMenu(null);
    const keyClose = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', keyClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', keyClose);
    };
  }, [areaMenu]);

  useEffect(() => {
    if (!selectedNode || !listRef.current) return;
    const item = itemRefs.current[selectedNode.id];
    const container = listRef.current;
    if (!item) return;

    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (itemTop < viewTop || itemBottom > viewBottom) {
      container.scrollTop = Math.max(0, itemTop - container.clientHeight / 2 + item.offsetHeight / 2);
    }
  }, [selectedNode?.id]);

  return (
    <div className="w-64 h-full border-r border-border bg-card/30 backdrop-blur-sm flex flex-col overflow-hidden">
      <FlowMinimap
        nodes={nodes}
        selectedNode={selectedNode}
        onSelect={onSelectNode}
      />

      {/* Node List */}
      <div
        ref={listRef}
        className="relative flex-1 min-h-0 overflow-y-auto p-2 pb-24 scroll-pb-24"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('[data-node-item]')) return;
          e.preventDefault();
          const insertEl = (e.target as HTMLElement).closest('[data-insert-zone]');
          const atIndex = insertEl
            ? Number((insertEl as HTMLElement).dataset.insertIndex ?? nodes.length) - 1
            : nodes.length - 1;
          setAreaMenu({
            x: Math.min(e.clientX, window.innerWidth - 148),
            y: Math.min(e.clientY, window.innerHeight - 72),
            atIndex,
          });
        }}
      >
        {nodes.map((node, index) => (
          <Fragment key={node.id}>
            {onInsertNode && (
              <InsertZone atIndex={index} onInsert={onInsertNode} />
            )}
            <div ref={(el) => { itemRefs.current[node.id] = el; }}>
              <NodeListItem
                node={node}
                index={index}
                isSelected={selectedNode?.id === node.id}
                characterColors={characterColors}
                onSelect={onSelectNode}
                onJump={onJumpToIndex}
                onReorder={onReorderNodes}
                onDelete={() => onDeleteNode?.(node.id)}
                onCopy={() => onCopyNode?.(node)}
                onCut={() => onCutNode?.(node)}
                onPaste={() => onPasteNode?.(index)}
                canPaste={Boolean(clipboardNode)}
              />
            </div>
          </Fragment>
        ))}
        {onInsertNode && (
          <InsertZone atIndex={nodes.length} onInsert={onInsertNode} append />
        )}
      </div>

      <div className="p-3 border-t border-border">
        <div className="text-xs text-muted-foreground font-mono-family">
          共 {nodes.length} 条指令
        </div>
      </div>

      {areaMenu && createPortal(
        <div
          style={{ left: areaMenu.x, top: areaMenu.y }}
          className="fixed z-50 min-w-[8rem] bg-popover border border-border rounded-md shadow-md p-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            disabled={!clipboardNode}
            onClick={() => { onPasteNode?.(areaMenu.atIndex); setAreaMenu(null); }}
            className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Clipboard className="w-3.5 h-3.5 shrink-0" />
            <span>粘贴到此处</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
