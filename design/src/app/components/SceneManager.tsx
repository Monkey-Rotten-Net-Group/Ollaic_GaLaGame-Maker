import { useState, useCallback, useRef, useEffect } from 'react';
import { X, FilePlus, Pencil, Check, Loader2, ArrowLeft } from 'lucide-react';
import {
  getScenePath, createScene, openProject, updateSceneHeader,
  type ProjectInfo, type SceneHeader,
} from '../lib/webgal-ipc';

export interface SceneManagerPanelProps {
  projectPath: string;
  projectInfo: ProjectInfo;
  currentSceneName: string;
  sceneHeaders: Record<string, SceneHeader>;
  onSwitchScene: (name: string) => void;
  onHeaderUpdated: (name: string, header: SceneHeader) => void;
  onSceneCreated: () => Promise<void>;
  onClose: () => void;
}

export function SceneManagerPanel({
  projectPath,
  projectInfo,
  currentSceneName,
  sceneHeaders,
  onSwitchScene,
  onHeaderUpdated,
  onSceneCreated,
  onClose,
}: SceneManagerPanelProps) {
  // Edit sub-panel
  const [editingScene, setEditingScene] = useState<string | null>(null);
  const [editChapter, setEditChapter] = useState('');
  const [editOutline, setEditOutline] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // New scene form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showNewForm) setTimeout(() => newInputRef.current?.focus(), 40);
  }, [showNewForm]);

  // ---------------------------------------------------------------------------
  // Edit panel
  // ---------------------------------------------------------------------------
  const openEdit = useCallback((name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const h = sceneHeaders[name] ?? {};
    setEditingScene(name);
    setEditChapter(h.chapter ?? '');
    setEditOutline(h.outline ?? '');
    setSaved(false);
  }, [sceneHeaders]);

  const closeEdit = useCallback(() => setEditingScene(null), []);

  const handleSave = useCallback(async () => {
    if (!editingScene) return;
    setSaving(true);
    try {
      const path = await getScenePath(projectPath, editingScene);
      const header: SceneHeader = {
        chapter: editChapter.trim() || undefined,
        outline: editOutline.trim() || undefined,
      };
      await updateSceneHeader(path, header);
      onHeaderUpdated(editingScene, header);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      console.error('SceneManager: save header failed', e);
    }
    setSaving(false);
  }, [editingScene, editChapter, editOutline, projectPath, onHeaderUpdated]);

  // ---------------------------------------------------------------------------
  // Create scene
  // ---------------------------------------------------------------------------
  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      await createScene(projectPath, newName.trim());
      await onSceneCreated();
      setNewName('');
      setShowNewForm(false);
    } catch (e) {
      setCreateError(String(e));
    }
    setCreating(false);
  }, [projectPath, newName, onSceneCreated]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="relative h-full w-full flex flex-col">

      {/* ── Level 2: edit view (replaces list) ── */}
      {editingScene ? (
      <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-3 border-b border-border flex-shrink-0">
            <button
              onClick={closeEdit}
              className="p-1 rounded hover:bg-secondary/50 transition-colors"
              aria-label="返回场景列表"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-sm font-medium font-display-family flex-1 truncate">
              {editingScene}
            </span>
            {saved && <Check className="w-3.5 h-3.5 text-chart-5 flex-shrink-0" />}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 font-mono-family">
                章节
              </label>
              <input
                type="text"
                value={editChapter}
                onChange={(e) => setEditChapter(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleSave()}
                placeholder="例: 第一章 · 序幕"
                className="w-full px-3 py-1.5 bg-secondary/30 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 font-mono-family">
                大纲
              </label>
              <textarea
                value={editOutline}
                onChange={(e) => setEditOutline(e.target.value)}
                placeholder="场景内容简介"
                rows={5}
                className="w-full px-3 py-1.5 bg-secondary/30 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none transition-all"
              />
            </div>
          </div>

          <div className="px-4 py-3 border-t border-border flex-shrink-0">
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {saving ? '保存中' : '保存'}
            </button>
          </div>
        </div>
      ) : (
      /* ── Level 1: scene list ── */
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-1 px-3 py-3 border-b border-border flex-shrink-0">
          <span className="text-sm font-medium font-display-family flex-1">场景管理</span>
          <button
            onClick={() => { setShowNewForm((v) => !v); setCreateError(''); setNewName(''); }}
            className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors"
            title="新建场景"
            aria-label="新建场景"
          >
            <FilePlus className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors"
            aria-label="关闭场景管理"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* New scene inline form */}
        {showNewForm && (
          <div className="px-3 py-3 border-b border-border space-y-2 flex-shrink-0">
            <input
              ref={newInputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
                if (e.key === 'Escape') setShowNewForm(false);
              }}
              placeholder="文件名（不含 .txt）"
              className="w-full px-3 py-1.5 bg-secondary/30 border border-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <div className="flex gap-2">
              <button
                onClick={() => void handleCreate()}
                disabled={!newName.trim() || creating}
                className="flex-1 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1 transition-all"
              >
                {creating
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Check className="w-3 h-3" />}
                创建
              </button>
              <button
                onClick={() => setShowNewForm(false)}
                className="px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 text-xs transition-colors"
              >
                取消
              </button>
            </div>
            {createError && <p className="text-xs text-destructive">{createError}</p>}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {projectInfo.scenes.map((name) => {
            const h = sceneHeaders[name] ?? {};
            const isCurrent = name === currentSceneName;
            const isEditing = name === editingScene;

            return (
              <button
                key={name}
                onClick={() => onSwitchScene(name)}
                className={`w-full text-left px-3 py-2.5 border-b border-border/50 transition-all group flex items-start gap-2 ${
                  isCurrent
                    ? 'bg-primary/10 border-l-2 border-l-primary'
                    : 'hover:bg-secondary/30 border-l-2 border-l-transparent'
                }`}
              >
                <div className="flex-1 min-w-0">
                  {h.chapter ? (
                    <>
                      <div className={`text-sm truncate leading-snug ${isCurrent ? 'text-primary font-medium' : ''}`}>
                        {h.chapter}
                      </div>
                      {h.outline && (
                        <div className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
                          {h.outline}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className={`text-xs font-mono-family truncate ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`}>
                      {name}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => openEdit(name, e)}
                  className={`flex-shrink-0 p-1 rounded transition-colors mt-0.5 ${
                    isEditing
                      ? 'text-primary bg-primary/10'
                      : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-secondary/50'
                  }`}
                  aria-label={`编辑 ${name} 元数据`}
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </button>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}
