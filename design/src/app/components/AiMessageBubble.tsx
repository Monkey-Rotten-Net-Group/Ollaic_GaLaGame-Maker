import { useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, ChevronRight, FileEdit } from 'lucide-react';
import type { ChatDiffLine } from '../hooks/useChatSession';

interface AiMessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  stopped?: boolean;
  diff?: ChatDiffLine[];
}

function DiffBlock({ diff }: { diff: ChatDiffLine[] }) {
  const [open, setOpen] = useState(false);
  const added = diff.filter(l => l.kind === 'added').length;
  const removed = diff.filter(l => l.kind === 'removed').length;
  const label = [added > 0 && `+${added}`, removed > 0 && `-${removed}`].filter(Boolean).join(' ');

  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2 py-1.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
        aria-expanded={open}
      >
        <FileEdit className="h-3.5 w-3.5 shrink-0 text-chart-2" />
        <span className="flex-1 text-left">查看修改内容</span>
        {label && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{label}</span>}
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 max-h-52 overflow-auto rounded-md border border-border/50 bg-background/35 p-1.5 font-mono text-[11px] leading-relaxed">
          {diff.map((line, i) => {
            if (line.kind === 'added') {
              return <div key={i} className="text-green-400 whitespace-pre-wrap"><span className="select-none text-green-600">+ </span>{line.text}</div>;
            }
            if (line.kind === 'removed') {
              return <div key={i} className="text-red-400 whitespace-pre-wrap line-through decoration-red-600/50"><span className="select-none no-underline text-red-600">- </span>{line.text}</div>;
            }
            if (line.text === '...') {
              return <div key={i} className="text-muted-foreground/50 select-none text-center">···</div>;
            }
            return <div key={i} className="text-muted-foreground/70 whitespace-pre-wrap"><span className="select-none">  </span>{line.text}</div>;
          })}
        </div>
      )}
    </div>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={`code-${match.index}`} className="rounded bg-background/70 px-1 py-0.5 text-[0.92em]">{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`strong-${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function MarkdownText({ text, enabled }: { text: string; enabled: boolean }) {
  if (!enabled) return <div className="whitespace-pre-wrap">{text}</div>;

  const lines = text.split('\n');
  const output: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const unordered = lines[i].match(/^\s*[-*]\s+(.+)$/);
    const ordered = lines[i].match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const orderedList = !!ordered;
      const items: string[] = [];
      while (i < lines.length) {
        const item = orderedList
          ? lines[i].match(/^\s*\d+\.\s+(.+)$/)
          : lines[i].match(/^\s*[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        i += 1;
      }
      const ListTag = orderedList ? 'ol' : 'ul';
      output.push(
        <ListTag key={`list-${i}`} className={`my-1 space-y-0.5 ${orderedList ? 'list-decimal' : 'list-disc'} pl-5`}>
          {items.map((item, index) => <li key={`${item}-${index}`}>{renderInlineMarkdown(item)}</li>)}
        </ListTag>,
      );
      continue;
    }

    output.push(
      <div key={`line-${i}`} className={lines[i] ? '' : 'h-3'}>
        {renderInlineMarkdown(lines[i])}
      </div>,
    );
    i += 1;
  }
  return <>{output}</>;
}

export function AiMessageBubble({ role, content, isStreaming = false, stopped = false, diff }: AiMessageBubbleProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const completeBlockRegex = /```(?:[a-z-]+|json)?\s*[\s\S]*?```/gi;
  const completeBlockTestRegex = /```(?:[a-z-]+|json)?\s*[\s\S]*?```/i;
  const openBlockRegex = /```(?:[a-z-]+|json)?\s*[\s\S]*$/i;
  const hasStructuredBlocks = completeBlockTestRegex.test(content) || openBlockRegex.test(content);
  const textParts = hasStructuredBlocks
    ? content.replace(openBlockRegex, '').split(completeBlockRegex)
    : [content];
  const hasOpenStructuredBlock = openBlockRegex.test(content);
  const fallbackCardLabel = hasOpenStructuredBlock && isStreaming
    ? '正在生成修改预览...'
    : '已生成修改预览';
  const structuredBlocks = Array.from(content.matchAll(/```(?:[a-z-]+|json)?\s*([\s\S]*?)(?:```|$)/gi), (match) => match[1] ?? '');

  return (
    <div
      className={`max-w-[85%] rounded-lg px-3 py-2 text-sm break-words ${
        role === 'user'
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary border border-border'
      } ${role === 'assistant' ? 'font-mono-family' : 'font-body-family'}`}
    >
      {textParts.map((part, index) => (
        <div key={`part-${index}`}>
          {part.trim() && <MarkdownText text={part.trim()} enabled={role === 'assistant'} />}
          {(structuredBlocks[index] !== undefined || (index === 0 && hasOpenStructuredBlock)) && (
            <div className="my-2 text-xs">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [index]: !prev[index] }))}
                className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2 py-1.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                aria-expanded={expanded[index]}
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-chart-5" />
                <span className="min-w-0 flex-1 truncate text-left">{fallbackCardLabel}</span>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded[index] ? 'rotate-90' : ''}`} />
              </button>
              {expanded[index] && (
                <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background/35 p-2 text-[11px] leading-relaxed text-muted-foreground">
                  {structuredBlocks[index] ?? ''}
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
      {!content && isStreaming && '思考中...'}
      {isStreaming && content && <span className="inline-block w-2 h-3 ml-1 bg-current align-middle animate-pulse" />}
      {diff && diff.length > 0 && !isStreaming && <DiffBlock diff={diff} />}
      {stopped && <div className="mt-1 text-[11px] text-muted-foreground">已停止</div>}
    </div>
  );
}
