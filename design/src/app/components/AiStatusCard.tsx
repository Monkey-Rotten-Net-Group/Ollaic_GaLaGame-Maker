import type { MissingAssetIssue } from '../lib/story-agent';

interface MissingAssetCardProps {
  issues: MissingAssetIssue[];
  onUseFallback: () => void;
  onOpenAssets: () => void;
  onRetryPrompt: () => void;
}

interface ConflictCardProps {
  onKeepManual: () => void;
  onApplyAi: () => void;
  onRegenerate: () => void;
}

interface ErrorCardProps {
  message: string;
  canRetry: boolean;
  cooldown: number;
  showSettings?: boolean;
  onRetry: () => void;
  onOpenSettings: () => void;
}

const categoryLabels: Record<string, string> = {
  background: '背景',
  figure: '立绘',
  bgm: 'BGM',
  vocal: '语音 / 音效',
  video: '视频',
};

export function MissingAssetCard({ issues, onUseFallback, onOpenAssets, onRetryPrompt }: MissingAssetCardProps) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs">
      <div className="font-medium text-foreground">发现缺失素材</div>
      <div className="mt-2 space-y-1 text-muted-foreground">
        {issues.map((issue) => (
          <div key={`${issue.command}-${issue.file}`}>
            缺少{categoryLabels[issue.expectedCategory] ?? issue.expectedCategory}素材「{issue.file}」（命令：{issue.command}）
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        <button type="button" onClick={onUseFallback} className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">
          暂用默认素材继续
        </button>
        <button type="button" onClick={onOpenAssets} className="w-full rounded-md bg-secondary px-3 py-2 hover:bg-secondary/70">
          去素材库补充
        </button>
        <button type="button" onClick={onRetryPrompt} className="w-full rounded-md border border-border bg-background/60 px-3 py-2 hover:bg-secondary/70">
          重新描述需求
        </button>
      </div>
    </div>
  );
}

export function ConflictCard({ onKeepManual, onApplyAi, onRegenerate }: ConflictCardProps) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs">
      <div className="font-medium text-foreground">检测到内容冲突</div>
      <p className="mt-2 text-muted-foreground">
        你在 AI 方案待确认期间手动修改了脚本。当前有两份内容：AI 方案与手动修改。
      </p>
      <div className="mt-3 space-y-2">
        <button type="button" onClick={onKeepManual} className="w-full rounded-md bg-secondary px-3 py-2 hover:bg-secondary/70">
          丢弃 AI 方案，保留手动修改
        </button>
        <button type="button" onClick={onApplyAi} className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">
          丢弃手动修改，应用 AI 方案
        </button>
        <button type="button" onClick={onRegenerate} className="w-full rounded-md border border-border bg-background/60 px-3 py-2 hover:bg-secondary/70">
          重新生成（基于你的最新内容）
        </button>
      </div>
    </div>
  );
}

export function ErrorCard({ message, canRetry, cooldown, showSettings = true, onRetry, onOpenSettings }: ErrorCardProps) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
      <div className="whitespace-pre-wrap">{message}</div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={!canRetry || cooldown > 0}
          className="rounded-md bg-secondary px-3 py-2 text-foreground hover:bg-secondary/70 disabled:opacity-40"
        >
          {cooldown > 0 ? `${cooldown}s 后重试` : '重试'}
        </button>
        {showSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md bg-secondary px-3 py-2 text-foreground hover:bg-secondary/70"
          >
            打开 AI 设置
          </button>
        )}
      </div>
    </div>
  );
}
