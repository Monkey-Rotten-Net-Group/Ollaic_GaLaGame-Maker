import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  ArrowRight, BookOpen, ChevronDown, Clipboard, Copy, FileText, GitBranch, GripVertical, Image,
  MoreHorizontal, Music, Play, Plus, Scissors, Search, Trash2, Users,
} from 'lucide-react';
import type { Character } from '../../lib/character-types';
import type { SceneHeader } from '../../lib/webgal-ipc';
import type { WebGalCommandType, WebGalNode } from '../../lib/webgal-types';
import {
  categoryLabels, categoryTagClass, commandCategories, commandLabels, getCommandCategory,
  isMetadataComment,
} from '../../lib/webgal-types';
import { figureLabel } from '../../lib/node-display';
import type { NodeDiffEntry } from '../../lib/node-diff';
import { PreviewNodeCard } from '../PreviewNodeCard';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '../ui/context-menu';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { commandIconFor, getCommandSummary } from './command-presentation';

export type ScriptStreamDisplayMode = 'stream' | 'compact';

interface ScriptCommandStreamProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  currentSceneName: string;
  sceneHeaders?: Record<string, SceneHeader>;
  onSelectNode: (node: WebGalNode) => void;
  onInsertNode: (type: WebGalCommandType, atIndex: number) => void;
  onDeleteNode?: (nodeId: string) => void;
  onCopyNode?: (nodeId: string) => void;
  onCutNode?: (nodeId: string) => void;
  onPasteNode?: (atIndex: number) => void;
  onReorderNodes?: (fromIndex: number, toIndex: number) => void;
  onJumpToIndex?: (index: number) => void;
  onCreateUnlockNode?: (sourceNode: WebGalNode, atIndex: number) => void;
  clipboardNode?: WebGalNode | null;
  characterColors?: Record<string, string>;
  characters?: Character[];
  searchQuery?: string;
  previewEntries?: NodeDiffEntry[];
  projectPath?: string;
  displayMode?: ScriptStreamDisplayMode;
}

// --- Sub-components for DnD and insert zones ---

const CMD_ITEM = 'script-command';

function InsertZone({ atIndex, onInsert, compact = false }: { atIndex: number; onInsert: (type: WebGalCommandType, atIndex: number) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);

  const insertCommand = useCallback((type: WebGalCommandType) => {
    onInsert(type, atIndex);
    setOpen(false);
  }, [atIndex, onInsert]);

  return (
    <div className={`group relative mx-auto flex items-center justify-center ${compact ? 'h-1.5' : 'h-6'} max-w-4xl`}>
      <div className={`absolute inset-x-0 top-1/2 h-px ${compact ? 'bg-transparent group-hover:bg-secondary/40' : 'bg-outline-variant/20 group-hover:bg-secondary/40'} transition-colors`} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative z-10 flex h-4 w-4 items-center justify-center rounded-full border border-outline-variant/30 bg-surface-bright text-[9px] text-muted-foreground opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 hover:border-secondary hover:text-secondary data-[state=open]:opacity-100"
            title="插入指令"
            aria-label="插入指令"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 rounded border border-border bg-surface-container-high p-3 shadow-lg"
        >
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">插入指令</div>
          {Object.entries(commandCategories).map(([category, types]) => (
            <div key={category} className="mb-2 last:mb-0">
              <div className="mb-1 text-[9px] font-semibold uppercase text-on-surface-variant/60">
                {categoryLabels[category] || category}
              </div>
              <div className="flex flex-wrap gap-1">
                {types.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => insertCommand(type)}
                    className="rounded-sm border border-outline-variant/30 px-2 py-1 text-[10px] text-on-surface-variant hover:border-secondary hover:text-secondary transition-colors"
                  >
                    {commandLabels[type]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface ScriptCommandCardProps {
  node: WebGalNode;
  index: number;
  displayIndex: number;
  selected: boolean;
  Icon: ReturnType<typeof commandIconFor>;
  tag: string;
  tagClass: string;
  isDialogue: boolean;
  isBackground: boolean;
  isBranch: boolean;
  charColor?: string;
  /** Speaker to show — the node's own character, or the inherited one for a
   *  continuation line (empty character). */
  displayCharacter?: string;
  /** True when displayCharacter was inherited rather than set on this node. */
  characterInherited?: boolean;
  /** Continuation dialogue lines (no own character) merged into this card. */
  continuationLines?: WebGalNode[];
  /** Currently selected node id (to highlight the right line in a merged card). */
  selectedNodeId?: string;
  onSelectNode: (node: WebGalNode) => void;
  onInsertNode: (type: WebGalCommandType, atIndex: number) => void;
  onDeleteNode?: (nodeId: string) => void;
  onCopyNode?: (nodeId: string) => void;
  onCutNode?: (nodeId: string) => void;
  onPasteNode?: (atIndex: number) => void;
  onReorderNodes?: (fromIndex: number, toIndex: number) => void;
  onJumpToIndex?: (index: number) => void;
  onCreateUnlockNode?: (sourceNode: WebGalNode, atIndex: number) => void;
  clipboardNode?: WebGalNode | null;
  /** Active search query — disables drag-reorder while filtering. */
  query?: string;
  /** Characters for resolving changeFigure labels. */
  characters?: Character[];
  projectPath?: string;
}

function ScriptCommandCard({
  node,
  index,
  displayIndex,
  selected,
  Icon,
  tag,
  tagClass,
  isDialogue,
  isBackground,
  isBranch,
  charColor,
  displayCharacter,
  characterInherited,
  continuationLines,
  selectedNodeId,
  onSelectNode,
  onInsertNode,
  onDeleteNode,
  onCopyNode,
  onCutNode,
  onPasteNode,
  onReorderNodes,
  onJumpToIndex,
  onCreateUnlockNode,
  clipboardNode,
  query,
  characters,
  projectPath,
}: ScriptCommandCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const [{ isDragging }, drag, preview] = useDrag({
    type: CMD_ITEM,
    item: () => ({ index, id: node.id }),
    canDrag: () => Boolean(onReorderNodes) && !query,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const [, drop] = useDrop({
    accept: CMD_ITEM,
    hover: (item: { index: number; id: string }, monitor) => {
      if (!ref.current || !onReorderNodes) return;
      const dragIndex = item.index;
      const hoverIndex = index;
      if (dragIndex === hoverIndex) return;
      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) return;
      const hoverClientY = clientOffset.y - hoverBoundingRect.top;
      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) return;
      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) return;
      onReorderNodes(dragIndex, hoverIndex);
      item.index = hoverIndex;
    },
  });

  drag(drop(ref));
  const canCreateUnlock = onCreateUnlockNode
    && ((node.type === 'changeBg' && (node.asset || node.content || '').trim() && (node.asset || node.content || '').trim() !== 'none')
      || (node.type === 'bgm' && (node.asset || node.content || '').trim() && (node.asset || node.content || '').trim() !== 'none'));
  const unlockLabel = node.type === 'changeBg' ? '加入CG鉴赏' : '加入BGM鉴赏';

  return (
    <div ref={preview} key={node.id} data-cmd-card data-cmd-index={index} data-node-id={node.id} className="group flex gap-3" style={{ opacity: isDragging ? 0.4 : 1 }}>
      <div className="flex w-12 shrink-0 flex-col items-center pt-2">
        <div className={`flex h-8 w-8 items-center justify-center rounded-full border text-[10px] font-bold ${
          selected ? 'border-primary text-primary' : 'border-outline-variant/30 text-on-surface-variant/40'
        }`}>
          {String(displayIndex + 1).padStart(2, '0')}
        </div>
        <div className="my-2 w-px flex-1 bg-outline-variant/20" />
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
      <div
        ref={ref}
        className={`relative w-full max-w-3xl overflow-hidden border shadow-sm transition-all ${
          isBranch
            ? `border-2 bg-tertiary/5 ${selected ? 'border-tertiary' : 'border-tertiary/30'} ollaic-chamfer-tr`
            : `bg-surface-bright ${selected ? 'border-primary ring-1 ring-primary/20' : 'border-outline-variant/40 hover:border-secondary'}`
        }`}
      >
        <button
          type="button"
          onClick={() => onSelectNode(node)}
          className="w-full p-4 text-left"
        >
          <div className={`absolute right-0 top-0 px-2 py-1 text-[9px] uppercase tracking-tight ${tagClass}`}>{tag}</div>

          {isBackground ? (
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden border border-outline-variant/20 bg-surface-container-highest">
                {projectPath && (node.asset || node.content) ? (
                  <img
                    src={convertFileSrc(`${projectPath}/game/background/${node.asset || node.content}`)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Image className="h-5 w-5 text-on-surface-variant/30" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="mb-1 font-bold text-foreground">设置背景: {node.asset || node.content || '未选择背景'}</p>
              </div>
            </div>
          ) : node.type === 'bgm' || node.type === 'playEffect' || node.type === 'playVideo' ? (
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-audio/25 bg-audio-soft">
                <Music className="h-5 w-5 text-audio" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-audio">
                    {node.type === 'bgm' ? '背景音乐' : node.type === 'playEffect' ? '音效' : '视频'}
                  </span>
                  {node.volume !== undefined && (
                    <span className="rounded border border-outline-variant/30 px-2 py-0.5 text-[10px] text-on-surface-variant/60">
                      音量 {node.volume}
                    </span>
                  )}
                </div>
                <p className="truncate font-mono-family text-sm text-foreground">
                  {node.asset || node.content || '未选择素材'}
                </p>
              </div>
            </div>
          ) : isDialogue ? (
            <div className="flex items-start gap-3">
              {charColor ? (
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${charColor}20` }}
                >
                  <span
                    className="h-5 w-5 rounded-full"
                    style={{ backgroundColor: charColor }}
                  />
                </div>
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container/20">
                  <Users className="h-5 w-5 text-primary" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={`font-bold ${characterInherited ? 'opacity-60' : ''}`}
                    style={charColor ? { color: charColor } : { color: 'var(--color-primary)' }}
                    title={characterInherited ? '继承自上一句角色' : undefined}
                  >
                    {displayCharacter || '未指定角色'}
                  </span>
                  {characterInherited && (
                    <span className="rounded border border-outline-variant/30 px-1.5 py-0.5 text-[9px] font-normal text-on-surface-variant/50">
                      承上
                    </span>
                  )}
                </div>
                <div className="space-y-1.5">
                  {[node, ...(continuationLines ?? [])].map((lineNode) => {
                    const merged = (continuationLines?.length ?? 0) > 0;
                    const lineSelected = merged && selectedNodeId === lineNode.id;
                    return (
                      <div key={lineNode.id}>
                        <div
                          role={merged ? 'button' : undefined}
                          tabIndex={merged ? 0 : undefined}
                          onClick={merged ? (e) => { e.stopPropagation(); onSelectNode(lineNode); } : undefined}
                          className={`border-l-4 p-3 text-base leading-relaxed text-on-surface whitespace-pre-wrap transition-colors ${
                            merged
                              ? `cursor-pointer ${lineSelected ? 'border-primary bg-primary/5' : 'border-primary/30 bg-surface-container-low/50 hover:bg-surface-container-low'}`
                              : 'border-primary/30 bg-surface-container-low/50'
                          }`}
                        >
                          "{lineNode.content || '……'}"
                        </div>
                        {(lineNode.voice || lineNode.figureEmotion) && (
                          <div className="mt-1 flex flex-wrap gap-2 pl-3">
                            {lineNode.voice && <span className="rounded border border-outline-variant/30 px-2 py-0.5 text-[10px] text-on-surface-variant/60">语音: {lineNode.voice}</span>}
                            {lineNode.figureEmotion && (
                              <span className="rounded border border-outline-variant/30 px-2 py-0.5 text-[10px] text-on-surface-variant/60">表情: {lineNode.figureEmotion}</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : isBranch ? (
            <>
              <div className="mb-4 flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-tertiary" />
                <span className="font-bold text-tertiary">抉择分支: {node.content || '剧情选择'}</span>
              </div>
              <div className="space-y-2">
                {(node.choices?.length ? node.choices : [{ text: getCommandSummary(node), target: '@next' }]).map((choice, choiceIndex) => (
                  <div key={`${node.id}-${choiceIndex}`} className="flex items-center justify-between border border-tertiary/20 bg-surface-bright p-2 text-sm">
                    <span>{choiceIndex + 1}. {choice.text}</span>
                    <span className="text-[10px] text-tertiary">跳转至: {choice.target}</span>
                  </div>
                ))}
              </div>
            </>
          ) : node.type === 'changeFigure' ? (
            <div className="flex items-center gap-4">
              <div className="flex h-20 w-14 shrink-0 items-center justify-center overflow-hidden rounded">
                {projectPath && (node.asset || node.content) && (node.asset || node.content) !== 'none' ? (
                  <img
                    src={convertFileSrc(`${projectPath}/game/figure/${node.asset || node.content}`)}
                    alt=""
                    className="h-full w-full object-contain object-top"
                  />
                ) : (
                  <Users className="h-5 w-5 text-on-surface-variant/30" />
                )}
              </div>
              <span className="min-w-0 truncate text-sm">
                {figureLabel(node, characters)}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Icon className="h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0 truncate text-sm">
                {getCommandSummary(node)}
              </span>
            </div>
          )}
        </button>
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            ref={onReorderNodes ? drag : undefined}
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-outline-variant/60 hover:bg-surface-container-low hover:text-foreground cursor-grab active:cursor-grabbing"
            title="拖拽排序"
            aria-label="拖拽排序"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-outline-variant/60 hover:bg-surface-container-low hover:text-foreground"
                title="更多操作"
                aria-label="更多操作"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {onCopyNode && (
                <DropdownMenuItem onClick={() => onCopyNode(node.id)}>
                  <Copy className="h-4 w-4" /> 复制
                </DropdownMenuItem>
              )}
              {onCutNode && (
                <DropdownMenuItem onClick={() => onCutNode(node.id)}>
                  <Scissors className="h-4 w-4" /> 剪切
                </DropdownMenuItem>
              )}
              {onPasteNode && (
                <DropdownMenuItem
                  onClick={() => onPasteNode(index)}
                  disabled={!clipboardNode}
                >
                  <Clipboard className="h-4 w-4" /> 粘贴到此处
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onInsertNode(node.type, index + 1)}>
                <Plus className="h-4 w-4" /> 在下方插入
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onInsertNode(node.type, index)}>
                <ArrowRight className="h-4 w-4 -rotate-180" /> 在上方插入
              </DropdownMenuItem>
              {onJumpToIndex && (
                <DropdownMenuItem onClick={() => onJumpToIndex(index)}>
                  <ArrowRight className="h-4 w-4" /> 跳到运行时
                </DropdownMenuItem>
              )}
              {canCreateUnlock && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onCreateUnlockNode?.(node, index + 1)}>
                    <BookOpen className="h-4 w-4" /> {unlockLabel}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              {onDeleteNode && (
                <DropdownMenuItem
                  onClick={() => onDeleteNode(node.id)}
                  className="text-error focus:text-error"
                >
                  <Trash2 className="h-4 w-4" /> 删除
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          {onCopyNode && (
            <ContextMenuItem onClick={() => onCopyNode(node.id)} className="gap-2 text-xs">
              <Copy className="h-3.5 w-3.5" /> 复制
            </ContextMenuItem>
          )}
          {onCutNode && (
            <ContextMenuItem onClick={() => onCutNode(node.id)} className="gap-2 text-xs">
              <Scissors className="h-3.5 w-3.5" /> 剪切
            </ContextMenuItem>
          )}
          {onPasteNode && (
            <ContextMenuItem onClick={() => onPasteNode(index)} disabled={!clipboardNode} className="gap-2 text-xs">
              <Clipboard className="h-3.5 w-3.5" /> 粘贴到此处
            </ContextMenuItem>
          )}
          {canCreateUnlock && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onCreateUnlockNode?.(node, index + 1)} className="gap-2 text-xs">
                <BookOpen className="h-3.5 w-3.5" /> {unlockLabel}
              </ContextMenuItem>
            </>
          )}
          {onDeleteNode && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onDeleteNode(node.id)} className="gap-2 text-xs text-error focus:text-error">
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

function ScriptCommandCompactRow({
  node,
  index,
  displayIndex,
  selected,
  Icon,
  tag,
  isDialogue,
  isBackground,
  isBranch,
  charColor,
  displayCharacter,
  characterInherited,
  continuationLines,
  selectedNodeId,
  onSelectNode,
  onInsertNode,
  onDeleteNode,
  onCopyNode,
  onCutNode,
  onPasteNode,
  onReorderNodes,
  onJumpToIndex,
  onCreateUnlockNode,
  clipboardNode,
  query,
  characters,
  projectPath,
}: ScriptCommandCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const [{ isDragging }, drag, preview] = useDrag({
    type: CMD_ITEM,
    item: () => ({ index, id: node.id }),
    canDrag: () => Boolean(onReorderNodes) && !query,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const [, drop] = useDrop({
    accept: CMD_ITEM,
    hover: (item: { index: number; id: string }, monitor) => {
      if (!ref.current || !onReorderNodes) return;
      const dragIndex = item.index;
      const hoverIndex = index;
      if (dragIndex === hoverIndex) return;
      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) return;
      const hoverClientY = clientOffset.y - hoverBoundingRect.top;
      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) return;
      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) return;
      onReorderNodes(dragIndex, hoverIndex);
      item.index = hoverIndex;
    },
  });

  drag(drop(ref));
  const canCreateUnlock = onCreateUnlockNode
    && ((node.type === 'changeBg' && (node.asset || node.content || '').trim() && (node.asset || node.content || '').trim() !== 'none')
      || (node.type === 'bgm' && (node.asset || node.content || '').trim() && (node.asset || node.content || '').trim() !== 'none'));
  const unlockLabel = node.type === 'changeBg' ? '加入CG鉴赏' : '加入BGM鉴赏';

  const rowBgClass = isBackground
    ? selected
      ? 'border-emerald-500 bg-emerald-500/15'
      : 'border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10'
    : isBranch
      ? selected
        ? 'border-amber-500 bg-amber-500/15'
        : 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
      : selected
        ? 'border-primary bg-primary/10 shadow-sm'
        : 'border-outline-variant/25 bg-surface-bright/70 hover:bg-surface-container-low hover:border-outline-variant/50';

  return (
    <div
      ref={preview}
      key={node.id}
      data-cmd-card
      data-cmd-index={index}
      data-node-id={node.id}
      className="group relative flex w-full max-w-4xl items-stretch"
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            onClick={(event) => {
              // Menu portals bubble through React but are outside the row.
              if (event.currentTarget.contains(event.target as Node)) onSelectNode(node);
            }}
            className={`flex min-h-9 w-full items-center gap-2.5 rounded border px-3 py-1.5 text-xs transition-colors cursor-pointer ${rowBgClass}`}
          >
            {/* Index & hover Play button */}
            <div className="relative flex h-5 w-7 shrink-0 items-center justify-center font-mono text-[11px] text-muted-foreground">
              {onJumpToIndex ? (
                <>
                  <span className="transition-opacity duration-150 group-hover:opacity-0">{String(displayIndex + 1).padStart(2, '0')}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onJumpToIndex(index);
                    }}
                    className="absolute inset-0 m-auto flex h-5 w-5 items-center justify-center rounded bg-primary/20 text-primary opacity-0 transition-opacity duration-150 hover:bg-primary hover:text-primary-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                    title="跳到此处运行"
                    aria-label={`运行到此处第 ${displayIndex + 1} 行`}
                  >
                    <Play className="h-3 w-3 fill-current ml-0.5" />
                  </button>
                </>
              ) : (
                <span>{String(displayIndex + 1).padStart(2, '0')}</span>
              )}
            </div>

            {/* Tag / Category Badge */}
            {isDialogue ? (
              <span
                className={`shrink-0 max-w-28 truncate rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                  characterInherited ? 'opacity-65' : ''
                }`}
                style={
                  charColor
                    ? { backgroundColor: `${charColor}20`, color: charColor }
                    : { backgroundColor: 'var(--color-primary-container, rgba(56,189,248,0.15))', color: 'var(--color-primary)' }
                }
                title={characterInherited ? '继承自上一句角色' : undefined}
              >
                {displayCharacter || '旁白'}
              </span>
            ) : isBackground ? (
              <span className="flex shrink-0 items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-500">
                <Image className="h-3 w-3" /> 背景
              </span>
            ) : isBranch ? (
              <span className="flex shrink-0 items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-500">
                <GitBranch className="h-3 w-3" /> 分支
              </span>
            ) : node.type === 'bgm' || node.type === 'playEffect' || node.type === 'playVideo' ? (
              <span className="flex shrink-0 items-center gap-1 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-bold text-sky-500">
                <Music className="h-3 w-3" /> {node.type === 'bgm' ? 'BGM' : node.type === 'playEffect' ? '音效' : '视频'}
              </span>
            ) : node.type === 'changeFigure' ? (
              <span className="flex shrink-0 items-center gap-1 rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-bold text-purple-400">
                <Users className="h-3 w-3" /> 立绘
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1 rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                <Icon className="h-3 w-3" /> {tag}
              </span>
            )}

            {/* Main Content */}
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectNode(node);
                }}
                aria-pressed={selectedNodeId === node.id}
                className="block w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {isDialogue ? (
                  <span className="text-on-surface">
                    "{node.content || '……'}"
                  </span>
                ) : isBackground ? (
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-foreground">
                      {node.asset || node.content || '未选择背景'}
                    </span>
                    {projectPath && (node.asset || node.content) && (
                      <img
                        src={convertFileSrc(`${projectPath}/game/background/${node.asset || node.content}`)}
                        alt=""
                        className="h-4 w-6 rounded border border-emerald-500/20 object-cover"
                      />
                    )}
                  </span>
                ) : isBranch ? (
                  <span className="font-medium text-tertiary">
                    {(node.choices?.length ? node.choices : [{ text: getCommandSummary(node), target: '@next' }])
                      .map((choice) => `${choice.text} ➔ ${choice.target}`)
                      .join(' | ')}
                  </span>
                ) : node.type === 'changeFigure' ? (
                  <span className="truncate text-foreground">
                    {figureLabel(node, characters)}
                  </span>
                ) : node.type === 'bgm' || node.type === 'playEffect' || node.type === 'playVideo' ? (
                  <span className="font-mono text-[11px] text-foreground">
                    {node.asset || node.content || '未选择素材'}{node.volume !== undefined ? ` (音量: ${node.volume})` : ''}
                  </span>
                ) : (
                  <span className="truncate text-muted-foreground">
                    {getCommandSummary(node)}
                  </span>
                )}
              </button>
              {continuationLines && continuationLines.length > 0 && (
                <div className="mt-1 space-y-0.5 border-t border-outline-variant/15 pt-1">
                  {continuationLines.map((lineNode) => {
                    const lineSelected = selectedNodeId === lineNode.id;
                    return (
                      <button
                        type="button"
                        aria-pressed={selectedNodeId === lineNode.id}
                        key={lineNode.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectNode(lineNode);
                        }}
                        className={`flex items-center gap-1.5 w-full rounded text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          lineSelected ? 'font-semibold text-primary' : 'text-on-surface-variant/80 hover:text-foreground'
                        }`}
                      >
                        <span className="rounded bg-outline-variant/20 px-1 text-[9px] text-muted-foreground">承上</span>
                        <span className="truncate">"{lineNode.content || '……'}"</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Extra Metadata Badges */}
            {(node.voice || node.figureEmotion) && (
              <div className="flex shrink-0 items-center gap-1 text-[10px] text-on-surface-variant/70">
                {node.voice && (
                  <span className="rounded bg-outline-variant/20 px-1.5 py-0.5">
                    语音: {node.voice}
                  </span>
                )}
                {node.figureEmotion && (
                  <span className="rounded bg-outline-variant/20 px-1.5 py-0.5">
                    表情: {node.figureEmotion}
                  </span>
                )}
              </div>
            )}

            {/* Hover Actions: Drag & Dropdown */}
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                ref={onReorderNodes ? drag : undefined}
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-outline-variant/60 hover:bg-surface-container-high hover:text-foreground cursor-grab active:cursor-grabbing"
                title="拖拽排序"
                aria-label="拖拽排序"
              >
                <GripVertical className="h-3 w-3" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    className="rounded p-1 text-outline-variant/60 hover:bg-surface-container-high hover:text-foreground"
                    title="更多操作"
                    aria-label="更多操作"
                  >
                    <MoreHorizontal className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {onCopyNode && (
                    <DropdownMenuItem onClick={() => onCopyNode(node.id)}>
                      <Copy className="h-4 w-4" /> 复制
                    </DropdownMenuItem>
                  )}
                  {onCutNode && (
                    <DropdownMenuItem onClick={() => onCutNode(node.id)}>
                      <Scissors className="h-4 w-4" /> 剪切
                    </DropdownMenuItem>
                  )}
                  {onPasteNode && (
                    <DropdownMenuItem
                      onClick={() => onPasteNode(index)}
                      disabled={!clipboardNode}
                    >
                      <Clipboard className="h-4 w-4" /> 粘贴到此处
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onInsertNode(node.type, index + 1)}>
                    <Plus className="h-4 w-4" /> 在下方插入
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onInsertNode(node.type, index)}>
                    <ArrowRight className="h-4 w-4 -rotate-180" /> 在上方插入
                  </DropdownMenuItem>
                  {onJumpToIndex && (
                    <DropdownMenuItem onClick={() => onJumpToIndex(index)}>
                      <Play className="h-4 w-4" /> 跳到运行时
                    </DropdownMenuItem>
                  )}
                  {canCreateUnlock && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onCreateUnlockNode?.(node, index + 1)}>
                        <BookOpen className="h-4 w-4" /> {unlockLabel}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  {onDeleteNode && (
                    <DropdownMenuItem
                      onClick={() => onDeleteNode(node.id)}
                      className="text-error focus:text-error"
                    >
                      <Trash2 className="h-4 w-4" /> 删除
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          {onCopyNode && (
            <ContextMenuItem onClick={() => onCopyNode(node.id)} className="gap-2 text-xs">
              <Copy className="h-3.5 w-3.5" /> 复制
            </ContextMenuItem>
          )}
          {onCutNode && (
            <ContextMenuItem onClick={() => onCutNode(node.id)} className="gap-2 text-xs">
              <Scissors className="h-3.5 w-3.5" /> 剪切
            </ContextMenuItem>
          )}
          {onPasteNode && (
            <ContextMenuItem onClick={() => onPasteNode(index)} disabled={!clipboardNode} className="gap-2 text-xs">
              <Clipboard className="h-3.5 w-3.5" /> 粘贴到此处
            </ContextMenuItem>
          )}
          {canCreateUnlock && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onCreateUnlockNode?.(node, index + 1)} className="gap-2 text-xs">
                <BookOpen className="h-3.5 w-3.5" /> {unlockLabel}
              </ContextMenuItem>
            </>
          )}
          {onDeleteNode && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onDeleteNode(node.id)} className="gap-2 text-xs text-error focus:text-error">
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

export function ScriptCommandStream({
  nodes,
  selectedNode,
  currentSceneName,
  sceneHeaders,
  onSelectNode,
  onInsertNode,
  onDeleteNode,
  onCopyNode,
  onCutNode,
  onPasteNode,
  onReorderNodes,
  onJumpToIndex,
  onCreateUnlockNode,
  clipboardNode,
  characterColors,
  characters,
  searchQuery,
  previewEntries,
  projectPath,
  displayMode = 'stream',
}: ScriptCommandStreamProps) {
  const query = searchQuery?.trim().toLowerCase() ?? '';
  const isCompact = displayMode === 'compact';

  // Right-click on empty area (between/around cards) → paste at the position
  // nearest the cursor, so the user can choose where the clipboard node lands.
  const [areaMenu, setAreaMenu] = useState<{ x: number; y: number; atIndex: number } | null>(null);
  useEffect(() => {
    if (!areaMenu) return;
    const close = () => setAreaMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [areaMenu]);

  // Compute the paste anchor for an empty-area right-click from its Y position.
  // onPasteNode(atIndex) inserts *after* node atIndex (pasteSceneNode uses
  // atIndex + 1), so to drop between two cards we return the index of the card
  // just above the cursor: the card before the first one whose vertical midpoint
  // is below the cursor. Above the first card → -1 (start); below all → last.
  const areaPasteIndex = useCallback((container: HTMLElement, clientY: number): number => {
    const cards = container.querySelectorAll<HTMLElement>('[data-cmd-card]');
    for (const el of Array.from(cards)) {
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return Number(el.dataset.cmdIndex) - 1;
    }
    return nodes.length - 1;
  }, [nodes.length]);

  // WebGAL continuation: a dialogue line with no character keeps the previous
  // speaker. Carry the last explicit speaker forward so continuation lines (and
  // the extra lines a multi-line dialogue splits into on save) show who is
  // talking instead of "未指定角色". Display-only — the node's own character
  // stays empty so the script round-trips unchanged.
  const effectiveSpeakers = useMemo(() => {
    const map = new Map<string, string>();
    let current = '';
    for (const node of nodes) {
      if (node.type !== 'dialogue') continue;
      const own = node.character?.trim();
      if (own) current = own;
      if (current) map.set(node.id, current);
    }
    return map;
  }, [nodes]);

  // Display-layer grouping: merge a dialogue head with the continuation lines
  // that follow it (contiguous dialogue nodes with no own character) into one
  // card. The nodes stay separate (runtime still advances per line); we only
  // skip the absorbed lines in the top-level list and render them inside the
  // head card. Disabled while searching so every match stays visible.
  const { continuationsByHead, absorbedIds } = useMemo(() => {
    const byHead = new Map<string, WebGalNode[]>();
    const absorbed = new Set<string>();
    if (query) return { continuationsByHead: byHead, absorbedIds: absorbed };
    let headId = '';
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'dialogue') { headId = ''; continue; }
      const own = n.character?.trim();
      const prevIsDialogue = i > 0 && nodes[i - 1].type === 'dialogue';
      if (!own && headId && prevIsDialogue) {
        absorbed.add(n.id);
        const arr = byHead.get(headId) ?? [];
        arr.push(n);
        byHead.set(headId, arr);
      } else {
        headId = n.id;
      }
    }
    return { continuationsByHead: byHead, absorbedIds: absorbed };
  }, [nodes, query]);
  const visibleNodes = query
    ? nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => {
          if (isMetadataComment(node)) return false;
          const haystack = [node.type, node.character, node.content, node.asset, node.voice]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
    : nodes.map((node, index) => ({ node, index })).filter(({ node }) => !isMetadataComment(node));

  interface ScriptSection {
    id: string;
    title: string;
    bgNode?: WebGalNode;
    bgAsset?: string;
    firstIndex: number;
    items: Array<{ node: WebGalNode; index: number }>;
    dialogueCount: number;
  }

  const sections = useMemo(() => {
    const list: ScriptSection[] = [];
    let currentSection: ScriptSection = {
      id: 'section-init',
      title: sceneHeaders?.[currentSceneName]?.chapter || '序幕 · 开场',
      firstIndex: 0,
      items: [],
      dialogueCount: 0,
    };

    for (let i = 0; i < visibleNodes.length; i++) {
      const item = visibleNodes[i];
      const { node, index } = item;

      if (node.type === 'changeBg' && i > 0 && currentSection.items.length > 0) {
        let title = '';
        if (index > 0) {
          const prevNode = nodes[index - 1];
          if (prevNode && prevNode.type === 'comment' && !isMetadataComment(prevNode) && prevNode.content?.trim()) {
            title = prevNode.content.trim().replace(/^[;；]\s*/, '').replace(/^小节[：:]\s*/, '');
          }
        }
        const bgAsset = (node.asset || node.content || '').trim();
        if (!title && bgAsset && bgAsset !== 'none') {
          const cleanStem = bgAsset.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
          title = `小节 ${list.length + 1} · ${cleanStem}`;
        }
        if (!title) {
          title = `小节 ${list.length + 1}`;
        }

        list.push(currentSection);
        currentSection = {
          id: `section-${node.id}`,
          title,
          bgNode: node,
          bgAsset: bgAsset && bgAsset !== 'none' ? bgAsset : undefined,
          firstIndex: index,
          items: [item],
          dialogueCount: 0,
        };
      } else {
        if (node.type === 'changeBg' && !currentSection.bgNode) {
          currentSection.bgNode = node;
          const bgAsset = (node.asset || node.content || '').trim();
          if (bgAsset && bgAsset !== 'none') {
            currentSection.bgAsset = bgAsset;
            if (currentSection.title === '序幕 · 开场' || !currentSection.title) {
              const cleanStem = bgAsset.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
              currentSection.title = `小节 1 · ${cleanStem}`;
            }
          }
        }
        currentSection.items.push(item);
        if (node.type === 'dialogue') {
          currentSection.dialogueCount += 1;
        }
      }
    }

    if (currentSection.items.length > 0 || list.length === 0) {
      list.push(currentSection);
    }

    return list;
  }, [visibleNodes, nodes, currentSceneName, sceneHeaders]);

  const hasMultipleSections = sections.length > 1;
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCollapsedSectionIds(new Set());
  }, [currentSceneName]);

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }, []);

  const collapseAllSections = useCallback(() => {
    setCollapsedSectionIds(new Set(sections.map((s) => s.id)));
  }, [sections]);

  const expandAllSections = useCallback(() => {
    setCollapsedSectionIds(new Set());
  }, []);

  const selectedNodeId = selectedNode?.id;
  const selectedSectionId = sections.find((section) =>
    section.items.some(({ node }) => node.id === selectedNodeId))?.id;
  const lastSelectionRef = useRef<{ scene: string; nodeId: string | undefined } | null>(null);

  // Reveal a newly selected command without undoing later manual collapses.
  // Edits and search filters can rebuild sections without changing selection.
  useEffect(() => {
    const previous = lastSelectionRef.current;
    lastSelectionRef.current = { scene: currentSceneName, nodeId: selectedNodeId };
    if (previous?.scene === currentSceneName && previous.nodeId === selectedNodeId) return;
    if (!selectedSectionId) return;
    setCollapsedSectionIds((prev) => {
      if (!prev.has(selectedSectionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSectionId);
      return next;
    });
  }, [currentSceneName, selectedNodeId, selectedSectionId]);

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 opacity-[0.03] ollaic-dot-grid" />
      <div className="relative z-10 flex h-10 shrink-0 items-center justify-between border-b border-outline-variant/20 bg-surface-bright/50 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="shrink-0 text-xs font-bold tracking-widest text-on-surface-variant">
            {isCompact ? '剧本视图' : '指令卡片'}
          </span>
          <div className="flex gap-2">
            {(() => {
              const header = sceneHeaders?.[currentSceneName];
              const chapter = header?.chapter?.trim() || '';
              if (chapter) {
                return (
                  <span className="rounded bg-secondary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-secondary">
                    {chapter}
                  </span>
                );
              }
              return null;
            })()}
            <span className="rounded bg-outline-variant/20 px-2 py-0.5 text-[10px] font-bold uppercase text-on-surface-variant">
              {currentSceneName.replace(/\.txt$/, '')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-on-surface-variant/50">
          {hasMultipleSections && !query && (
            <button
              type="button"
              onClick={collapsedSectionIds.size > 0 ? expandAllSections : collapseAllSections}
              className="rounded border border-outline-variant/30 bg-surface-container-high/50 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-surface-container-high hover:text-foreground transition-colors"
            >
              {collapsedSectionIds.size > 0 ? '全部展开' : '全部折叠'}
            </button>
          )}
          {query && (
            <span className="rounded-full bg-primary-container/40 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {visibleNodes.length} / {nodes.length}
            </span>
          )}
          <span className="font-mono-family text-[10px] text-muted-foreground">
            {nodes.length} 条指令
          </span>
        </div>
      </div>

      {previewEntries ? (
        <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-primary/30 bg-primary/10 px-4 py-2 text-center text-xs font-semibold text-primary">
            预览模式
          </div>
          <div className="flex-1 overflow-y-auto p-8">
            <div className="mx-auto flex max-w-xl flex-col items-center pb-20">
              {previewEntries.map((entry, index) => (
                <PreviewNodeCard key={`${entry.kind}-${index}`} entry={entry} />
              ))}
            </div>
          </div>
        </div>
      ) : (
      <div
        className="relative z-10 flex-1 overflow-y-auto p-4 sm:p-6"
        onContextMenu={(e) => {
          if (!clipboardNode || !onPasteNode) return;
          // A card right-click is handled by the card's own context menu.
          if ((e.target as HTMLElement).closest('[data-cmd-card]')) return;
          e.preventDefault();
          const atIndex = areaPasteIndex(e.currentTarget, e.clientY);
          setAreaMenu({ x: e.clientX, y: e.clientY, atIndex });
        }}
      >
        <div className={`mx-auto max-w-4xl ${isCompact ? 'space-y-1 pb-32' : 'space-y-6 pb-48'}`}>
        {nodes.length === 0 ? (
          <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 border border-dashed border-outline-variant/50 bg-surface-bright p-8 text-center text-muted-foreground">
            <FileText className="h-10 w-10 opacity-50" />
            <div className="text-base text-foreground">当前场景还没有命令</div>
            <button type="button" onClick={() => onInsertNode('dialogue', 0)} className="bg-primary px-4 py-2 text-sm font-semibold text-on-primary ollaic-chamfer-tr">
              添加第一句对白
            </button>
          </div>
        ) : visibleNodes.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 border border-dashed border-outline-variant/40 bg-surface-bright p-6 text-center text-muted-foreground">
            <Search className="h-6 w-6 opacity-50" />
            <div className="text-sm">没有匹配 "{query}" 的指令</div>
          </div>
        ) : (
          sections.map((section) => {
            const isSectionCollapsed = hasMultipleSections && !query && collapsedSectionIds.has(section.id);
            return (
              <div key={section.id} className="section-block">
                {hasMultipleSections && (
                  <div
                    className="group mb-2 mt-4 first:mt-0 flex cursor-pointer select-none items-center justify-between rounded-md border border-outline-variant/30 bg-surface-container-low/70 px-3 py-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-surface-container-low"
                    onClick={() => toggleSection(section.id)}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="flex h-4 w-4 items-center justify-center text-muted-foreground transition-transform group-hover:text-primary">
                        <ChevronDown className={`size-3.5 transition-transform duration-200 ${isSectionCollapsed ? '-rotate-90' : ''}`} />
                      </span>
                      <span className="truncate font-semibold text-foreground">
                        {section.title}
                      </span>
                      {section.bgAsset && (
                        <span className="flex shrink-0 items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-500">
                          <Image className="size-2.5" />
                          {section.bgAsset}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{section.dialogueCount} 句对白 · {section.items.length} 条指令</span>
                      {isSectionCollapsed && (
                        <span className="rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          已折叠
                        </span>
                      )}
                      {onJumpToIndex && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onJumpToIndex(section.firstIndex);
                          }}
                          className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-primary/20 hover:text-primary group-hover:opacity-100"
                          title="跳到本节开头运行"
                          aria-label={`跳到${section.title}开头运行`}
                        >
                          <Play className="ml-0.5 size-2.5 fill-current" />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {!isSectionCollapsed && (
                  <div className={isCompact ? 'space-y-1' : 'space-y-6'}>
                    {section.items.map(({ node, index }) => {
                      if (absorbedIds.has(node.id)) return null;
                      const Icon = commandIconFor(node.type);
                      const continuationLines = continuationsByHead.get(node.id);
                      const selected = selectedNode?.id === node.id
                        || (continuationLines?.some((c) => c.id === selectedNode?.id) ?? false);
                      const isDialogue = node.type === 'dialogue';
                      const isBackground = node.type === 'changeBg';
                      const isBranch = node.type === 'choose';
                      const tag = isBackground ? 'BG_LOAD' : isDialogue ? 'TEXT_CMD' : isBranch ? 'BRANCH_LOGIC' : node.type.toUpperCase();
                      const tagClass = categoryTagClass[getCommandCategory(node.type)];
                      const ownChar = node.character?.trim();
                      const displayCharacter = isDialogue ? (ownChar || effectiveSpeakers.get(node.id) || '') : '';
                      const characterInherited = isDialogue && !ownChar && !!displayCharacter;
                      const charColor = isDialogue && displayCharacter && characterColors?.[displayCharacter]
                        ? characterColors[displayCharacter]
                        : undefined;

                      return (
                        <Fragment key={node.id}>
                          {onInsertNode && (
                            <InsertZone atIndex={index} onInsert={onInsertNode} compact={isCompact} />
                          )}
                          {isCompact ? (
                            <ScriptCommandCompactRow
                              node={node}
                              index={index}
                              displayIndex={index}
                              selected={selected}
                              Icon={Icon}
                              tag={tag}
                              tagClass={tagClass}
                              isDialogue={isDialogue}
                              isBackground={isBackground}
                              isBranch={isBranch}
                              charColor={charColor}
                              displayCharacter={displayCharacter}
                              characterInherited={characterInherited}
                              continuationLines={continuationLines}
                              selectedNodeId={selectedNode?.id}
                              onSelectNode={onSelectNode}
                              onInsertNode={onInsertNode}
                              onDeleteNode={onDeleteNode}
                              onCopyNode={onCopyNode}
                              onCutNode={onCutNode}
                              onPasteNode={onPasteNode}
                              onReorderNodes={onReorderNodes}
                              onJumpToIndex={onJumpToIndex}
                              onCreateUnlockNode={onCreateUnlockNode}
                              clipboardNode={clipboardNode}
                              query={query}
                              characters={characters}
                              projectPath={projectPath}
                            />
                          ) : (
                            <ScriptCommandCard
                              node={node}
                              index={index}
                              displayIndex={index}
                              selected={selected}
                              Icon={Icon}
                              tag={tag}
                              tagClass={tagClass}
                              isDialogue={isDialogue}
                              isBackground={isBackground}
                              isBranch={isBranch}
                              charColor={charColor}
                              displayCharacter={displayCharacter}
                              characterInherited={characterInherited}
                              continuationLines={continuationLines}
                              selectedNodeId={selectedNode?.id}
                              onSelectNode={onSelectNode}
                              onInsertNode={onInsertNode}
                              onDeleteNode={onDeleteNode}
                              onCopyNode={onCopyNode}
                              onCutNode={onCutNode}
                              onPasteNode={onPasteNode}
                              onReorderNodes={onReorderNodes}
                              onJumpToIndex={onJumpToIndex}
                              onCreateUnlockNode={onCreateUnlockNode}
                              clipboardNode={clipboardNode}
                              query={query}
                              characters={characters}
                              projectPath={projectPath}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
        {/* Insert zone at end */}
        {onInsertNode && nodes.length > 0 && (
          <InsertZone atIndex={nodes.length} onInsert={onInsertNode} compact={isCompact} />
        )}
        </div>

        {/* Right-click on empty area → paste at the position nearest the cursor */}
        {areaMenu && clipboardNode && onPasteNode && (
          <div
            className="fixed z-50 min-w-[160px] rounded border border-border bg-surface-container-high p-1 shadow-lg"
            style={{ left: areaMenu.x, top: areaMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs hover:bg-surface-container-low"
              onClick={() => { onPasteNode(areaMenu.atIndex); setAreaMenu(null); }}
            >
              <Clipboard className="h-3.5 w-3.5" />
              粘贴到{areaMenu.atIndex < 0
                ? '开头'
                : areaMenu.atIndex >= nodes.length - 1
                  ? '末尾'
                  : `第 ${areaMenu.atIndex + 1} 句后`}
            </button>
          </div>
        )}

      </div>
      )}
    </section>
  );
}
