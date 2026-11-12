import { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, Package, RotateCcw, Save, X } from 'lucide-react';
import type { ExportValidationIssue, ProjectMetadata } from '../lib/webgal-ipc';

export type ExportTaskStatus = 'idle' | 'savingMetadata' | 'exporting' | 'succeeded' | 'failed';

export interface ExportTaskState {
  status: ExportTaskStatus;
  outputPath?: string;
  warnings: string[];
  issues: ExportValidationIssue[];
  error?: string;
  failureCount: number;
}

interface Props {
  open: boolean;
  projectName: string;
  initialMetadata: ProjectMetadata | null;
  exportTask?: ExportTaskState;
  saving?: boolean;
  onClose: () => void;
  onSave: (metadata: ProjectMetadata) => Promise<void> | void;
  onExport: (metadata: ProjectMetadata, outputDir: string, asZip: boolean) => Promise<void> | void;
  onRetryExport?: () => Promise<void> | void;
}

const EMPTY_METADATA: ProjectMetadata = {
  synopsis: '',
  description: '',
  coverPath: '',
  tags: [],
  version: '0.1.0',
  releaseNotes: '',
  lastExportDir: '',
};

export function ProjectMetadataDialog({
  open,
  projectName,
  initialMetadata,
  exportTask,
  saving = false,
  onClose,
  onSave,
  onExport,
  onRetryExport,
}: Props) {
  const [metadata, setMetadata] = useState<ProjectMetadata>(EMPTY_METADATA);
  const [tagsInput, setTagsInput] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [asZip, setAsZip] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next = initialMetadata ?? EMPTY_METADATA;
    setMetadata(next);
    setTagsInput(next.tags.join(', '));
    setOutputDir(next.lastExportDir || '');
  }, [open, initialMetadata]);

  const normalizedMetadata = useMemo<ProjectMetadata>(
    () => ({
      ...metadata,
      version: metadata.version.trim() || '0.1.0',
      tags: tagsInput
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    }),
    [metadata, tagsInput],
  );

  if (!open) return null;

  const task = exportTask ?? {
    status: 'idle',
    warnings: [],
    issues: [],
    failureCount: 0,
  };
  const exporting = task.status === 'savingMetadata' || task.status === 'exporting';

  const update = (patch: Partial<ProjectMetadata>) => {
    setMetadata((prev) => ({ ...prev, ...patch }));
  };

  const handlePickOutputDir = async () => {
    const dir = await openDialog({
      title: '选择导出目录',
      directory: true,
      defaultPath: outputDir || metadata.lastExportDir || undefined,
    });
    if (dir) setOutputDir(dir);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-display-family">项目元信息与导出</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              为《{projectName}》维护简介、版本与导出说明。导出结果会包含标准 WebGAL 目录和元信息文件。
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 hover:bg-secondary/50 transition-colors"
            aria-label="关闭项目元信息对话框"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid gap-5 px-5 py-5 md:grid-cols-[1.3fr_1fr]">
          <div className="space-y-4">
            <Field label="项目简介">
              <textarea
                value={metadata.description}
                onChange={(e) => update({ description: e.target.value })}
                rows={4}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-relaxed"
                placeholder="填写作品简介，用于项目卡片与导出交付说明。"
              />
            </Field>

            <Field label="剧情摘要">
              <textarea
                value={metadata.synopsis}
                onChange={(e) => update({ synopsis: e.target.value })}
                rows={6}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-relaxed"
                placeholder="记录创作设定、剧情概览或对 AI 很重要的世界观摘要。"
              />
            </Field>

            <Field label="封面路径">
              <input
                type="text"
                value={metadata.coverPath}
                onChange={(e) => update({ coverPath: e.target.value })}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm"
                placeholder="可选，留空表示暂不指定"
              />
            </Field>
          </div>

          <div className="space-y-4">
            <Field label="版本号">
              <input
                type="text"
                value={metadata.version}
                onChange={(e) => update({ version: e.target.value })}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm"
                placeholder="0.1.0"
              />
            </Field>

            <Field label="标签">
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm"
                placeholder="悬疑, 校园, 多分支"
              />
              <div className="mt-1 text-xs text-muted-foreground">使用英文逗号分隔。</div>
            </Field>

            <Field label="更新日志">
              <textarea
                value={metadata.releaseNotes}
                onChange={(e) => update({ releaseNotes: e.target.value })}
                rows={6}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-relaxed"
                placeholder="记录本次导出交付的改动摘要。"
              />
            </Field>

            <Field label="导出目录">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                  className="flex-1 rounded-md border border-border bg-input-background px-3 py-2 text-sm"
                  placeholder="请选择导出目录"
                />
                <button
                  onClick={handlePickOutputDir}
                  className="rounded-md border border-border bg-secondary px-3 py-2 hover:bg-secondary/70 transition-colors"
                  aria-label="选择导出目录"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={asZip}
                  onChange={(e) => setAsZip(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                同时打包为 zip 文件
              </label>
            </Field>
          </div>
        </div>

        {(task.status !== 'idle' || task.warnings.length > 0 || task.issues.length > 0) && (
          <div className="border-t border-border px-5 py-4">
            <ExportStatus task={task} onRetry={onRetryExport} retryDisabled={saving || exporting} />
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border px-5 py-4">
          <div className="text-xs text-muted-foreground">
            导出时会生成 `game/` 与 `project-metadata.json`，方便测试交付或未来平台接入。
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void onSave(normalizedMetadata)}
              disabled={saving || exporting}
              className="rounded-md bg-secondary px-4 py-2 text-sm hover:bg-secondary/70 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? '保存中…' : '保存元信息'}
            </button>
            <button
              onClick={() => void onExport(normalizedMetadata, outputDir, asZip)}
              disabled={saving || exporting || !outputDir.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-2"
            >
              <Package className="w-3.5 h-3.5" />
              {exporting ? '导出中…' : '导出项目'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportStatus({
  task,
  onRetry,
  retryDisabled,
}: {
  task: ExportTaskState;
  onRetry?: () => Promise<void> | void;
  retryDisabled: boolean;
}) {
  const warningIssues = task.issues.filter((issue) => issue.level === 'warning');
  const errorIssues = task.issues.filter((issue) => issue.level === 'error');

  if (task.status === 'savingMetadata' || task.status === 'exporting') {
    return (
      <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span>{task.status === 'savingMetadata' ? '正在保存项目元信息…' : '正在导出项目…'}</span>
        </div>
      </div>
    );
  }

  if (task.status === 'succeeded') {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" />
          <div className="min-w-0">
            <div className="font-medium text-emerald-700 dark:text-emerald-300">导出成功</div>
            {task.outputPath && <div className="mt-1 break-all text-xs text-muted-foreground">{task.outputPath}</div>}
            <IssueList warnings={task.warnings} warningIssues={warningIssues} errorIssues={errorIssues} />
          </div>
        </div>
      </div>
    );
  }

  if (task.status === 'failed') {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-destructive">
              导出失败{task.failureCount > 1 ? `（第 ${task.failureCount} 次）` : ''}
            </div>
            {task.error && <div className="mt-1 break-words text-xs text-muted-foreground">{task.error}</div>}
            <IssueList warnings={task.warnings} warningIssues={warningIssues} errorIssues={errorIssues} />
          </div>
          {onRetry && (
            <button
              onClick={() => void onRetry()}
              disabled={retryDisabled}
              className="shrink-0 rounded-md bg-secondary px-3 py-1.5 text-xs hover:bg-secondary/70 disabled:opacity-50 flex items-center gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重试
            </button>
          )}
        </div>
      </div>
    );
  }

  if (task.warnings.length > 0 || task.issues.length > 0) {
    return (
      <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
        <IssueList warnings={task.warnings} warningIssues={warningIssues} errorIssues={errorIssues} />
      </div>
    );
  }

  return null;
}

function IssueList({
  warnings,
  warningIssues,
  errorIssues,
}: {
  warnings: string[];
  warningIssues: ExportValidationIssue[];
  errorIssues: ExportValidationIssue[];
}) {
  const rows = [
    ...errorIssues.map((issue) => ({ kind: '错误', text: formatIssue(issue) })),
    ...warningIssues.map((issue) => ({ kind: '警告', text: formatIssue(issue) })),
    ...warnings.map((warning) => ({ kind: '警告', text: warning })),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      {rows.map((row, index) => (
        <div key={`${row.kind}-${index}`} className="break-words">
          <span className="font-medium">{row.kind}: </span>
          {row.text}
        </div>
      ))}
    </div>
  );
}

function formatIssue(issue: ExportValidationIssue): string {
  return issue.path ? `${issue.message} (${issue.path})` : issue.message;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
        {label}
      </div>
      {children}
    </div>
  );
}
