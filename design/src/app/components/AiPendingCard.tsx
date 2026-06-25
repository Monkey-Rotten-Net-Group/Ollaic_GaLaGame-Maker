import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { DiffLine } from '../lib/story-agent';
import type { ChangeEdit, PendingChangeSet, SceneEdit } from '../lib/change-set';
import { sceneDisplayName, type SceneHeader } from '../lib/webgal-ipc';
import { computeNodeDiff, summarizeNodeDiff } from '../lib/node-diff';
import { MiniNodeCard } from './MiniNodeCard';

function DiffViewer({ lines }: { lines: DiffLine[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? lines : lines.slice(0, 30);
  const extra = lines.length - visible.length;

  return (
    <div className={`mt-2 overflow-y-auto rounded-md bg-background/60 p-2 font-mono-family text-[11px] ${expanded ? 'max-h-none' : 'max-h-48'}`}>
      {visible.map((line, index) => (
        <div
          key={`${line.kind}-${index}`}
          className={`whitespace-pre-wrap px-1 py-0.5 ${
            line.kind === 'added'
              ? 'bg-green-950/40 text-green-300'
              : line.kind === 'removed'
              ? 'bg-red-950/40 text-red-300'
              : 'text-muted-foreground'
          }`}
        >
          <span className="mr-2">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
          {line.text}
        </div>
      ))}
      {extra > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 w-full rounded px-1 py-1 text-left text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        >
          ... 还有 {extra} 行变更，展开全部
        </button>
      )}
      {expanded && lines.length > 30 && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 w-full rounded px-1 py-1 text-left text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        >
          收起 diff
        </button>
      )}
    </div>
  );
}

/** Scene change shown as node-level diff, with the raw text diff as a fallback. */
function SceneNodeDiff({ edit }: { edit: SceneEdit }) {
  const [showText, setShowText] = useState(false);
  const entries = computeNodeDiff(edit.beforeNodes, edit.afterNodes);
  const { added, modified, removed } = summarizeNodeDiff(entries);
  return (
    <>
      {edit.warnings.length > 0 && (
        <div className="mt-2 rounded border border-primary/20 bg-background/50 p-1.5 text-muted-foreground">
          {edit.warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-[10px] font-mono-family">
        {added > 0 && <span className="text-green-400">+{added}</span>}
        {modified > 0 && <span className="text-yellow-400">✏{modified}</span>}
        {removed > 0 && <span className="text-red-400">-{removed}</span>}
      </div>
      {entries.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {entries.map((entry, i) => <MiniNodeCard key={i} entry={entry} />)}
        </div>
      ) : (
        <div className="mt-1.5 text-[11px] text-muted-foreground">无节点变化</div>
      )}
      <button
        type="button"
        onClick={() => setShowText((v) => !v)}
        className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        aria-expanded={showText}
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${showText ? 'rotate-90' : ''}`} />
        查看文本 diff
      </button>
      {showText && <DiffViewer lines={edit.diff} />}
    </>
  );
}

function EditRow({ edit, sceneHeaders }: { edit: ChangeEdit; sceneHeaders?: Record<string, SceneHeader> }) {
  const renderValue = (value: unknown): string => {
    if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('、');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value ?? '');
  };
  const label =
    edit.kind === 'scene'
      ? `场景「${sceneDisplayName(edit.file, sceneHeaders?.[edit.file])}」${edit.isCurrent ? '（当前）' : ''}`
      : edit.kind === 'create_character'
        ? `新建角色 ${edit.draft.name}`
      : edit.kind === 'character'
        ? `角色 ${edit.name}`
        : edit.kind === 'create_scene'
          ? `新建场景「${edit.chapter || edit.file}」`
          : '项目记忆';
  const detail =
    edit.kind === 'scene'
      ? edit.summary
      : edit.kind === 'create_character'
        ? `设定 ${edit.changedFields.join('、') || '基础字段'}`
      : edit.kind === 'create_scene'
        ? `文件 ${edit.file}${edit.outline ? ` · 大纲：${edit.outline}` : ''}`
        : `修改 ${edit.changedFields.join('、') || '（无变化）'}`;
  return (
    <div className="mt-2 rounded-md border border-border bg-background/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{label}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{edit.kind}</span>
      </div>
      <div className="mt-1 text-muted-foreground">{detail}</div>
      {edit.kind === 'scene' && <SceneNodeDiff edit={edit} />}
      {(edit.kind === 'character' || edit.kind === 'create_character' || edit.kind === 'memory') && (
        <div className="mt-2 space-y-1 font-mono-family text-[11px]">
          {edit.changedFields.map((field) => (
            <div key={field} className="rounded bg-background/60 p-1">
              <span className="text-muted-foreground">{field}: </span>
              <span className="text-foreground">
                {renderValue(((edit.kind === 'create_character' ? edit.draft : edit.after) as unknown as Record<string, unknown>)[field])}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Approval card for a multi-edit change set (scenes + characters + memory). */
export function ChangeSetCard({ changeSet, sceneHeaders, onAccept, onRevert }: {
  changeSet: PendingChangeSet;
  sceneHeaders?: Record<string, SceneHeader>;
  onAccept: () => void;
  onRevert: () => void;
}) {
  const { status, edits } = changeSet;
  return (
    <div className={`rounded-lg border p-3 text-xs ${
      status === 'pending'
        ? 'border-primary/30 bg-primary/10'
        : status === 'accepted'
        ? 'border-chart-5/30 bg-chart-5/10'
        : status === 'failed'
        ? 'border-destructive/30 bg-destructive/10'
        : 'border-border bg-secondary/40'
    }`}>
      <div className="font-medium text-foreground">
        {edits.length > 1 ? `共 ${edits.length} 处修改` : '修改方案'}
      </div>
      {edits.map((edit, index) => <EditRow key={`${edit.kind}-${index}`} edit={edit} sceneHeaders={sceneHeaders} />)}
      {status === 'pending' && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={onAccept} className="rounded-md bg-primary px-3 py-2 text-primary-foreground transition-all hover:opacity-90">
            同意
          </button>
          <button type="button" onClick={onRevert} className="rounded-md bg-secondary px-3 py-2 transition-colors hover:bg-secondary/70">
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
