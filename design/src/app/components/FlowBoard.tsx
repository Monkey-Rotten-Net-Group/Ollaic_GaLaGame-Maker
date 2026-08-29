import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bookmark,
  BookmarkCheck,
  Clock3,
  Download,
  FileText,
  GitBranch,
  Hash,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Square,
  StepForward,
  Trash2,
} from 'lucide-react';
import ReactFlow, {
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  type NodeDragHandler,
  type ReactFlowInstance,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { FlowStepInspector } from './FlowStepInspector';
import { PipelineEventLedger } from './PipelineEventLedger';
import { StepNode, type StepNodeData } from './StepNode';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { Switch } from './ui/switch';
import type { FlowStepView } from '../lib/flow-state';
import { layoutFlowSteps, loadFlowPositions, saveFlowPositions } from '../lib/flow-layout';
import { assetQueueDeleteArtifact, assetQueuePromoteArtifact } from '../lib/pipeline-ipc';
import { isAssetQueueStep, stepExecutor } from '../lib/pipeline-types';
import type { AssetQueueState, RunState, RunStatus, StoryPlan } from '../lib/pipeline-types';
import { useFlowRunController } from '../hooks/useFlowRunController';

const NODE_TYPES = { step: StepNode };

const RUN_STATUS: Record<RunStatus, string> = {
  idle: '待创建',
  running: '生产中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  timeout: '已超时',
  persistenceFailed: '状态保存失败',
};

export interface FlowBoardProps {
  projectPath: string;
  onOpenArtifact?: (step: FlowStepView, plan: StoryPlan | null) => void;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function summarizeStep(step: FlowStepView) {
  if (!step.output) return step.prompt || undefined;
  try {
    const output = JSON.parse(step.output) as Record<string, unknown>;
    if (typeof output.synopsis === 'string') return output.synopsis;
    if (typeof output.worldbook === 'string') return output.worldbook;
    if (Array.isArray(output.chapters)) {
      return output.chapters
        .map((chapter) => chapter && typeof chapter === 'object' && 'title' in chapter ? String(chapter.title) : '')
        .filter(Boolean)
        .join(' / ');
    }
    if (Array.isArray(output.characters)) {
      return output.characters
        .map((character) => character && typeof character === 'object' && 'name' in character ? String(character.name) : '')
        .filter(Boolean)
        .join(' / ');
    }
    if (Array.isArray(output.sceneDrafts)) return `${output.sceneDrafts.length} 个场景对白草稿`;
    if (Array.isArray(output.assetPlan)) return `${output.assetPlan.length} 项资产需求`;
    if (Array.isArray(output.scenes)) return `${output.scenes.length} 个 WebGAL 场景文件`;
  } catch {
    // Plain text is already suitable as a compact node summary.
  }
  return step.output;
}

function isDowngraded(step: FlowStepView) {
  if (step.history.some((attempt) => Boolean(attempt.downgrade))) return true;
  if (!step.output) return false;
  try {
    const output = JSON.parse(step.output) as { downgrade?: unknown };
    return typeof output.downgrade === 'string' && output.downgrade.length > 0;
  } catch {
    return false;
  }
}

function assetQueueProgress(queue: AssetQueueState | null) {
  if (!queue?.tasks.length) return null;
  const done = queue.tasks.filter((task) => task.status === 'succeeded' || task.status === 'failed').length;
  const failed = queue.tasks.filter((task) => task.status === 'failed').length;
  return {
    progress: (done / queue.tasks.length) * 100,
    summary: `${done}/${queue.tasks.length} 已处理${failed ? ` · ${failed} 失败` : ''}`,
  };
}

export function FlowBoard({ projectPath, onOpenArtifact }: FlowBoardProps) {
  const {
    state,
    prompt,
    setPrompt,
    allowLocalFallback,
    setAllowLocalFallback,
    plan,
    assetQueue,
    events,
    busy,
    loading,
    detached,
    error,
    loadLatest,
    start,
    pause,
    resume,
    stepOnce,
    stop,
    togglePinned,
    clearHistory,
    exportHistory,
    retryStep,
    updatePromptAndRetry,
    skipStep,
    updateDependencies,
    previewAssetArtifact,
    updateAssetArtifact,
  } = useFlowRunController(projectPath);
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNodeData>([]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const layoutKeyRef = useRef<string | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<StepNodeData> | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [wideInspector, setWideInspector] = useState(() => (
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia('(min-width: 1280px)').matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 1280px)');
    const update = () => setWideInspector(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const modal = Boolean(selectedStepId && !wideInspector);
    const chrome = document.querySelectorAll<HTMLElement>('.ollaic-topbar, .ollaic-sidenav');
    headerRef.current?.toggleAttribute('inert', modal);
    workspaceRef.current?.toggleAttribute('inert', modal);
    chrome.forEach((element) => element.toggleAttribute('inert', modal));
    return () => chrome.forEach((element) => element.removeAttribute('inert'));
  }, [selectedStepId, wideInspector]);

  useEffect(() => {
    if (state.runStatus !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.runStatus]);

  useEffect(() => {
    const layoutKey = `${projectPath}:${state.runId ?? 'draft'}`;
    const isNewLayout = layoutKeyRef.current !== layoutKey;
    const stored = isNewLayout ? loadFlowPositions(projectPath, state.runId) : {};
    const layout = layoutFlowSteps(state.steps, stored);
    const queueProgress = assetQueueProgress(assetQueue);
    setNodes((current) => state.steps.map((step) => {
      const existing = isNewLayout ? null : current.find((node) => node.id === step.id);
      return {
        id: step.id,
        type: 'step',
        position: existing?.position ?? layout[step.id],
        data: {
          id: step.id,
          kind: step.kind,
          executor: stepExecutor(step),
          status: step.status,
          attempt: step.attempt,
          cost: step.history.some((attempt) => attempt.cost != null)
            ? step.history.reduce((sum, attempt) => sum + (attempt.cost ?? 0), 0)
            : undefined,
          progress: isAssetQueueStep(step) ? queueProgress?.progress : undefined,
          summary: isAssetQueueStep(step) && queueProgress ? queueProgress.summary : summarizeStep(step),
          downgraded: isDowngraded(step),
          selected: step.id === selectedStepId,
        },
      };
    }));
    layoutKeyRef.current = layoutKey;
  }, [assetQueue, projectPath, selectedStepId, setNodes, state.runId, state.steps]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void flowInstanceRef.current?.fitView({ padding: 0.2, duration: 180 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedStepId]);

  const openInspector = useCallback((stepId: string) => {
    if (!selectedStepId) previousFocusRef.current = document.activeElement as HTMLElement | null;
    setSelectedStepId(stepId);
  }, [selectedStepId]);

  const closeInspector = useCallback(() => {
    setSelectedStepId(null);
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  }, []);

  const startRun = useCallback(async () => {
    setSelectedStepId(null);
    await start();
  }, [start]);

  const connect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const target = state.steps.find((step) => step.id === connection.target);
    if (!target || target.status !== 'pending') return;
    void updateDependencies(target.id, Array.from(new Set([...target.dependsOn, connection.source])));
  }, [state.steps, updateDependencies]);

  const deleteEdges = useCallback((deleted: Edge[]) => {
    const targets = new Set(deleted.map((edge) => edge.target));
    for (const targetId of targets) {
      const target = state.steps.find((step) => step.id === targetId);
      if (!target || target.status !== 'pending') continue;
      const removedSources = new Set(deleted.filter((edge) => edge.target === targetId).map((edge) => edge.source));
      void updateDependencies(targetId, target.dependsOn.filter((dependency) => !removedSources.has(dependency)));
    }
  }, [state.steps, updateDependencies]);

  const persistNodePositions = useCallback<NodeDragHandler>((_event, dragged) => {
    const positions = Object.fromEntries(nodes.map((node) => [
      node.id,
      node.id === dragged.id ? dragged.position : node.position,
    ]));
    saveFlowPositions(projectPath, state.runId, positions);
    const draggedStep = state.steps.find((step) => step.id === dragged.id);
    if (state.runStatus !== 'paused' || detached || draggedStep?.status !== 'pending') return;
    const dependency = nodes.find((node) => {
      if (node.id === dragged.id) return false;
      return Math.abs(node.position.x - dragged.position.x) < 118
        && Math.abs(node.position.y - dragged.position.y) < 66;
    });
    if (dependency && !draggedStep.dependsOn.includes(dependency.id)) {
      void updateDependencies(dragged.id, [...draggedStep.dependsOn, dependency.id]);
    }
  }, [detached, nodes, projectPath, state.runId, state.runStatus, state.steps, updateDependencies]);

  const edges = useMemo(() => state.steps.flatMap((step) => step.dependsOn.map((dependency) => ({
    id: `${dependency}-${step.id}`,
    source: dependency,
    target: step.id,
    animated: step.status === 'running',
    deletable: state.runStatus === 'paused' && !detached,
    style: { strokeWidth: 1.5 },
  }))), [detached, state.runStatus, state.steps]);

  const selectedStep = state.steps.find((step) => step.id === selectedStepId) ?? null;
  const running = state.runStatus === 'running';
  const paused = state.runStatus === 'paused';
  const recoverable = detached && (running || paused);
  const locallyControllable = (running || paused) && !detached;
  const finishedSteps = state.steps.filter((step) => ['succeeded', 'failed', 'skipped'].includes(step.status)).length;
  const progress = state.steps.length ? Math.round((finishedSteps / state.steps.length) * 100) : 0;
  const totalCost = state.steps.reduce((sum, step) => sum + step.history.reduce((stepSum, attempt) => stepSum + (attempt.cost ?? 0), 0), 0);
  const hasPricedAttempts = state.steps.some((step) => step.history.some((attempt) => attempt.cost != null));
  const totalTokens = state.steps.reduce((sum, step) => sum + step.history.reduce(
    (stepSum, attempt) => stepSum + (attempt.promptTokens ?? 0) + (attempt.completionTokens ?? 0),
    0,
  ), 0);
  const elapsedUntil = running ? now : (state.updatedAt ?? now);
  const elapsed = state.startedAt == null ? 0 : elapsedUntil - state.startedAt;
  const canCreate = !running && !paused;
  const historyClearBlocked = running || state.steps.some((step) => step.status === 'running');

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-container-lowest"
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && selectedStepId && !wideInspector) closeInspector();
      }}
    >
      <header ref={headerRef} className="shrink-0 border-b border-border bg-surface-container-lowest">
        <div className="flex flex-col gap-2 px-3 py-3 lg:flex-row lg:items-center">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block font-mono-family text-[10px] font-semibold text-muted-foreground">PRODUCTION BRIEF</span>
            <Input
              placeholder="题材、风格、篇幅、角色关系与目标体验"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="h-9 w-full rounded-sm bg-surface-container-low"
              aria-label="production brief"
            />
          </label>
          <div className="flex min-h-9 flex-wrap items-center gap-2 lg:self-end">
            {canCreate && (
              <label className="flex h-9 items-center gap-2 border border-border bg-surface-container-low px-2 text-[11px] text-muted-foreground">
                <Switch
                  checked={allowLocalFallback}
                  onCheckedChange={setAllowLocalFallback}
                  aria-label="允许本地内容降级"
                />
                允许本地降级
              </label>
            )}
            {canCreate && (
              <Button onClick={startRun} disabled={busy || loading || !prompt.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : <Play />}
                {state.runId ? '新建流程' : '创建流程'}
              </Button>
            )}
            {running && !recoverable && (
              <Button variant="outline" onClick={pause} disabled={busy} title="当前步骤结束后暂停">
                <Pause /> 暂停
              </Button>
            )}
            {(paused || recoverable) && (
              <>
                <Button onClick={resume} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <Play />}
                  {recoverable ? '恢复运行' : state.steps.some((step) => step.attempt > 0) ? '继续运行' : '运行'}
                </Button>
                <Button variant="outline" onClick={stepOnce} disabled={busy} title="执行下一个可运行步骤后暂停">
                  <StepForward /> 单步
                </Button>
              </>
            )}
            {locallyControllable && (
              <Button variant="outline" onClick={stop} disabled={busy} className="text-destructive" title="停止当前生产流程">
                <Square /> 停止
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-y divide-border border-t border-border sm:grid-cols-4 sm:divide-y-0">
          <div className="min-w-0 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><Hash className="size-3" />运行编号</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono-family text-xs" title={state.runId ?? undefined}>{state.runId ?? '尚未创建'}</span>
              {state.runId && (
                <>
                  <Button type="button" size="icon" variant="ghost" className="size-6" onClick={togglePinned} disabled={busy} aria-label={state.pinned ? '取消固定运行记录' : '固定运行记录'} title={state.pinned ? '取消固定' : '固定记录，保留全部尝试'}>
                    {state.pinned ? <BookmarkCheck /> : <Bookmark />}
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="size-6" onClick={exportHistory} disabled={busy} aria-label="导出运行记录" title="导出运行记录">
                    <Download />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="size-6 text-destructive" onClick={clearHistory} disabled={busy || historyClearBlocked} aria-label="清除运行记录" title={historyClearBlocked ? '暂停并等待当前步骤结束后才能清理' : '清除步骤尝试记录'}>
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><GitBranch className="size-3" />运行状态</div>
            <div className="mt-1 flex items-center gap-2 text-xs font-semibold" data-testid="flow-run-status">
              <span className={`size-1.5 rounded-full ${running ? 'animate-pulse bg-primary' : state.runStatus === 'failed' ? 'bg-destructive' : state.runStatus === 'completed' ? 'bg-emerald-600' : 'bg-muted-foreground'}`} />
              {RUN_STATUS[state.runStatus]}
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"><span>总体进度</span><span>{finishedSteps}/{state.steps.length}</span></div>
            <Progress value={progress} className="mt-2 h-1 rounded-none" aria-label="总体进度" />
          </div>
          <div className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><Clock3 className="size-3" />已用时间 / Token / 成本</div>
            <div className="mt-1 flex items-center justify-between gap-2 font-mono-family text-xs">
              <span>{formatElapsed(elapsed)}</span>
              <span className="text-muted-foreground">{totalTokens.toLocaleString()} tk / {hasPricedAttempts ? `$${totalCost.toFixed(4)}` : '未计价'}</span>
            </div>
          </div>
        </div>

        <div className="flex min-h-10 items-start gap-2 border-t border-border bg-surface-container-low px-3 py-2 text-xs">
          <FileText className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <strong className="shrink-0">StoryPlan</strong>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={plan?.synopsis || undefined}>
            {plan?.synopsis || '等待策划步骤生成故事梗概'}
          </span>
          <span className="shrink-0 font-mono-family text-[10px] text-muted-foreground">
            {plan?.characters?.length ?? 0} 角色 / {plan?.scenes?.length ?? 0} 场景 / {plan?.assetPlan?.length ?? 0} 资产需求
          </span>
        </div>
      </header>

      {recoverable && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertCircle className="size-3.5" />
          发现上次未结束的运行。恢复后会从最后一个安全状态继续。
        </div>
      )}
      {error && (
        <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button size="sm" variant="outline" onClick={loadLatest} disabled={loading}>
            <RotateCcw /> 重试加载
          </Button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div ref={workspaceRef} className="flex min-w-0 flex-1 flex-col">
          <section className="relative min-h-[260px] flex-1" aria-label="生产流程图">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex min-h-9 items-center justify-between border-b border-border/70 bg-surface-container-lowest/85 px-3 backdrop-blur-sm">
              <div className="flex items-center gap-2 text-xs font-semibold"><GitBranch className="size-3.5 text-primary" />流程地图</div>
              <span className="text-[10px] text-muted-foreground">
                {paused && !detached ? '拖到另一节点上可添加依赖，也可连接端点或删除连线' : '拖动节点可整理布局'}
              </span>
            </div>
            <div className="h-full pt-9 ollaic-dot-grid" data-testid="flow-canvas">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                onInit={(instance) => { flowInstanceRef.current = instance; }}
                onNodesChange={onNodesChange}
                onNodeDragStop={persistNodePositions}
                onNodeClick={(_event, node: Node) => openInspector(node.id)}
                onNodeDoubleClick={(_event, node: Node) => {
                  const step = state.steps.find((candidate) => candidate.id === node.id);
                  if (step?.status === 'succeeded' && (['character', 'asset'].includes(step.kind) || step.id === 'scene')) {
                    onOpenArtifact?.(step, plan);
                  }
                }}
                onNodeContextMenu={(event, node) => {
                  event.preventDefault();
                  openInspector(node.id);
                }}
                onConnect={connect}
                onEdgesDelete={deleteEdges}
                nodesConnectable={paused && !detached}
                edgesUpdatable={false}
                minZoom={0.35}
                maxZoom={1.75}
                onlyRenderVisibleElements
                fitView
                fitViewOptions={{ padding: 0.2 }}
              >
                <Background gap={24} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>

            {loading && (
              <div role="status" className="absolute inset-0 z-20 flex items-center justify-center bg-surface-container-lowest/80 text-sm text-muted-foreground backdrop-blur-sm">
                <Loader2 className="mr-2 size-4 animate-spin" />正在读取生产记录
              </div>
            )}
            {!loading && !state.runId && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 text-center">
                <div className="max-w-sm border-y border-border bg-surface-container-lowest/90 px-6 py-5">
                  <p className="text-sm font-semibold">从生产简报建立第一条流程</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">流程将完成世界观、剧情、角色、对白和资产规划，并写入可编辑的 WebGAL 场景。</p>
                </div>
              </div>
            )}
          </section>

          <div className="h-36 shrink-0 border-t border-border sm:h-44">
            <PipelineEventLedger
              events={events}
              steps={state.steps.map((step) => ({ id: step.id, kind: step.kind as RunState['steps'][number]['def']['kind'] }))}
            />
          </div>
        </div>

        {selectedStep && (
          <div
            ref={inspectorRef}
            role={wideInspector ? 'region' : 'dialog'}
            aria-label="步骤检查器"
            aria-modal={wideInspector ? undefined : true}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeInspector();
              if (event.key !== 'Tab' || wideInspector) return;
              const focusable = inspectorRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
              );
              if (!focusable?.length) return;
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            className="absolute inset-y-0 right-0 z-30 w-full max-w-[420px] border-l border-border bg-surface-container-lowest shadow-[-10px_0_30px_var(--shadow-soft)] xl:static xl:w-[380px] xl:shrink-0 xl:shadow-none"
          >
            <FlowStepInspector
              selected={selectedStep}
              busy={busy}
              detached={detached}
              onClose={closeInspector}
              onRetry={retryStep}
              onSkip={skipStep}
              onPromptRerun={updatePromptAndRetry}
              onOpenArtifact={(step) => onOpenArtifact?.(step, plan)}
              events={events}
              assetQueue={assetQueue}
              onPreviewAssetArtifact={previewAssetArtifact}
              onDeleteAssetArtifact={(taskId, attempt) => updateAssetArtifact(assetQueueDeleteArtifact, taskId, attempt)}
              onPromoteAssetArtifact={(taskId, attempt) => updateAssetArtifact(assetQueuePromoteArtifact, taskId, attempt)}
            />
          </div>
        )}
      </div>

      <span className="sr-only" aria-live="polite">
        当前运行状态：{RUN_STATUS[state.runStatus]}，总体进度 {progress}%
      </span>
    </div>
  );
}
