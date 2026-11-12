import { describe, expect, it } from 'vitest';
import {
  buildConversationMessages,
  buildEditScopeContext,
  createLineDiff,
  formatUserTurnContent,
  resolveEffectiveEditScope,
} from './story-agent';
import type { WebGalNode } from './webgal-types';

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

describe('edit scope helpers', () => {
  const sampleNode: WebGalNode = {
    id: 'n2',
    type: 'dialogue',
    character: '林夏',
    content: '晚上好。',
    flags: [],
    position: { x: 0, y: 0 },
    connections: [],
  };

  it('falls back from node to scene when no node is selected', () => {
    expect(resolveEffectiveEditScope('node', null, 'scene')).toBe('scene');
    expect(resolveEffectiveEditScope('full', null, 'scene')).toBe('full');
    expect(resolveEffectiveEditScope('node', sampleNode, 'scene')).toBe('node');
    expect(resolveEffectiveEditScope(undefined, null)).toBeUndefined();
  });

  it('formats distinct LLM system scope instructions without altering raw user messages', () => {
    expect(buildEditScopeContext(undefined, 'start.txt')).toBe('');
    expect(buildEditScopeContext({ scope: 'scene' }, 'start.txt')).toContain('仅当前场景（start.txt）');
    expect(buildEditScopeContext({ scope: 'full' }, 'start.txt')).toContain('全剧范围');
    const nodeContext = buildEditScopeContext(
      { scope: 'node', selectedNode: sampleNode, selectedNodeIndex: 1 },
      'start.txt',
    );
    expect(nodeContext).toContain('第 2 条指令');
    expect(nodeContext).toContain('林夏');
    expect(nodeContext).toContain('晚上好。');
  });

  it('formats user turn scope header only for the model request and keeps full scope cross-scene capable', () => {
    expect(formatUserTurnContent([{ id: '1', sceneName: 'start.txt' }], 'start.txt', '1')).toBe('1');
    expect(
      formatUserTurnContent(
        [{ id: 'u-0', sceneName: 'other.txt' }],
        'start.txt',
        '继续修改',
        { scope: 'full' },
      ),
    ).toBe('[当前打开场景: start.txt | 编辑范围: 全剧范围（可跨场景读取与修改）]\n继续修改');
    expect(
      formatUserTurnContent(
        [{ id: 'u-0', sceneName: 'other.txt' }],
        'start.txt',
        '继续修改',
        { scope: 'scene' },
      ),
    ).toContain('仅编辑当前场景 start.txt');
  });
});
