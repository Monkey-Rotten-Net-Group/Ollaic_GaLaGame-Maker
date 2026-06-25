import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronRight, FileEdit, Wrench, AlertCircle,
  List, FileText, Search, Users, UserRound, Brain,
  PencilLine, UserCog, BookMarked, FilePlus,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import type { AssistantStep, ChatDiffLine } from '../hooks/useChatSession';

const TOOL_ICONS: Record<string, LucideIcon> = {
  list_scenes: List,
  read_scene: FileText,
  search_assets: Search,
  list_characters: Users,
  get_character: UserRound,
  read_memory: Brain,
  edit_scene: PencilLine,
  insert_figure: UserPlus,
  create_character: UserPlus,
  edit_character: UserCog,
  edit_memory: BookMarked,
  create_scene: FilePlus,
};

interface AiMessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  steps?: AssistantStep[];
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

/** Full GFM markdown (tables, headings, quotes, code, lists, task lists). */
function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-1.5 leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mt-2 mb-1 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-2 mb-1 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-1">{children}</p>,
          ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">{children}</a>,
          blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
          hr: () => <hr className="my-2 border-border" />,
          // Override `pre` itself (react-markdown wraps fenced code in pre>code):
          // without this the default <pre> has no overflow handling and long
          // lines paint outside the bubble. overflow-x-auto + max-w-full keeps a
          // long code block scrolling inside the bubble instead of overflowing.
          pre: ({ children }) => (
            <pre className="my-1.5 max-w-full overflow-x-auto rounded-md border border-border/50 bg-background/50 p-2 text-[11px] leading-relaxed">
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const inline = !className;
            if (inline) return <code className="rounded bg-background/70 px-1 py-0.5 text-[0.92em] break-words">{children}</code>;
            return <code className={className}>{children}</code>;
          },
          table: ({ children }) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-[11px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-background/40">{children}</thead>,
          th: ({ children }) => <th className="border border-border/60 px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-border/60 px-2 py-1 align-top">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Renders a multi-step assistant reply: per-turn text blocks + tool-call rows. */
function StepsView({ steps }: { steps: AssistantStep[] }) {
  return (
    <div className="space-y-2">
      {steps.map((step, si) => (
        <div key={si} className="space-y-1.5">
          {step.text?.trim() && <Markdown>{step.text.trim()}</Markdown>}
          {step.toolCalls?.map((call, ci) => {
            const ToolIcon = TOOL_ICONS[call.name] ?? Wrench;
            return (
              <div
                key={ci}
                className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] ${
                  call.ok === false
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-border/50 bg-background/35 text-muted-foreground'
                }`}
                title={call.error}
              >
                {call.ok === false
                  ? <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  : <ToolIcon className="h-3.5 w-3.5 shrink-0 text-chart-2" />}
                <span className="min-w-0 flex-1 truncate">{call.label}</span>
                {call.ok === false && <span className="shrink-0">失败</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function AiMessageBubble({ role, content, steps, isStreaming = false, stopped = false, diff }: AiMessageBubbleProps) {
  return (
    <div
      className={`min-w-0 max-w-[85%] rounded-lg px-3 py-2 text-sm break-words ${
        role === 'user'
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary border border-border'
      } ${role === 'assistant' ? 'font-mono-family' : 'font-body-family'}`}
    >
      {steps && steps.length > 0 ? (
        <StepsView steps={steps} />
      ) : content && role === 'assistant' ? (
        <Markdown>{content}</Markdown>
      ) : (
        <div className="whitespace-pre-wrap">{content}</div>
      )}
      {!content && (!steps || steps.length === 0) && isStreaming && '思考中...'}
      {isStreaming && content && <span className="inline-block w-2 h-3 ml-1 bg-current align-middle animate-pulse" />}
      {diff && diff.length > 0 && !isStreaming && <DiffBlock diff={diff} />}
      {stopped && <div className="mt-1 text-[11px] text-muted-foreground">已停止</div>}
    </div>
  );
}
