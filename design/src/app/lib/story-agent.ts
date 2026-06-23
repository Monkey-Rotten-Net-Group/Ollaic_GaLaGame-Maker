import type { AssetInfo } from './assets-ipc';
import type { AiChatMessage } from './ai-ipc';

export interface MissingAssetIssue {
  command: string;
  file: string;
  expectedCategory: string;
}

export interface DiffLine {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

const categoryLabels: Record<string, string> = {
  background: '背景',
  figure: '立绘',
  bgm: 'BGM',
  sfx: '音效',
  vocal: '语音',
  video: '视频',
};

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

export function truncateContextMessages(
  history: Array<{ id: string; role: 'user' | 'assistant'; content: string }>,
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
  const trimmed = content.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}
