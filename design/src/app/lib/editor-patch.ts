export type EditorPatch =
  | {
      type: 'insert';
      file: string;
      afterLine: number | 'end';
      anchorText?: string;
      text: string;
    }
  | {
      type: 'delete';
      file: string;
      startLine: number;
      endLine: number;
      anchorText?: string;
    }
  | {
      type: 'replace';
      file: string;
      startLine: number;
      endLine: number;
      anchorText?: string;
      text: string;
    };

export type EditorResponse =
  | { type: 'patches'; patches: EditorPatch[] }
  | { type: 'chat'; message: string };

const scriptCommands = new Set([
  'changeBg',
  'changeFigure',
  'miniAvatar',
  'bgm',
  'playEffect',
  'playVideo',
  'choose',
  'changeScene',
  'setVar',
  'unlockCg',
  'unlockBgm',
  'callScene',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonCandidate(raw: string): unknown {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : raw.trim();
  const cleaned = candidate.trim().replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}

function isPositiveLine(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function isEditorPatch(value: unknown): value is EditorPatch {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  if (typeof value.file !== 'string' || value.file.trim().length === 0) return false;
  if (value.anchorText !== undefined && typeof value.anchorText !== 'string') return false;
  if (value.type === 'insert') {
    return (value.afterLine === 'end' || isPositiveLine(value.afterLine)) && typeof value.text === 'string';
  }
  if (value.type === 'delete') {
    return isPositiveLine(value.startLine) && isPositiveLine(value.endLine) && value.startLine <= value.endLine;
  }
  if (value.type === 'replace') {
    return isPositiveLine(value.startLine) && isPositiveLine(value.endLine) && value.startLine <= value.endLine && typeof value.text === 'string';
  }
  return false;
}

export function validateEditorResponse(value: unknown): EditorResponse | null {
  if (!isRecord(value)) return null;
  if (value.type === 'chat' && typeof value.message === 'string') {
    return { type: 'chat', message: value.message };
  }
  if (Array.isArray(value.patches) && value.patches.every(isEditorPatch)) {
    return { type: 'patches', patches: value.patches };
  }
  return null;
}

export function extractEditorResponse(raw: string): EditorResponse | null {
  try {
    return validateEditorResponse(parseJsonCandidate(raw));
  } catch {
    return null;
  }
}

function splitPatchText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return normalized.length > 0 ? normalized.split('\n') : [];
}

export function normalizePatchText(text: string): string {
  return splitPatchText(text).map((line) => {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith(';') || trimmed.endsWith(';')) return trimmed;
    return trimmed + ';';
  }).join('\n');
}

export function validatePatchText(text: string): string[] {
  const errors: string[] = [];
  splitPatchText(normalizePatchText(text)).forEach((line, index) => {
    const trimmed = line.trim();
    const lineNo = index + 1;
    if (!trimmed || trimmed.startsWith(';')) return;
    const body = trimmed.slice(0, -1);
    if (body.startsWith(':')) return;
    const colonIndex = body.indexOf(':');
    if (colonIndex <= 0) {
      errors.push(`第 ${lineNo} 行不是有效 WebGAL 行：${line}`);
      return;
    }
    // Unknown prefixes are treated as dialogue speaker names. Asset references are validated separately.
  });
  return errors;
}

export function summarizePatch(patch: EditorPatch): string {
  if (patch.type === 'insert') return patch.afterLine === 'end' ? `在 ${patch.file} 末尾插入内容` : `在 ${patch.file} 第 ${patch.afterLine} 行后插入内容`;
  if (patch.type === 'delete') return patch.startLine === patch.endLine ? `删除 ${patch.file} 第 ${patch.startLine} 行` : `删除 ${patch.file} 第 ${patch.startLine}-${patch.endLine} 行`;
  return patch.startLine === patch.endLine ? `替换 ${patch.file} 第 ${patch.startLine} 行` : `替换 ${patch.file} 第 ${patch.startLine}-${patch.endLine} 行`;
}

export function summarizePatches(patches: EditorPatch[]): string {
  return patches.map(summarizePatch).join(' · ');
}

export function extractPatchAssetRefs(text: string): Array<{ command: string; file: string; expectedCategory: string }> {
  const categoryByCommand: Record<string, string> = {
    changeBg: 'background',
    changeFigure: 'figure',
    miniAvatar: 'figure',
    bgm: 'bgm',
    playEffect: 'sfx',
    playVideo: 'video',
  };
  const refs: Array<{ command: string; file: string; expectedCategory: string }> = [];
  for (const line of splitPatchText(text)) {
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_]*):([^;\s]+)/);
    if (!match) continue;
    const expectedCategory = categoryByCommand[match[1]];
    if (!expectedCategory) continue;
    const file = match[2].replace(/\\/g, '/').split('/').pop() ?? match[2];
    if (file && file !== 'none') refs.push({ command: match[1], file, expectedCategory });
  }
  return refs;
}
