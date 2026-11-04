import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp, Brain, Loader2, MessageSquarePlus, MoreHorizontal, Pencil, Square, Trash2, Wand2,
  Bot, Check, ChevronDown, Pin, Sliders, Sparkles, Workflow, X,
} from 'lucide-react';
import type { SceneHeader } from '../../lib/webgal-ipc';
import type { WebGalNode } from '../../lib/webgal-types';
import { useChatModelSelection } from '../../hooks/useChatModelSelection';
import { useAiAgent } from '../../hooks/useAiAgent';
import { getConfiguredModels } from '../../lib/ai-models';
import type { useFlowRunController } from '../../hooks/useFlowRunController';
import { AiMessageBubble } from '../AiMessageBubble';
import { ChangeSetCard } from '../AiPendingCard';
import { ConflictCard, ErrorCard, MissingAssetCard } from '../AiStatusCard';
import { AiAttachmentTray, AiUploadsButton } from '../AiUploadsPanel';
import { WorkflowPlanCard } from './WorkflowPlanCard';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog';

export interface AiAssistantPanelProps {
  aiAgent: ReturnType<typeof useAiAgent>;
  projectPath: string | null;
  sceneHeaders: Record<string, SceneHeader>;
  currentSceneName?: string;
  selectedNode?: WebGalNode | null;
  selectedNodeIndex?: number;
  onClearContext?: () => void;
  onClose?: () => void;
  onToggleWorkflowBoard?: () => void;
  onInsertSnippet?: (text: string) => void;
  onDiffSnippet?: (text: string) => void;
  onOpenSettings: () => void;
  onOpenMemory: () => void;
  onSend: (text: string) => void;
  workflowController?: ReturnType<typeof useFlowRunController>;
  onOpenWorkflowBoard?: () => void;
  onPreviewScene?: (sceneId: string) => void;
  embedded?: boolean;
  disabled?: boolean;
}

interface SlashCommand {
  name: string;
  label: string;
  description: string;
  insert: string;
  triggerPlanMode?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/workflow',
    label: '/workflow <故事企划>',
    description: '启动 Stage 1 立项企划与角色视觉定锚',
    insert: '/workflow ',
    triggerPlanMode: true,
  },
  {
    name: '/scene',
    label: '/scene <场景ID>',
    description: '启动 Stage 2 生产指定场景的脚本与素材',
    insert: '/scene ',
  },
  {
    name: '/plan',
    label: '/plan',
    description: '查看全剧企划状态与分场概览',
    insert: '/plan',
  },
  {
    name: '/help',
    label: '/help',
    description: '查看可用指令说明',
    insert: '/help',
  },
];

interface AiInputBoxProps {
  /** Programmatic seed from the agent (prefill on regenerate, clear after send). */
  value: string;
  busy: boolean;
  locked: boolean;
  pending: boolean;
  isPlanMode: boolean;
  onTogglePlanMode: () => void;
  onSubmit: (text: string) => void;
  onStop: () => void;
  /** Rendered at the bottom-right corner inside the textarea. */
  attachSlot?: ReactNode;
  modelSlot?: ReactNode;
  /** Rendered above the textarea for files queued with the next message. */
  traySlot?: ReactNode;
}

// Keeps the draft in local state so typing only re-renders this small box,
// not the whole StoryEditor tree (script list, worldline, timeline, ...).
const AiInputBox = memo(function AiInputBox({
  value,
  busy,
  locked,
  pending,
  isPlanMode,
  onTogglePlanMode,
  onSubmit,
  onStop,
  attachSlot,
  modelSlot,
  traySlot,
}: AiInputBoxProps) {
  const [draft, setDraft] = useState(value);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync when the agent changes input externally (regenerate prefills, send clears).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const matchingCommands = draft.startsWith('/') && !draft.includes(' ')
    ? SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(draft.split(' ')[0]))
    : [];

  useEffect(() => {
    if (matchingCommands.length > 0) {
      setSlashMenuOpen(true);
      setSlashIndex(0);
    } else {
      setSlashMenuOpen(false);
    }
  }, [draft, matchingCommands.length]);

  const applySlashCommand = (cmd: SlashCommand) => {
    if (cmd.triggerPlanMode && !isPlanMode) {
      onTogglePlanMode();
    }
    setDraft(cmd.insert);
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  };

  const submit = () => {
    if (locked) return;
    if (busy) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text || pending) return;

    if (isPlanMode && !text.startsWith('/')) {
      onSubmit(`/workflow ${text}`);
    } else {
      onSubmit(text);
    }
    setDraft('');
    setSlashMenuOpen(false);
  };

  return (
    <>
      {traySlot}
      <div className="relative mt-1">
        {/* Slash Command Suggestions Palette */}
        {slashMenuOpen && matchingCommands.length > 0 && (
          <div
            role="listbox"
            aria-label="快捷指令菜单"
            className="absolute bottom-full left-0 mb-1.5 w-72 rounded-lg border border-border bg-surface-container-lowest p-1 shadow-md z-30"
          >
            <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground border-b border-border/50">
              快捷指令（Enter 或点击插入）
            </div>
            {matchingCommands.map((cmd, idx) => (
              <button
                key={cmd.name}
                type="button"
                role="option"
                aria-selected={idx === slashIndex}
                onClick={() => applySlashCommand(cmd)}
                className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  idx === slashIndex ? 'bg-secondary-container/60 text-foreground' : 'text-muted-foreground hover:bg-surface-container-low'
                }`}
              >
                <span className="font-mono font-medium text-foreground">{cmd.label}</span>
                <span className="text-[10px] text-muted-foreground">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (slashMenuOpen && matchingCommands.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashIndex((prev) => (prev + 1) % matchingCommands.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashIndex((prev) => (prev - 1 + matchingCommands.length) % matchingCommands.length);
                return;
              }
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault();
                applySlashCommand(matchingCommands[slashIndex]);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setSlashMenuOpen(false);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          disabled={busy || locked || pending}
          className="h-24 w-full resize-none rounded-lg border border-border bg-surface-container-lowest p-2.5 pb-10 text-sm focus:border-secondary disabled:opacity-60"
          placeholder={
            busy
              ? '生成中...'
              : pending
                ? '请先同意或拒绝当前 AI 修改...'
                : isPlanMode
                  ? '[规划模式] 输入全剧企划、修改设定，或安排分场制作...'
                  : '输入你的创作想法...（输入 / 可用工作流指令）'
          }
          aria-label="AI 创作输入"
        />
        {(attachSlot || modelSlot) && (
          <div className="absolute bottom-2.5 left-2.5 right-11 flex min-w-0 items-center gap-1.5 overflow-hidden">
            {attachSlot}
            <button
              type="button"
              onClick={onTogglePlanMode}
              disabled={locked || busy}
              className={`flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                isPlanMode
                  ? 'border-primary/40 bg-primary/15 text-primary shadow-xs'
                  : 'border-border bg-surface-container-low text-muted-foreground hover:bg-secondary-container/60 hover:text-foreground'
              }`}
              title="规划模式：触发 Stage 1 企划定锚或全剧规划 (/workflow)"
              aria-pressed={isPlanMode}
            >
              <Sparkles className="h-3 w-3 shrink-0" />
              <span className="hidden xs:inline">规划模式</span>
            </button>
            <div className="min-w-0 flex-1 truncate">{modelSlot}</div>
          </div>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={locked || (!busy && (!draft.trim() || pending))}
          className="absolute bottom-2.5 right-2.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary-container text-black transition-colors hover:bg-secondary-container/80 disabled:opacity-40"
          aria-label={busy ? '停止生成' : '发送（Enter）'}
          title={busy ? '停止生成' : '发送（Enter）'}
        >
          {busy ? <Square className="h-3 w-3 fill-current" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </button>
      </div>
    </>
  );
});

function getNodeTypeLabel(node: WebGalNode | null | undefined): string {
  if (!node) return '行';
  switch (node.type) {
    case 'dialogue':
      return node.character ? `${node.character} 对白` : '对白';
    case 'changeBg':
      return '背景';
    case 'changeFigure':
      return '立绘';
    case 'bgm':
      return '音乐';
    case 'playEffect':
      return '音效';
    case 'choose':
      return '分支';
    case 'changeScene':
      return '跳转';
    case 'comment':
      return '注释';
    case 'intro':
      return '黑底字';
    case 'setVar':
      return '变量';
    default:
      return node.type;
  }
}

export function AiAssistantPanel({
  aiAgent,
  projectPath,
  sceneHeaders,
  currentSceneName,
  selectedNode,
  selectedNodeIndex,
  onClearContext,
  onClose,
  onToggleWorkflowBoard,
  onInsertSnippet,
  onDiffSnippet,
  onOpenSettings,
  onOpenMemory,
  onSend,
  workflowController,
  onOpenWorkflowBoard,
  onPreviewScene,
  embedded = false,
  disabled = false,
}: AiAssistantPanelProps) {
  const [isPlanMode, setIsPlanMode] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const modelSelection = useChatModelSelection();
  const { config: chatConfig, catalog } = modelSelection;

  const currentProvider = chatConfig?.provider ?? '';
  const currentModel = chatConfig?.model ?? '';
  const activeProviderOption = catalog?.chat.find((p) => p.value === currentProvider);
  // Only models the user added to this provider's pool in AI settings are
  // switchable here, not the provider's full preset list.
  const availableModels = chatConfig ? getConfiguredModels(chatConfig) : [];

  const activeSession = aiAgent.sessions.find((session) => session.id === aiAgent.activeId);

  const [contextScope, setContextScope] = useState<'node' | 'scene' | 'full'>('node');

  useEffect(() => {
    if (selectedNode) {
      setContextScope('node');
    }
  }, [selectedNode?.id]);

  const nodeIndexLabel =
    selectedNodeIndex !== undefined && selectedNodeIndex >= 0
      ? String(selectedNodeIndex + 1).padStart(2, '0')
      : '01';
  const nodeTypeLabel = getNodeTypeLabel(selectedNode);
  const sceneChapter = currentSceneName ? sceneHeaders?.[currentSceneName]?.chapter : '';

  return (
    <aside className={`flex min-h-0 flex-1 flex-col bg-surface-container-lowest ${embedded ? 'w-full' : 'w-80 shrink-0 border-l border-border'}`}>
      {/* Solid Single-line Header (Height 40px) */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3 gap-2 bg-surface-container-low/80 select-none">
        {/* Left: Assistant Session Dropdown */}
        <DropdownMenu open={sessionMenuOpen} onOpenChange={setSessionMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={aiAgent.busy || aiAgent.committing}
              className="flex min-w-0 max-w-[170px] sm:max-w-[200px] items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-foreground hover:bg-surface-container transition-colors disabled:opacity-50"
              title={`当前会话: ${activeSession?.title || '新对话'} (点击切换历史)`}
              aria-label="切换 Agent 会话"
            >
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Bot className="size-3.5" />
              </div>
              <span className="truncate text-xs font-bold text-foreground">
                Agent · {activeSession?.title ?? '新对话'}
              </span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuItem
              onClick={() => {
                setSessionMenuOpen(false);
                aiAgent.startNewSession();
              }}
              className="cursor-pointer"
            >
              <MessageSquarePlus className="h-4 w-4 mr-1.5 text-primary" />
              <span>新建会话</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">历史会话</DropdownMenuLabel>
            <div className="max-h-64 overflow-y-auto">
              {aiAgent.sessions.map((session) => (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setSessionMenuOpen(false);
                    aiAgent.selectSession(session.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSessionMenuOpen(false);
                      aiAgent.selectSession(session.id);
                    }
                  }}
                  className={`group flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-foreground hover:bg-secondary-container/45 ${
                    session.id === aiAgent.activeId ? 'bg-secondary-container/50 font-semibold' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  {session.id === aiAgent.activeId && (
                    <Check className="h-3.5 w-3.5 text-primary shrink-0 mr-0.5" />
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSessionMenuOpen(false);
                      setRenameTarget(session);
                      setRenameValue(session.title);
                    }}
                    className="shrink-0 rounded p-0.5 text-foreground opacity-60 hover:bg-secondary-container hover:opacity-100"
                    aria-label="重命名会话"
                    title="重命名"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSessionMenuOpen(false);
                      setDeleteTarget(session);
                    }}
                    className="shrink-0 rounded p-0.5 text-foreground opacity-60 hover:bg-error-container hover:text-on-error-container hover:opacity-100"
                    aria-label="删除会话"
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Center: Quiet, leaving airy space */}
        <div className="min-w-0 flex-1" />

        {/* Right: Actions Group: [+], [🧠], [✕] */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={aiAgent.startNewSession}
            disabled={aiAgent.busy || aiAgent.committing}
            className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-surface-container transition-all disabled:opacity-40"
            aria-label="新建会话"
            title="新建对话 (+)"
          >
            <MessageSquarePlus className="size-4" />
          </button>
          <button
            type="button"
            onClick={onOpenMemory}
            disabled={!projectPath || aiAgent.committing}
            className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-surface-container transition-all disabled:opacity-40"
            aria-label="设定集与世界观记忆库"
            title="角色卡与设定集记忆库"
          >
            <Brain className="size-4 text-primary" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-surface-container transition-all"
              aria-label="收起面板"
              title="收起 AI 面板"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Persistent Context Tag (升级为行级响应式交互芯片) */}
      {currentSceneName && (
        <div className="flex h-7 shrink-0 items-center justify-between border-b border-border/50 bg-surface-container-lowest px-3 text-[11px] text-muted-foreground select-none">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-[10px] opacity-70">关联:</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary hover:bg-primary/20 transition-all cursor-pointer shadow-2xs"
                  title="点击切换 AI 上下文关联范围"
                  aria-label="切换上下文关联范围"
                >
                  <Pin className="size-2.5 text-primary shrink-0" />
                  <span className="font-mono font-semibold">
                    {contextScope === 'node' && selectedNode
                      ? `Line ${nodeIndexLabel} [${nodeTypeLabel}]`
                      : contextScope === 'scene'
                        ? `场景 (${sceneChapter || currentSceneName.replace(/\.txt$/, '')})`
                        : `全文 (${currentSceneName.replace(/\.txt$/, '')}.txt)`}
                  </span>
                  <ChevronDown className="size-2.5 opacity-70 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 text-xs">
                <DropdownMenuLabel className="text-[10.5px] text-muted-foreground">AI 关联范围</DropdownMenuLabel>
                {selectedNode && (
                  <DropdownMenuItem
                    onClick={() => setContextScope('node')}
                    className="flex items-center justify-between cursor-pointer text-xs"
                  >
                    <span className="font-mono">当前选中项 (Line {nodeIndexLabel} · {nodeTypeLabel})</span>
                    {contextScope === 'node' && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => setContextScope('scene')}
                  className="flex items-center justify-between cursor-pointer text-xs"
                >
                  <span>仅当前场景 ({sceneChapter || currentSceneName.replace(/\.txt$/, '')})</span>
                  {contextScope === 'scene' && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setContextScope('full')}
                  className="flex items-center justify-between cursor-pointer text-xs"
                >
                  <span>全文范围 ({currentSceneName})</span>
                  {contextScope === 'full' && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                {selectedNode && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        setContextScope('full');
                        onClearContext?.();
                      }}
                      className="text-muted-foreground cursor-pointer text-xs"
                    >
                      <X className="size-3 mr-1" />
                      <span>清除选中行</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="text-[10px] text-muted-foreground/60 font-mono">
            {contextScope === 'node' && selectedNode ? '行级聚焦' : '场景级'}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {workflowController && (
          <WorkflowPlanCard
            controller={workflowController}
            onOpenWorkflowBoard={onOpenWorkflowBoard}
            onPreviewScene={onPreviewScene}
          />
        )}
        {aiAgent.messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <AiMessageBubble
              role={message.role}
              content={message.content}
              steps={message.steps}
              isStreaming={aiAgent.streamingIdRef.current === message.id && aiAgent.busy}
              stopped={message.stopped}
              diff={message.diff}
              attachments={message.attachments}
              onInsertSnippet={onInsertSnippet}
              onDiffSnippet={onDiffSnippet}
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
            committing={aiAgent.committing}
            onAccept={() => { void aiAgent.acceptChange(); }}
            onRevert={aiAgent.revertChange}
          />
        )}
        {aiAgent.status === 'conflict' && (
          <ConflictCard
            committing={aiAgent.committing}
            onKeepManual={aiAgent.revertChange}
            onApplyAi={() => { void aiAgent.forceApplyChange(); }}
            onRegenerate={aiAgent.regenerateAfterConflict}
          />
        )}
        {aiAgent.status === 'missing_assets' && aiAgent.missingIssues.length > 0 && (
          <MissingAssetCard
            issues={aiAgent.missingIssues}
            onUseFallback={aiAgent.useFallbackAssets}
            onOpenAssets={aiAgent.openAssets}
            onRetryPrompt={aiAgent.retryWithExistingAssets}
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

      <div className="border-t border-border bg-surface-container-low p-3.5">
        <AiInputBox
          value={aiAgent.input}
          busy={aiAgent.busy}
          locked={aiAgent.committing || disabled}
          pending={aiAgent.pendingChangeSet?.status === 'pending'}
          isPlanMode={isPlanMode}
          onTogglePlanMode={() => setIsPlanMode((v) => !v)}
          onSubmit={onSend}
          onStop={aiAgent.stop}
          attachSlot={(
            <AiUploadsButton
              uploads={aiAgent.uploads}
              attachedIds={aiAgent.attachedIds}
              busy={aiAgent.uploadBusy}
              error={aiAgent.uploadError}
              disabled={!projectPath || disabled}
              onAdd={aiAgent.addUploads}
              onAttach={aiAgent.attachUpload}
              onDetach={aiAgent.detachUpload}
              onRemove={aiAgent.removeUpload}
              onPreview={aiAgent.previewUpload}
              onDismissError={aiAgent.clearUploadError}
            />
          )}
          modelSlot={(
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) void modelSelection.refresh();
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={aiAgent.busy || aiAgent.committing || modelSelection.switching}
                  className="flex h-6 min-w-0 max-w-[100px] xs:max-w-[125px] sm:max-w-[145px] items-center gap-1 rounded-full border border-border bg-surface-container-low px-2 text-[11px] font-mono-family text-muted-foreground hover:bg-secondary-container/60 hover:text-foreground transition-colors disabled:opacity-40"
                  title={`当前对话模型: ${currentModel || '默认'}`}
                  aria-label="切换对话模型"
                >
                  <Bot className="h-3 w-3 shrink-0 text-primary" />
                  <span className="min-w-0 truncate">
                    {modelSelection.switching ? '切换中…' : currentModel || '选择模型'}
                  </span>
                  <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-56 max-h-80 flex flex-col">
                <DropdownMenuLabel className="text-xs shrink-0">
                  当前供应商: {activeProviderOption?.label || currentProvider || '默认'}
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="shrink-0" />
                <div className="min-h-0 flex-1 overflow-y-auto pr-0.5 max-h-56">
                  {availableModels.length > 0 ? (
                    availableModels.map((m) => (
                      <DropdownMenuItem
                        key={m}
                        disabled={modelSelection.loading || modelSelection.switching}
                        onSelect={() => {
                          void modelSelection.switchModel(m);
                        }}
                        className={`flex items-center justify-between text-xs cursor-pointer ${
                          m === currentModel ? 'font-bold text-primary bg-primary/10' : ''
                        }`}
                      >
                        <span className="truncate">{m}</span>
                        {m === currentModel && <Check className="h-3.5 w-3.5 ml-1 text-primary shrink-0" />}
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <div className="px-2 py-1 text-xs text-muted-foreground">模型池为空，请在 AI 设置中添加模型</div>
                  )}
                </div>
                <DropdownMenuSeparator className="shrink-0" />
                <DropdownMenuItem
                  onClick={onOpenSettings}
                  className="text-xs text-primary cursor-pointer shrink-0"
                >
                  <Sliders className="h-3.5 w-3.5 mr-1.5" />
                  <span>配置更多服务商与模型…</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          traySlot={(
            <AiAttachmentTray
              uploads={aiAgent.uploads}
              attachedIds={aiAgent.attachedIds}
              onDetach={aiAgent.detachUpload}
            />
          )}
        />
        {modelSelection.error && (
          <div role="alert" className="mt-2 flex items-center gap-2 text-xs text-destructive">
            <span>{modelSelection.error}</span>
            <button type="button" onClick={onOpenSettings} className="shrink-0 underline">
              打开 AI 设置
            </button>
          </div>
        )}
      </div>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && renameValue.trim() && renameTarget) {
                aiAgent.renameSession(renameTarget.id, renameValue);
                setRenameTarget(null);
              }
            }}
            className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm"
            placeholder="会话名称"
            aria-label="会话名称"
          />
          <DialogFooter>
            <button type="button" onClick={() => setRenameTarget(null)} className="rounded-md bg-secondary px-3 py-2 text-sm transition-colors hover:bg-secondary/70">
              取消
            </button>
            <button
              type="button"
              disabled={!renameValue.trim()}
              onClick={() => {
                if (!renameTarget) return;
                aiAgent.renameSession(renameTarget.id, renameValue);
                setRenameTarget(null);
              }}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground transition-all hover:opacity-90 disabled:opacity-50"
            >
              保存
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>
              确定删除会话「{deleteTarget?.title}」？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" onClick={() => setDeleteTarget(null)} className="rounded-md bg-secondary px-3 py-2 text-sm transition-colors hover:bg-secondary/70">
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                if (!deleteTarget) return;
                aiAgent.removeSession(deleteTarget.id);
                setDeleteTarget(null);
              }}
              className="rounded-md bg-destructive px-3 py-2 text-sm text-destructive-foreground transition-all hover:opacity-90"
            >
              删除
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
