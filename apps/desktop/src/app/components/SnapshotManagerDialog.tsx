import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { SnapshotInfo } from '../lib/webgal-ipc';

type SnapshotKind = NonNullable<SnapshotInfo['kind']>;
type SnapshotFilter = 'all' | SnapshotKind | 'legacy';

interface Props {
  open: boolean;
  snapshots: SnapshotInfo[];
  busy?: boolean;
  error?: string | null;
  status?: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  onCreate: (label: string, kind: SnapshotInfo['kind']) => Promise<void> | void;
  onCreateExportCandidate: () => Promise<void> | void;
  onRestore: (snapshot: SnapshotInfo) => Promise<void> | void;
  onRename: (snapshot: SnapshotInfo, label: string) => Promise<void> | void;
  onDelete: (snapshot: SnapshotInfo) => Promise<void> | void;
}

export function SnapshotManagerDialog({
  open,
  snapshots,
  busy = false,
  error,
  status,
  onClose,
  onRefresh,
  onCreate,
  onCreateExportCandidate,
  onRestore,
  onRename,
  onDelete,
}: Props) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<SnapshotKind>('manual');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SnapshotFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [pendingAction, setPendingAction] = useState<{ type: 'restore' | 'delete'; snapshot: SnapshotInfo } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(`snapshot-${new Date().toISOString().slice(0, 10)}`);
    setKind('manual');
    setQuery('');
    setFilter('all');
    setSelectedId(null);
    setEditingId(null);
    setEditingLabel('');
    setPendingAction(null);
    void onRefresh();
  }, [open, onRefresh]);

  const filteredSnapshots = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return snapshots.filter((snapshot) => {
      const snapshotKind = snapshot.kind ?? 'legacy';
      if (filter !== 'all' && snapshotKind !== filter) return false;
      if (!normalizedQuery) return true;
      return [
        snapshot.label,
        snapshot.description ?? '',
        snapshot.id,
        formatSnapshotKind(snapshot.kind),
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [snapshots, query, filter]);

  const selected = useMemo(
    () => filteredSnapshots.find((snapshot) => snapshot.id === selectedId) ?? filteredSnapshots[0] ?? null,
    [filteredSnapshots, selectedId],
  );

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: snapshots.length };
    for (const snapshot of snapshots) {
      const snapshotKind = snapshot.kind ?? 'legacy';
      base[snapshotKind] = (base[snapshotKind] ?? 0) + 1;
    }
    return base;
  }, [snapshots]);

  if (!open) return null;

  const createDisabled = busy || !label.trim();

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-display-family">历史版本</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              创建、查看和回滚项目快照。回滚会替换游戏目录、项目元信息和编辑器状态。
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 hover:bg-secondary/50 transition-colors"
            aria-label="关闭历史版本"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] gap-0 overflow-hidden">
          <div className="min-h-0 overflow-y-auto p-5">
            <div className="mb-4 grid gap-2 lg:grid-cols-[minmax(0,1fr)_160px_auto_auto]">
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border bg-input-background px-3 py-2 text-sm"
                placeholder="快照名称"
                aria-label="快照名称"
              />
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as SnapshotKind)}
                className="rounded-md border border-border bg-input-background px-3 py-2 text-sm"
                aria-label="快照类型"
              >
                <option value="manual">手动快照</option>
                <option value="exportCandidate">导出候选</option>
              </select>
              <button
                onClick={() => void onCreate(label, kind)}
                disabled={createDisabled}
                className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
                创建快照
              </button>
              <button
                onClick={() => void onCreateExportCandidate()}
                disabled={busy}
                className="rounded-md bg-secondary px-3 py-2 text-sm hover:bg-secondary/70 disabled:opacity-50 flex items-center gap-2"
              >
                <Star className="h-3.5 w-3.5" />
                标记候选
              </button>
            </div>

            <div className="mb-4 grid gap-2 lg:grid-cols-[minmax(0,1fr)_180px_auto]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-full rounded-md border border-border bg-input-background py-2 pl-9 pr-3 text-sm"
                  placeholder="搜索名称、类型或 ID"
                  aria-label="搜索快照"
                />
              </div>
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value as SnapshotFilter)}
                className="rounded-md border border-border bg-input-background px-3 py-2 text-sm"
                aria-label="筛选快照类型"
              >
                <option value="all">全部 ({counts.all ?? 0})</option>
                <option value="manual">手动 ({counts.manual ?? 0})</option>
                <option value="exportCandidate">导出候选 ({counts.exportCandidate ?? 0})</option>
                <option value="beforeRestore">回滚备份 ({counts.beforeRestore ?? 0})</option>
                <option value="auto">自动 ({counts.auto ?? 0})</option>
                <option value="legacy">旧快照 ({counts.legacy ?? 0})</option>
              </select>
              <button
                onClick={() => void onRefresh()}
                disabled={busy}
                className="rounded-md bg-secondary px-3 py-2 text-sm hover:bg-secondary/70 disabled:opacity-50 flex items-center justify-center"
                aria-label="刷新快照列表"
              >
                <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {error && (
              <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <span>{error}</span>
              </div>
            )}
            {pendingAction && (
              <div className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-3 text-sm">
                <div className="font-medium">
                  {pendingAction.type === 'restore' ? '确认回滚快照' : '确认删除快照'}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  {pendingAction.type === 'restore'
                    ? `将回滚到“${pendingAction.snapshot.label}”。当前 game、项目元信息和编辑器状态会被替换，系统会先创建 before-restore 备份。`
                    : `将删除“${pendingAction.snapshot.label}”。此操作不可撤销。`}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => {
                      const action = pendingAction;
                      setPendingAction(null);
                      if (action.type === 'restore') void onRestore(action.snapshot);
                      else void onDelete(action.snapshot);
                    }}
                    disabled={busy}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                  >
                    确认
                  </button>
                  <button
                    onClick={() => setPendingAction(null)}
                    disabled={busy}
                    className="rounded-md bg-secondary px-3 py-1.5 text-xs hover:bg-secondary/70 disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {status && !error && (
              <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4" />
                <span>{status}</span>
              </div>
            )}

            {snapshots.length === 0 ? (
              <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
                当前项目还没有快照。
              </div>
            ) : filteredSnapshots.length === 0 ? (
              <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
                没有匹配的快照。
              </div>
            ) : (
              <div className="space-y-2">
                {filteredSnapshots.map((snapshot) => (
                  <SnapshotRow
                    key={snapshot.id}
                    snapshot={snapshot}
                    selected={snapshot.id === selected?.id}
                    busy={busy}
                    editing={editingId === snapshot.id}
                    editingLabel={editingLabel}
                    onEditingLabelChange={setEditingLabel}
                    onStartRename={() => {
                      setEditingId(snapshot.id);
                      setEditingLabel(snapshot.label);
                    }}
                    onCancelRename={() => {
                      setEditingId(null);
                      setEditingLabel('');
                    }}
                    onCommitRename={() => {
                      void onRename(snapshot, editingLabel);
                      setEditingId(null);
                      setEditingLabel('');
                    }}
                    onSelect={() => setSelectedId(snapshot.id)}
                    onRestore={() => setPendingAction({ type: 'restore', snapshot })}
                    onDelete={() => setPendingAction({ type: 'delete', snapshot })}
                  />
                ))}
              </div>
            )}
          </div>

          <aside className="border-l border-border bg-secondary/20 p-5">
            {selected ? (
              <div className="space-y-4 text-sm">
                <div>
                  <div className="text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
                    已选快照
                  </div>
                  <div className="mt-1 break-words text-base font-medium">{selected.label}</div>
                </div>
                <SnapshotDetail label="创建时间" value={formatTime(selected.createdAt)} />
                <SnapshotDetail label="类型" value={formatSnapshotKind(selected.kind)} />
                {selected.description && <SnapshotDetail label="说明" value={selected.description} />}
                <SnapshotDetail label="文件数量" value={selected.fileCount != null ? String(selected.fileCount) : '旧快照未记录'} />
                <SnapshotDetail label="元信息" value={selected.metadataIncluded === true ? '包含' : selected.metadataIncluded === false ? '不包含' : '旧快照未记录'} />
                <SnapshotDetail label="编辑器状态" value={selected.includesEditorState ? '包含' : '未记录或不包含'} />
                <SnapshotDetail label="ID" value={selected.id} mono />
                <div className="rounded-md border border-border bg-background/50 p-3 text-xs leading-5 text-muted-foreground">
                  回滚会先自动创建 before-restore 备份，然后恢复此快照里的 game、项目元信息和编辑器状态。
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">选择一个快照查看详情。</div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function SnapshotRow({
  snapshot,
  selected,
  busy,
  editing,
  editingLabel,
  onEditingLabelChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onSelect,
  onRestore,
  onDelete,
}: {
  snapshot: SnapshotInfo;
  selected: boolean;
  busy: boolean;
  editing: boolean;
  editingLabel: string;
  onEditingLabelChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: () => void;
  onSelect: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-3 transition-colors ${
        selected ? 'border-primary/50 bg-primary/10' : 'border-border bg-background/40 hover:bg-secondary/30'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex gap-2">
              <input
                value={editingLabel}
                onChange={(event) => onEditingLabelChange(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border bg-input-background px-2 py-1.5 text-sm"
                aria-label="编辑快照名称"
                autoFocus
              />
              <button
                onClick={onCommitRename}
                disabled={busy || !editingLabel.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              >
                保存
              </button>
              <button
                onClick={onCancelRename}
                disabled={busy}
                className="rounded-md bg-secondary px-3 py-1.5 text-xs hover:bg-secondary/70 disabled:opacity-50"
              >
                取消
              </button>
            </div>
          ) : (
            <button onClick={onSelect} className="block w-full text-left">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{snapshot.label}</span>
                <KindBadge kind={snapshot.kind} />
              </div>
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{formatTime(snapshot.createdAt)}</span>
            <span>{snapshot.fileCount != null ? `${snapshot.fileCount} 个文件` : '旧快照'}</span>
            {snapshot.metadataIncluded && <span className="rounded bg-secondary px-1.5 py-0.5">元信息</span>}
            {snapshot.includesEditorState && <span className="rounded bg-secondary px-1.5 py-0.5">编辑器状态</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label="回滚" disabled={busy} onClick={onRestore}>
            <RotateCcw className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="重命名" disabled={busy || editing} onClick={onStartRename}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="删除" disabled={busy} onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind?: SnapshotInfo['kind'] }) {
  const normalized = kind ?? 'legacy';
  const className =
    normalized === 'exportCandidate'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/25'
      : normalized === 'beforeRestore'
        ? 'bg-blue-500/15 text-blue-300 border-blue-500/25'
        : normalized === 'auto'
          ? 'bg-purple-500/15 text-purple-300 border-purple-500/25'
          : normalized === 'legacy'
            ? 'bg-muted text-muted-foreground border-border'
            : 'bg-secondary text-foreground border-border';
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${className}`}>
      {formatSnapshotKind(kind)}
    </span>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-border bg-secondary px-2 py-1.5 hover:bg-secondary/70 disabled:opacity-50"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function SnapshotDetail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
        {label}
      </div>
      <div className={`mt-1 break-words ${mono ? 'text-xs font-mono-family' : ''}`}>{value}</div>
    </div>
  );
}

function formatTime(createdAt: string): string {
  const value = Number(createdAt);
  if (!Number.isFinite(value)) return createdAt;
  return new Date(value).toLocaleString();
}

function formatSnapshotKind(kind?: SnapshotInfo['kind']): string {
  switch (kind) {
    case 'manual':
      return '手动';
    case 'exportCandidate':
      return '导出候选';
    case 'beforeRestore':
      return '回滚备份';
    case 'auto':
      return '自动';
    case undefined:
    case '':
      return '旧快照';
    default:
      return kind;
  }
}
