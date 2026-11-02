import { normalizePatchText, type EditorPatch } from './editor-patch';

export class EditorPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorPatchError';
  }
}

export interface ResolvedLine {
  line: number;
  corrected: boolean;
}

export interface AppliedEditorPatch {
  content: string;
  lineDelta: number;
  corrected: boolean;
}

function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function splitInsertText(text: string): string[] {
  const normalized = normalizePatchText(text);
  return normalized.length > 0 ? normalized.split('\n') : [];
}

function assertRange(startLine: number, endLine: number, total: number): void {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > total) {
    throw new EditorPatchError(`行号范围 ${startLine}-${endLine} 超出当前脚本范围 1-${total}`);
  }
}

function normalizeScriptLine(value: string): string {
  return value
    .trim()
    .replace(/;+\s*$/, '')
    .trim();
}

function stripDisplayLinePrefix(value: string, lines: string[]): string | null {
  const match = /^(\d+):\s+(.+)$/.exec(value.trim());
  if (!match) return null;
  const [, digits, rawRemainder] = match;
  const speakerPrefix = `${digits}:`;
  if (lines.some((line) => line.trim().startsWith(speakerPrefix))) {
    return null;
  }
  const remainder = normalizeScriptLine(rawRemainder);
  if (!remainder) return null;
  if (remainder.startsWith(';') || remainder === 'end' || remainder.includes(':')) {
    return remainder;
  }
  return null;
}

function resolveCandidateAgainstLines(
  lines: string[],
  lineNo: number,
  candidate: string,
  rawAnchor: string,
): ResolvedLine | null {
  if (lineNo <= lines.length && lines[lineNo - 1] === candidate) {
    return { line: lineNo, corrected: false };
  }

  const start = Math.max(1, lineNo - 3);
  const end = Math.min(lines.length, lineNo + 3);
  const nearbyMatches: number[] = [];
  for (let line = start; line <= end; line += 1) {
    if (lines[line - 1] === candidate) nearbyMatches.push(line);
  }
  if (nearbyMatches.length === 1) return { line: nearbyMatches[0], corrected: true };
  if (nearbyMatches.length > 1) {
    throw new EditorPatchError(`anchorText 匹配到多行，无法确定目标行：${rawAnchor}`);
  }

  const matches: number[] = [];
  lines.forEach((line, index) => {
    if (line === candidate) matches.push(index + 1);
  });
  if (matches.length === 1) return { line: matches[0], corrected: true };
  if (matches.length > 1) {
    throw new EditorPatchError(`anchorText 匹配到多行，无法确定目标行：${rawAnchor}`);
  }

  return null;
}

export function resolveLineWithAnchor(
  lines: string[],
  lineNo: number,
  anchorText?: string,
): ResolvedLine {
  if (!Number.isInteger(lineNo) || lineNo < 1) {
    throw new EditorPatchError(`行号 ${lineNo} 不是有效正整数`);
  }
  if (!anchorText) {
    if (lineNo > lines.length) {
      throw new EditorPatchError(`行号 ${lineNo} 超出当前脚本范围 1-${lines.length}`);
    }
    return { line: lineNo, corrected: false };
  }

  const exactMatch = resolveCandidateAgainstLines(lines, lineNo, anchorText, anchorText);
  if (exactMatch) return exactMatch;

  // Tolerate omitted trailing `;` semicolons while preserving speaker/command prefixes,
  // and only strip copied `22: ` display line numbers when the remainder is still a
  // complete WebGAL line and the number is not a speaker in the script.
  const normalizedLines = lines.map(normalizeScriptLine);
  const normalizedAnchor = normalizeScriptLine(anchorText);
  if (normalizedAnchor.length > 0) {
    const normalizedMatch = resolveCandidateAgainstLines(
      normalizedLines,
      lineNo,
      normalizedAnchor,
      anchorText,
    );
    if (normalizedMatch) return normalizedMatch;
  }

  const strippedAnchor = stripDisplayLinePrefix(anchorText, lines);
  if (strippedAnchor) {
    const strippedMatch = resolveCandidateAgainstLines(
      normalizedLines,
      lineNo,
      strippedAnchor,
      anchorText,
    );
    if (strippedMatch) return strippedMatch;
  }

  throw new EditorPatchError(`无法定位 anchorText：${anchorText}`);
}

export function applyEditorPatch(content: string, patch: EditorPatch): AppliedEditorPatch {
  const lines = normalizeLines(content);

  if (patch.type === 'insert') {
    const inserted = splitInsertText(patch.text);
    if (patch.afterLine === 'end') {
      lines.push(...inserted);
      return { content: lines.join('\n'), lineDelta: inserted.length, corrected: false };
    }
    const resolved = resolveLineWithAnchor(lines, patch.afterLine, patch.anchorText);
    lines.splice(resolved.line, 0, ...inserted);
    return { content: lines.join('\n'), lineDelta: inserted.length, corrected: resolved.corrected };
  }

  const resolvedStart = resolveLineWithAnchor(lines, patch.startLine, patch.anchorText);
  const length = patch.endLine - patch.startLine + 1;
  const resolvedEnd = resolvedStart.line + length - 1;
  assertRange(resolvedStart.line, resolvedEnd, lines.length);

  if (patch.type === 'delete') {
    lines.splice(resolvedStart.line - 1, length);
    return { content: lines.join('\n'), lineDelta: -length, corrected: resolvedStart.corrected };
  }

  const inserted = splitInsertText(patch.text);
  lines.splice(resolvedStart.line - 1, length, ...inserted);
  return { content: lines.join('\n'), lineDelta: inserted.length - length, corrected: resolvedStart.corrected };
}

function offsetPatch(patch: EditorPatch, offset: number): EditorPatch {
  if (patch.type === 'insert') {
    return patch.afterLine === 'end' ? patch : { ...patch, afterLine: patch.afterLine + offset };
  }
  return {
    ...patch,
    startLine: patch.startLine + offset,
    endLine: patch.endLine + offset,
  };
}

export function applyEditorPatches(content: string, patches: EditorPatch[]): { content: string; correctedAnchors: number } {
  let next = content;
  let offset = 0;
  let correctedAnchors = 0;
  for (const patch of patches) {
    const applied = applyEditorPatch(next, offsetPatch(patch, offset));
    next = applied.content;
    offset += applied.lineDelta;
    if (applied.corrected) correctedAnchors += 1;
  }
  return { content: next, correctedAnchors };
}
