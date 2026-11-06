import { memo, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
} from 'lucide-react';
import type { useFlowRunController } from '../../hooks/useFlowRunController';
import { stepTitle } from '../../lib/flow-presentation';
import { Button } from '../ui/button';
import { Progress } from '../ui/progress';

export interface WorkflowPlanCardProps {
  controller: ReturnType<typeof useFlowRunController>;
  onOpenWorkflowBoard?: () => void;
  onPreviewScene?: (sceneId: string) => void;
}

export const WorkflowPlanCard = memo(function WorkflowPlanCard({
  controller,
  onOpenWorkflowBoard,
  onPreviewScene,
}: WorkflowPlanCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { state, plan, busy } = controller;

  const running = state.runStatus === 'running';
  const paused = state.runStatus === 'paused';
  const failed = state.runStatus === 'failed';
  const isSceneScope = state.scope?.type === 'scene';
  const activeSceneId = state.scope?.type === 'scene' ? state.scope.sceneId : null;

  const totalSteps = state.steps.length;
  const finishedSteps = state.steps.filter(
    (step) => step.status === 'succeeded' || step.status === 'skipped',
  ).length;
  const activeStep = state.steps.find((step) => step.status === 'running');
  const progress = totalSteps > 0 ? Math.round((finishedSteps / totalSteps) * 100) : 0;

  const scenePlans = useMemo(() => plan?.scenePlans ?? [], [plan?.scenePlans]);
  const approvedScenes = scenePlans.filter(
    (s) => s.approvalStatus === 'approved',
  ).length;
  const totalScenes = scenePlans.length;

  const nextPendingScene = useMemo(() => {
    return scenePlans.find(
      (s) => s.approvalStatus === 'pending' || s.approvalStatus === 'drafted' || s.approvalStatus === 'stale',
    );
  }, [scenePlans]);

  // Don't render card if there is no plan and no active/past run
  if (!plan && !state.runId && state.runStatus === 'idle') {
    return null;
  }

  return (
    <section
      aria-label="工作流状态与规划卡"
      className="my-2 rounded-xl border border-border bg-surface-container-low p-3 text-xs shadow-xs transition-all"
    >
      {/* Header bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {running ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          ) : failed ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          ) : (
            <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          )}
          <span className="truncate font-semibold text-foreground">
            {running
              ? isSceneScope
                ? `Stage 2 单场制作中 (${activeSceneId})`
                : 'Stage 1 立项定锚中...'
              : paused
                ? '工作流已暂停'
                : failed
                  ? '生产遇到问题'
                  : 'Stage 1 · 故事企划与角色定锚'}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {onOpenWorkflowBoard && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenWorkflowBoard}
              className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              title="在主舞台展开工作流看板与分场队列"
            >
              <span>看板</span>
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="ollaic-icon-button h-6 w-6 text-muted-foreground hover:text-foreground"
            aria-label={collapsed ? '展开规划卡' : '折叠规划卡'}
            title={collapsed ? '展开' : '折叠'}
          >
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Collapsed summary strip */}
      {collapsed ? (
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="truncate">
            {plan?.synopsis ? plan.synopsis.slice(0, 32) + '…' : '企划已定锚'}
          </span>
          {totalScenes > 0 && (
            <span className="shrink-0 font-medium">
              分场进度: {approvedScenes}/{totalScenes}
            </span>
          )}
        </div>
      ) : (
        <div className="mt-2.5 space-y-2.5">
          {/* Active running progress */}
          {(running || paused) && (
            <div className="space-y-1.5 rounded-lg border border-border/70 bg-surface-container-lowest p-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="truncate text-muted-foreground">
                  当前步骤：
                  <strong className="text-foreground">
                    {activeStep ? stepTitle(activeStep.id) : paused ? '等待继续' : '处理中'}
                  </strong>
                </span>
                <span className="font-mono text-muted-foreground">
                  {finishedSteps}/{totalSteps}
                </span>
              </div>
              <Progress value={progress} className="h-1.5" aria-label="工作流步骤进度" />
              <div className="flex justify-end gap-1.5 pt-1">
                <Button
                  size="sm"
                  variant={paused ? 'default' : 'outline'}
                  onClick={paused ? controller.resume : controller.pause}
                  disabled={busy}
                  className="h-6 px-2 text-[11px]"
                >
                  {paused ? <Play className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}
                  {paused ? '继续工作流' : '暂停'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={controller.stop}
                  disabled={busy}
                  className="h-6 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                >
                  <Square className="mr-1 h-3 w-3" /> 停止
                </Button>
              </div>
            </div>
          )}

          {/* Error prompt */}
          {controller.error && (
            <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
              <span className="min-w-0 flex-1 break-words">{controller.error}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={controller.loadLatest}
                disabled={busy}
                className="h-6 px-2 text-[11px]"
              >
                <RotateCcw className="mr-1 h-3 w-3" /> 刷新状态
              </Button>
            </div>
          )}

          {/* Synopsis */}
          {plan?.synopsis && (
            <div className="rounded-lg border border-border/60 bg-surface-container-lowest p-2.5">
              <p className="line-clamp-3 text-[11px] leading-relaxed text-foreground">
                {plan.synopsis}
              </p>
              {plan.characters && plan.characters.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/40 pt-1.5 text-[10px]">
                  <span className="text-muted-foreground">已定锚角色：</span>
                  {plan.characters.map((char) => (
                    <span
                      key={char.id}
                      className="rounded bg-surface-container-low px-1.5 py-0.5 font-medium text-foreground"
                    >
                      {char.name || char.id}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Scene Production Actions */}
          {totalScenes > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[11px]">
              <span className="text-muted-foreground">
                分场制作：<strong className="text-foreground">{approvedScenes}/{totalScenes}</strong> 场已锁定
              </span>

              <div className="flex items-center gap-1.5">
                {nextPendingScene && (
                  <Button
                    size="sm"
                    onClick={() => void controller.runScene(nextPendingScene.id)}
                    disabled={running || paused || busy}
                    className="h-6 gap-1 px-2 text-[11px]"
                    title={paused ? '请先继续或停止当前工作流' : `生产场景: ${nextPendingScene.title || nextPendingScene.id}`}
                  >
                    <Play className="h-3 w-3" />
                    <span>生成: {nextPendingScene.title || nextPendingScene.id}</span>
                  </Button>
                )}
                {nextPendingScene && onPreviewScene && nextPendingScene.approvalStatus !== 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPreviewScene(nextPendingScene.id)}
                    disabled={busy}
                    className="h-6 px-2 text-[11px]"
                    title="在预览区快速试玩该场景"
                  >
                    试玩
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
