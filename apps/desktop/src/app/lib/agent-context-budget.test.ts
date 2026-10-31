import { describe, expect, it } from 'vitest';
import { buildContextTrace, estimateContextTokens } from './agent-context-budget';

describe('agent context budget', () => {
  it('estimates mixed Chinese and ASCII text deterministically', () => {
    expect(estimateContextTokens('中文中文')).toBe(3);
    expect(estimateContextTokens('abcd')).toBe(1);
  });

  it('reports message and tool schema blocks', () => {
    const trace = buildContextTrace([
      { role: 'system', content: 'rules' },
      { role: 'user', content: '修改场景' },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call-1' },
    ], [{ name: 'read_scene', description: 'read', parameters: { type: 'object' } }], {
      contextWindowTokens: 100,
      reservedOutputTokens: 10,
      safetyMarginTokens: 10,
      triggerRatio: 0.5,
    });

    expect(trace.blocks.map((item) => item.id)).toEqual(['system', 'history', 'tool-results', 'tool-schemas']);
    expect(trace.budgetSource).toBe('default');
    expect(trace.triggerTokens).toBe(40);
    expect(trace.estimatedInputTokens).toBeGreaterThan(0);
  });

  it('marks a context that needs compaction before the hard limit', () => {
    const trace = buildContextTrace([{ role: 'user', content: 'a'.repeat(250) }], [], {
      contextWindowTokens: 100,
      reservedOutputTokens: 10,
      safetyMarginTokens: 10,
      triggerRatio: 0.8,
    });
    expect(trace.shouldCompact).toBe(true);
    expect(trace.overBudget).toBe(false);
  });

  it('includes assistant toolCalls payload in history block estimation', () => {
    const withoutToolCalls = buildContextTrace([
      { role: 'assistant', content: '' },
    ]);
    const withToolCalls = buildContextTrace([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'edit_scene', arguments: { file: 'start.txt', patches: ['角色:台词;'] } }],
      },
    ]);
    expect(withToolCalls.estimatedInputTokens).toBeGreaterThan(withoutToolCalls.estimatedInputTokens);
    expect(withToolCalls.blocks[0]?.characters).toBeGreaterThan(0);
  });
});
