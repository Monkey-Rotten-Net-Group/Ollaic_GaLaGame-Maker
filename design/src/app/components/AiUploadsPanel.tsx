import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Check, FileText, Loader2, Paperclip, Plus, Trash2, Upload, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  AI_UPLOAD_EXTENSIONS,
  formatUploadSize,
  type AiUpload,
  type AiUploadContent,
} from '../lib/ai-uploads-ipc';

interface AiUploadsButtonProps {
  uploads: AiUpload[];
  attachedIds: string[];
  busy: boolean;
  error: string | null;
  disabled?: boolean;
  onAdd: (sourcePaths: string[]) => Promise<void>;
  onAttach: (id: string) => void;
  onDetach: (id: string) => void;
  onRemove: (id: string) => Promise<void>;
  onPreview: (id: string) => Promise<AiUploadContent | null>;
  onDismissError: () => void;
}

/**
 * "+" attach button at the corner of the chat input. Uploading attaches the
 * file to the message being composed; sending hands it off to that message and
 * clears the tray. Files stay in the project store below `.webgal-editor/`, so
 * they are never part of a playable build — the agent only reads them.
 */
export function AiUploadsButton({
  uploads,
  attachedIds,
  busy,
  error,
  disabled = false,
  onAdd,
  onAttach,
  onDetach,
  onRemove,
  onPreview,
  onDismissError,
}: AiUploadsButtonProps) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AiUploadContent | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const pickFiles = async () => {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: '文本参考资料', extensions: AI_UPLOAD_EXTENSIONS }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await onAdd(paths);
  };

  const inspect = async (id: string) => {
    if (previewId === id) {
      setPreviewId(null);
      setPreview(null);
      return;
    }
    setPreviewId(id);
    setPreview(await onPreview(id));
  };

  const remove = async (id: string) => {
    if (previewId === id) {
      setPreviewId(null);
      setPreview(null);
    }
    await onRemove(id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface-container-low text-muted-foreground transition-colors hover:bg-secondary-container/60 hover:text-foreground disabled:opacity-40"
          aria-label="附加参考资料"
          title="附加参考资料"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">附加参考资料</span>
            {attachedIds.length > 0 && (
              <span className="font-mono-family text-[10px] text-muted-foreground">
                已附加 {attachedIds.length}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => { void pickFiles(); }}
            disabled={disabled || busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-secondary px-3 py-2 text-xs hover:bg-secondary/70 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {busy ? '上传中...' : '上传新文件'}
          </button>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            仅支持文本类文件（{AI_UPLOAD_EXTENSIONS.slice(0, 6).join(' / ')} 等），单个不超过 2 MB。
            上传后会附加到本条消息，发送即随消息一起交给 AI；不会写入可运行的项目文件。
          </p>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
              <button
                type="button"
                onClick={onDismissError}
                className="shrink-0 rounded p-0.5 hover:bg-destructive/20"
                aria-label="关闭错误提示"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {uploads.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">还没有上传过参考资料。</p>
          ) : (
            <>
              <p className="text-[10px] text-muted-foreground">
                此前上传的文件（点勾选附加到本条消息）：
              </p>
              <ul className="max-h-52 space-y-1 overflow-y-auto">
                {uploads.map((upload) => {
                  const attached = attachedIds.includes(upload.id);
                  return (
                    <li key={upload.id} className="rounded-md border border-border bg-input-background">
                      <div className="flex items-center gap-1 px-1.5 py-1.5">
                        <button
                          type="button"
                          onClick={() => (attached ? onDetach(upload.id) : onAttach(upload.id))}
                          disabled={disabled}
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-40 ${
                            attached
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border text-transparent hover:border-primary/60'
                          }`}
                          aria-label={attached ? `取消附加 ${upload.name}` : `附加 ${upload.name}`}
                          title={attached ? '取消附加' : '附加到本条消息'}
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { void inspect(upload.id); }}
                          className="min-w-0 flex-1 text-left"
                          title={`${upload.name} · ${upload.lineCount} 行 · ${formatUploadSize(upload.size)}`}
                        >
                          <span className="block truncate text-[11px] text-foreground">{upload.name}</span>
                          <span className="block font-mono-family text-[10px] text-muted-foreground">
                            {upload.lineCount} 行 · {formatUploadSize(upload.size)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => { void remove(upload.id); }}
                          disabled={disabled}
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                          aria-label={`删除参考文件 ${upload.name}`}
                          title="从项目中删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {previewId === upload.id && (
                        <pre className="max-h-40 overflow-auto border-t border-border px-2 py-1.5 font-mono-family text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
                          {preview?.text || '（无法预览内容）'}
                          {preview?.truncated ? `\n… 共 ${preview.totalLines} 行，仅显示前 ${preview.toLine} 行` : ''}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface AiAttachmentTrayProps {
  uploads: AiUpload[];
  attachedIds: string[];
  onDetach: (id: string) => void;
}

/** Chips above the input showing what will be sent with the next message. */
export function AiAttachmentTray({ uploads, attachedIds, onDetach }: AiAttachmentTrayProps) {
  const attached = attachedIds
    .map((id) => uploads.find((upload) => upload.id === id))
    .filter((upload): upload is AiUpload => Boolean(upload));
  if (attached.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attached.map((upload) => (
        <span
          key={upload.id}
          className="flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary-container/40 py-0.5 pl-2 pr-1 text-[11px] text-foreground"
          title={`${upload.name} · ${upload.lineCount} 行 · ${formatUploadSize(upload.size)}`}
        >
          <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 max-w-40 truncate">{upload.name}</span>
          <button
            type="button"
            onClick={() => onDetach(upload.id)}
            className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
            aria-label={`移除附件 ${upload.name}`}
            title="不随本条消息发送"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Attachment chips rendered inside a sent user message bubble. */
export function AiSentAttachments({
  attachments,
}: {
  attachments: Array<{ id: string; name: string; lineCount: number; size: number }>;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="flex max-w-full items-center gap-1 rounded-full bg-background/25 px-2 py-0.5 text-[10px]"
          title={`${attachment.name} · ${attachment.lineCount} 行 · ${formatUploadSize(attachment.size)}`}
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="min-w-0 max-w-40 truncate">{attachment.name}</span>
        </span>
      ))}
    </div>
  );
}
