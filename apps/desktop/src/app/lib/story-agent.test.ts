import { describe, expect, it } from 'vitest';
import { buildConversationMessages, createLineDiff } from './story-agent';

describe('buildConversationMessages', () => {
  it('keeps older turns and replays bounded tool context', () => {
    const messages = buildConversationMessages([
      { id: 'u-1', role: 'user', content: '先读取角色设定' },
      {
        id: 'a-1',
        role: 'assistant',
        content: '已读取。',
        steps: [{ toolCalls: [{ name: 'get_character', ok: true, arguments: { id: 'hero' }, resultSummary: '{"name":"主角"}' }] }],
      },
      { id: 'u-2', role: 'user', content: '继续扩写' },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1].content).toContain('get_character');
    expect(messages[1].content).toContain('主角');
  });

  it('labels messages from different scenes so legacy models do not mix scripts', () => {
    const messages = buildConversationMessages([
      { id: 'u-1', role: 'user', content: '扩写旧场景', sceneName: 'archive.txt' },
      { id: 'u-2', role: 'user', content: '清理当前场景', sceneName: 'market.txt' },
    ]);
    expect(messages[0].content).toContain('[对话关联场景: archive.txt]');
    expect(messages[1].content).toContain('[对话关联场景: market.txt]');
  });
});

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
