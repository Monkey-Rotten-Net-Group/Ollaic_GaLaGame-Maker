import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowLeft, Bot, Brain, Check, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, User } from 'lucide-react';
import {
  addMemoryEntry, deleteMemoryEntry, MEMORY_CATEGORIES, memoryEntries, readProjectMemory, updateMemoryEntry,
  type MemoryCategory, type MemoryEntry, type ProjectMemory,
} from '../lib/project-memory';
import { OllaicSideNav, OllaicTopBar } from './OllaicChrome';
import { Switch } from './ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

const categoryTone: Record<MemoryCategory, string> = {
  world: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  character: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  plot: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  style: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  preference: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  constraint: 'bg-secondary text-foreground',
};

function formatTime(value: string): string {
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function ProjectMemoryPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const projectPath = useMemo(() => {
    try { return localStorage.getItem(`project-path-${projectId}`); } catch { return null; }
  }, [projectId]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MemoryCategory | 'all'>('all');
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('all');
  const [editing, setEditing] = useState<MemoryEntry | 'new' | null>(null);
  const [draftCategory, setDraftCategory] = useState<MemoryCategory>('world');
  const [draftContent, setDraftContent] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null);
  const pathRef = useRef<string | null>(projectPath);
  const loadVersion = useRef(0);
  const mutationRef = useRef(false);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoaded(false);
    setError(null);
    try {
      const value = projectPath ? await readProjectMemory(projectPath) : null;
      if (version !== loadVersion.current || pathRef.current !== projectPath) return;
      setMemory(value);
      setLoaded(true);
    } catch (e) {
      if (version === loadVersion.current && pathRef.current === projectPath) setError(String(e));
    } finally {
      if (version === loadVersion.current && pathRef.current === projectPath) setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    pathRef.current = projectPath;
    setMemory(null);
    setLoaded(false);
    setBusy(false);
    setEditing(null);
    setDeleting(null);
    void load();
    return () => { pathRef.current = null; loadVersion.current++; };
  }, [projectPath, load]);

  const entries = memoryEntries(memory);
  const activeCount = entries.filter((entry) => entry.enabled).length;
  const visible = entries.filter((entry) =>
    (category === 'all' || entry.category === category)
    && (source === 'all' || entry.source === source)
    && (status === 'all' || entry.enabled === (status === 'enabled'))
    && `${entry.content} ${MEMORY_CATEGORIES[entry.category]}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ).sort((a, b) => {
    const time = (value: string) => new Date(/^\d+$/.test(value) ? Number(value) : value).getTime() || 0;
    return time(b.updatedAt) - time(a.updatedAt);
  });

  const openEditor = (entry: MemoryEntry | 'new') => {
    setEditing(entry);
    setDraftCategory(entry === 'new' ? category === 'all' ? 'world' : category : entry.category);
    setDraftContent(entry === 'new' ? '' : entry.content);
    setFormError(null);
  };

  const mutate = async (operation: () => Promise<ProjectMemory>, close?: () => void) => {
    if (mutationRef.current || !projectPath) return;
    mutationRef.current = true;
    loadVersion.current++;
    setBusy(true);
    setError(null);
    setFormError(null);
    try {
      const next = await operation();
      if (pathRef.current !== projectPath) return;
      setMemory(next);
      close?.();
    } catch (e) {
      if (pathRef.current !== projectPath) return;
      if (editing || deleting) setFormError(String(e));
      else setError(String(e));
    } finally {
      mutationRef.current = false;
      if (pathRef.current === projectPath) setBusy(false);
    }
  };

  const save = () => {
    if (!projectPath || !editing || !draftContent.trim()) return;
    void mutate(() => editing === 'new'
      ? addMemoryEntry(projectPath, draftCategory, draftContent)
      : updateMemoryEntry(projectPath, editing.id, { category: draftCategory, content: draftContent }, 'user', editing.updatedAt),
    () => setEditing(null));
  };

  const canEdit = !!projectPath && loaded && !loading && !busy;
  const controlClass = 'min-w-0 rounded-md border border-border bg-surface-container-lowest px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="min-h-screen bg-surface-container-lowest text-foreground">
      <OllaicTopBar title="项目记忆" />
      <OllaicSideNav active="memory" projectId={projectId} />
      <main className="ml-20 min-w-0 pt-12">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
            <div className="flex min-w-0 items-center gap-3">
              <Brain className="size-6 shrink-0 text-primary" />
              <div>
                <h1 className="text-xl font-semibold">项目记忆</h1>
                <p className="mt-1 text-xs text-muted-foreground">{entries.length} 条记忆 · {activeCount} 条启用</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" className="ollaic-icon-button" aria-label="返回编辑器" title="返回编辑器" onClick={() => navigate(`/editor/${projectId}`)}><ArrowLeft className="size-4" /></button>
              <button type="button" className="ollaic-icon-button disabled:opacity-40" aria-label="刷新记忆" title="刷新记忆" disabled={loading || busy || !projectPath} onClick={() => { void load(); }}><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} /></button>
              <button type="button" className="ollaic-command ollaic-command-primary disabled:opacity-40" disabled={!canEdit} onClick={() => openEditor('new')}><Plus className="size-4" />新增记忆</button>
            </div>
          </header>

          {!projectPath ? (
            <div className="py-20 text-center">
              <p className="text-sm text-muted-foreground">未找到当前项目</p>
              <button type="button" className="ollaic-command mx-auto mt-4" onClick={() => navigate('/')}><ArrowLeft className="size-4" />返回首页</button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 py-4">
                <label className={`flex basis-full items-center gap-2 sm:flex-1 ${controlClass}`}>
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input className="min-w-0 flex-1 bg-transparent outline-none" aria-label="搜索记忆" placeholder="搜索记忆..." value={query} onChange={(event) => setQuery(event.target.value)} />
                </label>
                <select className={`${controlClass} flex-1 sm:flex-none`} aria-label="记忆来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部来源</option><option value="agent">Agent 更新</option><option value="user">手动更新</option></select>
                <select className={`${controlClass} flex-1 sm:flex-none`} aria-label="记忆状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border" role="tablist" aria-label="记忆分类">
                {(['all', ...Object.keys(MEMORY_CATEGORIES)] as Array<MemoryCategory | 'all'>).map((item) => (
                  <button type="button" key={item} role="tab" aria-selected={category === item} onClick={() => setCategory(item)} className={`border-b-2 py-2 text-xs transition-colors ${category === item ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                    {item === 'all' ? '全部' : MEMORY_CATEGORIES[item]} <span className="ml-1 text-muted-foreground">{item === 'all' ? entries.length : entries.filter((entry) => entry.category === item).length}</span>
                  </button>
                ))}
              </div>

              {error && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><span className="min-w-0 break-words">{error}</span><button type="button" className="ollaic-command" disabled={busy || loading} onClick={() => { void load(); }}>重新加载</button></div>}
              {loading ? <div role="status" className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />读取记忆中...</div> : loaded && visible.length === 0 ? (
                <div className="flex flex-col items-center py-20 text-center">
                  <Brain className="mb-4 size-9 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">{entries.length ? '没有匹配的记忆' : '暂无项目记忆'}</p>
                  {!entries.length && <button type="button" className="ollaic-command mt-4" disabled={!canEdit} onClick={() => openEditor('new')}><Plus className="size-4" />新增记忆</button>}
                </div>
              ) : (
                <ul aria-label="项目记忆列表" className="divide-y divide-border">
                  {visible.map((entry) => (
                    <li key={entry.id} className={`py-5 ${entry.enabled ? '' : 'bg-surface-container-low/40'}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2 text-xs">
                          <span className={`rounded px-2 py-1 ${categoryTone[entry.category]}`}>{MEMORY_CATEGORIES[entry.category]}</span>
                          <span className="flex items-center gap-1 text-muted-foreground">{entry.source === 'agent' ? <Bot className="size-3.5" /> : <User className="size-3.5" />}{entry.source === 'agent' ? 'Agent 更新' : '手动更新'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch checked={entry.enabled} disabled={!canEdit} aria-label={`启用记忆：${entry.content}`} title={entry.enabled ? '已启用' : '已停用'} onCheckedChange={(enabled) => { void mutate(() => updateMemoryEntry(projectPath, entry.id, { enabled }, 'user', entry.updatedAt)); }} />
                          <button type="button" className="ollaic-icon-button disabled:opacity-40" disabled={!canEdit} aria-label={`编辑记忆：${entry.content}`} title="编辑记忆" onClick={() => openEditor(entry)}><Pencil className="size-4" /></button>
                          <button type="button" className="ollaic-icon-button text-destructive disabled:opacity-40" disabled={!canEdit} aria-label={`删除记忆：${entry.content}`} title="删除记忆" onClick={() => { setFormError(null); setDeleting(entry); }}><Trash2 className="size-4" /></button>
                        </div>
                      </div>
                      <p className={`mt-3 whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere] ${entry.enabled ? '' : 'text-muted-foreground'}`}>{entry.content}</p>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><time>更新于 {formatTime(entry.updatedAt)}</time>{!entry.enabled && <span>已停用</span>}</div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </main>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto" aria-describedby={undefined} onInteractOutside={(event) => { if (busy) event.preventDefault(); }} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
          <DialogHeader><DialogTitle>{editing === 'new' ? '新增记忆' : '编辑记忆'}</DialogTitle></DialogHeader>
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
            <label className="grid gap-2 text-sm">分类<select className={controlClass} value={draftCategory} disabled={busy} onChange={(event) => setDraftCategory(event.target.value as MemoryCategory)}>{Object.entries(MEMORY_CATEGORIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <label className="grid gap-2 text-sm">内容<textarea autoFocus required maxLength={4000} rows={7} className={`${controlClass} resize-y leading-6`} value={draftContent} disabled={busy} onChange={(event) => setDraftContent(event.target.value)} /></label>
            <div className="text-right text-xs text-muted-foreground">{draftContent.length} / 4000</div>
            {formError && <p role="alert" className="break-words text-sm text-destructive">{formError}</p>}
            <DialogFooter><button type="button" disabled={busy} className="ollaic-command justify-center" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={busy || !draftContent.trim() || draftContent.length > 4000} className="ollaic-command ollaic-command-primary justify-center disabled:opacity-40">{busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{busy ? '保存中...' : '保存记忆'}</button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}>
        <DialogContent onInteractOutside={(event) => { if (busy) event.preventDefault(); }} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
          <DialogHeader><DialogTitle>删除记忆</DialogTitle><DialogDescription>确定删除这条记忆？</DialogDescription></DialogHeader>
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">{deleting?.content}</p>
          {formError && <p role="alert" className="break-words text-sm text-destructive">{formError}</p>}
          <DialogFooter><button type="button" className="ollaic-command justify-center" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button type="button" className="ollaic-command justify-center text-destructive disabled:opacity-40" disabled={busy} onClick={() => { if (deleting && projectPath) void mutate(() => deleteMemoryEntry(projectPath, deleting.id, deleting.updatedAt), () => setDeleting(null)); }}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}删除记忆</button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
