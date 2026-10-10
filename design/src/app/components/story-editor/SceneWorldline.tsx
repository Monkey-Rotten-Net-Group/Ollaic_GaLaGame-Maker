import { useEffect, useState } from 'react';
import {
  ArrowRight, BookOpen, FileText, FolderOpen, GitBranch, Maximize2, Minimize2, Play, Plus,
  Trash2, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { SceneHeader } from '../../lib/webgal-ipc';
import type { SceneLink, WebGalNode } from '../../lib/webgal-types';
import { isMetadataComment } from '../../lib/webgal-types';
import { SceneGraph } from '../SceneGraph';
import { commandIconFor, commandToneFor, getCommandSummary } from './command-presentation';

interface SceneWorldlinePanelProps {
  scenes: string[];
  currentSceneName: string;
  sceneHeaders: Record<string, SceneHeader>;
  sceneLinkMap: Record<string, SceneLink[]>;
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onOpenScene: (sceneName: string) => void;
  onOpenSceneManager?: () => void;
  characterColors?: Record<string, string>;
  onDeleteNode?: (nodeId: string) => void;
  onJumpToIndex?: (index: number) => void;
  onNewScene?: () => void;
  onRenameScene?: (sceneName: string) => void;
  onDeleteScene?: (sceneName: string) => void;
  onEnlargePreview?: () => void;
}

interface FullScreenWorldlineProps {
  scenes: string[];
  currentSceneName: string;
  sceneHeaders: Record<string, SceneHeader>;
  sceneLinkMap: Record<string, SceneLink[]>;
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onOpenScene: (sceneName: string) => void;
  onClose: () => void;
  characterColors?: Record<string, string>;
  onNewScene?: () => void;
  onDeleteScene?: (sceneName: string) => void;
  onRenameScene?: (sceneName: string) => void;
  onOpenSceneManager?: () => void;
  onDeleteNode?: (nodeId: string) => void;
  onJumpToIndex?: (index: number) => void;
}

export function FullScreenWorldline({
  scenes,
  currentSceneName,
  sceneHeaders,
  sceneLinkMap,
  nodes,
  selectedNode,
  onSelectNode,
  onOpenScene,
  onClose,
  characterColors,
  onNewScene,
  onDeleteScene,
  onRenameScene,
  onOpenSceneManager,
  onDeleteNode,
  onJumpToIndex,
}: FullScreenWorldlineProps) {
  const visibleNodes = nodes.filter((node) => !isMetadataComment(node) && (node.type !== 'comment' || node.content?.trim()));
  const [ctxMenu, setCtxMenu] = useState<{ sceneName: string; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  // Escape key to exit enlarged view
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="flex h-full flex-col bg-surface-container-lowest">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface-container-low px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-foreground transition-colors"
            aria-label="返回脚本流"
          >
            <ArrowRight className="h-4 w-4 rotate-180" />
            返回脚本流
          </button>
          <div className="h-5 w-px bg-border/60" />
          <span className="flex items-center gap-2 font-mono-family text-xs font-semibold uppercase tracking-widest text-on-surface-variant">
            <GitBranch className="h-4 w-4 text-secondary" /> 场景关系图 · 放大预览
          </span>
          <span className="rounded bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
            {scenes.length} 场景
          </span>
          {onNewScene && (
            <button
              type="button"
              onClick={onNewScene}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-primary transition-colors"
              title="新建场景"
            >
              <Plus className="h-3.5 w-3.5" />
              新建
            </button>
          )}
          {onOpenSceneManager && (
            <button
              type="button"
              onClick={onOpenSceneManager}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-foreground transition-colors"
              title="场景管理"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              管理
            </button>
          )}
        </div>

        {/* Zoom controls and exit button */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
            className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground"
            title="缩小视图"
            aria-label="缩小视图"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="rounded px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-surface-container-high hover:text-foreground transition-colors"
            title="重置缩放 (100%)"
            aria-label="重置缩放"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2, +(z + 0.15).toFixed(2)))}
            className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground"
            title="放大视图"
            aria-label="放大视图"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-4 w-px bg-border/60" />
          <button
            type="button"
            onClick={onClose}
            className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground"
            title="退出放大预览 (Esc)"
            aria-label="退出放大预览"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Static relationship graph (non-draggable) */}
        <div className="relative flex-1 overflow-auto bg-surface-container-low">
          <div className="absolute inset-0 opacity-60 flow-grid pointer-events-none" />
          <div
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'top center',
              transition: 'transform 100ms ease-out',
            }}
            className="w-full"
          >
            <SceneGraph
              scenes={scenes}
              currentSceneName={currentSceneName}
              sceneLinkMap={sceneLinkMap}
              sceneHeaders={sceneHeaders}
              onSwitchScene={onOpenScene}
              onNodeContextMenu={(name, e) => setCtxMenu({ sceneName: name, x: e.clientX, y: e.clientY })}
              graphWidth={520}
              className="relative z-10 w-full px-8 py-8"
            />
          </div>

          {/* Right-click context menu on nodes */}
          {ctxMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />
              <div
                className="fixed z-50 min-w-[160px] rounded border border-border bg-surface-container-high p-1 shadow-lg"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
              >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs hover:bg-surface-container-low"
                onClick={() => { onOpenScene(ctxMenu.sceneName); setCtxMenu(null); }}
              >
                <BookOpen className="h-3.5 w-3.5" />
                切换到此场景
              </button>
              {onRenameScene && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs hover:bg-surface-container-low"
                  onClick={() => { onRenameScene(ctxMenu.sceneName); setCtxMenu(null); }}
                >
                  <FileText className="h-3.5 w-3.5" />
                  重命名
                </button>
              )}
              {onDeleteScene && ctxMenu.sceneName !== currentSceneName && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-error hover:bg-error/10"
                  onClick={() => { onDeleteScene(ctxMenu.sceneName); setCtxMenu(null); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除场景
                </button>
              )}
              <div className="my-0.5 h-px bg-border/50" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-container-low"
                onClick={() => setCtxMenu(null)}
              >
                关闭
              </button>
            </div>
            </>
          )}
        </div>

        {/* Right sidebar: node index */}
        <div className="flex w-72 shrink-0 flex-col border-l border-border bg-surface-container-lowest">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">当前场景索引</span>
            <span className="font-mono-family text-[10px] text-muted-foreground">{visibleNodes.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleNodes.map((node, index) => {
              const Icon = commandIconFor(node.type);
              const sel = selectedNode?.id === node.id;
              const charColor = node.type === 'dialogue' && node.character && characterColors?.[node.character]
                ? characterColors[node.character]
                : undefined;
              const nodeIndex = nodes.indexOf(node);
              return (
                <div
                  key={node.id}
                  className="group flex items-start border-l-2 transition-colors hover:bg-surface-container-low"
                  style={{ borderColor: sel ? 'var(--color-secondary)' : 'transparent' }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectNode(node)}
                    className={`flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left ${sel ? 'bg-surface-container-low' : ''}`}
                  >
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${commandToneFor(node.type)}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono-family text-[10px] text-muted-foreground">{index + 1} {node.type}</span>
                      <span className="block truncate text-xs text-on-surface">{getCommandSummary(node)}</span>
                    </span>
                    {charColor && (
                      <span className="ml-auto mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: charColor }} />
                    )}
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 pr-1 pt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {onJumpToIndex && (
                      <button
                        type="button"
                        onClick={() => onJumpToIndex(nodeIndex)}
                        className="rounded p-1 text-muted-foreground hover:text-primary hover:bg-primary/10"
                        title="运行到此处"
                        aria-label="运行到此处"
                      >
                        <Play className="h-3 w-3" />
                      </button>
                    )}
                    {onDeleteNode && (
                      <button
                        type="button"
                        onClick={() => onDeleteNode(node.id)}
                        className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="删除"
                        aria-label="删除节点"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SceneWorldlinePanel({
  scenes,
  currentSceneName,
  sceneHeaders,
  sceneLinkMap,
  nodes,
  selectedNode,
  onSelectNode,
  onOpenScene,
  onOpenSceneManager,
  characterColors,
  onDeleteNode,
  onJumpToIndex,
  onNewScene,
  onRenameScene,
  onDeleteScene,
  onEnlargePreview,
}: SceneWorldlinePanelProps) {
  const visibleNodes = nodes.filter((node) => !isMetadataComment(node) && (node.type !== 'comment' || node.content?.trim()));
  const [ctxMenu, setCtxMenu] = useState<{ sceneName: string; x: number; y: number } | null>(null);

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-surface-container-lowest">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex items-center gap-1.5 font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant truncate">
            <GitBranch className="h-3 w-3 text-secondary shrink-0" /> 场景关系图
          </span>
          <span className="rounded bg-secondary/10 px-1.5 py-0.5 font-mono text-[9px] text-secondary shrink-0">
            {scenes.length}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onNewScene && (
            <button
              type="button"
              onClick={onNewScene}
              className="ollaic-icon-button h-6 w-6"
              aria-label="新建场景"
              title="新建场景"
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
          {onOpenSceneManager && (
            <button
              type="button"
              onClick={onOpenSceneManager}
              className="ollaic-icon-button h-6 w-6"
              aria-label="场景管理"
              title="场景管理"
            >
              <FolderOpen className="h-3 w-3" />
            </button>
          )}
          {onEnlargePreview && (
            <button
              type="button"
              onClick={onEnlargePreview}
              className="ollaic-icon-button h-6 w-6"
              aria-label="放大预览"
              title="放大预览"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        <SceneGraph
          scenes={scenes}
          currentSceneName={currentSceneName}
          sceneLinkMap={sceneLinkMap}
          sceneHeaders={sceneHeaders}
          onSwitchScene={onOpenScene}
          onNodeContextMenu={(name, e) => setCtxMenu({ sceneName: name, x: e.clientX, y: e.clientY })}
          fitToWidth={false}
          className="h-72 shrink-0 border-b border-border bg-surface-container-low p-2"
        />

        {/* Right-click context menu on nodes */}
        {ctxMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />
            <div
              className="fixed z-50 min-w-[160px] rounded border border-border bg-surface-container-high p-1 shadow-lg"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs hover:bg-surface-container-low"
                onClick={() => { onOpenScene(ctxMenu.sceneName); setCtxMenu(null); }}
              >
                <BookOpen className="h-3.5 w-3.5" />
                切换到此场景
              </button>
              {onRenameScene && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs hover:bg-surface-container-low"
                  onClick={() => { onRenameScene(ctxMenu.sceneName); setCtxMenu(null); }}
                >
                  <FileText className="h-3.5 w-3.5" />
                  重命名
                </button>
              )}
              {onDeleteScene && ctxMenu.sceneName !== currentSceneName && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-error hover:bg-error/10"
                  onClick={() => { onDeleteScene(ctxMenu.sceneName); setCtxMenu(null); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除场景
                </button>
              )}
              <div className="my-0.5 h-px bg-border/50" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-container-low"
                onClick={() => setCtxMenu(null)}
              >
                关闭
              </button>
            </div>
          </>
        )}
      </div>

      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <span className="font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">当前场景索引</span>
        <span className="font-mono-family text-[10px] text-muted-foreground">{visibleNodes.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleNodes.map((node, index) => {
          const Icon = commandIconFor(node.type);
          const selected = selectedNode?.id === node.id;
          const charColor = node.type === 'dialogue' && node.character && characterColors?.[node.character]
            ? characterColors[node.character]
            : undefined;
          const nodeIndex = nodes.indexOf(node);
          return (
            <div
              key={node.id}
              className="group flex items-start border-l-2 transition-colors hover:bg-surface-container-low"
              style={{ borderColor: selected ? 'var(--color-secondary)' : 'transparent' }}
            >
              <button
                type="button"
                onClick={() => onSelectNode(node)}
                className={`flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left ${
                  selected ? 'bg-surface-container-low' : ''
                }`}
              >
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${commandToneFor(node.type)}`} />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono-family text-[10px] text-muted-foreground">{index + 1} {node.type}</span>
                  <span className="block truncate text-xs text-on-surface">{getCommandSummary(node)}</span>
                </span>
                {charColor && (
                  <span className="ml-auto mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: charColor }} />
                )}
              </button>
              <div className="flex shrink-0 items-center gap-0.5 pr-1 pt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {onJumpToIndex && (
                  <button
                    type="button"
                    onClick={() => onJumpToIndex(nodeIndex)}
                    className="rounded p-1 text-muted-foreground hover:text-primary hover:bg-primary/10"
                    title="运行到此处"
                    aria-label="运行到此处"
                  >
                    <Play className="h-3 w-3" />
                  </button>
                )}
                {onDeleteNode && (
                  <button
                    type="button"
                    onClick={() => onDeleteNode(node.id)}
                    className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    title="删除"
                    aria-label="删除节点"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
