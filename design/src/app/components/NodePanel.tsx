import { Fragment, useState } from 'react';
import {
  MessageCircle, GitBranch, Image as ImageIcon, User, Music, Film, Tag,
  ArrowRight, Type, Monitor, Variable, Keyboard, Wand2, Move, Award, ChevronDown, ChevronRight,
  Play, Plus,
} from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from '../lib/webgal-types';
import { commandCategories, commandLabels, categoryLabels } from '../lib/webgal-types';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

interface NodePanelProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onAddNode: (type: WebGalCommandType) => void;
  /** Insert a node at a specific position (0 = before first, nodes.length = append). */
  onInsertNode?: (type: WebGalCommandType, atIndex: number) => void;
  characterColors?: Record<string, string>;
  /** Called when the user clicks "执行到此句" on the node at `index` (0-based). */
  onJumpToIndex?: (index: number) => void;
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

function InsertZone({
  atIndex,
  onInsert,
}: {
  atIndex: number;
  onInsert: (type: WebGalCommandType, atIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`在位置 ${atIndex + 1} 插入指令`}
          className={`group/zone relative w-full flex items-center justify-center cursor-pointer transition-all overflow-visible ${
            open ? 'h-7' : 'h-1.5 hover:h-7'
          }`}
        >
          <div
            className={`absolute inset-x-2 top-1/2 -translate-y-1/2 h-px bg-border transition-opacity ${
              open ? 'opacity-100' : 'opacity-0 group-hover/zone:opacity-100'
            }`}
          />
          <div
            className={`relative z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/40 text-[10px] transition-opacity ${
              open ? 'opacity-100' : 'opacity-0 group-hover/zone:opacity-100'
            }`}
          >
            <Plus className="w-3 h-3" />
            <span className="font-mono-family">插入</span>
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

export function NodePanel({ nodes, selectedNode, onSelectNode, onAddNode, onInsertNode, characterColors, onJumpToIndex }: NodePanelProps) {
  const [expandedCat, setExpandedCat] = useState<string | null>(null);

  return (
    <div className="w-64 border-r border-border bg-card/30 backdrop-blur-sm flex flex-col">
      {/* Add Node - categorized */}
      <div className="p-3 border-b border-border">
        <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-2 font-mono-family">
          添加指令
        </h3>
        <div className="space-y-1">
          {Object.entries(commandCategories).map(([catKey, types]) => (
            <div key={catKey}>
              <button
                onClick={() => setExpandedCat(expandedCat === catKey ? null : catKey)}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded text-xs hover:bg-secondary/50 transition-colors"
                aria-label={`${expandedCat === catKey ? '收起' : '展开'} ${categoryLabels[catKey]}`}
              >
                <span className="font-medium">{categoryLabels[catKey]}</span>
                {expandedCat === catKey
                  ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                  : <ChevronRight className="w-3 h-3 text-muted-foreground" />
                }
              </button>
              {expandedCat === catKey && (
                <div className="grid grid-cols-2 gap-1 mt-1 mb-2 pl-1">
                  {types.map((type) => {
                    const Icon = commandIcons[type] || Type;
                    return (
                      <button
                        key={type}
                        onClick={() => onAddNode(type)}
                        className={`p-1.5 rounded border border-border transition-all flex items-center gap-1.5 group text-xs ${categoryColors[catKey]}`}
                        aria-label={`添加 ${commandLabels[type]}`}
                      >
                        <Icon className="w-3 h-3 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                        <span className="truncate">{commandLabels[type]}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Node List */}
      <div className="flex-1 overflow-y-auto p-2">
        {nodes.map((node, index) => {
          const Icon = commandIcons[node.type] || Type;
          const isSelected = selectedNode?.id === node.id;
          const color = typeColorMap[node.type] || 'text-muted-foreground';

          return (
            <Fragment key={node.id}>
              {onInsertNode && (
                <InsertZone atIndex={index} onInsert={onInsertNode} />
              )}
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelectNode(node)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectNode(node);
                  }
                }}
                className={`
                  group relative w-full px-2.5 py-2 rounded border transition-all text-left cursor-pointer
                  ${isSelected
                    ? 'border-primary bg-primary/10 shadow-[0_0_12px_rgba(212,165,116,0.15)]'
                    : 'border-transparent hover:border-border hover:bg-secondary/30'
                  }
                `}
              >
                <div className="flex items-start gap-2">
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
                  {onJumpToIndex && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onJumpToIndex(index);
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
            </Fragment>
          );
        })}
        {onInsertNode && (
          <InsertZone atIndex={nodes.length} onInsert={onInsertNode} />
        )}
      </div>

        <div className="p-3 border-t border-border">
        <div className="text-xs text-muted-foreground font-mono-family">
          共 {nodes.length} 条指令
        </div>
      </div>
    </div>
  );
}
