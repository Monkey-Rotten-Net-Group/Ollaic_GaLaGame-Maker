import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Braces,
  Clock3,
  Eye,
  GitBranch,
  History,
  ListTree,
  Loader2,
  PencilLine,
  RotateCcw,
  SkipForward,
  SquareArrowOutUpRight,
  Trash2,
  Upload,
  Workflow,
  X,
} from 'lucide-react';
import type { FlowStepView } from '../lib/flow-state';
import { isAssetQueueStep } from '../lib/pipeline-types';
import type { AssetQueueState, AssetTaskStatus, StepStatus } from '../lib/pipeline-types';
import type { PipelineEventRecord } from './PipelineEventLedger';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { cn } from './ui/utils';

const STATUS: Record<StepStatus, { label: string; className: string }> = {
  pending: { label: '待运行', className: 'bg-muted-foreground' },
  running: { label: '运行中', className: 'bg-blue-500' },
  succeeded: { label: '已完成', className: 'bg-emerald-500' },
  failed: { label: '失败', className: 'bg-destructive' },
  awaitingInput: { label: '待输入', className: 'bg-amber-500' },
  skipped: { label: '已跳过', className: 'bg-muted-foreground' },
};

const ASSET_STATUS: Record<AssetTaskStatus, { label: string; className: string }> = {
  pending: { label: '等待', className: 'bg-muted-foreground' },
  running: { label: '生成中', className: 'bg-blue-500' },
  retrying: { label: '重试中', className: 'bg-amber-500' },
  succeeded: { label: '已完成', className: 'bg-emerald-500' },
  failed: { label: '失败', className: 'bg-destructive' },
};

export interface FlowStepInspectorProps {
  selected: FlowStepView | null;
  busy: boolean;
  detached: boolean;
  onClose: () => void;
  onRetry: (stepId: string) => void;
  onSkip: (stepId: string) => void;
  onPromptRerun: (stepId: string, prompt: string) => void;
  onOpenArtifact?: (step: FlowStepView) => void;
  events?: readonly PipelineEventRecord[];
  assetQueue?: AssetQueueState | null;
  onPreviewAssetArtifact?: (taskId: string, attempt: number) => Promise<string>;
  onDeleteAssetArtifact?: (taskId: string, attempt: number) => Promise<void>;
  onPromoteAssetArtifact?: (taskId: string, attempt: number) => Promise<void>;
}

function formatted(value: string | null | undefined) {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function duration(ms: number | null | undefined) {
  if (ms == null) return '未完成';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function timestamp(value: number | null | undefined) {
  if (value == null) return '未记录';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function DataBlock({ value, tone = 'default' }: { value: string; tone?: 'default' | 'error' }) {
  return (
    <pre
      className={cn(
        'max-h-72 overflow-auto whitespace-pre-wrap break-words border border-border/70 bg-surface-container-lowest p-3 font-mono-family text-[11px] leading-5',
        tone === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'text-foreground/85',
      )}
    >
      {formatted(value)}
    </pre>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 font-mono-family text-[10px] font-semibold text-muted-foreground">{children}</h3>;
}

export function FlowStepInspector({
  selected,
  busy,
  detached,
  onClose,
  onRetry,
  onSkip,
  onPromptRerun,
  onOpenArtifact,
  events = [],
  assetQueue = null,
  onPreviewAssetArtifact,
  onDeleteAssetArtifact,
  onPromoteAssetArtifact,
}: FlowStepInspectorProps) {
  const [promptDraft, setPromptDraft] = useState(selected?.prompt ?? '');
  const [artifactBusy, setArtifactBusy] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, string>>({});

  useEffect(() => {
    setPromptDraft(selected?.prompt ?? '');
    setArtifactBusy(null);
    setArtifactError(null);
    setArtifactPreviews({});
  }, [selected?.id, selected?.prompt]);

  if (!selected) return null;

  const state = STATUS[selected.status];
  const stepEvents = events.filter((record) => (
    'stepId' in record.event && record.event.stepId === selected.id
  ));
  const showAssetQueue = selected.kind === 'asset' && isAssetQueueStep(selected);
  const runArtifactAction = async (key: string, action: () => Promise<void>) => {
    setArtifactBusy(key);
    setArtifactError(null);
    try {
      await action();
    } catch (error) {
      setArtifactError(String(error));
    } finally {
      setArtifactBusy(null);
    }
  };

  return (
    <aside
      aria-label={`${selected.id} 步骤检查器`}
      className="flex h-full min-h-0 flex-col border-l border-border bg-surface-container-lowest"
    >
      <header className="shrink-0 border-b border-border bg-surface-container-low px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 border border-border bg-surface-container p-1.5 text-primary">
            <Workflow className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-semibold">{selected.id}</h2>
              <span className="shrink-0 font-mono-family text-[10px] text-muted-foreground">{selected.kind}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={cn('size-1.5 shrink-0 rounded-full', state.className)} aria-hidden="true" />
              <span>{state.label}</span>
              <span aria-hidden="true">/</span>
              <span>尝试 {selected.attempt}</span>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="关闭步骤检查器" autoFocus>
            <X />
          </Button>
        </div>
      </header>

      <Tabs defaultValue="details" className="min-h-0 flex-1 gap-0">
        <TabsList className="h-10 w-full shrink-0 justify-start rounded-none border-b border-border bg-surface-container-lowest p-0">
          <TabsTrigger value="details" className="h-10 rounded-none border-0 px-4 text-xs data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent">
            <GitBranch /> 详情
          </TabsTrigger>
          <TabsTrigger value="output" className="h-10 rounded-none border-0 px-4 text-xs data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent">
            <Braces /> 输出
          </TabsTrigger>
          <TabsTrigger value="history" className="h-10 rounded-none border-0 px-4 text-xs data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent">
            <History /> 记录
          </TabsTrigger>
          <TabsTrigger value="logs" className="h-10 rounded-none border-0 px-4 text-xs data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent">
            <ListTree /> 日志
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="space-y-5 p-4">
              <section>
                <SectionLabel>依赖</SectionLabel>
                {selected.dependsOn.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.dependsOn.map((dependency) => (
                      <code key={dependency} className="border border-border bg-surface-container-low px-2 py-1 text-[11px] text-foreground">
                        {dependency}
                      </code>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">无</p>
                )}
              </section>

              <section>
                <SectionLabel>Prompt</SectionLabel>
                <Textarea
                  value={promptDraft}
                  onChange={(event) => setPromptDraft(event.target.value)}
                  placeholder="留空时沿用 Production Brief"
                  aria-label={`${selected.id} 步骤 Prompt`}
                  className="min-h-28 rounded-sm bg-surface-container-lowest font-mono-family text-[11px] leading-5"
                  disabled={selected.status === 'running' || busy}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={busy || selected.status === 'running' || promptDraft === selected.prompt}
                  onClick={() => onPromptRerun(selected.id, promptDraft)}
                >
                  <PencilLine /> 保存并重跑
                </Button>
              </section>

              {selected.error && (
                <section>
                  <SectionLabel>错误</SectionLabel>
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium text-destructive">
                    <AlertTriangle className="size-3.5" aria-hidden="true" />
                    执行失败
                  </div>
                  <DataBlock value={selected.error} tone="error" />
                </section>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="output" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="space-y-5 p-4">
              {showAssetQueue && (
                <section>
                  <SectionLabel>资产任务</SectionLabel>
                  {artifactError && (
                    <div role="alert" className="mb-3 flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      <span className="break-words">{artifactError}</span>
                    </div>
                  )}
                  {assetQueue?.tasks.length ? (
                    <ol className="divide-y divide-border border border-border" aria-label="资产任务列表">
                      {assetQueue.tasks.map((task) => {
                        const status = ASSET_STATUS[task.status];
                        const error = task.error ?? task.attempts[task.attempts.length - 1]?.error;
                        return (
                          <li key={task.id} className="space-y-2 bg-surface-container-lowest p-3 text-xs">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={cn('size-1.5 shrink-0 rounded-full', status.className)} aria-hidden="true" />
                              <strong className="min-w-0 flex-1 truncate" title={task.targetStem}>{task.targetStem}</strong>
                              <span className="shrink-0 text-[10px] text-muted-foreground">{task.kind} · {status.label}</span>
                            </div>
                            <p className="break-words leading-5 text-foreground/85">{task.prompt}</p>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono-family text-[10px] text-muted-foreground">
                              <span>场景 {task.sceneRef || '未指定'}</span>
                              {task.characterRef && <span>角色 {task.characterRef}</span>}
                              <span>重试 {Math.max(0, task.attempts.length - 1)}</span>
                            </div>
                            {task.assetFile && <p className="break-all font-mono-family text-[10px] text-emerald-700 dark:text-emerald-400">正式素材 {task.assetFile}</p>}
                            {task.attempts.filter((attempt) => attempt.artifact).map((attempt) => {
                              const key = `${task.id}:${attempt.attempt}`;
                              const preview = artifactPreviews[key];
                              return (
                                <div key={key} className="space-y-2 border-t border-border/70 pt-2">
                                  <p className="break-all font-mono-family text-[10px] text-muted-foreground">
                                    候选 {attempt.attempt} · {attempt.artifact}
                                  </p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {onPreviewAssetArtifact && (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={artifactBusy !== null}
                                        aria-label={`预览 ${task.targetStem} 候选 ${attempt.attempt}`}
                                        onClick={() => void runArtifactAction(`preview:${key}`, async () => {
                                          const data = await onPreviewAssetArtifact(task.id, attempt.attempt);
                                          setArtifactPreviews((current) => ({ ...current, [key]: data }));
                                        })}
                                      >
                                        {artifactBusy === `preview:${key}` ? <Loader2 className="animate-spin" /> : <Eye />}
                                        预览
                                      </Button>
                                    )}
                                    {onPromoteAssetArtifact && (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={artifactBusy !== null}
                                        aria-label={`提升 ${task.targetStem} 候选 ${attempt.attempt}`}
                                        onClick={() => void runArtifactAction(`promote:${key}`, () => onPromoteAssetArtifact(task.id, attempt.attempt))}
                                      >
                                        {artifactBusy === `promote:${key}` ? <Loader2 className="animate-spin" /> : <Upload />}
                                        提升
                                      </Button>
                                    )}
                                    {onDeleteAssetArtifact && (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="text-destructive"
                                        disabled={artifactBusy !== null}
                                        aria-label={`删除 ${task.targetStem} 候选 ${attempt.attempt}`}
                                        onClick={() => void runArtifactAction(`delete:${key}`, async () => {
                                          await onDeleteAssetArtifact(task.id, attempt.attempt);
                                          setArtifactPreviews((current) => {
                                            const next = { ...current };
                                            delete next[key];
                                            return next;
                                          });
                                        })}
                                      >
                                        {artifactBusy === `delete:${key}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                                        删除
                                      </Button>
                                    )}
                                  </div>
                                  {preview?.startsWith('data:image/') && (
                                    <img src={preview} alt={`${task.targetStem} 候选 ${attempt.attempt}`} className="max-h-48 w-full object-contain" />
                                  )}
                                  {preview?.startsWith('data:audio/') && (
                                    <audio src={preview} controls className="w-full" aria-label={`${task.targetStem} 候选 ${attempt.attempt} 音频预览`} />
                                  )}
                                </div>
                              );
                            })}
                            {error && <p className="break-words text-[11px] text-destructive">{error}</p>}
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="text-xs text-muted-foreground">暂无资产任务</p>
                  )}
                </section>
              )}
              <section>
              <SectionLabel>结构化输出</SectionLabel>
              {selected.output ? <DataBlock value={selected.output} /> : <p className="text-xs text-muted-foreground">暂无输出</p>}
              </section>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="history" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {selected.history.length ? (
              <div className="divide-y divide-border">
                {[...selected.history].reverse().map((attempt) => (
                  <details key={attempt.attempt} className="group px-4 py-3" open={attempt.attempt === selected.attempt}>
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                      <span className={cn('size-1.5 rounded-full', attempt.error ? 'bg-destructive' : attempt.finishedAt ? 'bg-emerald-500' : 'bg-blue-500')} aria-hidden="true" />
                      <span className="font-semibold">尝试 {attempt.attempt}</span>
                      <span className="ml-auto flex items-center gap-1 font-mono-family text-[10px] text-muted-foreground">
                        <Clock3 className="size-3" aria-hidden="true" />
                        {duration(attempt.durationMs)}
                      </span>
                    </summary>
                    <div className="mt-4 space-y-4 border-l border-border pl-3">
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                        <div>
                          <dt className="text-muted-foreground">开始</dt>
                          <dd className="mt-0.5 font-mono-family">{timestamp(attempt.startedAt)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">结束</dt>
                          <dd className="mt-0.5 font-mono-family">{timestamp(attempt.finishedAt)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">成本</dt>
                          <dd className="mt-0.5 font-mono-family">{attempt.cost == null ? '未记录' : attempt.cost}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Token</dt>
                          <dd className="mt-0.5 font-mono-family">{(attempt.promptTokens ?? 0) + (attempt.completionTokens ?? 0)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">降级</dt>
                          <dd className="mt-0.5">{attempt.downgrade ?? '无'}</dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">回滚快照</dt>
                          <dd className="mt-0.5 break-all font-mono-family">{attempt.rollbackSnapshot ?? '无'}</dd>
                        </div>
                      </dl>
                      <section>
                        <SectionLabel>输入快照</SectionLabel>
                        <DataBlock value={attempt.inputSnapshot} />
                      </section>
                      {attempt.output && (
                        <section>
                          <SectionLabel>输出</SectionLabel>
                          <DataBlock value={attempt.output} />
                        </section>
                      )}
                      {attempt.error && (
                        <section>
                          <SectionLabel>错误</SectionLabel>
                          <DataBlock value={attempt.error} tone="error" />
                        </section>
                      )}
                      {attempt.diff && (
                        <section>
                          <SectionLabel>变更差异</SectionLabel>
                          <DataBlock value={attempt.diff} />
                        </section>
                      )}
                      {attempt.warnings.length > 0 && (
                        <section>
                          <SectionLabel>警告</SectionLabel>
                          <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
                            {attempt.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
                          </ul>
                        </section>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <p className="p-4 text-xs text-muted-foreground">暂无执行记录</p>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="logs" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {stepEvents.length ? (
              <ol className="divide-y divide-border">
                {stepEvents.map(({ event, receivedAt }, index) => (
                  <li key={`${receivedAt}-${event.type}-${index}`} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 px-4 py-3 text-xs">
                    <time className="font-mono-family text-[10px] text-muted-foreground">
                      {new Date(receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}
                    </time>
                    <span>
                      {event.type === 'stepStarted' && '开始执行'}
                      {event.type === 'stepSucceeded' && '执行完成'}
                      {event.type === 'stepSkipped' && '已跳过'}
                      {event.type === 'stepFailed' && `执行失败：${event.error}`}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="p-4 text-xs text-muted-foreground">暂无此步骤的运行日志</p>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>

      <footer className="flex shrink-0 flex-wrap gap-2 border-t border-border bg-surface-container-low px-4 py-3">
        {selected.status === 'succeeded' && onOpenArtifact && (['character', 'asset'].includes(selected.kind) || selected.id === 'scene') && (
          <Button type="button" size="sm" onClick={() => onOpenArtifact(selected)}>
            <SquareArrowOutUpRight />
            {selected.kind === 'character' ? '打开角色' : selected.kind === 'asset' ? '打开资源库' : '打开场景'}
          </Button>
        )}
        {selected.status !== 'running' && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRetry(selected.id)}>
            <RotateCcw /> 从此步重跑
          </Button>
        )}
        {selected.status === 'pending' && !detached && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onSkip(selected.id)}>
            <SkipForward /> 跳过
          </Button>
        )}
      </footer>
    </aside>
  );
}
