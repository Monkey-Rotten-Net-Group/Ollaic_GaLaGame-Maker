import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Square,
  StepForward,
} from "lucide-react";
import { FlowStepInspector } from "./FlowStepInspector";
import { PipelineEventLedger } from "./PipelineEventLedger";
import { AiSettingsDialog } from "./AiSettingsDialog";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import type { FlowStepView } from "../lib/flow-state";
import { stepDescription, stepTitle } from "../lib/flow-presentation";
import {
  assetQueueDeleteArtifact,
  assetQueuePromoteArtifact,
  pipelineGetCapabilities,
  type FlowCapabilities,
} from "../lib/pipeline-ipc";
import { isAssetQueueStep } from "../lib/pipeline-types";
import type {
  RunState,
  RunStatus,
  StepStatus,
  StoryPlan,
} from "../lib/pipeline-types";
import { useFlowRunController } from "../hooks/useFlowRunController";
import { SceneProductionQueue } from "./flow-board/SceneProductionQueue";

const RUN_STATUS: Record<RunStatus, string> = {
  idle: "待创建",
  running: "生产中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  timeout: "已超时",
  persistenceFailed: "状态保存失败",
};

const STEP_STATUS: Record<StepStatus, string> = {
  pending: "待运行",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  awaitingInput: "待输入",
  skipped: "已跳过",
};

const STAGE1_PREVIEW_STEPS = [
  "plan",
  "memory",
  "outline",
  "character",
  "anchorPlan",
  "assetQueue",
] as const;

export interface FlowBoardProps {
  projectPath: string;
  onOpenArtifact?: (step: FlowStepView, plan: StoryPlan | null) => void;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function summarizeStep(step: FlowStepView) {
  if (!step.output) return stepDescription(step.id);
  try {
    const output = JSON.parse(step.output) as Record<string, unknown>;
    if (typeof output.synopsis === "string") return output.synopsis;
    if (typeof output.worldbook === "string") return output.worldbook;
    for (const key of ["chapters", "characters"]) {
      if (Array.isArray(output[key]))
        return (output[key] as Record<string, unknown>[])
          .map((item) => String(item?.title ?? item?.name ?? ""))
          .filter(Boolean)
          .join(" / ");
    }
    if (Array.isArray(output.sceneDrafts))
      return `${output.sceneDrafts.length} 个场景对白草稿`;
    if (Array.isArray(output.assetPlan))
      return `${output.assetPlan.length} 项素材需求`;
    if (Array.isArray(output.scenes))
      return `${output.scenes.length} 个 WebGAL 场景文件`;
  } catch {
    /* Plain text is a useful summary too. */
  }
  return step.output;
}

function isDowngraded(step: FlowStepView) {
  if (step.history.some((attempt) => Boolean(attempt.downgrade))) return true;
  try {
    return Boolean(step.output && JSON.parse(step.output).downgrade);
  } catch {
    return false;
  }
}

export function FlowBoard(props: FlowBoardProps) {
  const controller = useFlowRunController(props.projectPath);
  return <FlowBoardView {...props} controller={controller} />;
}

export function FlowBoardView({
  projectPath,
  onOpenArtifact,
  controller,
  onClose,
  embedded = false,
  blocked = false,
}: FlowBoardProps & {
  controller: ReturnType<typeof useFlowRunController>;
  onClose?: () => void;
  embedded?: boolean;
  blocked?: boolean;
}) {
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
    runSetup,
    runScene,
    approveScene,
    unlockScene,
    pause,
    resume,
    stepOnce,
    stop,
    retryStep,
    updatePromptAndRetry,
    updateDependencies,
    skipStep,
    previewAssetArtifact,
    updateAssetArtifact,
    bindImportedAudio,
    importedAudioByDir,
  } = controller;
  const [newConfiguration, setNewConfiguration] = useState(false);
  const [capabilities, setCapabilities] = useState<FlowCapabilities | null>(
    null,
  );
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const [now, setNow] = useState(Date.now());
  const capabilitiesRequest = useRef(0);
  const headerRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [wideInspector, setWideInspector] = useState(
    () =>
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(min-width: 1280px)").matches,
  );

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
    setNewConfiguration(false);
    setSelectedStepId(null);
    setSelectedSceneId(null);
    void checkCapabilities();
    return () => {
      capabilitiesRequest.current += 1;
    };
  }, [checkCapabilities, projectPath]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setWideInspector(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const hasPlanScenes = Boolean(plan?.scenePlans && plan.scenePlans.length > 0);
  const configuring = (!state.runId && !hasPlanScenes) || newConfiguration;
  const running = state.runStatus === "running";
  const paused = state.runStatus === "paused";
  const recoverable = detached && (running || paused);
  const isSceneScope = state.scope?.type === "scene";
  const activeSceneId =
    state.scope?.type === "scene" ? state.scope.sceneId : null;
  const selectedScene =
    plan?.scenePlans?.find((s) => s.id === selectedSceneId) ?? null;
  const selectedStep = configuring ? null : selectedScene
    ? state.scope?.type === 'scene' && state.scope.sceneId === selectedScene.id
      ? state.steps.find((step) => step.id === 'scene') ?? null
      : null
    : state.steps.find((step) => step.id === selectedStepId) ?? null;

  const inspectorOpen = Boolean(selectedStep || selectedScene);

  useEffect(() => {
    const modal = Boolean(
      inspectorOpen && (embedded || !wideInspector),
    );
    const surfaces = [
      headerRef.current,
      workspaceRef.current,
      ...(embedded
        ? []
        : document.querySelectorAll<HTMLElement>(".ollaic-topbar")),
    ];
    surfaces.forEach((element) => element?.toggleAttribute("inert", modal));
    return () =>
      surfaces.forEach((element) => element?.removeAttribute("inert"));
  }, [inspectorOpen, wideInspector, embedded]);

  useEffect(() => {
    if (state.runStatus !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.runStatus]);

  const openInspector = useCallback(
    (stepId: string) => {
      if (!selectedStepId && !selectedSceneId) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
      }
      setSelectedSceneId(null);
      setSelectedStepId(stepId);
    },
    [selectedStepId, selectedSceneId],
  );
  const closeInspector = useCallback(() => {
    setSelectedStepId(null);
    setSelectedSceneId(null);
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  }, []);


  const capabilityIssues = capabilities
    ? [capabilities.chatError, capabilities.assetError].filter(
        (issue): issue is string => Boolean(issue),
      )
    : [];
  const canStartSetup =
    !checking &&
    Boolean(capabilities) &&
    (!capabilityIssues.length || allowLocalFallback) &&
    Boolean(prompt.trim());

  const executedSteps = state.steps.filter((step) => step.status !== "skipped");
  const finishedSteps = executedSteps.filter(
    (step) => step.status === "succeeded" || step.status === "failed",
  ).length;
  const progress = executedSteps.length
    ? Math.round((finishedSteps / executedSteps.length) * 100)
    : 0;
  const elapsed =
    state.startedAt == null
      ? 0
      : (running ? now : (state.updatedAt ?? now)) - state.startedAt;
  const activeStep =
    state.steps.find(
      (step) => step.status === "running" || step.status === "failed",
    ) ?? state.steps.find((step) => step.status === "pending");

  const startStage1Setup = async () => {
    setSelectedStepId(null);
    setSelectedSceneId(null);
    if (await runSetup(prompt)) setNewConfiguration(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-container-lowest">
      <header
        ref={headerRef}
        className="shrink-0 border-b border-border px-4 py-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">
              {configuring
                ? "Stage 1 · 立项企划与角色定锚"
                : isSceneScope
                  ? `Stage 2 · 单场制作 (${activeSceneId})`
                  : "Stage 1 · 立项企划与角色定锚"}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {configuring
                ? "输入一句话创意或融合已有素材，先完成故事大纲、角色设定与基础锚定立绘，再逐场制作与审阅。"
                : activeStep
                  ? `${activeStep.status === "pending" ? "下一步" : "当前步骤"}：${stepTitle(activeStep.id)}`
                  : "立项定锚已完成，请在下方 Stage 2 队列中逐场生成、试玩与锁定。"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onClose && (
              <Button
                variant="ghost"
                onClick={onClose}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                title="关闭看板，返回剧本编辑器"
              >
                <ArrowLeft className="size-4" />
                <span>返回剧本</span>
              </Button>
            )}
            {configuring ? (
              <>
                {hasPlanScenes && (
                  <Button
                    variant="ghost"
                    onClick={() => setNewConfiguration(false)}
                    disabled={busy}
                  >
                    返回分场工作台
                  </Button>
                )}
                <Button
                  onClick={startStage1Setup}
                  disabled={blocked || busy || loading || !canStartSetup}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Play />}{" "}
                  启动 Stage 1：立项与角色定锚
                </Button>
              </>
            ) : (
              <>
                {running && !recoverable && (
                  <Button
                    variant="outline"
                    onClick={pause}
                    disabled={busy}
                    title="当前步骤结束后暂停"
                  >
                    <Pause /> 暂停
                  </Button>
                )}
                {(paused || recoverable) && (
                  <>
                    <Button onClick={resume} disabled={blocked || busy}>
                      {busy ? <Loader2 className="animate-spin" /> : <Play />}
                      {recoverable
                        ? "恢复运行"
                        : state.steps.some((step) => step.attempt > 0)
                          ? "继续运行"
                          : "开始生产"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={stepOnce}
                      disabled={blocked || busy}
                      title="执行下一个可运行步骤后暂停"
                    >
                      <StepForward /> 单步
                    </Button>
                  </>
                )}
                {(running || paused) && !detached && (
                  <Button
                    variant="ghost"
                    onClick={stop}
                    disabled={busy}
                    className="text-destructive"
                  >
                    <Square /> 停止
                  </Button>
                )}
                {!running && !paused && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelectedStepId(null);
                      setSelectedSceneId(null);
                      setNewConfiguration(true);
                      setAllowLocalFallback(false);
                      void checkCapabilities();
                    }}
                    disabled={busy}
                  >
                    <Settings2 /> 重新立项
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        {!configuring && state.runId && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <strong
              data-testid="flow-run-status"
              className={
                state.runStatus === "failed"
                  ? "text-destructive"
                  : "text-primary"
              }
            >
              {RUN_STATUS[state.runStatus]}
            </strong>
            <span>
              {finishedSteps}/{executedSteps.length} 步骤已处理
            </span>
            <Progress
              value={progress}
              className="h-1.5 max-w-48 flex-1"
              aria-label="总体进度"
            />
            <span className="text-muted-foreground">
              {formatElapsed(elapsed)}
            </span>
          </div>
        )}
      </header>

      {recoverable && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          <AlertCircle className="size-4 shrink-0" />
          发现上次未结束的运行。恢复后会从最后一个安全状态继续。
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={loadLatest}
            disabled={loading}
          >
            <RotateCcw /> 重试加载
          </Button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div ref={workspaceRef} className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            <div className="mx-auto max-w-4xl space-y-5">
              {loading && (
                <p
                  role="status"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="size-4 animate-spin" />
                  正在读取生产记录
                </p>
              )}

              {configuring ? (
                <>
                  <section
                    aria-label="生产目标"
                    className="rounded-xl border border-border bg-surface-container-low p-4"
                  >
                    <label
                      htmlFor="production-brief"
                      className="mb-2 block text-sm font-semibold"
                    >
                      故事企划与创作提示词
                    </label>
                    <Textarea
                      id="production-brief"
                      aria-label="production brief"
                      placeholder="输入一句话核心创意、世界观背景、人物关系或分支走向…"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      disabled={blocked || busy || loading}
                      className="min-h-24 resize-y rounded-lg bg-surface-container-lowest text-sm"
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      系统会自动复用项目中已导入的立绘、参考图与背景素材，仅补齐缺失设定与角色默认立绘锚点。
                    </p>
                  </section>

                  <section
                    aria-label="Stage 1 流程预览"
                    className="overflow-hidden rounded-xl border border-border"
                  >
                    <header className="flex items-center gap-3 bg-surface-container-low px-4 py-3">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        1
                      </span>
                      <div>
                        <h2 className="text-sm font-semibold">
                          Stage 1 · 全局设定与角色视觉定锚
                        </h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          先锁死世界观、分支变量、角色设定与基础立绘，确认后再进入 Stage 2 逐场制作
                        </p>
                      </div>
                    </header>
                    <ol className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                      {STAGE1_PREVIEW_STEPS.map((id, idx) => (
                        <li
                          key={id}
                          className={`flex items-start gap-3 px-4 py-3 ${idx >= 2 ? "sm:border-t sm:border-border" : ""}`}
                        >
                          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                            {idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold text-foreground">
                              {stepTitle(id)}
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                              {stepDescription(id)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>

                  <section
                    aria-label="运行前检查"
                    className="rounded-xl border border-border bg-surface-container-low p-4 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold">接口与环境检查</h2>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSettingsOpen(true)}
                      >
                        <Settings2 /> AI 设置
                      </Button>
                    </div>
                    {checking ? (
                      <p className="mt-2 flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" />
                        正在检查接口配置
                      </p>
                    ) : capabilityError || !capabilities ? (
                      <div role="alert" className="mt-2 text-destructive">
                        接口检查失败：{capabilityError ?? "未读取到配置"}
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-2"
                          onClick={checkCapabilities}
                        >
                          重新检查
                        </Button>
                      </div>
                    ) : (
                      <>
                        <p
                          className={`mt-2 ${capabilities.chatError ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                        >
                          剧本与策划模型：{capabilities.chatError ?? "对话模型已配置"}
                        </p>
                        <p
                          className={`mt-1.5 ${capabilities.assetError ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                        >
                          视觉与音频能力：
                          {capabilities.assetError ??
                            "图片、语音及立绘抠图能力已就绪"}
                        </p>
                        {capabilities.referenceImageWarning && (
                          <p
                            role="status"
                            className="mt-1.5 text-amber-700 dark:text-amber-300"
                          >
                            {capabilities.referenceImageWarning}
                          </p>
                        )}
                      </>
                    )}
                    <div className="mt-3 border-t border-border pt-3">
                      <label className="flex items-center gap-2 font-medium">
                        <Switch
                          checked={allowLocalFallback}
                          onCheckedChange={setAllowLocalFallback}
                          aria-label="允许本地内容降级"
                        />
                        允许本地降级（无外部 API 时使用内置确定性剧本与情绪音库）
                      </label>
                    </div>
                  </section>
                </>
              ) : (
                <>
                  {/* Stage 1 Global Bible Summary Card */}
                  {plan?.synopsis && (
                    <section
                      aria-label="故事概览"
                      className="rounded-xl border border-border bg-surface-container-low p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            1
                          </span>
                          <h2 className="text-sm font-semibold">
                            Stage 1 · 故事概览与角色定锚
                          </h2>
                        </div>
                        {isSceneScope && (
                          <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                            全局设定已锁定 · 当前正执行单场制作 ({activeSceneId})
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm leading-6">{plan.synopsis}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {plan.characters?.length ?? 0} 角色 /{" "}
                        {plan.scenes?.length ?? 0} 场景 /{" "}
                        {plan.assetPlan?.length ?? 0} 资产需求
                      </p>
                      {plan.characters && plan.characters.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/60 pt-2.5 text-xs">
                          <span className="text-muted-foreground">
                            已定锚角色：
                          </span>
                          {plan.characters.map((char) => (
                            <span
                              key={char.id}
                              className="rounded-md border border-border/70 bg-surface-container-lowest px-2 py-0.5 font-medium text-foreground"
                            >
                              {char.name || char.id}
                            </span>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {/* Active Run Steps (Stage 1 Setup Steps OR Current Single-Scene Steps) */}
                  {state.steps.length > 0 && (
                    <section
                      aria-label="当前执行步骤"
                      className="overflow-hidden rounded-xl border border-border"
                    >
                      <header className="flex items-center justify-between bg-surface-container-low px-4 py-3">
                        <h3 className="text-sm font-semibold">
                          {isSceneScope
                            ? `当前单场制作流水线 (${activeSceneId})`
                            : "Stage 1 · 立项定锚执行步骤"}
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          点击步骤可在右侧检查或微调输出
                        </span>
                      </header>
                      <ol className="divide-y divide-border">
                        {state.steps.map((step) => {
                          const id = step.id;
                          const queue = isAssetQueueStep(step)
                            ? assetQueue
                            : null;
                          const done =
                            queue?.tasks.filter(
                              (task) =>
                                task.status === "succeeded" ||
                                task.status === "failed",
                            ).length ?? 0;
                          const queueSummary = queue?.tasks.length
                            ? `${done}/${queue.tasks.length} 已处理`
                            : null;
                          const status = step.status;
                          const icon =
                            status === "succeeded" ? (
                              <Check className="size-4" />
                            ) : status === "running" ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : status === "failed" ? (
                              <AlertCircle className="size-4" />
                            ) : (
                              <Circle className="size-3" />
                            );
                          return (
                            <li
                              key={id}
                              data-step-id={id}
                              data-step-status={status}
                              className={
                                selectedStepId === id ? "bg-primary/5" : ""
                              }
                            >
                              <button
                                type="button"
                                aria-label={`查看${stepTitle(id)}`}
                                onClick={() => openInspector(id)}
                                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-container-low/50 focus-visible:outline-2 focus-visible:outline-primary"
                              >
                                <span
                                  className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                                    status === "failed"
                                      ? "bg-destructive/10 text-destructive"
                                      : status === "succeeded"
                                        ? "bg-emerald-500/10 text-emerald-600"
                                        : "bg-primary/10 text-primary"
                                  }`}
                                >
                                  {icon}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium">
                                    {stepTitle(id)}
                                  </span>
                                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                                    {queueSummary ?? summarizeStep(step)}
                                  </span>
                                  {queue?.tasks.length ? (
                                    <Progress
                                      value={(done / queue.tasks.length) * 100}
                                      aria-label={`${id} 步骤进度`}
                                      className="mt-2 h-1"
                                    />
                                  ) : null}
                                  {isDowngraded(step) && (
                                    <span className="mt-1 block text-[11px] text-amber-700 dark:text-amber-300">
                                      使用了降级结果，请检查输出
                                    </span>
                                  )}
                                </span>
                                <span
                                  className={`mt-1 shrink-0 text-[11px] ${
                                    status === "failed"
                                      ? "text-destructive"
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  {STEP_STATUS[status]}
                                </span>
                                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  )}

                  {/* Stage 2 Scene Production Queue */}
                  <SceneProductionQueue
                    projectPath={projectPath}
                    plan={plan ?? {
                      version: 1,
                      prompt,
                      synopsis: "",
                      memory: { worldbook: "", glossary: {} },
                      chapters: [],
                      characters: [],
                      scenePlans: [],
                      branches: { entryScene: "", edges: [] },
                      sceneDrafts: [],
                      assetPlan: [],
                      scenes: [],
                      pipelineRuns: [],
                    }}
                    busy={blocked || busy}
                    selectedSceneId={selectedSceneId}
                    onSelectScene={(scene) => {
                      setSelectedSceneId(scene.id);
                      previousFocusRef.current = document.activeElement as HTMLElement | null;
                      setSelectedStepId(null);
                    }}
                    onRunScene={runScene}
                    onApproveScene={approveScene}
                    onUnlockScene={unlockScene}
                  />
                </>
              )}
            </div>
          </div>

          {!configuring && state.runId && (
            <div className="shrink-0 border-t border-border">
              <button
                type="button"
                aria-expanded={showEvents}
                aria-controls="production-events"
                onClick={() => setShowEvents((shown) => !shown)}
                className="flex w-full items-center gap-2 px-4 py-3 text-xs font-medium hover:bg-surface-container-low"
              >
                {showEvents ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                )}{" "}
                运行日志
                <span className="ml-auto text-muted-foreground">
                  {events.length} 条
                </span>
              </button>
              {showEvents && (
                <div id="production-events" className="h-40">
                  <PipelineEventLedger
                    events={events}
                    steps={state.steps.map((step) => ({
                      id: step.id,
                      kind: step.kind as RunState["steps"][number]["def"]["kind"],
                    }))}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {inspectorOpen && (
          <div
            ref={inspectorRef}
            role={!embedded && wideInspector ? "region" : "dialog"}
            aria-label="步骤检查器"
            aria-modal={!embedded && wideInspector ? undefined : true}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeInspector();
              if (event.key !== "Tab" || (!embedded && wideInspector)) return;
              const focusable =
                inspectorRef.current?.querySelectorAll<HTMLElement>(
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
            className={`absolute inset-y-0 right-0 z-30 w-full max-w-[420px] border-l border-border bg-surface-container-lowest shadow-[-10px_0_30px_var(--shadow-soft)] ${
              embedded ? "" : "xl:static xl:w-[380px] xl:shrink-0 xl:shadow-none"
            }`}
          >
            <FlowStepInspector
              key={selectedScene?.id ?? selectedStep?.id}
              selected={selectedStep}
              selectedScene={selectedScene}
              onRunScene={runScene}
              onApproveScene={approveScene}
              onUnlockScene={unlockScene}
              busy={blocked || busy}
              detached={detached}
              onClose={closeInspector}
              onRetry={retryStep}
              onSkip={skipStep}
              onPromptRerun={updatePromptAndRetry}
              dependencySteps={state.steps}
              onDependenciesChange={updateDependencies}
              onOpenArtifact={(step) => onOpenArtifact?.(step, plan)}
              events={events}
              assetQueue={assetQueue}
              onPreviewAssetArtifact={previewAssetArtifact}
              onDeleteAssetArtifact={(taskId, attempt) =>
                updateAssetArtifact(assetQueueDeleteArtifact, taskId, attempt)
              }
              onPromoteAssetArtifact={(taskId, attempt) =>
                updateAssetArtifact(assetQueuePromoteArtifact, taskId, attempt)
              }
              onBindImportedAudio={bindImportedAudio}
              importedAudioByDir={importedAudioByDir}
            />
          </div>
        )}
      </div>

      <AiSettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          void checkCapabilities();
        }}
        onSaved={() => {
          void checkCapabilities();
        }}
      />
      <span className="sr-only" aria-live="polite">
        {configuring
          ? "正在配置 Stage 1 立项与角色定锚"
          : `当前运行状态：${RUN_STATUS[state.runStatus]}，总体进度 ${progress}%`}
      </span>
    </div>
  );
}
