import type { AssetInfo } from './assets-ipc';
import type { AiChatMessage } from './ai-ipc';
import { stripWebGalJsonBlocks, type WebGalScene } from './webgal-schema';

export interface MissingAssetIssue {
  command: string;
  file: string;
  expectedCategory: string;
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  stopped?: boolean;
}

export interface DiffLine {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface FallbackAssetResult {
  scene: WebGalScene;
  replacements: string[];
  unresolved: MissingAssetIssue[];
}

export type StoryEditOperation =
  | { kind: 'delete_line'; line: number }
  | { kind: 'delete_range'; startLine: number; endLine: number }
  | { kind: 'replace_line'; line: number; content: string }
  | { kind: 'replace_range'; startLine: number; endLine: number; content: string }
  | { kind: 'insert_before_line'; line: number; content: string }
  | { kind: 'insert_after_line'; line: number; content: string };

export interface StoryEditPlan {
  type: 'edit_script';
  summary?: string;
  operations: StoryEditOperation[];
}

const categoryLabels: Record<string, string> = {
  background: '背景',
  figure: '立绘',
  bgm: 'BGM',
  sfx: '音效',
  vocal: '语音',
  video: '视频',
};

const fileCategoryByNodeType: Record<string, string> = {
  changeBg: 'background',
  changeFigure: 'figure',
  miniAvatar: 'figure',
  bgm: 'bgm',
  playEffect: 'sfx',
  playVideo: 'video',
};

function normalizeAssetName(value: string): string {
  return value.trim().replace(/\\/g, '/').split('/').pop() ?? value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStoryEditPlan(value: unknown): value is StoryEditPlan {
  if (!isRecord(value) || value.type !== 'edit_script' || !Array.isArray(value.operations)) return false;
  return value.operations.every((operation) => {
    if (!isRecord(operation) || typeof operation.kind !== 'string') return false;
    switch (operation.kind) {
      case 'delete_line':
        return Number.isInteger(operation.line) && operation.line > 0;
      case 'delete_range':
        return Number.isInteger(operation.startLine) && Number.isInteger(operation.endLine) && operation.startLine > 0 && operation.endLine > 0;
      case 'replace_line':
      case 'insert_before_line':
      case 'insert_after_line':
        return Number.isInteger(operation.line) && operation.line > 0 && typeof operation.content === 'string';
      case 'replace_range':
        return Number.isInteger(operation.startLine) && Number.isInteger(operation.endLine) && operation.startLine > 0 && operation.endLine > 0 && typeof operation.content === 'string';
      default:
        return false;
    }
  });
}

function parseJsonBlock(raw: string): unknown {
  return JSON.parse(raw.trim().replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1'));
}

export function extractStoryEditPlan(content: string): StoryEditPlan | null {
  const regex = /```(?:story-edit-json|json)\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = parseJsonBlock(match[1]);
      if (isStoryEditPlan(parsed)) return parsed;
    } catch {
      // try next block
    }
  }
  return null;
}

export function hasStoryEditJsonBlock(content: string): boolean {
  return /```story-edit-json\s*[\s\S]*?(?:```|$)/i.test(content);
}

function splitContentLines(content: string): string[] {
  const trimmed = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return trimmed.length > 0 ? trimmed.split('\n') : [];
}

function assertLineInRange(line: number, total: number): number {
  if (!Number.isInteger(line) || line < 1 || line > Math.max(total, 1)) {
    throw new Error(`行号 ${line} 超出范围`);
  }
  return line - 1;
}

function withLineOffset(operation: StoryEditOperation, offset: number): StoryEditOperation {
  switch (operation.kind) {
    case 'delete_line':
    case 'replace_line':
    case 'insert_before_line':
    case 'insert_after_line':
      return { ...operation, line: operation.line + offset };
    case 'delete_range':
    case 'replace_range':
      return {
        ...operation,
        startLine: operation.startLine + offset,
        endLine: operation.endLine + offset,
      };
  }
}

export function applyStoryEditPlan(beforeContent: string, plan: StoryEditPlan): string {
  const lines = beforeContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let offset = 0;

  for (const rawOperation of plan.operations) {
    const operation = withLineOffset(rawOperation, offset);
    let delta = 0;
    switch (operation.kind) {
      case 'delete_line': {
        const index = assertLineInRange(operation.line, lines.length);
        lines.splice(index, 1);
        delta = -1;
        break;
      }
      case 'delete_range': {
        const start = assertLineInRange(operation.startLine, lines.length);
        const end = assertLineInRange(operation.endLine, lines.length);
        if (end < start) throw new Error(`删除范围无效：${operation.startLine}-${operation.endLine}`);
        const removed = end - start + 1;
        lines.splice(start, removed);
        delta = -removed;
        break;
      }
      case 'replace_line': {
        const index = assertLineInRange(operation.line, lines.length);
        const inserted = splitContentLines(operation.content);
        lines.splice(index, 1, ...inserted);
        delta = inserted.length - 1;
        break;
      }
      case 'replace_range': {
        const start = assertLineInRange(operation.startLine, lines.length);
        const end = assertLineInRange(operation.endLine, lines.length);
        if (end < start) throw new Error(`替换范围无效：${operation.startLine}-${operation.endLine}`);
        const removed = end - start + 1;
        const inserted = splitContentLines(operation.content);
        lines.splice(start, removed, ...inserted);
        delta = inserted.length - removed;
        break;
      }
      case 'insert_before_line': {
        const index = assertLineInRange(operation.line, lines.length);
        const inserted = splitContentLines(operation.content);
        lines.splice(index, 0, ...inserted);
        delta = inserted.length;
        break;
      }
      case 'insert_after_line': {
        const index = assertLineInRange(operation.line, lines.length);
        const inserted = splitContentLines(operation.content);
        lines.splice(index + 1, 0, ...inserted);
        delta = inserted.length;
        break;
      }
    }
    offset += delta;
  }

  return lines.join('\n');
}

export function buildNumberedScriptContext(script: string, maxLines = 120): string {
  const lines = script.split('\n');
  const visible = lines.length > maxLines
    ? [...lines.slice(0, 40), '; ...中间内容已省略...', ...lines.slice(-80)]
    : lines;
  const omitted = lines.length > maxLines ? lines.length - visible.length + 1 : 0;
  return visible.map((line, index) => {
    if (line === '; ...中间内容已省略...') return line;
    const lineNo = lines.length > maxLines && index > 40 ? index + omitted : index + 1;
    return `${lineNo}: ${line}`;
  }).join('\n');
}

function uniqueByName(assets: AssetInfo[]): AssetInfo[] {
  const seen = new Set<string>();
  const result: AssetInfo[] = [];
  for (const asset of assets) {
    const key = `${asset.category}/${asset.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(asset);
  }
  return result;
}

export function buildAssetContext(assets: AssetInfo[], limitPerCategory = 24): string {
  if (assets.length === 0) {
    return '当前素材库未读取到可用素材。生成脚本时不要编造素材名；如果需要素材，请明确提示缺少素材。';
  }

  const grouped = new Map<string, AssetInfo[]>();
  for (const asset of uniqueByName(assets)) {
    const list = grouped.get(asset.category) ?? [];
    list.push(asset);
    grouped.set(asset.category, list);
  }

  const sections: string[] = [];
  for (const [category, list] of grouped) {
    const names = list.slice(0, limitPerCategory).map((asset) => asset.name);
    const omitted = list.length > limitPerCategory ? `，另有 ${list.length - limitPerCategory} 个未列出` : '';
    sections.push(`- ${categoryLabels[category] ?? category}: ${names.join(', ')}${omitted}`);
  }

  return [
    '当前素材库可用文件如下。生成 WebGAL 内容时必须优先使用这些文件名；不要引用列表外素材。',
    ...sections,
  ].join('\n');
}

export function hasAssetContextTruncation(assets: AssetInfo[], limitPerCategory = 24): boolean {
  const grouped = new Map<string, number>();
  for (const asset of uniqueByName(assets)) {
    grouped.set(asset.category, (grouped.get(asset.category) ?? 0) + 1);
  }
  return Array.from(grouped.values()).some((count) => count > limitPerCategory);
}

export function validateSceneAssets(scene: WebGalScene, assets: AssetInfo[]): MissingAssetIssue[] {
  const available = new Set(assets.map((asset) => `${asset.category}/${asset.name}`));
  const issues: MissingAssetIssue[] = [];

  for (const node of scene.nodes) {
    const expectedCategory = fileCategoryByNodeType[node.type];
    if (!expectedCategory || !('file' in node)) continue;
    const rawFile = typeof node.file === 'string' ? node.file : '';
    if (!rawFile || rawFile === 'none') continue;
    const file = normalizeAssetName(rawFile);
    if (!available.has(`${expectedCategory}/${file}`)) {
      issues.push({
        command: node.type,
        file,
        expectedCategory,
      });
    }
  }

  return issues;
}

export function formatMissingAssetIssues(issues: MissingAssetIssue[]): string {
  return issues.map((issue) => {
    const category = categoryLabels[issue.expectedCategory] ?? issue.expectedCategory;
    return `缺少${category}素材「${issue.file}」（命令：${issue.command}）`;
  }).join('\n');
}

function findFirstAsset(assets: AssetInfo[], category: string): AssetInfo | null {
  return assets.find((asset) => asset.category === category) ?? null;
}

export function applyFallbackAssets(scene: WebGalScene, assets: AssetInfo[]): FallbackAssetResult {
  const replacements: string[] = [];
  const unresolved: MissingAssetIssue[] = [];
  const available = new Set(assets.map((asset) => `${asset.category}/${asset.name}`));

  const nodes = scene.nodes.flatMap((node) => {
    const expectedCategory = fileCategoryByNodeType[node.type];
    if (!expectedCategory || !('file' in node)) return [node];
    const rawFile = typeof node.file === 'string' ? node.file : '';
    if (!rawFile || rawFile === 'none') return [node];
    const file = normalizeAssetName(rawFile);
    if (available.has(`${expectedCategory}/${file}`)) return [node];

    const fallback = findFirstAsset(assets, expectedCategory);
    if (fallback) {
      replacements.push(`将缺失的${categoryLabels[expectedCategory] ?? expectedCategory}「${file}」暂用「${fallback.name}」替代。`);
      return [{ ...node, file: fallback.name }];
    }

    if (['changeBg', 'bgm', 'playEffect', 'playVideo'].includes(node.type)) {
      replacements.push(`移除缺失${categoryLabels[expectedCategory] ?? expectedCategory}命令「${file}」。`);
      return [];
    }

    unresolved.push({ command: node.type, file, expectedCategory });
    return [node];
  });

  return { scene: { nodes }, replacements, unresolved };
}

export function createLineDiff(beforeContent: string, afterContent: string): DiffLine[] {
  const beforeLines = beforeContent.split('\n');
  const afterLines = afterContent.split('\n');
  const table: number[][] = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      table[i][j] = beforeLines[i] === afterLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const full: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      full.push({ kind: 'context', text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      full.push({ kind: 'removed', text: beforeLines[i] });
      i += 1;
    } else {
      full.push({ kind: 'added', text: afterLines[j] });
      j += 1;
    }
  }
  while (i < beforeLines.length) {
    full.push({ kind: 'removed', text: beforeLines[i] });
    i += 1;
  }
  while (j < afterLines.length) {
    full.push({ kind: 'added', text: afterLines[j] });
    j += 1;
  }

  if (!full.some((line) => line.kind !== 'context')) return [{ kind: 'context', text: '无文本差异' }];

  const keep = new Set<number>();
  full.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let k = Math.max(0, index - 2); k <= Math.min(full.length - 1, index + 2); k += 1) {
      keep.add(k);
    }
  });

  const compact: DiffLine[] = [];
  let skipped = false;
  full.forEach((line, index) => {
    if (!keep.has(index)) {
      skipped = true;
      return;
    }
    if (skipped && compact.length > 0) {
      compact.push({ kind: 'context', text: '...' });
    }
    skipped = false;
    compact.push(line);
  });
  return compact;
}

export function summarizeEditPlan(plan: StoryEditPlan): string {
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const operation of plan.operations) {
    const contentLines = 'content' in operation ? splitContentLines(operation.content).length : 0;
    switch (operation.kind) {
      case 'delete_line':
        removed += 1;
        break;
      case 'delete_range':
        removed += Math.max(0, operation.endLine - operation.startLine + 1);
        break;
      case 'replace_line':
        changed += 1;
        added += Math.max(0, contentLines - 1);
        break;
      case 'replace_range': {
        const rangeLines = Math.max(0, operation.endLine - operation.startLine + 1);
        changed += Math.min(rangeLines, contentLines);
        if (rangeLines > contentLines) removed += rangeLines - contentLines;
        if (contentLines > rangeLines) added += contentLines - rangeLines;
        break;
      }
      case 'insert_before_line':
      case 'insert_after_line':
        added += contentLines;
        break;
    }
  }

  const parts = [
    changed > 0 ? `修改 ${changed} 行` : '',
    removed > 0 ? `删除 ${removed} 行` : '',
    added > 0 ? `新增 ${added} 行` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : `编辑方案：${plan.operations.length} 个操作`;
}

export function truncateContextMessages(
  history: AgentChatMessage[],
  maxMessages: number,
): AiChatMessage[] {
  return history
    .filter((message) => message.id !== '1')
    .slice(-maxMessages)
    .map((message) => ({
      role: message.role,
      content: message.role === 'assistant'
        ? summarizeAssistantHistory(message.content)
        : message.content,
    }));
}

function summarizeAssistantHistory(content: string): string {
  const hasStructuredBlock = /```(?:webgal-json|story-edit-json|json)\s*[\s\S]*?```/i.test(content);
  if (hasStructuredBlock) {
    return '上一轮助手输出过结构化修改方案，具体 JSON 已由系统处理。继续对话时不要复述表格或旧方案；如果用户要求修改已有脚本，必须重新输出 story-edit-json。';
  }
  const stripped = stripWebGalJsonBlocks(content).trim();
  return stripped.length > 500 ? `${stripped.slice(0, 500)}...` : stripped;
}
