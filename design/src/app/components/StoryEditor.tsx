import { useState, useCallback, useEffect, useRef, useMemo, memo, Fragment } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Image, Search, Plus, Send, X,
  FileText, FolderOpen, Loader2,
  MessageCircle, GitBranch, Users, Music, Wand2, ArrowRight,
  GripVertical, MoreHorizontal, Copy, Trash2, Clipboard, Scissors, Play,
  BookOpen,
  MessageSquarePlus, Pencil, AlertCircle,
} from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AppSettingsDialog, loadAppSettings } from './AppSettingsDialog';
import { ProjectMetadataDialog, type ExportTaskState } from './ProjectMetadataDialog';
import { SnapshotManagerDialog } from './SnapshotManagerDialog';
import { SceneManagerPanel } from './SceneManagerPanel';
import type { WebGalNode, WebGalCommandType, SceneLink } from '../lib/webgal-types';
import { extractSceneLinks, commandCategories, commandLabels, categoryLabels, categoryTagClass, getCommandCategory, isMetadataComment } from '../lib/webgal-types';
import {
  parseScene, serializeScene, saveScene, loadScene,
  openProject, getScenePath, createScene,
  exportProject, readProjectMetadata, saveProjectMetadata,
  createProjectSnapshot, listProjectSnapshots, renameProjectSnapshot, deleteProjectSnapshot, restoreProjectSnapshot,
  setRuntimeProject, setRuntimeTemplateDir, getRuntimeUrl, jumpToSentence, openInBrowser,
  readFileText, writeFileText, parseSceneHeader, deleteScene, renameScene,
  type ProjectInfo, type SceneHeader, type ProjectMetadata, type SnapshotInfo,
} from '../lib/webgal-ipc';
import { listCharacters, listCharacterNames } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import { characterColor } from '../lib/character-editing';
import { useAiAgent } from '../hooks/useAiAgent';
import { insertSceneNode, reorderSceneNodes, pasteSceneNode } from '../lib/scene-editing';
import { listAssets, syncSceneVoiceCards } from '../lib/assets-ipc';
import {
  ensureSceneCard,
  extractSceneBackgroundAssets,
  loadAssetMetadata,
  saveAssetMetadata,
  syncSceneCardsFromBackgrounds,
} from '../lib/asset-metadata';
import { AiMemoryPanel } from './AiMemoryPanel';
import { AiMessageBubble } from './AiMessageBubble';
import { ChangeSetCard } from './AiPendingCard';
import { PreviewNodeCard } from './PreviewNodeCard';
import { SceneGraph } from './SceneGraph';
import { figureLabel } from '../lib/node-display';
import { computeFullNodeDiff, type NodeDiffEntry } from '../lib/node-diff';
import type { SceneEdit } from '../lib/change-set';
import { ConflictCard, ErrorCard } from './AiStatusCard';
import { DetailPanel } from './DetailPanel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from './ui/context-menu';
import { StoryOsSideNav, StoryOsTopBar } from './StoryOsChrome';
import { PerformanceTimeline } from './PerformanceTimeline';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// Fixed auto-save cadence (ms). Auto-save is toggled on/off from the top-bar
// switch; there is no user-configurable interval.
const AUTO_SAVE_INTERVAL_MS = 3_000;

const EMPTY_PROJECT_METADATA: ProjectMetadata = {
  synopsis: '',
  description: '',
  coverPath: '',
  tags: [],
  version: '0.1.0',
  releaseNotes: '',
  lastExportDir: '',
};

const IDLE_EXPORT_TASK: ExportTaskState = {
  status: 'idle',
  warnings: [],
  issues: [],
  failureCount: 0,
};

function getCommandSummary(node: WebGalNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.character ? `${node.character}: ${node.content || '(空对白)'}` : node.content || '(空对白)';
    case 'narrator':
      return node.content || '(空旁白)';
    case 'choose':
      return node.choices?.map((choice) => `${choice.text} -> ${choice.target}`).join(' / ') || node.content || '(空选项)';
    case 'changeBg':
    case 'changeFigure':
    case 'miniAvatar':
    case 'bgm':
    case 'playEffect':
    case 'playVideo':
      return node.asset || node.content || '未选择素材';
    case 'changeScene':
    case 'callScene':
      return node.targetScene || node.content || '未选择场景';
    case 'label':
    case 'jumpLabel':
      return node.labelName || node.content || '未命名标签';
    case 'setVar':
      return node.varName ? `${node.varName} = ${node.varValue ?? ''}` : node.content || '未设置变量';
    case 'setAnimation':
      return `${node.animationName || node.content || '未设置动画'}${node.animationTarget ? ` -> ${node.animationTarget}` : ''}`;
    case 'intro':
      return node.introLines?.join(' / ') || node.content || '(空黑屏文字)';
    case 'end':
      return '场景结束';
    default:
      return node.content || '—';
  }
}

/** Shallow equality for a scene's outgoing links — used to skip graph updates
 *  when an edit didn't change any jump/choose target. */
function sceneLinksEqual(a: SceneLink[], b: SceneLink[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].target !== b[i].target || a[i].kind !== b[i].kind || a[i].label !== b[i].label) {
      return false;
    }
  }
  return true;
}

function commandIconFor(type: WebGalCommandType) {
  switch (type) {
    case 'dialogue':
      return MessageCircle;
    case 'choose':
      return GitBranch;
    case 'changeBg':
      return Image;
    case 'changeFigure':
    case 'miniAvatar':
      return Users;
    case 'bgm':
    case 'playEffect':
      return Music;
    case 'setAnimation':
    case 'setTransform':
      return Wand2;
    case 'changeScene':
    case 'callScene':
      return ArrowRight;
    default:
      return FileText;
  }
}

function commandToneFor(type: WebGalCommandType): string {
  switch (type) {
    case 'dialogue':
      return 'text-primary';
    case 'choose':
      return 'text-tertiary';
    case 'changeBg':
      return 'text-secondary';
    case 'bgm':
    case 'playEffect':
      return 'text-tertiary';
    default:
      return 'text-on-surface-variant';
  }
}

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

function FullScreenWorldline({
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

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  return (
    <div className="flex h-full flex-col bg-surface-container-lowest">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface-container-low px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-foreground transition-colors"
            aria-label="返回编辑器"
          >
            <ArrowRight className="h-4 w-4 rotate-180" />
            返回编辑器
          </button>
          <div className="h-5 w-px bg-border/60" />
          <span className="flex items-center gap-2 font-mono-family text-xs font-semibold uppercase tracking-widest text-on-surface-variant">
            <GitBranch className="h-4 w-4 text-secondary" /> 场景关系图 · 全屏
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
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Static relationship graph (non-draggable) */}
        <div className="relative flex-1 overflow-auto bg-surface-container-low">
          <div className="absolute inset-0 opacity-60 flow-grid pointer-events-none" />
          <SceneGraph
            scenes={scenes}
            currentSceneName={currentSceneName}
            sceneLinkMap={sceneLinkMap}
            sceneHeaders={sceneHeaders}
            onSwitchScene={onOpenScene}
            onNodeContextMenu={(name, e) => setCtxMenu({ sceneName: name, x: e.clientX, y: e.clientY })}
            graphWidth={480}
            className="relative z-10 w-full px-8 py-8"
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

function SceneWorldlinePanel({
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
}: SceneWorldlinePanelProps) {
  const visibleNodes = nodes.filter((node) => !isMetadataComment(node) && (node.type !== 'comment' || node.content?.trim()));

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-surface-container-lowest">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <span className="flex items-center gap-1.5 font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
          <GitBranch className="h-3 w-3 text-secondary" /> 场景关系图
        </span>
        {onOpenSceneManager && (
          <button
            type="button"
            onClick={onOpenSceneManager}
            className="story-os-icon-button h-6 w-6"
            aria-label="场景管理"
            title="场景管理"
          >
            <FolderOpen className="h-3 w-3" />
          </button>
        )}
      </div>

      <SceneGraph
        scenes={scenes}
        currentSceneName={currentSceneName}
        sceneLinkMap={sceneLinkMap}
        sceneHeaders={sceneHeaders}
        onSwitchScene={onOpenScene}
        fitToWidth={false}
        className="h-72 shrink-0 border-b border-border bg-surface-container-low p-2"
      />

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

interface AiAssistantPanelProps {
  aiAgent: ReturnType<typeof useAiAgent>;
  projectPath: string | null;
  sceneHeaders: Record<string, SceneHeader>;
  sessionMenuOpen: boolean;
  onSessionMenuOpenChange: (open: boolean) => void;
  onRenameSession: (session: { id: string; title: string }) => void;
  onDeleteSession: (session: { id: string; title: string }) => void;
  onOpenSettings: () => void;
  onSend: (text: string) => void;
}

interface AiInputBoxProps {
  /** Programmatic seed from the agent (prefill on regenerate, clear after send). */
  value: string;
  busy: boolean;
  pending: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}

// Keeps the draft in local state so typing only re-renders this small box,
// not the whole StoryEditor tree (script list, worldline, timeline, ...).
const AiInputBox = memo(function AiInputBox({ value, busy, pending, onSubmit, onStop }: AiInputBoxProps) {
  const [draft, setDraft] = useState(value);
  // Sync when the agent changes input externally (regenerate prefills, send clears).
  useEffect(() => { setDraft(value); }, [value]);

  const submit = () => {
    if (busy) { onStop(); return; }
    const text = draft.trim();
    if (!text || pending) return;
    onSubmit(text);
    setDraft('');
  };

  return (
    <>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        disabled={busy || pending}
        className="mt-3 h-20 w-full resize-none rounded-sm border border-border bg-surface-container-lowest p-2 text-sm focus:border-secondary focus:outline-none focus:ring-2 focus:ring-secondary-container/30 disabled:opacity-60"
        placeholder={busy ? '生成中...' : pending ? '请先同意或拒绝当前 AI 修改...' : '输入你的创作想法...'}
        aria-label="AI 创作输入"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!busy && (!draft.trim() || pending)}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-sm bg-secondary-container/60 py-2 text-sm font-semibold text-black transition-colors hover:bg-secondary-container disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {busy ? '停止' : '发送'}
      </button>
    </>
  );
});

function AiAssistantPanel({
  aiAgent,
  projectPath,
  sceneHeaders,
  sessionMenuOpen,
  onSessionMenuOpenChange,
  onRenameSession,
  onDeleteSession,
  onOpenSettings,
  onSend,
}: AiAssistantPanelProps) {
  const activeSession = aiAgent.sessions.find((session) => session.id === aiAgent.activeId);
  const statusText = aiAgent.busy
    ? '生成中'
    : aiAgent.status === 'pending'
      ? '等待确认'
      : aiAgent.status === 'error'
        ? '需要处理'
        : '等待输入';

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface-container-lowest">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary-container/35 text-[var(--nav-active)]">
            <Wand2 className="h-3.5 w-3.5" />
          </div>
          <span className="truncate text-sm font-semibold text-on-surface" title={activeSession?.title}>
            {activeSession?.title ?? 'AI 创作助手'}
          </span>
          <span className="flex items-center gap-1 font-mono-family text-[10px] text-muted-foreground">
            <span className={`block h-1.5 w-1.5 rounded-full ${aiAgent.busy ? 'bg-primary' : 'bg-tertiary-container'}`} />
            {statusText}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={aiAgent.startNewSession}
            disabled={aiAgent.busy}
            className="story-os-icon-button h-7 w-7 disabled:opacity-40"
            aria-label="新建 AI 会话"
            title="新建会话"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
          <DropdownMenu open={sessionMenuOpen} onOpenChange={onSessionMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={aiAgent.busy}
                className="story-os-icon-button h-7 w-7 text-foreground disabled:opacity-40"
                aria-label="AI 会话管理"
                title="会话管理"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={() => { onSessionMenuOpenChange(false); aiAgent.startNewSession(); }}>
                <MessageSquarePlus className="h-4 w-4" />
                <span>新建会话</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>历史会话</DropdownMenuLabel>
              <div className="max-h-64 overflow-y-auto">
                {aiAgent.sessions.map((session) => (
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { onSessionMenuOpenChange(false); aiAgent.selectSession(session.id); }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSessionMenuOpenChange(false);
                        aiAgent.selectSession(session.id);
                      }
                    }}
                    className={`group flex cursor-pointer items-center gap-1 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-secondary-container/45 ${session.id === aiAgent.activeId ? 'bg-secondary-container/50' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSessionMenuOpenChange(false);
                        onRenameSession(session);
                      }}
                      className="shrink-0 rounded p-0.5 text-foreground opacity-60 hover:bg-secondary-container hover:opacity-100"
                      aria-label="重命名会话"
                      title="重命名"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSessionMenuOpenChange(false);
                        onDeleteSession(session);
                      }}
                      className="shrink-0 rounded p-0.5 text-foreground opacity-60 hover:bg-error-container hover:text-on-error-container hover:opacity-100"
                      aria-label="删除会话"
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {aiAgent.messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <AiMessageBubble
              role={message.role}
              content={message.content}
              steps={message.steps}
              isStreaming={aiAgent.streamingIdRef.current === message.id && aiAgent.busy}
              stopped={message.stopped}
              diff={message.diff}
            />
          </div>
        ))}
        {aiAgent.busy && aiAgent.stepLabel && (
          <div className="flex items-center gap-2 rounded-sm border border-border bg-surface-container-low px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">{aiAgent.stepLabel}</span>
          </div>
        )}
        {aiAgent.pendingChangeSet && aiAgent.status !== 'conflict' && (
          <ChangeSetCard
            changeSet={aiAgent.pendingChangeSet}
            sceneHeaders={sceneHeaders}
            onAccept={() => { void aiAgent.acceptChange(); }}
            onRevert={aiAgent.revertChange}
          />
        )}
        {aiAgent.status === 'conflict' && (
          <ConflictCard
            onKeepManual={aiAgent.revertChange}
            onApplyAi={() => { void aiAgent.forceApplyChange(); }}
            onRegenerate={aiAgent.regenerateAfterConflict}
          />
        )}
        {aiAgent.error && aiAgent.status === 'error' && (
          <ErrorCard
            message={aiAgent.error.message}
            canRetry={aiAgent.error.retryable}
            cooldown={aiAgent.cooldown}
            showSettings={aiAgent.error.kind === 'auth'}
            onRetry={aiAgent.retry}
            onOpenSettings={onOpenSettings}
          />
        )}
      </div>

      <div className="border-t border-border bg-surface-container-low p-4">
        <AiMemoryPanel
          memory={aiAgent.memory}
          disabled={!projectPath}
          onSave={aiAgent.saveMemory}
        />
        <AiInputBox
          value={aiAgent.input}
          busy={aiAgent.busy}
          pending={aiAgent.pendingChangeSet?.status === 'pending'}
          onSubmit={onSend}
          onStop={aiAgent.stop}
        />
      </div>
    </aside>
  );
}

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
}

// --- Sub-components for DnD and insert zones ---

const CMD_ITEM = 'script-command';

function InsertZone({ atIndex, onInsert }: { atIndex: number; onInsert: (type: WebGalCommandType, atIndex: number) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const toggleMenu = useCallback(() => {
    setOpen((value) => !value);
  }, []);

  const insertCommand = useCallback((type: WebGalCommandType) => {
    onInsert(type, atIndex);
    setOpen(false);
  }, [atIndex, onInsert]);

  return (
    <div
      ref={containerRef}
      className="group relative mx-auto flex h-6 max-w-3xl items-center justify-center"
    >
      <div className="absolute inset-x-0 top-1/2 h-px bg-outline-variant/20 group-hover:bg-secondary/40 transition-colors" />
      <button
        type="button"
        onClick={toggleMenu}
        className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full border border-outline-variant/30 bg-surface-bright text-[10px] text-muted-foreground opacity-0 shadow-sm transition-colors transition-opacity duration-150 group-hover:opacity-100 hover:border-secondary hover:text-secondary data-[open=true]:opacity-100"
        data-open={open}
        title="插入指令"
        aria-label="插入指令"
      >
        <Plus className="h-3 w-3" />
      </button>
      {open && (
        <div
          className="absolute left-1/2 top-5 z-50 w-72 -translate-x-1/2 rounded border border-border bg-surface-container-high p-3 shadow-lg"
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
        </div>
      )}
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
            ? `border-2 bg-tertiary/5 ${selected ? 'border-tertiary' : 'border-tertiary/30'} story-os-chamfer-tr`
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
function ScriptCommandStream({
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
}: ScriptCommandStreamProps) {
  const query = searchQuery?.trim().toLowerCase() ?? '';

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

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-background">
      <div className="pointer-events-none absolute inset-0 opacity-[0.03] story-os-dot-grid" />
      <div className="relative z-10 flex h-10 shrink-0 items-center justify-between border-b border-outline-variant/20 bg-surface-bright/50 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="shrink-0 text-xs font-bold tracking-widest text-on-surface-variant">指令流编辑</span>
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
        className="relative z-10 flex-1 overflow-y-auto p-8"
        onContextMenu={(e) => {
          if (!clipboardNode || !onPasteNode) return;
          // A card right-click is handled by the card's own context menu.
          if ((e.target as HTMLElement).closest('[data-cmd-card]')) return;
          e.preventDefault();
          const atIndex = areaPasteIndex(e.currentTarget, e.clientY);
          setAreaMenu({ x: e.clientX, y: e.clientY, atIndex });
        }}
      >
        <div className="mx-auto max-w-4xl space-y-6 pb-20">
        {nodes.length === 0 ? (
          <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 border border-dashed border-outline-variant/50 bg-surface-bright p-8 text-center text-muted-foreground">
            <FileText className="h-10 w-10 opacity-50" />
            <div className="text-base text-foreground">当前场景还没有命令</div>
            <button type="button" onClick={() => onInsertNode('dialogue', 0)} className="bg-primary px-4 py-2 text-sm font-semibold text-on-primary story-os-chamfer-tr">
              添加第一句对白
            </button>
          </div>
        ) : visibleNodes.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 border border-dashed border-outline-variant/40 bg-surface-bright p-6 text-center text-muted-foreground">
            <Search className="h-6 w-6 opacity-50" />
            <div className="text-sm">没有匹配 "{query}" 的指令</div>
          </div>
        ) : visibleNodes.map(({ node, index }, visibleIndex) => {
          if (absorbedIds.has(node.id)) return null; // merged into its head card
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
              {/* Insert zone before each node */}
              {onInsertNode && (
                <InsertZone atIndex={index} onInsert={onInsertNode} />
              )}
              <ScriptCommandCard
                node={node}
                index={index}
                displayIndex={visibleIndex}
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
            </Fragment>
          );
        })}
        {/* Insert zone at end */}
        {onInsertNode && nodes.length > 0 && (
          <InsertZone atIndex={nodes.length} onInsert={onInsertNode} />
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

export function StoryEditor() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedScene = searchParams.get('scene');
  const requestedSceneName = requestedScene || 'start.txt';
  const viewMode = searchParams.get('view'); // 'worldline' = full-screen scene graph

  // Project state
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [currentSceneName, setCurrentSceneName] = useState('start.txt');
  const [dirty, setDirty] = useState(false);
  const [sceneHeaders, setSceneHeaders] = useState<Record<string, SceneHeader>>({});
  const [sceneLinkMap, setSceneLinkMap] = useState<Record<string, SceneLink[]>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  // Editor state
  const [nodes, setNodes] = useState<WebGalNode[]>([]);
  const nodesRef = useRef<WebGalNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<WebGalNode | null>(null);
  const [scriptSource, setScriptSource] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [commandSearchQuery, setCommandSearchQuery] = useState('');
  const [clipboardNode, setClipboardNode] = useState<WebGalNode | null>(null);
  const [loading, setLoading] = useState(true);

  // AI state
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [projectMetadataOpen, setProjectMetadataOpen] = useState(false);
  const [projectMetadata, setProjectMetadata] = useState<ProjectMetadata | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [exportTask, setExportTask] = useState<ExportTaskState>(IDLE_EXPORT_TASK);
  // Transient success toast for single-scene export, rendered by React so its
  // dismissal timer is cleaned up on unmount (no stray DOM nodes).
  const [exportToast, setExportToast] = useState<string | null>(null);
  const exportToastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const lastExportPayloadRef = useRef<{
    metadata: ProjectMetadata;
    outputDir: string;
    asZip: boolean;
  } | null>(null);
  const [snapshotManagerOpen, setSnapshotManagerOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const [sceneManagerOpen, setSceneManagerOpen] = useState(false);
  const [newSceneOpen, setNewSceneOpen] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [newSceneError, setNewSceneError] = useState('');
  const [creatingScene, setCreatingScene] = useState(false);
  const [charactersForAi, setCharactersForAi] = useState<Character[]>([]);
  const [characterColors, setCharacterColors] = useState<Record<string, string>>({});
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const loadSceneHeaders = useCallback(async (projectPath: string, scenes: string[]) => {
    const entries = await Promise.all(
      scenes.map(async (name) => {
        try {
          const path = await getScenePath(projectPath, name);
          const text = await readFileText(path);
          return [name, parseSceneHeader(text)] as const;
        } catch {
          return [name, {}] as const;
        }
      }),
    );
    setSceneHeaders(Object.fromEntries(entries));
  }, []);

  const loadSceneLinkMap = useCallback(async (projectPath: string, scenes: string[]) => {
    const entries = await Promise.all(
      scenes.map(async (name) => {
        try {
          const path = await getScenePath(projectPath, name);
          const nodes = await loadScene(path);
          return [name, extractSceneLinks(nodes)] as const;
        } catch {
          return [name, [] as SceneLink[]] as const;
        }
      }),
    );
    setSceneLinkMap(Object.fromEntries(entries));
  }, []);

  // Keep the current scene's outgoing links live so the relationship graph
  // reflects edits — AI changes, manual edits, added/removed jump & control
  // nodes — without waiting for a save. extractSceneLinks only looks at
  // changeScene / callScene / choose targets, and sceneLinksEqual skips updates
  // that don't change any target, so editing dialogue never churns the graph.
  //
  // On a scene switch, currentSceneName updates a render before `nodes` (which
  // load async). In that in-between render `nodes` still belongs to the previous
  // scene, so attributing them to the new scene would write wrong links and make
  // the graph flicker (wrong → corrected). The prevNodes guard skips renders
  // where only currentSceneName changed; we only sync when `nodes` itself
  // changed, at which point currentSceneName already reflects its scene.
  const prevNodesRef = useRef(nodes);
  useEffect(() => {
    if (prevNodesRef.current === nodes) return;
    prevNodesRef.current = nodes;
    const links = extractSceneLinks(nodes);
    setSceneLinkMap((prev) => {
      const prevLinks = prev[currentSceneName];
      if (prevLinks && sceneLinksEqual(prevLinks, links)) return prev;
      return { ...prev, [currentSceneName]: links };
    });
  }, [nodes, currentSceneName]);

  const loadCharacterColors = useCallback(async (projectPath: string) => {
    try {
      const refs = await listCharacterNames(projectPath);
      const map: Record<string, string> = {};
      refs.forEach((ref, idx) => {
        map[ref.name] = characterColor(idx);
      });
      setCharacterColors(map);
    } catch {
      setCharacterColors({});
    }
  }, []);

  const refreshCharactersForAi = useCallback(async () => {
    if (!projectPath) return;
    try {
      const chars = await listCharacters(projectPath);
      setCharactersForAi(chars);
    } catch {
      setCharactersForAi([]);
    }
    void loadCharacterColors(projectPath);
  }, [loadCharacterColors, projectPath]);

  const handleHeaderUpdated = useCallback((name: string, header: SceneHeader) => {
    setSceneHeaders((prev) => ({ ...prev, [name]: header }));
  }, []);

  const chooseInitialScene = useCallback((scenes: string[], requested: string | null): string => {
    if (requested && scenes.includes(requested)) return requested;
    if (scenes.includes('start.txt')) return 'start.txt';
    return scenes[0] ?? 'start.txt';
  }, []);

  const refreshProjectInfo = useCallback(async () => {
    if (!projectPath) return;
    try {
      const info = await openProject(projectPath);
      setProjectInfo(info);
      void loadSceneHeaders(projectPath, info.scenes);
      void loadSceneLinkMap(projectPath, info.scenes);
    } catch {}
  }, [projectPath, loadSceneHeaders, loadSceneLinkMap]);

  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // In-memory draft cache: sceneName -> nodes snapshot for unsaved scenes
  const sceneDraftCache = useRef<Map<string, WebGalNode[]>>(new Map());
  const aiPreviewingCurrentSceneRef = useRef(false);
  // Keep a ref in sync so the close-requested handler always sees current dirty state
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    if (selectedNode) {
      const idx = nodesRef.current.findIndex((n) => n.id === selectedNode.id);
      if (idx >= 0) selectedIndexRef.current = idx;
    }
  }, [selectedNode]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const autoSaveRef = useRef<ReturnType<typeof setInterval>>();
  const selectedIndexRef = useRef(0);
  // Monotonic token guarding async scene loads (switch/open) against out-of-order
  // completion — only the most recent load is allowed to commit to state.
  const sceneLoadTokenRef = useRef(0);

  // Auto-save wiring. The cadence is fixed; users toggle it on/off from the
  // top-bar switch (autoSaveEnabled). There is no separate interval setting.
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);

  useEffect(() => {
    const settings = loadAppSettings();
    if (settings.runtimeTemplateDir) {
      setRuntimeTemplateDir(settings.runtimeTemplateDir).catch((e) => {
        console.warn('[runtime] failed to set template dir from app settings:', e);
      });
    }
  }, []);

  useEffect(() => {
    getRuntimeUrl()
      .then((url) => console.info(`[runtime] preview URL: ${url}`))
      .catch((e) => console.warn('[runtime] URL unavailable:', e));
    (window as unknown as { __jumpTo?: typeof jumpToSentence }).__jumpTo = jumpToSentence;
  }, []);

  useEffect(() => {
    setRuntimeProject(projectPath).catch((e) =>
      console.warn('[runtime] failed to sync project path:', e),
    );
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) {
      setProjectMetadata(null);
      return;
    }
    readProjectMetadata(projectPath)
      .then((metadata) => setProjectMetadata(metadata ?? EMPTY_PROJECT_METADATA))
      .catch((e) => {
        console.warn('[project] failed to load metadata:', e);
        setProjectMetadata(EMPTY_PROJECT_METADATA);
      });
  }, [projectPath]);

  // ---------------------------------------------------------------------------
  // Initialization: try to load project from localStorage or URL params
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      // Try to restore project path from localStorage
      const storedPath = localStorage.getItem(`project-path-${projectId}`);
      const sceneName = requestedSceneName;
      setCurrentSceneName(sceneName);

      if (storedPath) {
        try {
          const info = await openProject(storedPath);
          setProjectPath(storedPath);
          setProjectInfo(info);
          const initialSceneName = chooseInitialScene(info.scenes, requestedScene);
          const sceneCandidates = Array.from(new Set([
            initialSceneName,
            ...info.scenes,
          ])).filter(Boolean);

          let loadedInitialScene = false;
          for (const sceneName of sceneCandidates) {
            const scenePath = await getScenePath(storedPath, sceneName);
            try {
              const loaded = await loadScene(scenePath);
              setCurrentSceneName(sceneName);
            // Restore sessionStorage draft left by assets-page navigation
            const draftKey = `scene-draft-${projectId}-${sceneName}`;
            const draftJson = sessionStorage.getItem(draftKey);
            if (draftJson) {
              try {
                const draft = JSON.parse(draftJson) as WebGalNode[];
                setNodes(draft);
                const text = await serializeScene(draft);
                setScriptSource(text);
                setDirty(true);
              } catch {
                setNodes(loaded);
                const text = await serializeScene(loaded);
                setScriptSource(text);
              }
              sessionStorage.removeItem(draftKey);
            } else {
              setNodes(loaded);
              const text = await serializeScene(loaded);
              setScriptSource(text);
            }
              loadedInitialScene = true;
              break;
            } catch (e) {
              console.warn(`[project] failed to load scene ${sceneName}:`, e);
            }
          }

          if (!loadedInitialScene) {
            const sceneName = initialSceneName || info.scenes[0] || 'start.txt';
            setCurrentSceneName(sceneName);
            setNodes([]);
            setScriptSource('');
            setDirty(false);
          }
        } catch (e) {
          // Keep the stored path visible so a transient project-load failure does
          // not make the editor forget the project and render a blank workspace.
          console.error('Restore project failed:', e);
          setProjectPath(storedPath);
          setProjectInfo(null);
          setNodes([]);
          setScriptSource('');
          setDirty(false);
        }

        // Load character names for autocomplete
        try {
          const chars = await listCharacters(storedPath);
          setCharactersForAi(chars);
        } catch {
          setCharactersForAi([]);
        }
        void loadCharacterColors(storedPath);

        // Load scene header comments + outgoing scene-jump map for the graph view
        const info = await openProject(storedPath).catch(() => null);
        if (info) {
          void loadSceneHeaders(storedPath, info.scenes);
          void loadSceneLinkMap(storedPath, info.scenes);
        }
      } else {
        // No project path yet; keep the editor empty until a project is opened.
        setCurrentSceneName(requestedScene || 'start.txt');
        setNodes([]);
        setScriptSource('');
        setDirty(false);
      }

      setLoading(false);
    };
    init();
  }, [projectId, requestedSceneName]);

  // ---------------------------------------------------------------------------
  // 同步节点到脚本文本
  // ---------------------------------------------------------------------------
  const syncScript = useCallback(async (nextNodes: WebGalNode[]) => {
    try {
      const text = await serializeScene(nextNodes);
      setScriptSource(text);
    } catch {
      // keep stale
    }
  }, []);

  // Mark dirty on any node change
  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveStatus('idle');
  }, []);

  const commitEditedNodes = useCallback((nextNodes: WebGalNode[]) => {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    void syncScript(nextNodes);
    markDirty();
  }, [markDirty, syncScript]);

  // Undo / Redo
  const [history, setHistory] = useState<WebGalNode[][]>([]);
  const [redoHistory, setRedoHistory] = useState<WebGalNode[][]>([]);

  const pushHistory = useCallback((nodesSnapshot: WebGalNode[]) => {
    setHistory(prev => {
      const next = [...prev, nodesSnapshot];
      return next.length > 50 ? next.slice(-50) : next;
    });
    setRedoHistory([]);
  }, []);

  // Debounce timer for merging successive updateNode calls to the same node
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingRecordRef = useRef<WebGalNode[] | null>(null);

  const flushPendingHistory = useCallback((): WebGalNode[] | null => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const pending = pendingRecordRef.current;
    if (!pending) return null;
    pushHistory(pending);
    pendingRecordRef.current = null;
    return pending;
  }, [pushHistory]);

  const undo = useCallback(() => {
    const current = nodesRef.current;
    const pending = flushPendingHistory();
    if (pending) {
      setHistory(prev => prev.slice(0, -1));
      setRedoHistory(prev => [...prev, current].slice(-50));
      commitEditedNodes(pending);
      setSelectedNode(null);
      return;
    }
    const prevNodes = history[history.length - 1];
    if (!prevNodes) return;
    setHistory(prev => prev.slice(0, -1));
    setRedoHistory(prev => [...prev, current].slice(-50));
    commitEditedNodes(prevNodes);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, history]);

  const redo = useCallback(() => {
    if (flushPendingHistory()) return;
    const nextNodes = redoHistory[redoHistory.length - 1];
    if (!nextNodes) return;
    const current = nodesRef.current;
    setRedoHistory(prev => prev.slice(0, -1));
    setHistory(prev => [...prev, current].slice(-50));
    commitEditedNodes(nextNodes);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, redoHistory]);

  // ---------------------------------------------------------------------------
  // Node CRUD
  // ---------------------------------------------------------------------------
  const insertNode = useCallback((type: WebGalCommandType, atIndex: number) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const { nodes: updated, inserted } = insertSceneNode(current, type, atIndex, Date.now().toString());
    commitEditedNodes(updated);
    setSelectedNode(inserted);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const createUnlockNode = useCallback((sourceNode: WebGalNode, atIndex: number) => {
    const asset = (sourceNode.asset || sourceNode.content || '').trim();
    if (!asset || asset === 'none') return;
    const unlockType: WebGalCommandType | null = sourceNode.type === 'changeBg'
      ? 'unlockCg'
      : sourceNode.type === 'bgm'
        ? 'unlockBgm'
        : null;
    if (!unlockType) return;

    const current = nodesRef.current;
    const existing = current[atIndex];
    if (existing?.type === unlockType && (existing.asset || existing.content || '').trim() === asset) {
      setSelectedNode(existing);
      return;
    }

    const displayName = asset.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    flushPendingHistory();
    pushHistory(current);
    const { nodes: insertedNodes, inserted } = insertSceneNode(current, unlockType, atIndex, Date.now().toString());
    const updated = insertedNodes.map((node) => node.id === inserted.id
      ? {
          ...node,
          content: asset,
          asset,
          displayName,
        }
      : node);
    const selected = updated.find((node) => node.id === inserted.id) ?? inserted;
    commitEditedNodes(updated);
    setSelectedNode(selected);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const updateSelectedNode = useCallback((updates: Partial<WebGalNode>) => {
    const current = nodesRef.current;
    const selected = selectedNode;
    if (!selected) return;

    if (!pendingRecordRef.current) {
      pendingRecordRef.current = current;
    }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const pending = pendingRecordRef.current;
      if (pending) pushHistory(pending);
      pendingRecordRef.current = null;
    }, 800);

    let nextSelected: WebGalNode | null = null;
    const updated = current.map((node) => {
      if (node.id !== selected.id) return node;
      nextSelected = { ...node, ...updates };
      return nextSelected;
    });
    if (!nextSelected) return;
    nodesRef.current = updated;
    setNodes(updated);
    setSelectedNode(nextSelected);
    void syncScript(updated);
    markDirty();
  }, [markDirty, pushHistory, selectedNode, syncScript]);

  const deleteSelectedNode = useCallback(() => {
    const selected = selectedNode;
    if (!selected) return;
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = current.filter((node) => node.id !== selected.id);
    commitEditedNodes(updated);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, pushHistory, selectedNode]);

  // ---------------------------------------------------------------------------
  // Per-node operations (for context menu / drag handle)
  // ---------------------------------------------------------------------------
  const deleteNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = current.filter((node) => node.id !== nodeId);
    commitEditedNodes(updated);
    if (selectedNode?.id === nodeId) setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, pushHistory, selectedNode]);

  const copyNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    const target = current.find((node) => node.id === nodeId);
    if (!target) return;
    setClipboardNode({ ...target, id: `${target.id}__copy__${Date.now().toString()}` });
  }, []);

  const cutNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    const target = current.find((node) => node.id === nodeId);
    if (!target) return;
    setClipboardNode({ ...target, id: `${target.id}__cut__${Date.now().toString()}` });
    deleteNode(nodeId);
  }, [deleteNode]);

  const reorderNodes = useCallback((fromIndex: number, toIndex: number) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = reorderSceneNodes(current, fromIndex, toIndex);
    commitEditedNodes(updated);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const pasteNode = useCallback((atIndex: number) => {
    if (!clipboardNode) return;
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = pasteSceneNode(current, clipboardNode, atIndex, Date.now().toString());
    commitEditedNodes(updated);
  }, [clipboardNode, commitEditedNodes, flushPendingHistory, pushHistory]);

  const jumpToNode = useCallback((index: number) => {
    if (!currentSceneName) return;
    void jumpToSentence(currentSceneName, index + 1).catch((e) =>
      console.warn('[runtime] jumpToSentence failed:', e),
    );
  }, [currentSceneName]);

  const syncSceneBackgroundCard = useCallback(async (sceneFile: string, sceneNodes: WebGalNode[]) => {
    if (!projectPath) return;
    try {
      const backgroundAssets = await listAssets(projectPath, 'background');
      const availableBackgrounds = new Set(backgroundAssets.map((asset) => asset.name));
      const backgroundFilenames = extractSceneBackgroundAssets(sceneNodes);
      if (backgroundFilenames.length === 0) return;
      const metadata = await loadAssetMetadata(projectPath, projectId);
      const next = syncSceneCardsFromBackgrounds(
        metadata,
        sceneFile,
        backgroundFilenames,
        availableBackgrounds,
      );
      if (next !== metadata) await saveAssetMetadata(projectPath, next);
    } catch (e) {
      console.warn('[asset] sync scene background card failed:', e);
    }
  }, [projectId, projectPath]);

  // 场景背景卡片同步只在保存时进行（见 handleSave），避免用户逐字输入文件名
  // 时把 t / te / tes 等中间状态都建成卡片。

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async (): Promise<boolean> => {
    setSaveStatus('saving');
    try {
      let nodesToSave = nodesRef.current.length > 0 ? nodesRef.current : nodes;
      if (showScript) {
        nodesToSave = await parseScene(scriptSource);
        nodesRef.current = nodesToSave;
        setNodes(nodesToSave);
        setSelectedNode(null);
      }
      if (projectPath) {
        // Save to project's game/scene/ directory
        const scenePath = await getScenePath(projectPath, currentSceneName);
        await saveScene(scenePath, nodesToSave);
        await syncSceneBackgroundCard(currentSceneName, nodesToSave);
      } else {
        // No project open, prompt user to pick a save location.
        const selected = await saveDialog({
          title: '保存场景文件',
          defaultPath: currentSceneName,
          filters: [{ name: 'WebGAL Scene', extensions: ['txt'] }],
        });
        if (!selected) {
          setSaveStatus('idle');
          return false;
        }
        await saveScene(selected, nodesToSave);
      }
      setDirty(false);
      sceneDraftCache.current.delete(currentSceneName);
      // Refresh header + scene-graph link entry for the saved scene
      if (projectPath) void loadSceneHeaders(projectPath, projectInfo?.scenes ?? [currentSceneName]);
      // Sync voice cards from the dialogue lines
      if (projectPath) {
        syncSceneVoiceCards(projectPath, currentSceneName).catch((e) =>
          console.warn('[voice] sync voice cards failed:', e),
        );
      }
      setSceneLinkMap((prev) => ({ ...prev, [currentSceneName]: extractSceneLinks(nodesToSave) }));
      setSaveStatus('saved');
      // Reset status after 2s
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      return true;
    } catch (e) {
      console.error('Save failed:', e);
      setSaveStatus('error');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      return false;
    }
  }, [
    currentSceneName,
    loadSceneHeaders,
    nodes,
    projectInfo?.scenes,
    projectPath,
    scriptSource,
    showScript,
    syncSceneBackgroundCard,
  ]);

  // Guard navigation that would discard unsaved changes (back to home, window close)
  const guardedNavigate = useCallback((action: () => void) => {
    if (dirty) {
      pendingActionRef.current = action;
      setUnsavedConfirmOpen(true);
    } else {
      action();
    }
  }, [dirty]);

  const handleUnsavedSaveAndLeave = useCallback(async () => {
    const action = pendingActionRef.current;
    if (await handleSave()) {
      pendingActionRef.current = null;
      setUnsavedConfirmOpen(false);
      action?.();
    }
  }, [handleSave]);

  const handleUnsavedDiscard = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setDirty(false);
    setUnsavedConfirmOpen(false);
    action?.();
  }, []);

  const handleUnsavedCancel = useCallback(() => {
    setUnsavedConfirmOpen(false);
    pendingActionRef.current = null;
  }, []);

  // Warn on window/tab close when dirty (web fallback)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Intercept Tauri native window close when dirty
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let appWindow: ReturnType<typeof getCurrentWindow>;
    try {
      appWindow = getCurrentWindow();
    } catch {
      return undefined;
    }
    appWindow.onCloseRequested((event) => {
      if (dirtyRef.current) {
        event.preventDefault();
        pendingActionRef.current = () => void appWindow.destroy();
        setUnsavedConfirmOpen(true);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+S / Cmd+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Undo/Redo shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // Clipboard shortcuts (Ctrl+C/X/V)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (e.key === 'c' && selectedNode) {
          e.preventDefault();
          copyNode(selectedNode.id);
        } else if (e.key === 'x' && selectedNode) {
          e.preventDefault();
          cutNode(selectedNode.id);
        } else if (e.key === 'v' && clipboardNode) {
          e.preventDefault();
          const currentIndex = nodes.findIndex((n) => n.id === selectedNode?.id);
          pasteNode(currentIndex >= 0 ? currentIndex : nodes.length);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNode, clipboardNode, nodes, copyNode, cutNode, pasteNode]);

  // Auto-save: periodic save when dirty.
  // Use refs to avoid recreating the interval on every dirty/handleSave change.
  const handleSaveRef = useRef(handleSave);
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  useEffect(() => {
    if (!autoSaveEnabled || !projectPath) return;
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    autoSaveRef.current = setInterval(() => {
      if (dirtyRef.current) {
        handleSaveRef.current();
      }
    }, AUTO_SAVE_INTERVAL_MS);
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [autoSaveEnabled, projectPath]);

  // Clear the export-toast dismissal timer on unmount.
  useEffect(() => () => {
    if (exportToastTimerRef.current) clearTimeout(exportToastTimerRef.current);
  }, []);

  // ---------------------------------------------------------------------------
  // Open project folder
  // ---------------------------------------------------------------------------
  const handleOpenProject = useCallback(async () => {
    const selected = await openDialog({
      title: '选择 WebGAL 项目文件夹',
      directory: true,
    });
    if (!selected) return;

    try {
      const info = await openProject(selected);
      setProjectPath(selected);
      setProjectInfo(info);
      localStorage.setItem(`project-path-${projectId}`, selected);

      // Load start.txt or first available scene
      const sceneName = chooseInitialScene(info.scenes, null);
      const myToken = sceneLoadTokenRef.current + 1;
      sceneLoadTokenRef.current = myToken;
      setCurrentSceneName(sceneName);

      const scenePath = await getScenePath(selected, sceneName);
      try {
        const loaded = await loadScene(scenePath);
        const text = await serializeScene(loaded);
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes(loaded);
        setScriptSource(text);
        setDirty(false);
      } catch {
        // empty scene
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes([]);
        setScriptSource('');
      }

      // Load character names for autocomplete
      try {
        const chars = await listCharacters(selected);
        setCharactersForAi(chars);
      } catch {
        setCharactersForAi([]);
      }
      void loadCharacterColors(selected);

      void loadSceneHeaders(selected, info.scenes);
      void loadSceneLinkMap(selected, info.scenes);
    } catch (e) {
      console.error('Open project failed:', e);
    }
  }, [projectId, loadSceneHeaders, loadSceneLinkMap, chooseInitialScene]);

  // ---------------------------------------------------------------------------
  // Switch scene within project
  // ---------------------------------------------------------------------------
  const handleSwitchScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;

    // Stash current unsaved nodes in the in-memory draft cache
    if (dirty && !aiPreviewingCurrentSceneRef.current) {
      sceneDraftCache.current.set(currentSceneName, nodes);
    } else if (aiPreviewingCurrentSceneRef.current) {
      sceneDraftCache.current.delete(currentSceneName);
    }

    // Guard against out-of-order async results: a fast A→B→A switch must not
    // let B's (slower) load overwrite A's. Only the latest token may commit.
    const myToken = sceneLoadTokenRef.current + 1;
    sceneLoadTokenRef.current = myToken;
    setCurrentSceneName(sceneName);
    const scenePath = await getScenePath(projectPath, sceneName);
    try {
      // Prefer a cached draft over the saved file
      const draft = sceneDraftCache.current.get(sceneName);
      if (draft) {
        const text = await serializeScene(draft);
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes(draft);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(true);
      } else {
        const loaded = await loadScene(scenePath);
        const text = await serializeScene(loaded);
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes(loaded);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(false);
      }
    } catch {
      if (sceneLoadTokenRef.current !== myToken) return;
      setNodes([]);
      setScriptSource('');
    }
  }, [projectPath, currentSceneName, dirty, nodes]);

  // Stable wrapper for child components (SceneGraph) so they can be memoized —
  // the underlying handleSwitchScene closes over `nodes`/`dirty` and changes
  // on every edit, but the click target only needs the latest implementation.
  const handleSwitchSceneRef = useRef(handleSwitchScene);
  handleSwitchSceneRef.current = handleSwitchScene;
  const stableSwitchScene = useCallback((name: string) => {
    void handleSwitchSceneRef.current(name);
  }, []);

  // ---------------------------------------------------------------------------
  // Create new scene
  // ---------------------------------------------------------------------------
  const handleNewScene = useCallback(async () => {
    if (!projectPath) return;
    setNewSceneName('');
    setNewSceneError('');
    setNewSceneOpen(true);
  }, [projectPath]);

  const handleCreateSceneConfirm = useCallback(async () => {
    if (!projectPath || creatingScene) return;
    const name = newSceneName.trim();
    if (!name) {
      setNewSceneError('请输入场景文件名。');
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      setNewSceneError('文件名不能包含 \\ / : * ? " < > |。');
      return;
    }
    const baseName = name.replace(/\.txt$/i, '');
    const sceneName = `${baseName}.txt`;
    if (projectInfo?.scenes?.includes(sceneName)) {
      setNewSceneError(`场景 ${sceneName} 已存在。`);
      return;
    }
    setCreatingScene(true);
    setNewSceneError('');
    try {
      await createScene(projectPath, baseName);
      // Refresh project info
      const info = await openProject(projectPath);
      setProjectInfo(info);
      // Immediately create a matching background card in the asset library so the
      // new scene shows up under 素材库 > 背景, ready to fill in / generate.
      try {
        const metadata = await loadAssetMetadata(projectPath, projectId);
        const index = Object.keys(metadata.sceneCards ?? {}).length + 1;
        const next = ensureSceneCard(metadata, sceneName, index);
        if (next !== metadata) await saveAssetMetadata(projectPath, next);
      } catch (metaErr) {
        console.error('Create scene card failed:', metaErr);
      }
      // Switch to new scene
      await handleSwitchScene(sceneName);
      setNewSceneOpen(false);
      setNewSceneName('');
    } catch (e) {
      console.error('Create scene failed:', e);
      setNewSceneError(`创建场景失败: ${String(e)}`);
    } finally {
      setCreatingScene(false);
    }
  }, [projectPath, creatingScene, newSceneName, projectInfo?.scenes, projectId, handleSwitchScene]);

  const handleDeleteScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;
    const ok = window.confirm(`确定删除场景 "${sceneName}" 吗？此操作不可恢复。`);
    if (!ok) return;
    try {
      const path = await getScenePath(projectPath, sceneName);
      await deleteScene(path);
      // If deleting the current scene, switch to another
      if (sceneName === currentSceneName) {
        const info = await openProject(projectPath);
        const remaining = info.scenes.filter((s) => s !== sceneName);
        if (remaining.length > 0) {
          await handleSwitchScene(remaining[0]);
        }
      }
      void refreshProjectInfo();
    } catch (e) {
      console.error('Delete scene failed:', e);
      alert(`删除场景失败: ${e}`);
    }
  }, [projectPath, currentSceneName, handleSwitchScene, refreshProjectInfo]);

  const handleRenameScene = useCallback(async (oldName: string) => {
    if (!projectPath) return;
    const newName = prompt(`重命名 "${oldName}" 为:`, oldName.replace(/\.txt$/, ''));
    if (!newName || newName === oldName) return;
    const finalName = newName.endsWith('.txt') ? newName : `${newName}.txt`;
    try {
      const path = await getScenePath(projectPath, oldName);
      await renameScene(path, finalName);
      void refreshProjectInfo();
      if (oldName === currentSceneName) {
        setCurrentSceneName(finalName);
      }
    } catch (e) {
      console.error('Rename scene failed:', e);
      alert(`重命名场景失败: ${e}`);
    }
  }, [projectPath, currentSceneName, refreshProjectInfo]);

  // ---------------------------------------------------------------------------
  // Import / Export / Apply script
  // ---------------------------------------------------------------------------
  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      setScriptSource(text);
      const parsed = await parseScene(text);
      setNodes(parsed);
      setSelectedNode(null);
      markDirty();
    };
    input.click();
  }, [markDirty]);

  const handleExport = useCallback(async () => {
    try {
      console.log('开始导出场景:', currentSceneName, '节点数:', nodes.length);

      // Ensure filename has .txt extension
      const filename = currentSceneName.endsWith('.txt') ? currentSceneName : `${currentSceneName}.txt`;

      // Let user choose where to save
      const savePath = await saveDialog({
        title: '导出场景',
        defaultPath: filename,
        filters: [{
          name: 'WebGAL 场景文件',
          extensions: ['txt']
        }]
      });

      if (!savePath) {
        console.log('用户取消了导出');
        return;
      }

      console.log('用户选择保存到:', savePath);

      const text = await serializeScene(nodes);
      console.log('序列化完成，文本长度:', text.length);

      // Write to file using Tauri
      await writeFileText(savePath, text);

      console.log('导出成功:', savePath);

      // Show success notification (React-rendered; timer cleared on unmount).
      setExportToast(`✓ 已导出: ${filename}`);
      if (exportToastTimerRef.current) clearTimeout(exportToastTimerRef.current);
      exportToastTimerRef.current = setTimeout(() => setExportToast(null), 3000);
    } catch (e) {
      console.error('导出场景失败:', e);
      alert(`导出场景失败: ${e}`);
    }
  }, [nodes, currentSceneName]);

  // Handle node selection from scene index with auto-scroll to the node
  const handleSelectNodeWithScroll = useCallback((node: WebGalNode) => {
    setSelectedNode(node);

    // Scroll to the corresponding node in the command stream
    // Use a small delay to ensure the selection state is updated first
    setTimeout(() => {
      const cardElement = document.querySelector(`[data-node-id="${node.id}"]`);
      if (cardElement) {
        cardElement.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
    }, 50);
  }, []);

  const handleApplyScript = useCallback(async () => {
    const parsed = await parseScene(scriptSource);
    setNodes(parsed);
    setSelectedNode(null);
    setShowScript(false);
    markDirty();
  }, [scriptSource, markDirty]);

  const projectName = projectInfo?.config.Game_name || projectPath?.split('/').pop() || '未命名项目';

  const handleSaveProjectMetadata = useCallback(async (metadata: ProjectMetadata) => {
    if (!projectPath) return;
    setMetadataSaving(true);
    try {
      await saveProjectMetadata(projectPath, metadata);
      setProjectMetadata(metadata);
    } catch (e) {
      alert(`保存元信息失败: ${e}`);
    } finally {
      setMetadataSaving(false);
    }
  }, [projectPath]);

  const handleExportProjectWithMetadata = useCallback(async (
    metadata: ProjectMetadata,
    outputDir: string,
    asZip: boolean,
  ) => {
    if (!projectPath) return;
    const failureCount = exportTask.status === 'failed' ? exportTask.failureCount : 0;
    lastExportPayloadRef.current = { metadata, outputDir, asZip };
    try {
      if (dirty && !(await handleSave())) return;
      const payload = { ...metadata, lastExportDir: outputDir };
      lastExportPayloadRef.current = { metadata: payload, outputDir, asZip };
      setExportTask({
        status: 'savingMetadata',
        warnings: [],
        issues: [],
        failureCount,
      });
      await saveProjectMetadata(projectPath, payload);
      setProjectMetadata(payload);
      setExportTask({
        status: 'exporting',
        warnings: [],
        issues: [],
        failureCount,
      });
      const result = await exportProject(projectPath, outputDir, asZip, payload);
      if (result.success) {
        setExportTask({
          status: 'succeeded',
          outputPath: result.outputPath || outputDir,
          warnings: result.warnings ?? [],
          issues: result.issues ?? [],
          failureCount: 0,
        });
      } else {
        setExportTask((prev) => ({
          status: 'failed',
          warnings: result.warnings ?? [],
          issues: result.issues ?? [],
          error: '导出校验未通过，请处理错误后重试。',
          failureCount: prev.failureCount + 1,
        }));
      }
    } catch (e) {
      setExportTask((prev) => ({
        status: 'failed',
        warnings: prev.warnings ?? [],
        issues: prev.issues ?? [],
        error: String(e),
        failureCount: prev.failureCount + 1,
      }));
    }
  }, [projectPath, dirty, handleSave, exportTask.status, exportTask.failureCount]);

  const handleRetryExportProject = useCallback(async () => {
    const payload = lastExportPayloadRef.current;
    if (!payload) return;
    await handleExportProjectWithMetadata(payload.metadata, payload.outputDir, payload.asZip);
  }, [handleExportProjectWithMetadata]);

  const handleExportProject = useCallback(() => {
    if (!projectPath) return;
    setExportTask(IDLE_EXPORT_TASK);
    setProjectMetadataOpen(true);
  }, [projectPath]);

  const refreshSnapshots = useCallback(async () => {
    if (!projectPath) return;
    try {
      setSnapshotError(null);
      setSnapshots(await listProjectSnapshots(projectPath));
    } catch (e) {
      setSnapshotError(`读取快照失败: ${e}`);
    }
  }, [projectPath]);

  const handleOpenSnapshotManager = useCallback(() => {
    if (!projectPath) return;
    setSnapshotError(null);
    setSnapshotStatus(null);
    setSnapshotManagerOpen(true);
  }, [projectPath]);

  const handleCreateSnapshot = useCallback(async (label: string, kind: SnapshotInfo['kind'] = 'manual') => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      if (dirty && !(await handleSave())) return;
      const snapshot = await createProjectSnapshot(projectPath, label, kind);
      setSnapshotStatus(`快照已创建: ${snapshot.label}`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`创建快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, dirty, handleSave, refreshSnapshots]);

  const handleRestoreSnapshot = useCallback(async (snapshot: SnapshotInfo) => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      if (dirty && !(await handleSave())) return;
      await createProjectSnapshot(projectPath, 'before-restore', 'beforeRestore', `回滚到"${snapshot.label}"前自动备份`);
      await restoreProjectSnapshot(projectPath, snapshot.id);
      const info = await openProject(projectPath);
      setProjectInfo(info);
      void loadSceneHeaders(projectPath, info.scenes);
      void loadSceneLinkMap(projectPath, info.scenes);
      const restoredSceneName = info.scenes.includes(currentSceneName)
        ? currentSceneName
        : (info.scenes[0] ?? 'start.txt');
      setCurrentSceneName(restoredSceneName);
      const scenePath = await getScenePath(projectPath, restoredSceneName);
      const loaded = await loadScene(scenePath);
      setNodes(loaded);
      setScriptSource(await serializeScene(loaded));
      sceneDraftCache.current.clear();
      setDirty(false);
      setSelectedNode(null);
      setSnapshotStatus(`已回滚到"${snapshot.label}"，并自动创建 before-restore 备份。`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`回滚快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, dirty, handleSave, loadSceneHeaders, loadSceneLinkMap, currentSceneName, refreshSnapshots]);

  const handleRenameSnapshot = useCallback(async (snapshot: SnapshotInfo, label: string) => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      const renamed = await renameProjectSnapshot(projectPath, snapshot.id, label);
      setSnapshotStatus(`快照已重命名: ${renamed.label}`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`重命名快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, refreshSnapshots]);

  const handleDeleteSnapshot = useCallback(async (snapshot: SnapshotInfo) => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      await deleteProjectSnapshot(projectPath, snapshot.id);
      setSnapshotStatus(`快照已删除: ${snapshot.label}`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`删除快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, refreshSnapshots]);

  const handleCreateExportCandidateSnapshot = useCallback(async () => {
    await handleCreateSnapshot(`candidate-${new Date().toISOString().slice(0, 10)}`, 'exportCandidate');
  }, [handleCreateSnapshot]);

  const handleOpenRuntime = useCallback(async () => {
    try {
      const url = await getRuntimeUrl();
      await openInBrowser(url);
    } catch (e) {
      console.warn('[runtime] failed to open browser:', e);
      alert(`无法打开预览窗口: ${e}`);
    }
  }, []);

  useEffect(() => {
    const action = searchParams.get('action');
    if (!action || loading || !projectPath) return;

    if (action === 'preview') {
      void handleOpenRuntime();
    } else if (action === 'export') {
      handleExportProject();
    } else {
      return;
    }

    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [
    handleExportProject,
    handleOpenRuntime,
    loading,
    projectPath,
    searchParams,
    setSearchParams,
  ]);

  const aiAgent = useAiAgent({
    projectId,
    projectPath,
    currentSceneName,
    sceneHeaders,
    nodes,
    selectedNode,
    scriptSource,
    dirty,
    characters: charactersForAi,
    setNodes,
    setScriptSource,
    setDirty,
    setSaveStatus,
    setSelectedNode,
    setShowScript,
    pushHistory,
    onScenesChanged: async () => {
      if (!projectPath) return;
      const info = await openProject(projectPath);
      setProjectInfo(info);
      void loadSceneHeaders(projectPath, info.scenes);
      // Refresh the relationship graph for AI edits that touch other scenes'
      // jump/choose nodes (the current scene stays live via the nodes effect).
      void loadSceneLinkMap(projectPath, info.scenes);
    },
    onCharactersChanged: refreshCharactersForAi,
  });

  // While an AI change set is pending, if it edits the currently-open scene,
  // render the canvas as a read-only node diff (green added / red deleted /
  // yellow modified) instead of the editable list.
  const aiPreviewEntries = useMemo(() => {
    const set = aiAgent.pendingChangeSet;
    if (!set || set.status !== 'pending') return undefined;
    const sceneEdit = set.edits.find(
      (e): e is SceneEdit => e.kind === 'scene' && e.file === currentSceneName,
    );
    if (!sceneEdit) return undefined;
    return computeFullNodeDiff(sceneEdit.beforeNodes, sceneEdit.afterNodes);
  }, [aiAgent.pendingChangeSet, currentSceneName]);

  useEffect(() => {
    aiPreviewingCurrentSceneRef.current = Boolean(aiPreviewEntries);
    const set = aiAgent.pendingChangeSet;
    if (set?.status === 'accepted') {
      set.edits.forEach((edit) => {
        if (edit.kind === 'scene') sceneDraftCache.current.delete(edit.file);
      });
      return;
    }
    if (set?.status === 'reverted' && set.edits.some((edit) => edit.kind === 'scene' && edit.file === currentSceneName)) {
      sceneDraftCache.current.delete(currentSceneName);
    }
  }, [aiPreviewEntries, aiAgent.pendingChangeSet, currentSceneName]);

  const handleAiSend = useCallback((text: string) => { void aiAgent.sendPrompt(text); }, [aiAgent.sendPrompt]);
  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const gameName = projectInfo?.config?.Game_name || `项目 ${projectId ?? ''}`;

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="h-full story-shell">
        {exportToast && (
          <div
            role="status"
            className="fixed top-20 right-5 z-[9999] rounded-lg px-5 py-3 text-sm text-white shadow-lg"
            style={{ background: 'rgba(34, 197, 94, 0.9)' }}
          >
            {exportToast}
          </div>
        )}
        <StoryOsTopBar
          onUndo={undo}
          onRedo={redo}
          onRun={handleOpenRuntime}
          onPublish={handleExportProject}
          onSave={handleSave}
          onImport={() => guardedNavigate(handleImport)}
          onExport={handleExport}
          onOpenProject={() => guardedNavigate(handleOpenProject)}
          onSnapshots={handleOpenSnapshotManager}
          onToggleScript={() => setShowScript(!showScript)}
          scriptMode={showScript}
          onSearchChange={setCommandSearchQuery}
          searchValue={commandSearchQuery}
          searchPlaceholder="搜索指令 / 角色 / 内容..."
          saveStatus={saveStatus}
          autoSave={autoSaveEnabled}
          onAutoSaveChange={setAutoSaveEnabled}
          onSettings={() => setAppSettingsOpen(true)}
        />
        <StoryOsSideNav
          active={viewMode === 'worldline' ? 'world' : 'script'}
          projectId={projectId}
          projectLabel={gameName}
          onCreate={handleNewScene}
          onBeforeNavigate={guardedNavigate}
        />

        <div className="story-os-workspace flex flex-col">
        {viewMode === 'worldline' ? (
          <FullScreenWorldline
            scenes={projectInfo?.scenes ?? [currentSceneName]}
            currentSceneName={currentSceneName}
            sceneHeaders={sceneHeaders}
            sceneLinkMap={sceneLinkMap}
            nodes={nodes}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onOpenScene={stableSwitchScene}
            onClose={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('view');
              setSearchParams(next, { replace: true });
            }}
            characterColors={characterColors}
            onNewScene={handleNewScene}
            onDeleteScene={handleDeleteScene}
            onRenameScene={handleRenameScene}
            onOpenSceneManager={() => setSceneManagerOpen(true)}
            onDeleteNode={deleteNode}
            onJumpToIndex={jumpToNode}
          />
        ) : (
          <>
        {/* Main Content */}
        <div className="relative flex-1 flex overflow-hidden">
          <SceneWorldlinePanel
            scenes={projectInfo?.scenes ?? [currentSceneName]}
            currentSceneName={currentSceneName}
            sceneHeaders={sceneHeaders}
            sceneLinkMap={sceneLinkMap}
            nodes={nodes}
            selectedNode={selectedNode}
            onSelectNode={handleSelectNodeWithScroll}
            onOpenScene={stableSwitchScene}
            onOpenSceneManager={() => setSceneManagerOpen(true)}
            characterColors={characterColors}
            onDeleteNode={deleteNode}
            onJumpToIndex={jumpToNode}
          />

          {/* Center - Script Command Stream / Script Source */}
          {showScript ? (
            <div className="flex-1 flex flex-col bg-background/50">
              <div className="p-3 border-b border-border flex items-center justify-between">
                <span className="text-sm text-muted-foreground font-mono-family">
                  WebGAL 脚本编辑器 - {currentSceneName}
                </span>
                <button
                  onClick={handleApplyScript}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all text-sm"
                >
                  应用更改
                </button>
              </div>
              <textarea
                value={scriptSource}
                onChange={(e) => {
                  setScriptSource(e.target.value);
                  markDirty();
                }}
                className="flex-1 p-4 bg-transparent resize-none focus:outline-none text-sm leading-relaxed font-mono-family"
                spellCheck={false}
                aria-label="WebGAL 脚本编辑器"
              />
            </div>
          ) : (
            <ScriptCommandStream
              nodes={nodes}
              selectedNode={selectedNode}
              currentSceneName={currentSceneName}
              sceneHeaders={sceneHeaders}
              onSelectNode={setSelectedNode}
              onInsertNode={insertNode}
              onDeleteNode={deleteNode}
              onCopyNode={copyNode}
              onCutNode={cutNode}
              onPasteNode={pasteNode}
              onReorderNodes={reorderNodes}
              onJumpToIndex={jumpToNode}
              onCreateUnlockNode={createUnlockNode}
              clipboardNode={clipboardNode}
              characterColors={characterColors}
              characters={charactersForAi}
              searchQuery={commandSearchQuery}
              previewEntries={aiPreviewEntries}
              projectPath={projectPath ?? undefined}
            />
          )}

          <AiAssistantPanel
            aiAgent={aiAgent}
            projectPath={projectPath}
            sceneHeaders={sceneHeaders}
            sessionMenuOpen={sessionMenuOpen}
            onSessionMenuOpenChange={setSessionMenuOpen}
            onRenameSession={(session) => {
              setRenameTarget(session);
              setRenameValue(session.title);
            }}
            onDeleteSession={setDeleteTarget}
            onOpenSettings={() => setAiSettingsOpen(true)}
            onSend={handleAiSend}
          />

          {selectedNode && !showScript && (
            <div className="absolute bottom-0 right-80 top-0 z-30 w-80 border-l border-border bg-surface-container-lowest shadow-[-8px_0_24px_var(--shadow-soft)]">
              <DetailPanel
                node={selectedNode}
                onUpdateNode={updateSelectedNode}
                onDeleteNode={deleteSelectedNode}
                onClose={() => setSelectedNode(null)}
                characterNames={charactersForAi.map((character) => character.name)}
                projectPath={projectPath ?? undefined}
                characters={charactersForAi}
                projectId={projectId}
                scenes={projectInfo?.scenes ?? []}
                sceneHeaders={sceneHeaders}
              />
            </div>
          )}
        </div>

          <PerformanceTimeline
            nodes={nodes}
            selectedNodeId={selectedNode?.id}
            onSelectNode={(id) => {
              const found = nodes.find((node) => node.id === id);
              if (found) setSelectedNode(found);
            }}
          />
          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-outline-variant bg-surface-container px-4 text-[10px] text-on-surface-variant/40">
            <div className="flex items-center gap-4">
              <span>{scriptSource.length.toLocaleString()} 字</span>
              <span>约 {Math.max(1, Math.ceil(scriptSource.length / 380))} 分钟阅读量</span>
              <span className="h-3 w-px bg-outline-variant/30" />
              <span>UTF-8 | LF | Engine: WebGAL</span>
            </div>
          </footer>
          </>
        )}
        </div>

        <AiSettingsDialog
          open={aiSettingsOpen}
          onClose={() => setAiSettingsOpen(false)}
        />

        <ProjectMetadataDialog
          open={projectMetadataOpen}
          projectName={projectName}
          initialMetadata={projectMetadata}
          saving={metadataSaving}
          exportTask={exportTask}
          onClose={() => setProjectMetadataOpen(false)}
          onSave={handleSaveProjectMetadata}
          onExport={handleExportProjectWithMetadata}
          onRetryExport={handleRetryExportProject}
        />

        <SnapshotManagerDialog
          open={snapshotManagerOpen}
          snapshots={snapshots}
          busy={snapshotBusy}
          error={snapshotError}
          status={snapshotStatus}
          onClose={() => setSnapshotManagerOpen(false)}
          onRefresh={refreshSnapshots}
          onCreate={handleCreateSnapshot}
          onCreateExportCandidate={handleCreateExportCandidateSnapshot}
          onRestore={handleRestoreSnapshot}
          onRename={handleRenameSnapshot}
          onDelete={handleDeleteSnapshot}
        />

        <SceneManagerPanel
          open={sceneManagerOpen}
          onClose={() => setSceneManagerOpen(false)}
          projectPath={projectPath ?? ''}
          projectInfo={projectInfo}
          currentSceneName={currentSceneName}
          sceneHeaders={sceneHeaders}
          onSwitchScene={stableSwitchScene}
          onHeaderUpdated={handleHeaderUpdated}
          onRefreshProject={refreshProjectInfo}
          onNewScene={handleNewScene}
          onDeleteScene={handleDeleteScene}
        />

        <Dialog open={newSceneOpen} onOpenChange={(open) => {
          setNewSceneOpen(open);
          if (!open && !creatingScene) {
            setNewSceneName('');
            setNewSceneError('');
          }
        }}>
          <DialogContent className="max-w-md overflow-hidden border-border bg-surface-container-lowest p-0 shadow-2xl">
            <DialogHeader className="border-b border-border bg-surface-container px-5 py-4 text-left">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded border border-secondary/30 bg-secondary/10 text-secondary">
                  <FolderOpen className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <DialogTitle className="font-display-family text-base text-on-surface">新建场景</DialogTitle>
                  <DialogDescription className="mt-1 text-xs text-muted-foreground">
                    在 game/scene 下创建新的 WebGAL 场景脚本。
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-4 px-5 py-5">
              <label className="block space-y-2">
                <span className="font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
                  场景文件名
                </span>
                <div className="flex items-center rounded border border-border bg-surface-container-low focus-within:border-secondary">
                  <input
                    autoFocus
                    value={newSceneName}
                    onChange={(e) => {
                      setNewSceneName(e.target.value);
                      if (newSceneError) setNewSceneError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleCreateSceneConfirm();
                      }
                    }}
                    className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-on-surface outline-none placeholder:text-muted-foreground/60"
                    placeholder="chapter_02"
                    aria-label="场景文件名"
                    disabled={creatingScene}
                  />
                  {!newSceneName.trim().toLowerCase().endsWith('.txt') && (
                    <span className="border-l border-border px-3 font-mono-family text-xs text-muted-foreground">.txt</span>
                  )}
                </div>
              </label>
              <div className="rounded border border-outline-variant/30 bg-surface-container px-3 py-2">
                <div className="font-mono-family text-[10px] uppercase tracking-widest text-muted-foreground">预览</div>
                <div className="mt-1 truncate text-xs text-on-surface-variant">
                  game/scene/{newSceneName.trim() ? (newSceneName.trim().endsWith('.txt') ? newSceneName.trim() : `${newSceneName.trim()}.txt`) : 'chapter_02.txt'}
                </div>
              </div>
              {newSceneError && (
                <div className="flex items-start gap-2 rounded border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{newSceneError}</span>
                </div>
              )}
            </div>
            <DialogFooter className="border-t border-border bg-surface-container px-5 py-4">
              <button
                type="button"
                onClick={() => setNewSceneOpen(false)}
                disabled={creatingScene}
                className="rounded border border-border bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant transition-colors hover:border-outline-variant hover:text-on-surface disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => { void handleCreateSceneConfirm(); }}
                disabled={creatingScene || !newSceneName.trim()}
                className="flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {creatingScene ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                创建场景
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rename session — in-app dialog (Tauri has no native prompt). */}
        <Dialog open={renameTarget !== null} onOpenChange={(o) => { if (!o) setRenameTarget(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>重命名会话</DialogTitle>
            </DialogHeader>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameValue.trim() && renameTarget) {
                  aiAgent.renameSession(renameTarget.id, renameValue);
                  setRenameTarget(null);
                }
              }}
              className="w-full bg-input-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="会话名称"
              aria-label="会话名称"
            />
            <DialogFooter>
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="px-3 py-2 rounded-md bg-secondary text-sm hover:bg-secondary/70 transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!renameValue.trim()}
                onClick={() => { if (renameTarget) { aiAgent.renameSession(renameTarget.id, renameValue); setRenameTarget(null); } }}
                className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 transition-all disabled:opacity-50"
              >
                保存
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete session confirmation — in-app dialog. */}
        <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>删除会话</DialogTitle>
              <DialogDescription>
                确定删除会话「{deleteTarget?.title}」？此操作不可撤销。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-2 rounded-md bg-secondary text-sm hover:bg-secondary/70 transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => { if (deleteTarget) { aiAgent.removeSession(deleteTarget.id); setDeleteTarget(null); } }}
                className="px-3 py-2 rounded-md bg-destructive text-destructive-foreground text-sm hover:opacity-90 transition-all"
              >
                删除
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AppSettingsDialog
          open={appSettingsOpen}
          onClose={() => setAppSettingsOpen(false)}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
          onApplyRuntimeTemplateDir={(dir) => setRuntimeTemplateDir(dir)}
        />

        <AlertDialog open={unsavedConfirmOpen} onOpenChange={(open) => { if (!open) handleUnsavedCancel(); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>有未保存的更改</AlertDialogTitle>
              <AlertDialogDescription>
                当前场景有未保存的内容，离开后将会丢失。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleUnsavedCancel}>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { void handleUnsavedSaveAndLeave(); }}
                className="bg-primary text-primary-foreground"
              >
                保存并离开
              </AlertDialogAction>
              <AlertDialogAction
                onClick={handleUnsavedDiscard}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                直接离开
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

      </div>
    </DndProvider>
  );
}
