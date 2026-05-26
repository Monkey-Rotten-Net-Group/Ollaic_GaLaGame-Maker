import { useEffect, useState } from 'react';
import { emptyProjectMemory, type ProjectMemory } from '../lib/project-memory';

interface AiMemoryPanelProps {
  memory: ProjectMemory | null;
  disabled?: boolean;
  onSave: (memory: ProjectMemory) => Promise<void>;
}

export function AiMemoryPanel({ memory, disabled = false, onSave }: AiMemoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectMemory>(memory ?? emptyProjectMemory());
  const [saving, setSaving] = useState(false);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(memory ?? emptyProjectMemory());

  useEffect(() => {
    setDraft(memory ?? emptyProjectMemory());
  }, [memory]);

  const update = (patch: Partial<ProjectMemory>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ ...draft, updatedAt: new Date().toISOString() });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-border bg-card/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-muted-foreground hover:bg-secondary/40"
      >
        <span>项目记忆</span>
        {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-label="有未保存的项目记忆" />}
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <textarea
            value={draft.worldSetting}
            onChange={(e) => update({ worldSetting: e.target.value })}
            disabled={disabled}
            placeholder="世界观 / 背景设定"
            className="h-16 w-full resize-none rounded-md border border-border bg-input-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <textarea
            value={draft.writingStyle}
            onChange={(e) => update({ writingStyle: e.target.value })}
            disabled={disabled}
            placeholder="写作风格偏好"
            className="h-16 w-full resize-none rounded-md border border-border bg-input-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <textarea
            value={draft.userPreferences}
            onChange={(e) => update({ userPreferences: e.target.value })}
            disabled={disabled}
            placeholder="用户特殊偏好"
            className="h-16 w-full resize-none rounded-md border border-border bg-input-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={disabled || saving}
            className={`w-full rounded-md px-3 py-2 text-xs hover:bg-secondary/70 disabled:opacity-40 ${
              isDirty ? 'bg-primary text-primary-foreground hover:opacity-90' : 'bg-secondary'
            }`}
          >
            {saving ? '保存中...' : isDirty ? '保存记忆*' : '保存记忆'}
          </button>
        </div>
      )}
    </div>
  );
}
