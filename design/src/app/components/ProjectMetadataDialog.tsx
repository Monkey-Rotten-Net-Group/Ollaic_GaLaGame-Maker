import { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Package, Save, X } from 'lucide-react';
import type { ProjectMetadata } from '../lib/webgal-ipc';

interface Props {
  open: boolean;
  projectName: string;
  initialMetadata: ProjectMetadata | null;
  exporting?: boolean;
  saving?: boolean;
  onClose: () => void;
  onSave: (metadata: ProjectMetadata) => Promise<void> | void;
  onExport: (metadata: ProjectMetadata, outputDir: string) => Promise<void> | void;
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
  exporting = false,
  saving = false,
  onClose,
  onSave,
  onExport,
}: Props) {
  const [metadata, setMetadata] = useState<ProjectMetadata>(EMPTY_METADATA);
  const [tagsInput, setTagsInput] = useState('');
  const [outputDir, setOutputDir] = useState('');

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
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="填写作品简介，用于项目卡片与导出交付说明。"
              />
            </Field>

            <Field label="剧情摘要">
              <textarea
                value={metadata.synopsis}
                onChange={(e) => update({ synopsis: e.target.value })}
                rows={6}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="记录创作设定、剧情概览或对 AI 很重要的世界观摘要。"
              />
            </Field>

            <Field label="封面路径">
              <input
                type="text"
                value={metadata.coverPath}
                onChange={(e) => update({ coverPath: e.target.value })}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
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
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="0.1.0"
              />
            </Field>

            <Field label="标签">
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="悬疑, 校园, 多分支"
              />
              <div className="mt-1 text-xs text-muted-foreground">使用英文逗号分隔。</div>
            </Field>

            <Field label="更新日志">
              <textarea
                value={metadata.releaseNotes}
                onChange={(e) => update({ releaseNotes: e.target.value })}
                rows={6}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="记录本次导出交付的改动摘要。"
              />
            </Field>

            <Field label="导出目录">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                  className="flex-1 rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
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
            </Field>
          </div>
        </div>

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
              onClick={() => void onExport(normalizedMetadata, outputDir)}
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
