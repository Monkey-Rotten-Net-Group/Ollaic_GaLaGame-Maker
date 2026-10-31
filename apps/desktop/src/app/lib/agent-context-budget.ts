import type { AiChatMessage, ToolDef } from './ai-ipc';

export interface ContextBudgetConfig {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  triggerRatio: number;
  source?: 'provider' | 'default';
}

export interface ContextBlockTrace {
  id: string;
  kind: 'system' | 'history' | 'user' | 'tool-schema' | 'tool-result';
  messageCount: number;
  characters: number;
  estimatedTokens: number;
}

export interface ContextTrace {
  estimator: 'mixed-script-v1';
  budgetSource: 'provider' | 'default';
  estimatedInputTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  usableInputTokens: number;
  triggerTokens: number;
  utilization: number;
  overBudget: boolean;
  shouldCompact: boolean;
  blocks: ContextBlockTrace[];
  actualPromptTokens?: number;
  actualCompletionTokens?: number;
  cachedPromptTokens?: number;
  estimationErrorTokens?: number;
  estimationRatio?: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  contextWindowTokens: 128_000,
  reservedOutputTokens: 8_192,
  safetyMarginTokens: 4_096,
  triggerRatio: 0.8,
};

/**
 * Conservative mixed-script estimate. It is deliberately deterministic and
 * provider-independent until a provider exposes an exact tokenizer.
 */
export function estimateContextTokens(value: string): number {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const char of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (/\p{ASCII}/u.test(char)) ascii += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.6 + ascii / 4 + other / 2.5);
}

function block(kind: ContextBlockTrace['kind'], id: string, messages: AiChatMessage[]): ContextBlockTrace {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  const estimatedTokens = messages.reduce((total, message) => total + estimateContextTokens(message.content) + 4, 0);
  return { id, kind, messageCount: messages.length, characters, estimatedTokens };
}

export function buildContextTrace(
  messages: AiChatMessage[],
  tools: ToolDef[] = [],
  config: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
): ContextTrace {
  const system = messages.filter((message) => message.role === 'system');
  const history = messages.filter((message) => message.role === 'assistant' || message.role === 'user');
  const toolResults = messages.filter((message) => message.role === 'tool');
  const blocks = [
    ...(system.length > 0 ? [block('system', 'system', system)] : []),
    ...(history.length > 0 ? [block('history', 'history', history)] : []),
    ...(toolResults.length > 0 ? [block('tool-result', 'tool-results', toolResults)] : []),
    ...(tools.length > 0 ? [{
      id: 'tool-schemas',
      kind: 'tool-schema' as const,
      messageCount: tools.length,
      characters: JSON.stringify(tools).length,
      estimatedTokens: estimateContextTokens(JSON.stringify(tools)) + tools.length * 8,
    }] : []),
  ];
  const estimatedInputTokens = blocks.reduce((total, item) => total + item.estimatedTokens, 0);
  const usableInputTokens = Math.max(0, config.contextWindowTokens - config.reservedOutputTokens - config.safetyMarginTokens);
  const triggerTokens = Math.floor(usableInputTokens * config.triggerRatio);
  return {
    estimator: 'mixed-script-v1',
    budgetSource: config.source ?? 'default',
    estimatedInputTokens,
    contextWindowTokens: config.contextWindowTokens,
    reservedOutputTokens: config.reservedOutputTokens,
    safetyMarginTokens: config.safetyMarginTokens,
    usableInputTokens,
    triggerTokens,
    utilization: config.contextWindowTokens > 0 ? estimatedInputTokens / config.contextWindowTokens : 1,
    overBudget: estimatedInputTokens > usableInputTokens,
    shouldCompact: estimatedInputTokens >= triggerTokens,
    blocks,
  };
}
