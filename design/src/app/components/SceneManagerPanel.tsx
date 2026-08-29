import { useState, useCallback } from 'react';
import {
  X, Plus, FolderOpen, Pencil, Check, Trash2,
} from 'lucide-react';
import { updateSceneHeader, type ProjectInfo, type SceneHeader } from '../lib/webgal-ipc';

export interface SceneManagerPanelProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  projectInfo: ProjectInfo | null;
  currentSceneName: string;
  sceneHeaders: Record<string, SceneHeader>;
  onSwitchScene: (name: string) => void;
  onHeaderUpdated: (name: string, header: SceneHeader) => void;
  onRefreshProject: () => Promise<void>;
  onNewScene: () => Promise<void>;
  onDeleteScene: (name: string) => Promise<void>;
}

export function SceneManagerPanel({
  open,
  onClose,
  projectPath,
  projectInfo,
  currentSceneName,
  sceneHeaders,
  onSwitchScene,
  onHeaderUpdated,
  onRefreshProject,
  onNewScene,
  onDeleteScene,
}: SceneManagerPanelProps) {
  const [editingScene, setEditingScene] = useState<string | null>(null);
  const [editChapter, setEditChapter] = useState('');
  const [editOutline, setEditOutline] = useState('');
  const [saving, setSaving] = useState(false);

  const scenes = projectInfo?.scenes ?? [];

  const handleEdit = useCallback((sceneName: string) => {
    const header = sceneHeaders[sceneName] || {};
    setEditingScene(sceneName);
    setEditChapter(header.chapter || '');
    setEditOutline(header.outline || '');
  }, [sceneHeaders]);

  const handleSaveHeader = useCallback(async (sceneName: string) => {
    if (!projectPath) return;
    setSaving(true);
    try {
      const header: SceneHeader = { chapter: editChapter.trim(), outline: editOutline.trim() };
      await updateSceneHeader(projectPath, sceneName, header);
      onHeaderUpdated(sceneName, header);
      setEditingScene(null);
    } catch (e) {
      console.error('Failed to update scene header:', e);
    } finally {
      setSaving(false);
    }
  }, [projectPath, editChapter, editOutline, onHeaderUpdated]);

  if (!open) return null;

  return (
    <div className="fixed bottom-0 right-0 top-12 z-40 flex w-80 flex-col border-l border-border bg-surface-container-lowest shadow-[-8px_0_24px_var(--shadow-soft)]">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <span className="flex items-center gap-1.5 font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
          <FolderOpen className="h-3 w-3 text-secondary" /> 场景管理
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ollaic-icon-button h-6 w-6"
          aria-label="关闭场景管理"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {scenes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-muted-foreground">
            <FolderOpen className="h-8 w-8 opacity-40" />
            <p className="text-sm">暂无场景文件</p>
          </div>
        ) : (
          <div className="divide-y divide-outline-variant/20">
            {scenes.map((sceneName) => {
              const header = sceneHeaders[sceneName] || {};
              const isCurrent = sceneName === currentSceneName;
              const isEditing = editingScene === sceneName;

              return (
                <div key={sceneName} className={`${isCurrent ? 'bg-secondary-container/20' : ''}`}>
                  {isEditing ? (
                    <div className="space-y-2 p-3">
                      <input
                        type="text"
                        value={editChapter}
                        onChange={(e) => setEditChapter(e.target.value)}
                        placeholder="章节名称"
                        className="w-full rounded border border-border bg-surface-container-low px-2 py-1 text-xs focus:border-secondary focus:outline-none"
                        aria-label="章节名称"
                      />
                      <input
                        type="text"
                        value={editOutline}
                        onChange={(e) => setEditOutline(e.target.value)}
                        placeholder="概要"
                        className="w-full rounded border border-border bg-surface-container-low px-2 py-1 text-xs focus:border-secondary focus:outline-none"
                        aria-label="概要"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => { void handleSaveHeader(sceneName); }}
                          disabled={saving}
                          className="flex items-center gap-1 rounded bg-secondary-container/60 px-3 py-1 text-[10px] font-semibold text-secondary hover:bg-secondary-container disabled:opacity-50"
                        >
                          <Check className="h-3 w-3" />
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingScene(null)}
                          className="rounded px-3 py-1 text-[10px] text-muted-foreground hover:bg-surface-container-low"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3 px-3 py-3 hover:bg-surface-container-low transition-colors">
                      <div className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${isCurrent ? 'bg-secondary' : 'bg-outline-variant/40'}`} />
                      <button
                        type="button"
                        onClick={() => onSwitchScene(sceneName)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-sm font-semibold text-on-surface">
                          {header.chapter || sceneName.replace(/\.txt$/, '')}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {header.outline || sceneName}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleEdit(sceneName); }}
                        className="shrink-0 rounded p-1 text-outline-variant/60 hover:bg-surface-container-low hover:text-foreground"
                        title="编辑章节信息"
                        aria-label="编辑章节信息"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onDeleteScene(sceneName);
                        }}
                        disabled={scenes.length <= 1}
                        className="flex shrink-0 items-center gap-1 rounded border border-transparent px-2 py-1 text-[10px] text-outline-variant/70 hover:border-error/30 hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-30"
                        title={scenes.length <= 1 ? '至少保留一个场景' : '删除场景'}
                        aria-label="删除场景"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border p-3">
        <button
          type="button"
          onClick={() => { void onNewScene(); }}
          className="flex w-full items-center justify-center gap-2 rounded border border-dashed border-outline-variant/50 py-2 text-sm text-muted-foreground hover:border-secondary hover:text-secondary transition-colors"
        >
          <Plus className="h-4 w-4" />
          新建场景
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex w-full items-center justify-center gap-2 rounded border border-border bg-surface-container-low py-2 text-sm text-on-surface-variant hover:border-outline-variant hover:text-on-surface transition-colors"
        >
          <X className="h-4 w-4" />
          关闭面板
        </button>
      </div>
    </div>
  );
}
