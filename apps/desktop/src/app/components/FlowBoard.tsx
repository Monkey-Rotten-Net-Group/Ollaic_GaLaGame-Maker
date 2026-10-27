import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, ArrowRight, Bookmark, BookmarkCheck, Check, ChevronDown, ChevronRight,
  Circle, Download, Loader2, Pause, Play, RotateCcw, Settings2, Square, StepForward, Trash2,
} from 'lucide-react';
import { FlowStepInspector } from './FlowStepInspector';
import { PipelineEventLedger } from './PipelineEventLedger';
import { AiSettingsDialog } from './AiSettingsDialog';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import { DEFAULT_RECIPE_STEPS, type FlowStepView } from '../lib/flow-state';
import {
  FLOW_PHASES, excludeDependentSteps, includeRequiredSteps, missingScopeInputs, stepDescription, stepTitle,
} from '../lib/flow-presentation';
import {
  assetQueueDeleteArtifact, assetQueuePromoteArtifact, pipelineGetCapabilities, type FlowCapabilities,
} from '../lib/pipeline-ipc';
import { isAssetQueueStep } from '../lib/pipeline-types';
import type { RunState, RunStatus, StepStatus, StoryPlan } from '../lib/pipeline-types';
import { useFlowRunController } from '../hooks/useFlowRunController';

const RUN_STATUS: Record<RunStatus, string> = {
  idle: '待创建', running: '生产中', paused: '已暂停', completed: '已完成', failed: '失败',
  cancelled: '已停止', timeout: '已超时', persistenceFailed: '状态保存失败',
};
const STEP_STATUS: Record<StepStatus, string> = {
  pending: '待运行', running: '运行中', succeeded: '已完成', failed: '失败', awaitingInput: '待输入', skipped: '已跳过',
};
const CONTENT_STEPS = DEFAULT_RECIPE_STEPS.filter((step) => step.id !== 'assetQueue').map((step) => step.id);

export interface FlowBoardProps {
  projectPath: string;
  onOpenArtifact?: (step: FlowStepView, plan: StoryPlan | null) => void;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function summarizeStep(step: FlowStepView) {
  if (!step.output) return stepDescription(step.id);
  try {
    const output = JSON.parse(step.output) as Record<string, unknown>;
    if (typeof output.synopsis === 'string') return output.synopsis;
    if (typeof output.worldbook === 'string') return output.worldbook;
    for (const key of ['chapters', 'characters']) {
      if (Array.isArray(output[key])) return (output[key] as Record<string, unknown>[])
        .map((item) => String(item?.title ?? item?.name ?? '')).filter(Boolean).join(' / ');
    }
    if (Array.isArray(output.sceneDrafts)) return `${output.sceneDrafts.length} 个场景对白草稿`;
    if (Array.isArray(output.assetPlan)) return `${output.assetPlan.length} 项素材需求`;
    if (Array.isArray(output.scenes)) return `${output.scenes.length} 个 WebGAL 场景文件`;
  } catch { /* Plain text is a useful summary too. */ }
  return step.output;
}

function isDowngraded(step: FlowStepView) {
  if (step.history.some((attempt) => Boolean(attempt.downgrade))) return true;
  try { return Boolean(step.output && JSON.parse(step.output).downgrade); } catch { return false; }
}

export function FlowBoard(props: FlowBoardProps) {
  const controller = useFlowRunController(props.projectPath);
  return <FlowBoardView {...props} controller={controller} />;
}

export function FlowBoardView({ projectPath, onOpenArtifact, controller, embedded = false, blocked = false }: FlowBoardProps & {
  controller: ReturnType<typeof useFlowRunController>;
  embedded?: boolean;
  blocked?: boolean;
}) {
  const {
    state, prompt, setPrompt, allowLocalFallback, setAllowLocalFallback, plan, assetQueue, events,
    busy, loading, detached, error, loadLatest, start, pause, resume, stepOnce, stop,
    togglePinned, clearHistory, exportHistory, retryStep, updatePromptAndRetry, skipStep,
    updateDependencies, previewAssetArtifact, updateAssetArtifact, bindImportedAudio, importedAudioByDir,
  } = controller;
  const [selectedIds, setSelectedIds] = useState<string[]>(CONTENT_STEPS);
  const [newConfiguration, setNewConfiguration] = useState(false);
  const [capabilities, setCapabilities] = useState<FlowCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const [now, setNow] = useState(Date.now());
  const capabilitiesRequest = useRef(0);
  const headerRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [wideInspector, setWideInspector] = useState(() => typeof window.matchMedia !== 'function'
    || window.matchMedia('(min-width: 1280px)').matches);

  const checkCapabilities = useCallback(async () => {
    const request = ++capabilitiesRequest.current;
    setChecking(true);
    setCapabilityError(null);
    try {
      const next = await pipelineGetCapabilities();
      if (request === capabilitiesRequest.current) setCapabilities(next);
    } catch (err) {
      if (request === capabilitiesRequest.current) {
        setCapabilities(null);
        setCapabilityError(String(err));
      }
    } finally {
      if (request === capabilitiesRequest.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    setSelectedIds(CONTENT_STEPS);
    setNewConfiguration(false);
    setSelectedStepId(null);
    void checkCapabilities();
    return () => { capabilitiesRequest.current += 1; };
  }, [checkCapabilities, projectPath]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 1280px)');
    const update = () => setWideInspector(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const modal = Boolean(selectedStepId && (embedded || !wideInspector));
    const surfaces = [headerRef.current, workspaceRef.current,
      ...(embedded ? [] : document.querySelectorAll<HTMLElement>('.ollaic-topbar'))];
    surfaces.forEach((element) => element?.toggleAttribute('inert', modal));
    return () => surfaces.forEach((element) => element?.removeAttribute('inert'));
  }, [selectedStepId, wideInspector, embedded]);

  useEffect(() => {
    if (state.runStatus !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.runStatus]);

  const openInspector = useCallback((stepId: string) => {
    if (!selectedStepId) previousFocusRef.current = document.activeElement as HTMLElement | null;
    setSelectedStepId(stepId);
  }, [selectedStepId]);
  const closeInspector = useCallback(() => {
    setSelectedStepId(null);
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  }, []);

  const configuring = !state.runId || newConfiguration;
  const running = state.runStatus === 'running';
  const paused = state.runStatus === 'paused';
  const recoverable = detached && (running || paused);
  const selectedStep = configuring ? null : state.steps.find((step) => step.id === selectedStepId) ?? null;
  const missingInputs = missingScopeInputs(selectedIds);
  const assetSelected = selectedIds.includes('assetQueue');
  const capabilityIssues = capabilities ? [
    capabilities.chatError,
    assetSelected ? capabilities.assetError : null,
  ].filter((issue): issue is string => Boolean(issue)) : [];
  const scopeValid = selectedIds.length > 0 && !missingInputs.length;
  const canPrepare = scopeValid && !checking && Boolean(capabilities)
    && (!capabilityIssues.length || allowLocalFallback) && Boolean(prompt.trim());
  const executedSteps = state.steps.filter((step) => step.status !== 'skipped');
  const finishedSteps = executedSteps.filter((step) => step.status === 'succeeded' || step.status === 'failed').length;
  const progress = executedSteps.length ? Math.round(finishedSteps / executedSteps.length * 100) : 0;
  const totalCost = state.steps.reduce((sum, step) => sum + step.history.reduce((n, attempt) => n + (attempt.cost ?? 0), 0), 0);
  const hasPricedAttempts = state.steps.some((step) => step.history.some((attempt) => attempt.cost != null));
  const totalTokens = state.steps.reduce((sum, step) => sum + step.history.reduce((n, attempt) => n
    + (attempt.promptTokens ?? 0) + (attempt.completionTokens ?? 0), 0), 0);
  const elapsed = state.startedAt == null ? 0 : (running ? now : state.updatedAt ?? now) - state.startedAt;
  const historyClearBlocked = running || state.steps.some((step) => step.status === 'running');
  const activeStep = state.steps.find((step) => step.status === 'running' || step.status === 'failed')
    ?? state.steps.find((step) => step.status === 'pending');
  const phases = configuring ? FLOW_PHASES : FLOW_PHASES.map((phase, index) => ({
    ...phase,
    ids: state.steps.filter((step) => {
      if (isAssetQueueStep(step)) return index === 2;
      return index === (['plan', 'memory', 'outline', 'character'].includes(step.id) ? 0 : 1);
    }).map((step) => step.id),
  })).filter((phase) => phase.ids.length);

  const prepare = async () => {
    setSelectedStepId(null);
    if (await start(selectedIds)) setNewConfiguration(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-container-lowest">
      <header ref={headerRef} className="shrink-0 border-b border-border px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{configuring ? '安排这次生产' : '生产进度'}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{configuring
              ? '选择需要执行的步骤，检查接口后再运行。'
              : activeStep ? `${activeStep.status === 'pending' ? '下一步' : '当前步骤'}：${stepTitle(activeStep.id)}` : '查看本次生产结果与运行记录。'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {configuring ? (
              <Button onClick={prepare} disabled={blocked || busy || loading || !canPrepare}>
                {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />} 准备流程
              </Button>
            ) : (
              <>
                {running && !recoverable && <Button variant="outline" onClick={pause} disabled={busy} title="当前步骤结束后暂停"><Pause /> 暂停</Button>}
                {(paused || recoverable) && <>
                  <Button onClick={resume} disabled={blocked || busy}>{busy ? <Loader2 className="animate-spin" /> : <Play />}
                    {recoverable ? '恢复运行' : state.steps.some((step) => step.attempt > 0) ? '继续运行' : '开始生产'}</Button>
                  <Button variant="outline" onClick={stepOnce} disabled={blocked || busy} title="执行下一个可运行步骤后暂停"><StepForward /> 单步</Button>
                </>}
                {(running || paused) && !detached && <Button variant="ghost" onClick={stop} disabled={busy} className="text-destructive"><Square /> 停止</Button>}
                {!running && !paused && <Button variant="outline" onClick={() => { setSelectedStepId(null); setNewConfiguration(true); setAllowLocalFallback(false); void checkCapabilities(); }} disabled={busy}><Settings2 /> 新建配置</Button>}
              </>
            )}
          </div>
        </div>
        {!configuring && <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <strong data-testid="flow-run-status" className={state.runStatus === 'failed' ? 'text-destructive' : 'text-primary'}>{RUN_STATUS[state.runStatus]}</strong>
          <span>{finishedSteps}/{executedSteps.length} 步骤已处理</span>
          <Progress value={progress} className="h-1.5 max-w-48 flex-1" aria-label="总体进度" />
          <span className="text-muted-foreground">{formatElapsed(elapsed)}</span>
        </div>}
      </header>

      {recoverable && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-300"><AlertCircle className="size-4 shrink-0" />发现上次未结束的运行。恢复后会从最后一个安全状态继续。</div>}
      {error && <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
        <AlertCircle className="size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{error}</span>
        <Button size="sm" variant="outline" onClick={loadLatest} disabled={loading}><RotateCcw /> 重试加载</Button>
      </div>}

      <div className="relative flex min-h-0 flex-1">
        <div ref={workspaceRef} className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            <div className="mx-auto max-w-4xl space-y-5">
              {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取生产记录</p>}
              {configuring && <section aria-label="生产目标" className="rounded-xl border border-border bg-surface-container-low p-4">
                <label htmlFor="production-brief" className="mb-2 block text-sm font-semibold">这次想做什么？</label>
                <Textarea id="production-brief" aria-label="production brief" placeholder="描述题材、故事方向、角色关系和预期篇幅…" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={blocked || busy || loading} className="min-h-24 resize-y rounded-lg bg-surface-container-lowest text-sm" />
                <p className="mt-2 text-xs text-muted-foreground">生成内容会保存在项目中，之后可在编辑器里继续修改。</p>
              </section>}
              {!configuring && plan?.synopsis && <section aria-label="故事概览" className="rounded-xl border border-border bg-surface-container-low p-4">
                <h2 className="mb-2 text-sm font-semibold">故事概览</h2>
                <p className="text-sm leading-6">{plan.synopsis}</p>
                <p className="mt-2 text-xs text-muted-foreground">{plan.characters?.length ?? 0} 角色 / {plan.scenes?.length ?? 0} 场景 / {plan.assetPlan?.length ?? 0} 资产需求</p>
              </section>}

              <section aria-label={configuring ? '选择生产步骤' : '生产步骤'}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">{configuring ? '本次执行哪些步骤' : '步骤清单'}</h2>
                  {configuring && <span className="text-xs text-muted-foreground">已选择 {selectedIds.length} / {DEFAULT_RECIPE_STEPS.length} 步</span>}
                </div>
                <div className={`grid items-start gap-3 ${!embedded && phases.length > 1 ? 'lg:grid-cols-2' : ''}`}>
                  {phases.map((phase, index) => <section key={phase.title} aria-label={phase.title} className={`overflow-hidden rounded-xl border border-border ${!embedded && phase.title === '素材制作' ? 'lg:col-span-2' : ''}`}>
                    <header className="flex items-center gap-3 bg-surface-container-low px-4 py-3">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span>
                      <div><h3 className="text-sm font-semibold">{phase.title}</h3><p className="mt-0.5 text-xs text-muted-foreground">{phase.description}</p></div>
                    </header>
                    <ol className="divide-y divide-border">
                      {phase.ids.map((id) => {
                        const step = state.steps.find((candidate) => candidate.id === id);
                        const included = selectedIds.includes(id);
                        const queue = step && isAssetQueueStep(step) ? assetQueue : null;
                        const done = queue?.tasks.filter((task) => task.status === 'succeeded' || task.status === 'failed').length ?? 0;
                        const queueSummary = queue?.tasks.length ? `${done}/${queue.tasks.length} 已处理` : null;
                        const status = step?.status ?? 'pending';
                        const icon = status === 'succeeded' ? <Check className="size-4" /> : status === 'running' ? <Loader2 className="size-4 animate-spin" /> : status === 'failed' ? <AlertCircle className="size-4" /> : <Circle className="size-3" />;
                        return <li key={id} data-step-id={id} data-step-status={configuring ? included ? 'pending' : 'omitted' : status} className={selectedStepId === id && !configuring ? 'bg-primary/5' : ''}>
                          {configuring ? <label className="flex cursor-pointer items-start gap-3 px-4 py-3.5 hover:bg-surface-container-low/50">
                            <input type="checkbox" aria-label={`执行${stepTitle(id)}`} checked={included} disabled={blocked || busy || loading} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, id] : current.filter((selected) => selected !== id))} className="mt-1 size-4 shrink-0 accent-primary" />
                            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{stepTitle(id)}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{stepDescription(id)}</span></span>
                            <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">{included ? '执行' : '不执行'}</span>
                          </label> : <button type="button" aria-label={`查看${stepTitle(id)}`} onClick={() => openInspector(id)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-surface-container-low/50 focus-visible:outline-2 focus-visible:outline-primary">
                            <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${status === 'failed' ? 'bg-destructive/10 text-destructive' : status === 'succeeded' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-primary/10 text-primary'}`}>{icon}</span>
                            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{stepTitle(id)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{queueSummary ?? (step ? summarizeStep(step) : stepDescription(id))}</span>
                              {queue?.tasks.length ? <Progress value={done / queue.tasks.length * 100} aria-label={`${id} 步骤进度`} className="mt-2 h-1" /> : null}
                              {step && isDowngraded(step) && <span className="mt-1 block text-[11px] text-amber-700 dark:text-amber-300">使用了降级结果，请检查输出</span>}
                            </span>
                            <span className={`mt-1 shrink-0 text-[11px] ${status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{STEP_STATUS[status]}</span><ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          </button>}
                        </li>;
                      })}
                    </ol>
                  </section>)}
                </div>
              </section>

              {configuring && <section aria-label="运行前检查" className="rounded-xl border border-border bg-surface-container-low p-4 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">运行前检查</h2><Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}><Settings2 /> AI 设置</Button></div>
                {checking ? <p className="mt-2 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-3 animate-spin" />正在检查接口配置</p> : capabilityError || !capabilities ? <div role="alert" className="mt-2 text-destructive">接口检查失败：{capabilityError ?? '未读取到配置'}<Button variant="outline" size="sm" className="ml-2" onClick={checkCapabilities}>重新检查</Button></div> : <>
                  <p className={`mt-2 ${capabilities.chatError ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>内容生成：{capabilities.chatError ?? '对话模型已配置'}</p>
                  <p className="mt-2 leading-5 text-muted-foreground">{assetSelected ? `素材制作：${capabilities.assetError ?? '图片、语音及立绘抠图能力已配置；BGM 和音效需手动导入'}` : '本次不制作素材，无需图片或语音接口。场景中的素材可之后手动补充。'}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">这里只检查本地配置，接口连通性可在 AI 设置中测试。</p>
                </>}
                {missingInputs.length > 0 && <div role="alert" className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-amber-800 dark:text-amber-300">
                  <p className="font-medium">所选步骤缺少前置输入</p>
                  <ul className="mt-1 space-y-1">{missingInputs.map(({ step, dependency }) => <li key={step}>{stepTitle(step)}需要{stepTitle(dependency)}的结果。</li>)}</ul>
                  <p className="mt-2">新建故事还没有可复用的结果，请补选前置步骤或取消依赖它的后续步骤。</p>
                  <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setSelectedIds(includeRequiredSteps(selectedIds))}>补选前置步骤</Button><Button variant="outline" size="sm" onClick={() => setSelectedIds(excludeDependentSteps(selectedIds))}>取消相关后续步骤</Button></div>
                </div>}
                {!selectedIds.length && <p role="alert" className="mt-3 text-destructive">请至少选择一个生产步骤。</p>}
                <details className="mt-4 border-t border-border pt-3"><summary className="cursor-pointer font-medium">高级选项</summary>
                  <label className="mt-3 flex items-center gap-2"><Switch checked={allowLocalFallback} onCheckedChange={setAllowLocalFallback} aria-label="允许本地内容降级" />允许本地降级</label>
                  <p className="mt-2 leading-5 text-muted-foreground">接口不可用时使用本地生成内容；若选择素材制作，也会允许占位素材。降级结果会在步骤中标出。</p>
                </details>
                <p className="mt-4 text-muted-foreground">准备流程会保存所选步骤，之后点击「开始生产」执行。未选择的步骤不会运行。</p>
              </section>}
              {!configuring && <>
                <details className="rounded-xl border border-border p-4 text-xs"><summary className="cursor-pointer font-medium">本次生产目标</summary><p className="mt-3 whitespace-pre-wrap leading-5 text-muted-foreground">{prompt}</p></details>
                {!state.steps.some(isAssetQueueStep) && <p className="rounded-lg bg-surface-container-low px-4 py-3 text-xs leading-5 text-muted-foreground">本次未执行素材制作。图片、语音和音乐可在素材编辑器中补充。</p>}
                <details className="rounded-xl border border-border p-4 text-xs"><summary className="cursor-pointer font-medium">运行信息与记录管理</summary>
                  <p className="mt-3 break-all font-mono-family text-muted-foreground">{state.runId}</p>
                  <p className="mt-2 text-muted-foreground">{totalTokens.toLocaleString()} Token · {hasPricedAttempts ? `$${totalCost.toFixed(4)}` : '未计价'}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={togglePinned} disabled={busy} aria-label={state.pinned ? '取消固定运行记录' : '固定运行记录'}>{state.pinned ? <BookmarkCheck /> : <Bookmark />} {state.pinned ? '取消固定' : '固定记录'}</Button>
                    <Button size="sm" variant="outline" onClick={exportHistory} disabled={busy} aria-label="导出运行记录"><Download /> 导出记录</Button>
                    <Button size="sm" variant="ghost" onClick={clearHistory} disabled={busy || historyClearBlocked} aria-label="清除运行记录" className="text-destructive"><Trash2 /> 清除记录</Button>
                  </div>
                </details>
              </>}
            </div>
          </div>
          {!configuring && <div className="shrink-0 border-t border-border">
            <button type="button" aria-expanded={showEvents} aria-controls="production-events" onClick={() => setShowEvents((shown) => !shown)} className="flex w-full items-center gap-2 px-4 py-3 text-xs font-medium hover:bg-surface-container-low">
              {showEvents ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} 运行日志<span className="ml-auto text-muted-foreground">{events.length} 条</span>
            </button>
            {showEvents && <div id="production-events" className="h-40"><PipelineEventLedger events={events} steps={state.steps.map((step) => ({ id: step.id, kind: step.kind as RunState['steps'][number]['def']['kind'] }))} /></div>}
          </div>}
        </div>
        {selectedStep && <div ref={inspectorRef} role={!embedded && wideInspector ? 'region' : 'dialog'} aria-label="步骤检查器" aria-modal={!embedded && wideInspector ? undefined : true}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeInspector();
            if (event.key !== 'Tab' || (!embedded && wideInspector)) return;
            const focusable = inspectorRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
            if (!focusable?.length) return;
            const first = focusable[0]; const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }} className={`absolute inset-y-0 right-0 z-30 w-full max-w-[420px] border-l border-border bg-surface-container-lowest shadow-[-10px_0_30px_var(--shadow-soft)] ${embedded ? '' : 'xl:static xl:w-[380px] xl:shrink-0 xl:shadow-none'}`}>
          <FlowStepInspector key={selectedStep.id} selected={selectedStep} busy={blocked || busy} detached={detached} onClose={closeInspector}
            onRetry={retryStep} onSkip={skipStep} onPromptRerun={updatePromptAndRetry} onOpenArtifact={(step) => onOpenArtifact?.(step, plan)}
            steps={state.steps} canEditDependencies={paused && !detached} onUpdateDependencies={updateDependencies}
            events={events} assetQueue={assetQueue} onPreviewAssetArtifact={previewAssetArtifact}
            onDeleteAssetArtifact={(taskId, attempt) => updateAssetArtifact(assetQueueDeleteArtifact, taskId, attempt)}
            onPromoteAssetArtifact={(taskId, attempt) => updateAssetArtifact(assetQueuePromoteArtifact, taskId, attempt)}
            onBindImportedAudio={bindImportedAudio} importedAudioByDir={importedAudioByDir} />
        </div>}
      </div>
      <AiSettingsDialog open={settingsOpen} onClose={() => { setSettingsOpen(false); void checkCapabilities(); }} onSaved={() => { void checkCapabilities(); }} />
      <span className="sr-only" aria-live="polite">{configuring ? `已选择 ${selectedIds.length} 个生产步骤` : `当前运行状态：${RUN_STATUS[state.runStatus]}，总体进度 ${progress}%`}</span>
    </div>
  );
}
