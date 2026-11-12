import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Film,
  Filter,
  Layers,
  ListOrdered,
  Sparkles,
} from "lucide-react";
import type {
  SceneApprovalStatus,
  ScenePlan,
  StoryPlan,
} from "../../lib/pipeline-types";
import { SceneCard } from "./SceneCard";
import { ScenePreviewDialog } from "./ScenePreviewDialog";
import { readFileText } from "../../lib/webgal-ipc";

export interface SceneProductionQueueProps {
  projectPath: string;
  plan: StoryPlan;
  busy: boolean;
  selectedSceneId?: string | null;
  onSelectScene?: (scene: ScenePlan) => void;
  onRunScene: (sceneId: string) => Promise<string | boolean>;
  onApproveScene: (sceneId: string) => Promise<StoryPlan | null>;
  onUnlockScene: (sceneId: string) => Promise<StoryPlan | null>;
}

type FilterOption = "all" | SceneApprovalStatus;

export function SceneProductionQueue({
  projectPath,
  plan,
  busy,
  selectedSceneId,
  onSelectScene,
  onRunScene,
  onApproveScene,
  onUnlockScene,
}: SceneProductionQueueProps) {
  const [filter, setFilter] = useState<FilterOption>("all");
  const [previewScene, setPreviewScene] = useState<ScenePlan | null>(null);
  const [previewScript, setPreviewScript] = useState<string>("");

  const scenes = useMemo(() => plan.scenePlans ?? [], [plan.scenePlans]);

  // Character ID -> Name mapping
  const characterNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const char of plan.characters ?? []) {
      map[char.id] = char.name || char.id;
    }
    return map;
  }, [plan.characters]);

  // Status stats
  const stats = useMemo(() => {
    const counts: Record<SceneApprovalStatus, number> = {
      pending: 0,
      drafted: 0,
      approved: 0,
      stale: 0,
    };
    for (const s of scenes) {
      const st = s.approvalStatus ?? "pending";
      counts[st] = (counts[st] ?? 0) + 1;
    }
    return counts;
  }, [scenes]);

  const filteredScenes = useMemo(() => {
    if (filter === "all") return scenes;
    return scenes.filter((s) => (s.approvalStatus ?? "pending") === filter);
  }, [scenes, filter]);

  const handleOpenPreview = async (scene: ScenePlan) => {
    try {
      // First check if scene file exists in project, otherwise use draft beats
      const scenePath = `${projectPath}/game/scene/${scene.file}`;
      let text = "";
      try {
        text = await readFileText(scenePath);
      } catch {
        // Fallback to drafting from StoryPlan sceneDrafts
        const draft = plan.sceneDrafts?.find((d) => d.sceneId === scene.id);
        if (draft) {
          text = draft.beats
            .map((beat) => {
              const clean = (text: string) => text.trim().replace(/[\r\n]/g, ' ').replace(/;/g, '；');
              const speaker = plan.characters?.find((character) => character.id === beat.speaker)?.name ?? beat.speaker;
              return `${speaker ? clean(speaker).replace(/:/g, '：') : ''}:${clean(beat.text)};`;
            })
            .join("\n");
        }
      }
      setPreviewScript(text);
      setPreviewScene(scene);
    } catch {
      setPreviewScript("");
      setPreviewScene(scene);
    }
  };

  if (scenes.length === 0) {
    return (
      <section
        aria-label="分场制作队列"
        className="rounded-xl border border-dashed border-border p-8 text-center"
      >
        <Film className="mx-auto size-8 text-muted-foreground/60" />
        <h3 className="mt-3 text-sm font-semibold text-foreground">
          分场队列尚未展开
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          完成 Stage 1「立项企划」后，系统将自动根据章节大纲展开分场队列。
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Stage 2 分场制作队列" className="space-y-4">
      {/* Stage 2 Section Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-container-low p-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              2
            </span>
            <h3 className="text-base font-semibold text-foreground">
              Stage 2 · 分场制作队列 (Scene Production Queue)
            </h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            单场独立生成、快速迭代与通过锁定。每个场景完成后可直接进行带变量模拟的即时试玩。
          </p>
        </div>

        {/* Progress Counters */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface-container-lowest px-2.5 py-1 font-medium">
            <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            通过并锁定：{stats.approved} / {scenes.length}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface-container-lowest px-2.5 py-1 font-medium text-muted-foreground">
            草稿：{stats.drafted}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface-container-lowest px-2.5 py-1 font-medium text-muted-foreground">
            待生成：{stats.pending}
          </span>
          {stats.stale > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-medium text-amber-800 dark:text-amber-300">
              陈旧：{stats.stale}
            </span>
          )}
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-2 text-xs">
        <span className="mr-1 text-muted-foreground">筛选：</span>
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-lg px-2.5 py-1 transition-colors ${
            filter === "all"
              ? "bg-primary text-primary-foreground font-medium"
              : "text-muted-foreground hover:bg-surface-container-low hover:text-foreground"
          }`}
        >
          全部 ({scenes.length})
        </button>
        <button
          type="button"
          onClick={() => setFilter("pending")}
          className={`rounded-lg px-2.5 py-1 transition-colors ${
            filter === "pending"
              ? "bg-primary text-primary-foreground font-medium"
              : "text-muted-foreground hover:bg-surface-container-low hover:text-foreground"
          }`}
        >
          待生成 ({stats.pending})
        </button>
        <button
          type="button"
          onClick={() => setFilter("drafted")}
          className={`rounded-lg px-2.5 py-1 transition-colors ${
            filter === "drafted"
              ? "bg-primary text-primary-foreground font-medium"
              : "text-muted-foreground hover:bg-surface-container-low hover:text-foreground"
          }`}
        >
          已生成草稿 ({stats.drafted})
        </button>
        <button
          type="button"
          onClick={() => setFilter("approved")}
          className={`rounded-lg px-2.5 py-1 transition-colors ${
            filter === "approved"
              ? "bg-primary text-primary-foreground font-medium"
              : "text-muted-foreground hover:bg-surface-container-low hover:text-foreground"
          }`}
        >
          已通过 ({stats.approved})
        </button>
        {stats.stale > 0 && (
          <button
            type="button"
            onClick={() => setFilter("stale")}
            className={`rounded-lg px-2.5 py-1 transition-colors ${
              filter === "stale"
                ? "bg-amber-600 text-white font-medium"
                : "text-amber-700 dark:text-amber-300 hover:bg-amber-500/10"
            }`}
          >
            陈旧 ({stats.stale})
          </button>
        )}
      </div>

      {/* Scene Cards Grid */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {filteredScenes.map((scene) => {
          const hasScript = Boolean(
            plan.scenes?.includes(scene.file) ||
            plan.sceneDrafts?.some((d) => d.sceneId === scene.id),
          );
          const status = scene.approvalStatus ?? "pending";

          return (
            <SceneCard
              key={scene.id}
              scene={scene}
              sceneIndex={scenes.findIndex((item) => item.id === scene.id)}
              status={status}
              hasScript={hasScript}
              characterNames={characterNames}
              busy={busy}
              selected={selectedSceneId === scene.id}
              onSelect={() => onSelectScene?.(scene)}
              onRun={() => onRunScene(scene.id)}
              onApprove={() => onApproveScene(scene.id)}
              onUnlock={() => onUnlockScene(scene.id)}
              onPreview={() => handleOpenPreview(scene)}
            />
          );
        })}
      </div>

      {/* Live Preview Modal */}
      <ScenePreviewDialog
        open={Boolean(previewScene)}
        onClose={() => setPreviewScene(null)}
        projectPath={projectPath}
        scene={previewScene}
        plan={plan}
        sceneScript={previewScript}
      />
    </section>
  );
}
