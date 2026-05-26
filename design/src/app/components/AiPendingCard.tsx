import { useState } from 'react';
import type { DiffLine } from '../lib/story-agent';

interface AiPendingCardProps {
  summary: string;
  status: 'pending' | 'accepted' | 'reverted';
  diff: DiffLine[];
  warnings?: string[];
  onAccept: () => void;
  onRevert: () => void;
}

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

export function AiPendingCard({ summary, status, diff, warnings = [], onAccept, onRevert }: AiPendingCardProps) {
  return (
    <div className={`rounded-lg border p-3 text-xs ${
      status === 'pending'
        ? 'border-primary/30 bg-primary/10'
        : status === 'accepted'
        ? 'border-chart-5/30 bg-chart-5/10'
        : 'border-border bg-secondary/40'
    }`}>
      <div className="font-medium text-foreground">{summary}</div>
      {warnings.length > 0 && (
        <div className="mt-2 rounded-md border border-primary/20 bg-background/50 p-2 text-muted-foreground">
          {warnings.map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      )}
      <DiffViewer lines={diff} />
      {status === 'pending' && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onAccept}
            className="rounded-md bg-primary px-3 py-2 text-primary-foreground transition-all hover:opacity-90"
          >
            接受修改
          </button>
          <button
            type="button"
            onClick={onRevert}
            className="rounded-md bg-secondary px-3 py-2 transition-colors hover:bg-secondary/70"
          >
            撤销本次
          </button>
        </div>
      )}
    </div>
  );
}
