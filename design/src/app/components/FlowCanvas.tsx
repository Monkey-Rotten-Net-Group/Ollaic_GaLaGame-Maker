import { useRef, useCallback } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import {
  MessageCircle, GitBranch, Image as ImageIcon, User, Music, Film, Tag,
  ArrowRight, Type, Monitor, Variable, Keyboard, Wand2, Move, Award,
  GripVertical, ArrowDown,
} from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from '../lib/webgal-types';
import { commandLabels } from '../lib/webgal-types';

interface FlowCanvasProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onReorderNodes: (fromIndex: number, toIndex: number) => void;
  characterColors?: Record<string, string>;
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
}

function FlowNodeCard({
  node, index, isLast, isSelected, characterColors, onSelect, onReorder,
}: FlowNodeCardProps) {
  const ref = useRef<HTMLDivElement>(null);
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

  const [{ isDragging }, drag] = useDrag({
    type: DND_ITEM,
    item: (): DragItem => ({ index, id: node.id }),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  drag(drop(ref));

  return (
    <div className="flex flex-col items-center w-full">
      <div
        ref={ref}
        data-handler-id={handlerId}
        onClick={() => onSelect(node)}
        className={`
          group relative w-[360px] max-w-full transition-all
          ${isDragging ? 'opacity-30' : 'opacity-100'}
          ${isOver && !isDragging ? 'scale-[1.01]' : ''}
        `}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
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
            <span
              className="p-1 rounded text-muted-foreground/60 group-hover:text-foreground/80 transition-colors"
              title="拖动整张卡片调整顺序"
              aria-hidden="true"
            >
              <GripVertical className="w-4 h-4" />
            </span>
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

      {!isLast && (
        <div className="flex flex-col items-center my-1 h-6 select-none">
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
}: FlowCanvasProps) {
  const handleReorder = useCallback((from: number, to: number) => {
    onReorderNodes(from, to);
  }, [onReorderNodes]);

  return (
    <div className="flex-1 relative overflow-hidden bg-background/50">
      <div className="absolute inset-0 opacity-30 flow-grid" />
      <div className="absolute top-0 left-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-96 h-96 bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative size-full overflow-auto">
        <div className="min-h-full flex flex-col items-center px-6 py-10">
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
                  <FlowNodeCard
                    key={node.id}
                    node={node}
                    index={index}
                    isLast={index === nodes.length - 1}
                    isSelected={selectedNode?.id === node.id}
                    characterColors={characterColors}
                    onSelect={onSelectNode}
                    onReorder={handleReorder}
                  />
                ))}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-mono-family mt-4">
                ▲ 终点
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
