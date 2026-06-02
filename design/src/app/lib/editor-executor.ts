import { normalizePatchText, type EditorPatch } from './editor-patch';

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
    throw new Error(`行号范围 ${startLine}-${endLine} 超出当前脚本范围 1-${total}`);
  }
}

export function resolveLineWithAnchor(lines: string[], lineNo: number, anchorText?: string): ResolvedLine {
  if (!Number.isInteger(lineNo) || lineNo < 1) throw new Error(`行号 ${lineNo} 不是有效正整数`);
  if (!anchorText) {
    if (lineNo > lines.length) throw new Error(`行号 ${lineNo} 超出当前脚本范围 1-${lines.length}`);
    return { line: lineNo, corrected: false };
  }

  if (lineNo <= lines.length && lines[lineNo - 1] === anchorText) {
    return { line: lineNo, corrected: false };
  }

  const start = Math.max(1, lineNo - 3);
  const end = Math.min(lines.length, lineNo + 3);
  for (let line = start; line <= end; line += 1) {
    if (lines[line - 1] === anchorText) return { line, corrected: true };
  }

  const matches: number[] = [];
  lines.forEach((line, index) => {
    if (line === anchorText) matches.push(index + 1);
  });
  if (matches.length === 1) return { line: matches[0], corrected: true };

  if (matches.length > 1) throw new Error(`anchorText 匹配到多行，无法确定目标行：${anchorText}`);
  throw new Error(`无法定位 anchorText：${anchorText}`);
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
