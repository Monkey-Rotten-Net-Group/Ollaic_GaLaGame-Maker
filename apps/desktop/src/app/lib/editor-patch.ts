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
const SCRIPT_COMMAND_PATTERN = Array.from(scriptCommands).join('|');
const COMMAND_WITH_PREFIX_RE = new RegExp(`^(.*?)\\s+(${SCRIPT_COMMAND_PATTERN}):`);

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

export function splitPatchText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return normalized.length > 0 ? normalized.split('\n') : [];
}

function normalizeSetVarLine(line: string): string {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('setVar:')) return trimmed;
  const semiIdx = trimmed.indexOf(';');
  const commandPart = semiIdx >= 0 ? trimmed.slice(0, semiIdx) : trimmed;
  const suffix = semiIdx >= 0 ? trimmed.slice(semiIdx) : '';
  const rawRest = commandPart.slice('setVar:'.length).trim();
  if (!rawRest) return trimmed;

  const flagMatch = rawRest.match(/\s+-[a-zA-Z]/);
  const flagIndex = flagMatch?.index ?? -1;
  const exprPart = (flagIndex >= 0 ? rawRest.slice(0, flagIndex) : rawRest).trim();
  const flagsPart = flagIndex >= 0 ? rawRest.slice(flagIndex) : '';

  const compound = exprPart.match(/^([a-zA-Z_$][a-zA-Z0-9_.]*)\s*([+\-*/])=\s*(.+)$/);
  if (!compound) return trimmed;
  const [, variable, operator, rhs] = compound;
  return `setVar:${variable}=${variable}${operator}(${rhs.trim()})${flagsPart}${suffix}`;
}

export function normalizePatchText(text: string): string {
  return splitPatchText(text).map((line) => {
    const trimmed = normalizeSetVarLine(line);
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
    const commandWithPrefix = body.match(COMMAND_WITH_PREFIX_RE);
    if (commandWithPrefix && commandWithPrefix[1].trim()) {
      errors.push(
        `第 ${lineNo} 行的 WebGAL 命令前不能加说明文字：${line}。请直接写 ${commandWithPrefix[2]}:...;`,
      );
      return;
    }
    const prefix = body.slice(0, colonIndex);
    if (prefix === 'setVar') {
      const rest = body.slice(colonIndex + 1).trim();
      const flagIndex = rest.search(/\s+-[a-zA-Z]/);
      const exprPart = (flagIndex >= 0 ? rest.slice(0, flagIndex) : rest).trim();
      const eqIndex = exprPart.indexOf('=');
      const lhs = eqIndex >= 0 ? exprPart.slice(0, eqIndex).trim() : '';
      const rhs = eqIndex >= 0 ? exprPart.slice(eqIndex + 1).trim() : '';
      if (eqIndex <= 0 || !lhs || !rhs || rhs.startsWith('=')) {
        errors.push(`第 ${lineNo} 行 setVar 语法无效：${line}。请写成 setVar:变量名=值或表达式;`);
        return;
      }
      if (/[+\-*/]$/.test(lhs)) {
        errors.push(
          `第 ${lineNo} 行 setVar 变量名或赋值运算符无效：${line}。请写成 setVar:变量名=变量名*表达式;`,
        );
        return;
      }
      return;
    }
    if (scriptCommands.has(prefix)) return;
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
    playEffect: 'vocal',
    playVideo: 'video',
  };
  const refs: Array<{ command: string; file: string; expectedCategory: string }> = [];
  for (const line of splitPatchText(text)) {
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_]*):([^;\s]+)/);
    if (!match) continue;
    const expectedCategory = categoryByCommand[match[1]];
    if (!expectedCategory) continue;
    // Keep the qualified path (e.g. figure subdir "<角色ID>/x.png") so per-character
    // sprite references validate against the subdir-qualified asset list, not just
    // a basename. Flat categories have no slash, so this is a no-op for them.
    const file = match[2].replace(/\\/g, '/').replace(/^\.?\//, '');
    if (file && file !== 'none') refs.push({ command: match[1], file, expectedCategory });
  }
  return refs;
}
