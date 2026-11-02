import { describe, expect, it } from 'vitest';
import { partitionHistoryForBudget } from './useAiAgent';
import type { ChatMessage } from './useChatSession';

const BUDGET = {
  contextWindowTokens: 32_768,
  reservedOutputTokens: 2_048,
  safetyMarginTokens: 4_096,
  triggerRatio: 0.8,
};

function history(count: number, chars: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: 'a'.repeat(i % 2 === 0 ? chars : 20),
  }));
}

describe('partitionHistoryForBudget', () => {
  it('compacts a short history whose retained messages alone exceed the budget', () => {
    const result = partitionHistoryForBudget(
      history(20, 16_000),
      null,
      'system',
      'start.txt',
      'continue',
      [],
      BUDGET,
    );
    expect(result.trace.overBudget).toBe(false);
    expect(result.compactable.length).toBeGreaterThan(0);
    expect(result.retainedMessages.length).toBeLessThan(20);
  });

  it('chooses the retained suffix by token budget, not a fixed 24 messages', () => {
    const result = partitionHistoryForBudget(
      history(30, 8_000),
      null,
      'system',
      'start.txt',
      'continue',
      [],
      BUDGET,
    );
    expect(result.trace.overBudget).toBe(false);
    expect(result.retainedMessages.length).toBeLessThan(24);
  });

  it('keeps recent messages when everything already fits', () => {
    const result = partitionHistoryForBudget(
      history(6, 40),
      null,
      'system',
      'start.txt',
      'continue',
      [],
      BUDGET,
    );
    expect(result.trace.overBudget).toBe(false);
  });
});
