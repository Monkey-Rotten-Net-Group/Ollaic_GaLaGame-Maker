import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronRight,
  FileEdit,
  Wrench,
  AlertCircle,
  List,
  FileText,
  Search,
  Users,
  UserRound,
  Brain,
  PencilLine,
  UserCog,
  BookMarked,
  FilePlus,
  UserPlus,
  ImageIcon,
  Paperclip,
  Trash2,
  Check,
  Copy,
  CornerDownLeft,
  GitCompare,
  type LucideIcon,
} from 'lucide-react';
import type { AssistantStep, ChatAttachment, ChatDiffLine } from '../hooks/useChatSession';
import { AiSentAttachments } from './AiUploadsPanel';

const TOOL_ICONS: Record<string, LucideIcon> = {
  list_scenes: List,
  read_scene: FileText,
  search_assets: Search,
  list_characters: Users,
  get_character: UserRound,
  read_memory: Brain,
  list_reference_files: Paperclip,
  read_reference_file: FileText,
  edit_scene: PencilLine,
  set_scene_header: FileEdit,
  insert_dialogue_block: PencilLine,
  create_branch: FilePlus,
  insert_figure: UserPlus,
  create_character: UserPlus,
  plan_character_sprites: UserCog,
  plan_assets: ImageIcon,
  edit_character: UserCog,
  edit_memory: BookMarked,
  add_memory: BookMarked,
  update_memory: BookMarked,
  delete_memory: Trash2,
  create_scene: FilePlus,
};

interface AiMessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  steps?: AssistantStep[];
  isStreaming?: boolean;
  stopped?: boolean;
  diff?: ChatDiffLine[];
  /** Reference files that were sent along with this user message. */
  attachments?: ChatAttachment[];
  onInsertSnippet?: (text: string) => void;
  onDiffSnippet?: (text: string) => void;
}

function CodeBlock({
  children,
  className,
  onInsertSnippet,
  onDiffSnippet,
}: {
  children: React.ReactNode;
  className?: string;
  onInsertSnippet?: (text: string) => void;
  onDiffSnippet?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const rawText = String(children).replace(/\n$/, '');
  const langMatch = /language-(\w+)/.exec(className || '');
  const lang = langMatch ? langMatch[1] : '';

  const handleCopy = () => {
    void navigator.clipboard.writeText(rawText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-border/60 bg-surface-container-low">
      <div className="flex h-7 items-center justify-between border-b border-border/40 bg-surface-container-lowest/70 px-2.5 text-[10px] text-muted-foreground">
        <span className="font-mono uppercase font-semibold">{lang || 'webgal'}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-container hover:text-foreground transition-colors"
            title="复制到剪贴板"
          >
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
          {onInsertSnippet && (
            <button
              type="button"
              onClick={() => onInsertSnippet(rawText)}
              className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary hover:bg-primary/20 transition-colors"
              title="插入当前剧本光标或选中位置后"
            >
              <CornerDownLeft className="h-3 w-3" />
              <span>插入光标处</span>
            </button>
          )}
          {onDiffSnippet && (
            <button
              type="button"
              onClick={() => onDiffSnippet(rawText)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-container hover:text-foreground transition-colors"
              title="与当前选中内容进行对比替换"
            >
              <GitCompare className="h-3 w-3" />
              <span>对比替换</span>
            </button>
          )}
        </div>
      </div>
      <pre className="max-w-full overflow-x-auto p-2.5 font-mono text-[11px] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function DiffBlock({ diff }: { diff: ChatDiffLine[] }) {
  const [open, setOpen] = useState(false);
  const added = diff.filter((l) => l.kind === 'added').length;
  const removed = diff.filter((l) => l.kind === 'removed').length;
  const label = [added > 0 && `+${added}`, removed > 0 && `-${removed}`].filter(Boolean).join(' ');

  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2 py-1.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
        aria-expanded={open}
      >
        <FileEdit className="h-3.5 w-3.5 shrink-0 text-chart-2" />
        <span className="flex-1 text-left">查看修改内容</span>
        {label && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{label}</span>
        )}
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-1 max-h-52 overflow-auto rounded-md border border-border/50 bg-background/35 p-1.5 font-mono text-[11px] leading-relaxed">
          {diff.map((line, i) => {
            if (line.kind === 'added') {
              return (
                <div key={i} className="text-green-400 whitespace-pre-wrap">
                  <span className="select-none text-green-600">+ </span>
                  {line.text}
                </div>
              );
            }
            if (line.kind === 'removed') {
              return (
                <div
                  key={i}
                  className="text-red-400 whitespace-pre-wrap line-through decoration-red-600/50"
                >
                  <span className="select-none no-underline text-red-600">- </span>
                  {line.text}
                </div>
              );
            }
            if (line.text === '...') {
              return (
                <div key={i} className="text-muted-foreground/50 select-none text-center">
                  ···
                </div>
              );
            }
            return (
              <div key={i} className="text-muted-foreground/70 whitespace-pre-wrap">
                <span className="select-none"> </span>
                {line.text}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Full GFM markdown (tables, headings, quotes, code, lists, task lists). */
function Markdown({
  children,
  onInsertSnippet,
  onDiffSnippet,
}: {
  children: string;
  onInsertSnippet?: (text: string) => void;
  onDiffSnippet?: (text: string) => void;
}) {
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
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-border" />,
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const isInline = !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              return (
                <code className="rounded bg-background/70 px-1 py-0.5 text-[0.92em] break-words">
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock
                className={className}
                onInsertSnippet={onInsertSnippet}
                onDiffSnippet={onDiffSnippet}
              >
                {children}
              </CodeBlock>
            );
          },
          table: ({ children }) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-[11px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-background/40">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-border/60 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border/60 px-2 py-1 align-top">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Renders a multi-step assistant reply: per-turn text blocks + tool-call rows. */
function StepsView({
  steps,
  onInsertSnippet,
  onDiffSnippet,
}: {
  steps: AssistantStep[];
  onInsertSnippet?: (text: string) => void;
  onDiffSnippet?: (text: string) => void;
}) {
  return (
    <div className="space-y-2">
      {steps.map((step, si) => (
        <div key={si} className="space-y-1.5">
          {step.text?.trim() && (
            <Markdown onInsertSnippet={onInsertSnippet} onDiffSnippet={onDiffSnippet}>
              {step.text.trim()}
            </Markdown>
          )}
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
                {call.ok === false ? (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ToolIcon className="h-3.5 w-3.5 shrink-0 text-chart-2" />
                )}
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

export function AiMessageBubble({
  role,
  content,
  steps,
  isStreaming = false,
  stopped = false,
  diff,
  attachments,
  onInsertSnippet,
  onDiffSnippet,
}: AiMessageBubbleProps) {
  return (
    <div
      data-message-role={role}
      className={`min-w-0 max-w-[85%] rounded-lg px-3 py-2 text-sm break-words font-body-family ${
        role === 'user'
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-secondary-foreground border border-border'
      }`}
    >
      {steps && steps.length > 0 ? (
        <StepsView steps={steps} onInsertSnippet={onInsertSnippet} onDiffSnippet={onDiffSnippet} />
      ) : content && role === 'assistant' ? (
        <Markdown onInsertSnippet={onInsertSnippet} onDiffSnippet={onDiffSnippet}>
          {content}
        </Markdown>
      ) : (
        <div className="whitespace-pre-wrap">{content}</div>
      )}
      {!content && (!steps || steps.length === 0) && isStreaming && '思考中...'}
      {isStreaming && content && (
        <span className="inline-block w-2 h-3 ml-1 bg-current align-middle animate-pulse" />
      )}
      {attachments && attachments.length > 0 && <AiSentAttachments attachments={attachments} />}
      {diff && diff.length > 0 && !isStreaming && <DiffBlock diff={diff} />}
      {stopped && <div className="mt-1 text-[11px] text-muted-foreground">已停止</div>}
    </div>
  );
}
