import { memo, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUp, Brain, Loader2, MessageSquarePlus, MoreHorizontal, Pencil, Square, Trash2, Wand2,
  Bot, Check, ChevronDown, Sliders,
} from 'lucide-react';
import type { SceneHeader } from '../../lib/webgal-ipc';
import { useChatModelSelection } from '../../hooks/useChatModelSelection';
import { useAiAgent } from '../../hooks/useAiAgent';
import { AiMessageBubble } from '../AiMessageBubble';
import { ChangeSetCard } from '../AiPendingCard';
import { ConflictCard, ErrorCard, MissingAssetCard } from '../AiStatusCard';
import { AiAttachmentTray, AiUploadsButton } from '../AiUploadsPanel';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog';

interface AiAssistantPanelProps {
  aiAgent: ReturnType<typeof useAiAgent>;
  projectPath: string | null;
  sceneHeaders: Record<string, SceneHeader>;
  onOpenSettings: () => void;
  onOpenMemory: () => void;
  onSend: (text: string) => void;
  embedded?: boolean;
  disabled?: boolean;
}

interface AiInputBoxProps {
  /** Programmatic seed from the agent (prefill on regenerate, clear after send). */
  value: string;
  busy: boolean;
  locked: boolean;
  pending: boolean;
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
const AiInputBox = memo(function AiInputBox({ value, busy, locked, pending, onSubmit, onStop, attachSlot, modelSlot, traySlot }: AiInputBoxProps) {
  const [draft, setDraft] = useState(value);
  // Sync when the agent changes input externally (regenerate prefills, send clears).
  useEffect(() => { setDraft(value); }, [value]);

  const submit = () => {
    if (locked) return;
    if (busy) { onStop(); return; }
    const text = draft.trim();
    if (!text || pending) return;
    onSubmit(text);
    setDraft('');
  };

  return (
    <>
      {traySlot}
      <div className="relative mt-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          disabled={busy || locked || pending}
          className="h-24 w-full resize-none rounded-lg border border-border bg-surface-container-lowest p-2.5 pb-10 text-sm focus:border-secondary focus:outline-none focus:ring-2 focus:ring-secondary-container/30 disabled:opacity-60"
          placeholder={busy ? '生成中...' : pending ? '请先同意或拒绝当前 AI 修改...' : '输入你的创作想法...'}
          aria-label="AI 创作输入"
        />
        {(attachSlot || modelSlot) && (
          <div className="absolute bottom-3 left-2.5 flex items-center gap-1.5">
            {attachSlot}
            {modelSlot}
          </div>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={locked || (!busy && (!draft.trim() || pending))}
          className="absolute bottom-3 right-2.5 flex h-6 w-6 items-center justify-center rounded-full bg-secondary-container text-black transition-colors hover:bg-secondary-container/80 disabled:opacity-40"
          aria-label={busy ? '停止生成' : '发送（Enter）'}
          title={busy ? '停止生成' : '发送（Enter）'}
        >
          {busy ? <Square className="h-3 w-3 fill-current" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </button>
      </div>
    </>
  );
});

export function AiAssistantPanel({
  aiAgent,
  projectPath,
  sceneHeaders,
  onOpenSettings,
  onOpenMemory,
  onSend,
  embedded = false,
  disabled = false,
}: AiAssistantPanelProps) {
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const modelSelection = useChatModelSelection();
  const { config: chatConfig, catalog } = modelSelection;

  const currentProvider = chatConfig?.provider ?? '';
  const currentModel = chatConfig?.model ?? '';
  const activeProviderOption = catalog?.chat.find((p) => p.value === currentProvider);
  const availableModels = activeProviderOption?.models?.length
    ? activeProviderOption.models
    : activeProviderOption?.defaultModel
      ? [activeProviderOption.defaultModel]
      : currentModel
        ? [currentModel]
        : [];

  const activeSession = aiAgent.sessions.find((session) => session.id === aiAgent.activeId);

  return (
    <aside className={`flex min-h-0 flex-1 flex-col bg-surface-container-lowest ${embedded ? 'w-full' : 'w-80 shrink-0 border-l border-border'}`}>
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary-container/35 text-[var(--nav-active)]">
            <Wand2 className="h-3.5 w-3.5" />
          </div>
          <span className="truncate text-sm font-semibold text-on-surface" title={activeSession?.title}>
            {activeSession?.title ?? 'AI 创作助手'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onOpenMemory} disabled={!projectPath || aiAgent.committing} className="ollaic-icon-button h-7 w-7 disabled:opacity-40" aria-label="管理项目记忆" title="项目记忆"><Brain className="h-4 w-4" /></button>
          <button
            type="button"
            onClick={aiAgent.startNewSession}
            disabled={aiAgent.busy || aiAgent.committing}
            className="ollaic-icon-button h-7 w-7 disabled:opacity-40"
            aria-label="新建 AI 会话"
            title="新建会话"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
          <DropdownMenu open={sessionMenuOpen} onOpenChange={setSessionMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={aiAgent.busy || aiAgent.committing}
                className="ollaic-icon-button h-7 w-7 text-foreground disabled:opacity-40"
                aria-label="AI 会话管理"
                title="会话管理"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={() => { setSessionMenuOpen(false); aiAgent.startNewSession(); }}>
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
                    onClick={() => { setSessionMenuOpen(false); aiAgent.selectSession(session.id); }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSessionMenuOpen(false);
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
                        setSessionMenuOpen(false);
                        setRenameTarget(session);
                        setRenameValue(session.title);
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
                        setSessionMenuOpen(false);
                        setDeleteTarget(session);
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
              attachments={message.attachments}
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

      <div className="border-t border-border bg-surface-container-low p-4">
        <AiInputBox
          value={aiAgent.input}
          busy={aiAgent.busy}
          locked={aiAgent.committing || disabled}
          pending={aiAgent.pendingChangeSet?.status === 'pending'}
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
                  className="flex h-6 items-center gap-1 rounded-full border border-border bg-surface-container-low px-2 text-[11px] font-mono-family text-muted-foreground hover:bg-secondary-container/60 hover:text-foreground transition-colors disabled:opacity-40"
                  title={`当前对话模型: ${currentModel || '默认'}`}
                  aria-label="切换对话模型"
                >
                  <Bot className="h-3 w-3 text-primary" />
                  <span className="max-w-[110px] truncate">
                    {modelSelection.switching ? '切换中…' : currentModel || '选择模型'}
                  </span>
                  <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-56">
                <DropdownMenuLabel className="text-xs">
                  当前供应商: {activeProviderOption?.label || currentProvider || '默认'}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
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
                  <div className="px-2 py-1 text-xs text-muted-foreground">暂无可切换的预设模型</div>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onOpenSettings}
                  className="text-xs text-primary cursor-pointer"
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
            className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
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
