import { describe, expect, it } from 'vitest';
import { buildMemoryContext, memoryEntries, type ProjectMemory } from './project-memory';

const legacy: ProjectMemory = { worldSetting: '海边校园', writingStyle: '简洁', userPreferences: '', updatedAt: '2026-01-01' };

describe('project memory context', () => {
  it('maps old fields to stable entries without modifying the original', () => {
    const entries = memoryEntries(legacy);
    expect(entries.map((entry) => [entry.id, entry.category, entry.content])).toEqual([
      ['legacy-worldSetting', 'world', '海边校园'], ['legacy-writingStyle', 'style', '简洁'],
    ]);
    expect(legacy.entries).toBeUndefined();
    expect(buildMemoryContext(legacy)).toContain('海边校园');
  });

  it('omits disabled entries from prompts and never restores deleted entries', () => {
    const entries = memoryEntries(legacy).map((entry) => ({ ...entry, enabled: entry.category !== 'world' }));
    const context = buildMemoryContext({ ...legacy, entries });
    expect(context).toContain('简洁');
    expect(context).not.toContain('海边校园');
    expect(buildMemoryContext({ ...legacy, entries: [] })).toBe('');
    expect(memoryEntries(null)).toEqual([]);
  });
});
