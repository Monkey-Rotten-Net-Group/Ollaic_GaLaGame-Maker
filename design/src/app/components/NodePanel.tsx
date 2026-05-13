import { useState } from 'react';
import {
  MessageCircle, GitBranch, Image as ImageIcon, User, Music, Film, Tag,
  ArrowRight, Type, Monitor, Variable, Keyboard, Wand2, Move, Award, ChevronDown, ChevronRight,
  Play,
} from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from '../lib/webgal-types';
import { commandCategories, commandLabels, categoryLabels } from '../lib/webgal-types';

interface NodePanelProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onAddNode: (type: WebGalCommandType) => void;
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

export function NodePanel({ nodes, selectedNode, onSelectNode, onAddNode, characterColors, onJumpToIndex }: NodePanelProps) {
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
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {nodes.map((node, index) => {
          const Icon = commandIcons[node.type] || Type;
          const isSelected = selectedNode?.id === node.id;
          const color = typeColorMap[node.type] || 'text-muted-foreground';

          return (
            <div
              key={node.id}
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
          );
        })}
      </div>

        <div className="p-3 border-t border-border">
        <div className="text-xs text-muted-foreground font-mono-family">
          共 {nodes.length} 条指令
        </div>
      </div>
    </div>
  );
}
