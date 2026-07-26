import { invoke } from '@tauri-apps/api/core';

/** One reference file the author attached to the AI workflow. */
export interface AiUpload {
  id: string;
  /** Original file name chosen by the user. */
  name: string;
  /** File name inside the project's reference store. */
  storedName: string;
  extension: string;
  size: number;
  charCount: number;
  lineCount: number;
  /** Short single-line preview. */
  summary: string;
  /** Unix milliseconds, as a string. */
  importedAt: string;
}

/** A slice of one reference file's text. */
export interface AiUploadContent {
  id: string;
  name: string;
  text: string;
  fromLine: number;
  toLine: number;
  totalLines: number;
  truncated: boolean;
}

/** Text extensions the backend accepts. Mirrors `ai::uploads::SUPPORTED_EXTENSIONS`. */
export const AI_UPLOAD_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'log',
  'srt', 'ini', 'toml',
];

/** Largest single reference file accepted, in bytes. */
export const AI_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export async function listAiUploads(projectPath: string): Promise<AiUpload[]> {
  return invoke<AiUpload[]>('list_ai_uploads', { projectPath });
}

export async function importAiUpload(projectPath: string, sourcePath: string): Promise<AiUpload> {
  return invoke<AiUpload>('import_ai_upload', { projectPath, sourcePath });
}

export async function readAiUpload(
  projectPath: string,
  id: string,
  fromLine?: number,
  maxLines?: number,
): Promise<AiUploadContent> {
  return invoke<AiUploadContent>('read_ai_upload', {
    projectPath,
    id,
    fromLine: fromLine ?? null,
    maxLines: maxLines ?? null,
  });
}

export async function deleteAiUpload(projectPath: string, id: string): Promise<void> {
  return invoke<void>('delete_ai_upload', { projectPath, id });
}

export function formatUploadSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Compact listing of the files attached to the message being sent.
 * Only names and summaries — full text is fetched on demand via read_reference_file
 * so a large upload never inflates every request.
 *
 * Attaching is the access gate: files the user did not attach are omitted
 * entirely, so a leftover unrelated upload can't bleed into an unrelated answer.
 */
export function buildUploadContext(
  uploads: AiUpload[],
  attachedIds: string[] = [],
  limit = 20,
): string {
  if (uploads.length === 0 || attachedIds.length === 0) return '';
  const attachedSet = new Set(attachedIds);
  const attached = uploads.filter((upload) => attachedSet.has(upload.id));
  if (attached.length === 0) return '';

  const lines = attached.slice(0, limit).map((upload) =>
    `- ${upload.name}（id: ${upload.id}，${upload.lineCount} 行，${formatUploadSize(upload.size)}）：${upload.summary || '（空摘要）'}`,
  );
  const omitted = attached.length - Math.min(attached.length, limit);
  return [
    '【本条消息附带的参考资料】以下文件由作者随这条消息附加，仅供参考，不是项目脚本。需要具体内容时用 read_reference_file 按 id 读取；不要凭摘要臆测细节。',
    '只有这里列出的文件可用。若其内容与用户的请求无关，就当作没有参考资料，直接基于项目内容作答，不要强行把它们的内容写进剧情。',
    ...lines,
    ...(omitted > 0 ? [`另有 ${omitted} 个附件未列出，可用 list_reference_files 查看。`] : []),
  ].join('\n');
}

/** Largest amount of inlined reference text per legacy request. */
const LEGACY_INLINE_CHARS = 8000;

/**
 * Inline the attached files' text for providers without function calling.
 * Those models can't call read_reference_file, so a summary-only listing would
 * make attachments useless to them. Bounded so one big file can't crowd out the
 * script and asset context the patch protocol depends on.
 */
export async function buildInlineUploadContext(
  projectPath: string,
  uploads: AiUpload[],
  attachedIds: string[],
): Promise<string> {
  const attached = uploads.filter((upload) => attachedIds.includes(upload.id));
  if (attached.length === 0) return '';
  const budget = Math.max(500, Math.floor(LEGACY_INLINE_CHARS / attached.length));
  const blocks: string[] = [];
  for (const upload of attached) {
    try {
      const content = await readAiUpload(projectPath, upload.id, 1, 400);
      const text = content.text.slice(0, budget);
      const clipped = content.truncated || text.length < content.text.length;
      blocks.push(
        `--- ${upload.name} ---\n${text}${clipped ? `\n…（已截断，全文共 ${content.totalLines} 行）` : ''}`,
      );
    } catch {
      blocks.push(`--- ${upload.name} ---\n（读取失败，已跳过）`);
    }
  }
  return ['【本条消息附带的参考资料正文】仅供取材，不是项目脚本。', ...blocks].join('\n');
}
