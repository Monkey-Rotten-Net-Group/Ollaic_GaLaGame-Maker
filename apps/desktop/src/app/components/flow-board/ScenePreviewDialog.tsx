import { useMemo, useState } from "react";
import { Play, RefreshCw, Sliders, X } from "lucide-react";
import type { ScenePlan, StoryPlan } from "../../lib/pipeline-types";
import {
  deriveSceneEntryVariables,
  wrapScriptWithEntryVariables,
} from "../../lib/scene-entry-state";
import { useRuntimePreview } from "../../hooks/useRuntimePreview";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export interface ScenePreviewDialogProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  scene: ScenePlan | null;
  plan: StoryPlan;
  sceneScript: string;
}

export function ScenePreviewDialog({
  open,
  onClose,
  projectPath,
  scene,
  plan,
  sceneScript,
}: ScenePreviewDialogProps) {
  if (!open || !scene) return null;

  return (
    <ScenePreviewDialogContent
      key={`${projectPath}:${scene.id}`}
      onClose={onClose}
      projectPath={projectPath}
      scene={scene}
      plan={plan}
      sceneScript={sceneScript}
    />
  );
}

function ScenePreviewDialogContent({
  onClose,
  projectPath,
  scene,
  plan,
  sceneScript,
}: {
  onClose: () => void;
  projectPath: string;
  scene: ScenePlan;
  plan: StoryPlan;
  sceneScript: string;
}) {
  const derived = useMemo(
    () => deriveSceneEntryVariables(plan, scene.file),
    [plan, scene.file],
  );

  const [variables, setVariables] = useState<Record<string, string>>(() => ({
    ...derived.variables,
  }));

  const preview = useRuntimePreview(projectPath, sceneScript, true, {
    entryVariables: variables,
  });

  const handleReset = () => {
    setVariables({ ...derived.variables });
  };

  const handleVariableChange = (key: string, value: string) => {
    setVariables((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
    >
      <div className="flex h-[90vh] w-[95vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-surface-container-lowest shadow-2xl">
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h2
              id="preview-dialog-title"
              className="flex items-center gap-2 text-base font-semibold"
            >
              <Play className="size-4 text-primary fill-current" />
              单场即时试玩：{scene.title || scene.id} ({scene.file})
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              前序场景：
              {derived.precedingScenes.length > 0
                ? derived.precedingScenes.join(" → ")
                : "（开场入口场景，无前序）"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => preview.sync()}
              disabled={!preview.ready}
              title="重新同步入场变量并从头播放本场"
            >
              <RefreshCw className="size-3.5" /> 重新播放
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="关闭试玩"
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {/* Body: Split View (Left: Injected Variables / Right: WebGAL Viewport) */}
        <div className="flex min-h-0 flex-1 divide-x divide-border overflow-hidden">
          {/* Left panel: Entry State Simulator */}
          <aside className="w-80 shrink-0 overflow-y-auto bg-surface-container-low/50 p-4 text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-border/60">
              <span className="flex items-center gap-1.5 font-semibold text-foreground">
                <Sliders className="size-3.5 text-primary" />
                入场模拟变量
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
              >
                恢复默认
              </Button>
            </div>

            <p className="mt-2.5 leading-relaxed text-muted-foreground">
              已根据前序路径边缘的 effects
              自动推接入场状态。您可以在右侧试玩过程中自由调整，实时检验高好感度/低好感度分支与立绘演出效果。
            </p>

            <div className="mt-4 space-y-3">
              {Object.keys(variables).length === 0 ? (
                <div className="rounded-lg border border-border/80 bg-surface-container-low p-3 text-center text-muted-foreground">
                  项目未定义故事变量
                </div>
              ) : (
                Object.entries(variables).map(([key, val]) => {
                  const def = plan.variables?.find((v) => v.id === key);
                  const isBool =
                    def?.kind === "boolean" ||
                    val === "true" ||
                    val === "false";
                  return (
                    <div
                      key={key}
                      className="rounded-lg border border-border/70 bg-surface-container-lowest p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {key}
                        </span>
                        {def?.description && (
                          <span className="text-[11px] text-muted-foreground truncate">
                            {def.description}
                          </span>
                        )}
                      </div>

                      <div className="mt-2">
                        {isBool ? (
                          <label className="flex cursor-pointer items-center justify-between">
                            <span className="text-[11px] text-muted-foreground">
                              {val === "true"
                                ? "启用 (true)"
                                : "未启用 (false)"}
                            </span>
                            <Switch
                              checked={val === "true"}
                              onCheckedChange={(checked) =>
                                handleVariableChange(
                                  key,
                                  checked ? "true" : "false",
                                )
                              }
                            />
                          </label>
                        ) : (
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              aria-label={`变量 ${key}`}
                              value={val}
                              onChange={(e) =>
                                handleVariableChange(key, e.target.value)
                              }
                              className="h-7 w-20 rounded border border-border bg-surface-container-low px-2 text-xs font-mono text-foreground"
                            />
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="size-6 p-0 text-xs"
                                onClick={() =>
                                  handleVariableChange(
                                    key,
                                    String(Number(val || 0) - 1),
                                  )
                                }
                              >
                                -1
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="size-6 p-0 text-xs"
                                onClick={() =>
                                  handleVariableChange(
                                    key,
                                    String(Number(val || 0) + 1),
                                  )
                                }
                              >
                                +1
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Quick Action Button */}
            <Button
              className="mt-5 w-full"
              size="sm"
              onClick={() => preview.sync()}
              disabled={!preview.ready}
            >
              <RefreshCw className="size-3.5" /> 应用变量并重播本场
            </Button>
          </aside>

          {/* Right panel: WebGAL Runtime Iframe */}
          <main className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
            {preview.error ? (
              <div className="p-6 text-center text-sm text-destructive">
                {preview.error}
              </div>
            ) : preview.url ? (
              <iframe
                title="WebGAL 即时单场试玩"
                src={preview.url}
                onLoad={preview.onFrameLoad}
                className="h-full w-full border-0"
              />
            ) : (
              <div className="text-sm text-muted-foreground">
                正在加载 WebGAL 引擎...
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
