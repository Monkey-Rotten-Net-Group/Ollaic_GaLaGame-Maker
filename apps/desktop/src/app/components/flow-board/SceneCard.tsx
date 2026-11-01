import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Lock,
  Play,
  RotateCcw,
  Sparkles,
  Unlock,
} from "lucide-react";
import type { SceneApprovalStatus, ScenePlan } from "../../lib/pipeline-types";
import { Button } from "../ui/button";

export interface SceneCardProps {
  scene: ScenePlan;
  sceneIndex: number;
  status: SceneApprovalStatus;
  hasScript: boolean;
  characterNames?: Record<string, string>;
  busy: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onRun?: () => void;
  onApprove?: () => void;
  onUnlock?: () => void;
  onPreview?: () => void;
}

const STATUS_CONFIG: Record<
  SceneApprovalStatus,
  { label: string; bg: string; text: string; icon: React.ReactNode }
> = {
  pending: {
    label: "待生成",
    bg: "bg-muted/70",
    text: "text-muted-foreground",
    icon: <Clock className="size-3.5" />,
  },
  drafted: {
    label: "已生成草稿",
    bg: "bg-blue-500/10 dark:bg-blue-500/20",
    text: "text-blue-600 dark:text-blue-400",
    icon: <Sparkles className="size-3.5" />,
  },
  approved: {
    label: "已通过并锁定",
    bg: "bg-emerald-500/10 dark:bg-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-400",
    icon: <CheckCircle2 className="size-3.5" />,
  },
  stale: {
    label: "前序改动导致陈旧",
    bg: "bg-amber-500/15 dark:bg-amber-500/25",
    text: "text-amber-800 dark:text-amber-300",
    icon: <AlertTriangle className="size-3.5" />,
  },
};

export function SceneCard({
  scene,
  sceneIndex,
  status,
  hasScript,
  characterNames = {},
  busy,
  selected = false,
  onSelect,
  onRun,
  onApprove,
  onUnlock,
  onPreview,
}: SceneCardProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  const isApproved = status === "approved";
  const canApprove = (status === "drafted" || hasScript) && !isApproved;

  return (
    <div
      data-testid={`scene-card-${scene.id}`}
      data-scene-status={status}
      onClick={onSelect}
      className={`group relative flex flex-col justify-between rounded-xl border p-4 transition-all ${
        selected
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border bg-surface-container-low hover:border-primary/40 hover:bg-surface-container"
      }`}
    >
      <div>
        {/* Header row: Index, title, and status pill */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="text-xs font-semibold text-muted-foreground">
              第 {sceneIndex + 1} 场 · {scene.file}
            </span>
            <h4 className="mt-0.5 truncate text-base font-semibold text-foreground">
              {scene.title || scene.id}
            </h4>
          </div>
          <div
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.bg} ${cfg.text}`}
          >
            {cfg.icon}
            <span>{cfg.label}</span>
          </div>
        </div>

        {/* Location / Time / Emotional Arc */}
        {(scene.locationId || scene.timeOfDay || scene.emotionalArc) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {scene.locationId && (
              <span className="rounded bg-surface-container px-1.5 py-0.5 font-medium">
                {scene.locationId}
              </span>
            )}
            {scene.timeOfDay && (
              <span className="rounded bg-surface-container px-1.5 py-0.5 font-medium">
                {scene.timeOfDay}
              </span>
            )}
            {scene.emotionalArc && (
              <span className="truncate italic text-muted-foreground/90">
                {scene.emotionalArc}
              </span>
            )}
          </div>
        )}

        {/* Character tag chips */}
        {scene.characterIds && scene.characterIds.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {scene.characterIds.map((charId) => (
              <span
                key={charId}
                className="rounded-md border border-border/60 bg-surface-container-lowest px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {characterNames[charId] ?? charId}
              </span>
            ))}
          </div>
        )}

        {/* Summary */}
        {scene.summary && (
          <p className="mt-2.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {scene.summary}
          </p>
        )}
      </div>

      {/* Action Toolbar */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* 生成本场 */}
          <Button
            size="sm"
            variant={
              status === "pending" || status === "stale" ? "default" : "outline"
            }
            disabled={busy || isApproved}
            onClick={(e) => {
              e.stopPropagation();
              onRun?.();
            }}
            title={
              isApproved
                ? "本场已锁定，请先解锁后再重新生成"
                : "运行单场对白与脚本制作"
            }
          >
            {status === "stale" ? (
              <RotateCcw className="size-3.5" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {status === "pending" ? "生成本场" : "重新生成"}
          </Button>

          {/* 通过并锁定 / 解锁 */}
          {isApproved ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onUnlock?.();
              }}
              className="text-muted-foreground hover:text-foreground"
              title="解除锁定，允许重新生成或修改"
            >
              <Unlock className="size-3.5" /> 解锁
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canApprove}
              onClick={(e) => {
                e.stopPropagation();
                onApprove?.();
              }}
              className="text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
              title={
                canApprove ? "确认脚本质量并锁定本场" : "需生成草稿后方可通过"
              }
            >
              <Lock className="size-3.5" /> 通过并锁定
            </Button>
          )}
        </div>

        {/* 试玩本场 */}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || (!hasScript && status === "pending")}
          onClick={(e) => {
            e.stopPropagation();
            onPreview?.();
          }}
          className="ml-auto"
          title="带入口状态即时试玩本场"
        >
          <Play className="size-3.5 fill-current" /> 试玩本场
        </Button>
      </div>
    </div>
  );
}
