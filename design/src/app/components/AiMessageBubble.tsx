import { useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { extractWebGalJsonBlocks, summarizeScene } from '../lib/webgal-schema';
import { extractStoryEditPlan, summarizeEditPlan } from '../lib/story-agent';

interface AiMessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  stopped?: boolean;
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

export function AiMessageBubble({ role, content, isStreaming = false, stopped = false }: AiMessageBubbleProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const webgalBlocks = extractWebGalJsonBlocks(content);
  const storyEditPlan = extractStoryEditPlan(content);
  const completeBlockRegex = /```(?:webgal-json|story-edit-json|json)\s*[\s\S]*?```/gi;
  const completeBlockTestRegex = /```(?:webgal-json|story-edit-json|json)\s*[\s\S]*?```/i;
  const openBlockRegex = /```(?:webgal-json|story-edit-json|json)\s*[\s\S]*$/i;
  const hasStructuredBlocks = webgalBlocks.length > 0 || !!storyEditPlan || completeBlockTestRegex.test(content) || openBlockRegex.test(content);
  const textParts = hasStructuredBlocks
    ? content.replace(openBlockRegex, '').split(completeBlockRegex)
    : [content];
  const hasOpenStructuredBlock = openBlockRegex.test(content);
  const fallbackCardLabel = storyEditPlan
    ? summarizeEditPlan(storyEditPlan)
    : hasOpenStructuredBlock && isStreaming
    ? '正在生成结构化修改方案...'
    : '已生成结构化修改方案';

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
          {(webgalBlocks[index] || (index === 0 && (storyEditPlan || hasOpenStructuredBlock))) && (
            <div className="my-2 text-xs">
              {webgalBlocks[index]?.scene ? (
                <>
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => ({ ...prev, [index]: !prev[index] }))}
                    className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2 py-1.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                    aria-expanded={expanded[index]}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-chart-5" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      已生成 {summarizeScene(webgalBlocks[index].scene)}
                    </span>
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded[index] ? 'rotate-90' : ''}`} />
                  </button>
                  {expanded[index] && (
                    <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background/35 p-2 text-[11px] leading-relaxed text-muted-foreground">
                      {webgalBlocks[index].raw}
                    </pre>
                  )}
                </>
              ) : storyEditPlan || hasOpenStructuredBlock ? (
                <>
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
                      {content.match(/```(?:webgal-json|story-edit-json|json)\s*([\s\S]*?)(?:```|$)/i)?.[1] ?? ''}
                    </pre>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 px-1 py-1 text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>已收到结构化内容，生成结束后会校验。</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {!content && isStreaming && '思考中...'}
      {isStreaming && content && <span className="inline-block w-2 h-3 ml-1 bg-current align-middle animate-pulse" />}
      {stopped && <div className="mt-1 text-[11px] text-muted-foreground">已停止</div>}
    </div>
  );
}
