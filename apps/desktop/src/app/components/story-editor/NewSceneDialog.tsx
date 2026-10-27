import { useEffect, useState } from 'react';
import { AlertCircle, FolderOpen, Loader2, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface NewSceneDialogProps {
  open: boolean;
  existingScenes: string[];
  onOpenChange: (open: boolean) => void;
  onCreate: (sceneName: string) => Promise<void>;
}

export function NewSceneDialog({
  open,
  existingScenes,
  onOpenChange,
  onCreate,
}: NewSceneDialogProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setError('');
    }
  }, [open]);

  const normalizedName = name.trim().replace(/\.txt$/i, '');
  const sceneName = normalizedName ? `${normalizedName}.txt` : '';

  const create = async () => {
    if (creating) return;
    if (!normalizedName) {
      setError('请输入场景文件名。');
      return;
    }
    if (/[\\/:*?"<>|]/.test(normalizedName)) {
      setError('文件名不能包含 \\ / : * ? " < > |。');
      return;
    }
    if (existingScenes.includes(sceneName)) {
      setError(`场景 ${sceneName} 已存在。`);
      return;
    }
    setCreating(true);
    setError('');
    try {
      await onCreate(sceneName);
      onOpenChange(false);
    } catch (cause) {
      setError(`创建场景失败: ${String(cause)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent className="max-w-md overflow-hidden border-border bg-surface-container-lowest p-0 shadow-2xl">
        <DialogHeader className="border-b border-border bg-surface-container px-5 py-4 text-left">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded border border-secondary/30 bg-secondary/10 text-primary">
              <FolderOpen className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="font-display-family text-base text-on-surface">新建场景</DialogTitle>
              <DialogDescription className="mt-1 text-xs text-muted-foreground">
                在 game/scene 下创建新的 WebGAL 场景脚本。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="space-y-4 px-5 py-5">
          <label className="block space-y-2">
            <span className="font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
              场景文件名
            </span>
            <div className="flex items-center rounded border border-border bg-surface-container-low focus-within:border-secondary">
              <input
                autoFocus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (error) setError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void create();
                  }
                }}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-on-surface outline-none placeholder:text-muted-foreground/60"
                placeholder="chapter_02"
                aria-label="场景文件名"
                disabled={creating}
              />
              {!name.trim().toLowerCase().endsWith('.txt') && (
                <span className="border-l border-border px-3 font-mono-family text-xs text-muted-foreground">.txt</span>
              )}
            </div>
          </label>
          <div className="rounded border border-outline-variant/30 bg-surface-container px-3 py-2">
            <div className="font-mono-family text-[10px] uppercase tracking-widest text-muted-foreground">预览</div>
            <div className="mt-1 truncate text-xs text-on-surface-variant">
              game/scene/{sceneName || 'chapter_02.txt'}
            </div>
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-border bg-surface-container px-5 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={creating}
            className="rounded border border-border bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant transition-colors hover:border-outline-variant hover:text-on-surface disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating || !name.trim()}
            className="flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建场景
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
