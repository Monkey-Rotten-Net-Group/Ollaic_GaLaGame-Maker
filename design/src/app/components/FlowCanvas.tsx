import { useRef, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDrag, useDrop } from 'react-dnd';
import {
  MessageCircle, GitBranch, Image as ImageIcon, User, Music, Film, Tag,
  ArrowRight, Type, Monitor, Variable, Keyboard, Wand2, Move, Award,
  GripVertical, ArrowDown, Copy, Scissors, Trash2, Clipboard,
} from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from '../lib/webgal-types';
import { commandLabels } from '../lib/webgal-types';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';

interface FlowCanvasProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onReorderNodes: (fromIndex: number, toIndex: number) => void;
  characterColors?: Record<string, string>;
  onDeleteNode?: (id: string) => void;
  onCopyNode?: (node: WebGalNode) => void;
  onCutNode?: (node: WebGalNode) => void;
  onPasteNode?: (atIndex: number) => void;
  clipboardNode?: WebGalNode | null;
}

const DND_ITEM = 'flow-node';

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

const typeColors: Partial<Record<WebGalCommandType, string>> = {
  dialogue: 'border-accent bg-accent/5',
  narrator: 'border-accent bg-accent/5',
  intro: 'border-accent bg-accent/5',
  choose: 'border-primary bg-primary/5',
  changeBg: 'border-chart-5 bg-chart-5/5',
  changeFigure: 'border-chart-5 bg-chart-5/5',
  miniAvatar: 'border-chart-5 bg-chart-5/5',
  changeScene: 'border-blue-400 bg-blue-400/5',
  callScene: 'border-blue-400 bg-blue-400/5',
  end: 'border-blue-400 bg-blue-400/5',
  bgm: 'border-purple-400 bg-purple-400/5',
  playEffect: 'border-purple-400 bg-purple-400/5',
  playVideo: 'border-purple-400 bg-purple-400/5',
  label: 'border-yellow-400 bg-yellow-400/5',
  jumpLabel: 'border-yellow-400 bg-yellow-400/5',
  setVar: 'border-yellow-400 bg-yellow-400/5',
  setTextbox: 'border-yellow-400 bg-yellow-400/5',
  getUserInput: 'border-yellow-400 bg-yellow-400/5',
  setAnimation: 'border-primary bg-primary/5',
  setTransform: 'border-primary bg-primary/5',
  unlockCg: 'border-primary bg-primary/5',
  unlockBgm: 'border-primary bg-primary/5',
  comment: 'border-muted bg-muted/5',
};

const TERMINAL_TYPES = new Set<WebGalCommandType>([
  'choose', 'changeScene', 'end', 'jumpLabel',
]);

function getNodeSummary(node: WebGalNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.content || '(空对话)';
    case 'narrator':
      return node.content || '(空旁白)';
    case 'changeBg':
      return node.asset || node.content || 'none';
    case 'changeFigure':
      return `${node.asset || node.content || 'none'}${node.figurePosition && node.figurePosition !== 'center' ? ` [${node.figurePosition}]` : ''}`;
    case 'choose':
      return node.choices?.map(c => c.text).join(' | ') || '';
    case 'changeScene':
    case 'callScene':
      return `→ ${node.targetScene || node.content}`;
    case 'label':
      return `# ${node.labelName || node.content}`;
    case 'jumpLabel':
      return `→ ${node.labelName || node.content}`;
    case 'setVar':
      return node.varName ? `${node.varName} = ${node.varValue}` : node.content;
    case 'intro':
      return node.introLines?.join(' | ') || node.content;
    case 'bgm':
    case 'playEffect':
      return node.asset || node.content || 'none';
    case 'setAnimation':
      return `${node.animationName || node.content}${node.animationTarget ? ` → ${node.animationTarget}` : ''}`;
    case 'comment':
      return node.content;
    case 'end':
      return '场景结束';
    default:
      return node.content || '—';
  }
}

interface DragItem {
  index: number;
  id: string;
}

interface FlowNodeCardProps {
  node: WebGalNode;
  index: number;
  isLast: boolean;
  isSelected: boolean;
  characterColors?: Record<string, string>;
  onSelect: (node: WebGalNode) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  canPaste?: boolean;
}

function FlowNodeCard({
  node, index, isLast, isSelected, characterColors, onSelect, onReorder,
  onDelete, onCopy, onCut, onPaste, canPaste,
}: FlowNodeCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLSpanElement>(null);
  const [gripMenuOpen, setGripMenuOpen] = useState(false);
  const Icon = commandIcons[node.type] || Type;
  const colors = typeColors[node.type] || 'border-border bg-card/50';
  const terminal = TERMINAL_TYPES.has(node.type);

  const [{ handlerId, isOver }, drop] = useDrop<
    DragItem,
    void,
    { handlerId: string | symbol | null; isOver: boolean }
  >({
    accept: DND_ITEM,
    collect: (monitor) => ({
      handlerId: monitor.getHandlerId(),
      isOver: monitor.isOver({ shallow: true }),
    }),
    hover(item, monitor) {
      if (!ref.current) return;
      const dragIndex = item.index;
      const hoverIndex = index;
      if (dragIndex === hoverIndex) return;
      const rect = ref.current.getBoundingClientRect();
      const hoverMidY = (rect.bottom - rect.top) / 2;
      const offset = monitor.getClientOffset();
      if (!offset) return;
      const hoverClientY = offset.y - rect.top;
      if (dragIndex < hoverIndex && hoverClientY < hoverMidY) return;
      if (dragIndex > hoverIndex && hoverClientY > hoverMidY) return;
      onReorder(dragIndex, hoverIndex);
      item.index = hoverIndex;
    },
  });

  const [{ isDragging }, drag, dragPreview] = useDrag({
    type: DND_ITEM,
    item: (): DragItem => ({ index, id: node.id }),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  drag(gripRef);
  dragPreview(drop(ref));

  const menuItems = (
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
    <div className="flex flex-col items-center w-full">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            data-node-item="true"
            data-handler-id={handlerId}
            onClick={() => onSelect(node)}
            className={`
              group relative w-[360px] max-w-full transition-all
              ${isDragging ? 'opacity-30' : 'opacity-100'}
              ${isOver && !isDragging ? 'scale-[1.01]' : ''}
            `}
          >
            <div
              className={`
                px-4 py-3 rounded-lg border backdrop-blur-sm transition-all
                ${colors}
                ${isSelected
                  ? 'border-primary shadow-[0_0_20px_rgba(212,165,116,0.25)] ring-1 ring-primary/40'
                  : 'hover:border-primary/40'
                }
              `}
            >
              <div className="flex items-center gap-2.5 mb-1.5">
                <Popover open={gripMenuOpen} onOpenChange={setGripMenuOpen}>
                  <PopoverTrigger asChild>
                    <span
                      ref={gripRef}
                      onClick={(e) => { e.stopPropagation(); setGripMenuOpen(true); }}
                      className="p-1 rounded text-muted-foreground/60 group-hover:text-foreground/80 hover:!text-foreground transition-colors cursor-grab active:cursor-grabbing shrink-0"
                      title="拖动调整顺序，单击打开菜单"
                      aria-label="节点操作"
                    >
                      <GripVertical className="w-4 h-4" />
                    </span>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="right" sideOffset={4} className="w-32 p-1">
                    <button type="button" onClick={(e) => { e.stopPropagation(); onCopy?.(); setGripMenuOpen(false); }}
                      className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors flex items-center gap-2">
                      <Copy className="w-3.5 h-3.5 shrink-0" /> 复制
                    </button>
                    <button type="button" onClick={(e) => { e.stopPropagation(); onCut?.(); setGripMenuOpen(false); }}
                      className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors flex items-center gap-2">
                      <Scissors className="w-3.5 h-3.5 shrink-0" /> 剪切
                    </button>
                    <button type="button" onClick={(e) => { e.stopPropagation(); onPaste?.(); setGripMenuOpen(false); }}
                      disabled={!canPaste}
                      className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
                      <Clipboard className="w-3.5 h-3.5 shrink-0" /> 粘贴
                    </button>
                    <div className="my-1 border-t border-border" />
                    <button type="button" onClick={(e) => { e.stopPropagation(); onDelete?.(); setGripMenuOpen(false); }}
                      className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-destructive/20 text-destructive transition-colors flex items-center gap-2">
                      <Trash2 className="w-3.5 h-3.5 shrink-0" /> 删除
                    </button>
                  </PopoverContent>
                </Popover>

                <div className={`p-1.5 rounded ${isSelected ? 'bg-primary/20' : 'bg-background/50'}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono-family flex items-center gap-1.5">
                    <span className="opacity-50">#{index + 1}</span>
                    <span>{commandLabels[node.type]}</span>
                  </div>
                </div>
                {node.type === 'dialogue' && node.character && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 flex items-center gap-1 bg-accent/20 text-accent"
                    style={characterColors?.[node.character] ? {
                      backgroundColor: `${characterColors[node.character]}20`,
                      color: characterColors[node.character],
                    } : undefined}
                  >
                    {characterColors?.[node.character] && (
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: characterColors[node.character] }}
                      />
                    )}
                    {node.character}
                  </span>
                )}
              </div>

              <p className="text-sm text-foreground/80 line-clamp-2 font-body-family pl-1">
                {getNodeSummary(node) || '(空)'}
              </p>

              {node.type === 'choose' && node.choices && node.choices.length > 0 && (
                <div className="mt-2 space-y-1">
                  {node.choices.map((choice, idx) => (
                    <div key={idx} className="text-xs px-2 py-1 rounded bg-primary/10 text-primary/80 truncate">
                      → {choice.text}{choice.target ? ` → ${choice.target}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-32">
          {menuItems}
        </ContextMenuContent>
      </ContextMenu>

      {!isLast && (
        <div className="flex flex-col items-center my-1 h-6 select-none" data-connector-index={index}>
          {terminal ? (
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-mono-family">
              · · ·
            </span>
          ) : (
            <>
              <div className="w-px flex-1 bg-gradient-to-b from-primary/40 to-primary/60" />
              <ArrowDown className="w-3 h-3 text-primary/70 -mt-0.5" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function FlowCanvas({
  nodes, selectedNode, onSelectNode, onReorderNodes, characterColors,
  onDeleteNode, onCopyNode, onCutNode, onPasteNode, clipboardNode,
}: FlowCanvasProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
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

  const handleReorder = useCallback((from: number, to: number) => {
    onReorderNodes(from, to);
  }, [onReorderNodes]);

  useEffect(() => {
    if (!selectedNode || !scrollRef.current) return;
    const card = cardRefs.current[selectedNode.id];
    const container = scrollRef.current;
    if (!card) return;

    const cardTop = card.offsetTop;
    const cardBottom = cardTop + card.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (cardTop < viewTop || cardBottom > viewBottom) {
      container.scrollTop = Math.max(0, cardTop - container.clientHeight / 2 + card.offsetHeight / 2);
    }
  }, [selectedNode?.id]);

  return (
    <div
      className="flex-1 relative overflow-hidden bg-background/50"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-node-item]')) return;
        e.preventDefault();
        const connectorEl = (e.target as HTMLElement).closest('[data-connector-index]');
        let atIndex: number;
        if (connectorEl) {
          atIndex = Number((connectorEl as HTMLElement).dataset.connectorIndex);
        } else {
          // Find nearest gap by mouse Y position
          atIndex = -1;
          for (let i = 0; i < nodes.length; i++) {
            const el = cardRefs.current[nodes[i].id];
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (e.clientY > rect.top + rect.height / 2) atIndex = i;
            else break;
          }
        }
        setAreaMenu({
          x: Math.min(e.clientX, window.innerWidth - 148),
          y: Math.min(e.clientY, window.innerHeight - 72),
          atIndex,
        });
      }}
    >
      <div className="absolute inset-0 opacity-30 flow-grid" />
      <div className="absolute top-0 left-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-96 h-96 bg-accent/5 rounded-full blur-3xl pointer-events-none" />

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
      <div ref={scrollRef} className="relative size-full overflow-auto scroll-pb-32">
        <div className="min-h-full flex flex-col items-center px-6 pt-10 pb-32">
          {nodes.length === 0 ? (
            <div className="m-auto text-center">
              <div className="text-5xl mb-4 opacity-20">📖</div>
              <p className="text-lg text-muted-foreground mb-2 font-display-family">
                开始编织你的故事
              </p>
              <p className="text-sm text-muted-foreground">
                从左侧添加 WebGAL 指令，或导入 .txt 场景文件
              </p>
            </div>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-mono-family mb-4">
                ▼ 起点
              </div>
              <div className="flex flex-col items-center w-full max-w-md">
                {nodes.map((node, index) => (
                  <div key={node.id} ref={(el) => { cardRefs.current[node.id] = el; }} className="w-full">
                    <FlowNodeCard
                      node={node}
                      index={index}
                      isLast={index === nodes.length - 1}
                      isSelected={selectedNode?.id === node.id}
                      characterColors={characterColors}
                      onSelect={onSelectNode}
                      onReorder={handleReorder}
                      onDelete={() => onDeleteNode?.(node.id)}
                      onCopy={() => onCopyNode?.(node)}
                      onCut={() => onCutNode?.(node)}
                      onPaste={() => onPasteNode?.(index)}
                      canPaste={Boolean(clipboardNode)}
                    />
                  </div>
                ))}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-mono-family mt-4 mb-16">
                ▲ 终点
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
