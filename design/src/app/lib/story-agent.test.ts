import { describe, expect, it } from 'vitest';
import { createLineDiff } from './story-agent';

describe('createLineDiff', () => {
  it('reports no diff when content is identical', () => {
    expect(createLineDiff('a;\nb;', 'a;\nb;')).toEqual([{ kind: 'context', text: '无文本差异' }]);
  });

  it('marks an added line', () => {
    const diff = createLineDiff('a;\nb;', 'a;\nNEW;\nb;');
    expect(diff.some((l) => l.kind === 'added' && l.text === 'NEW;')).toBe(true);
  });

  it('marks a removed line', () => {
    const diff = createLineDiff('a;\nGONE;\nb;', 'a;\nb;');
    expect(diff.some((l) => l.kind === 'removed' && l.text === 'GONE;')).toBe(true);
  });
});
