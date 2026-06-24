import { describe, expect, it } from 'vitest';
import { computeFullNodeDiff, computeNodeDiff, summarizeNodeDiff } from './node-diff';
import type { WebGalNode } from './webgal-types';

function figureNode(overrides: Partial<WebGalNode> = {}): WebGalNode {
  return {
    id: '1',
    type: 'changeFigure',
    content: 'shizuka_default.webp',
    asset: 'shizuka_default.webp',
    figurePosition: 'center',
    next: true,
    flags: [
      { key: 'center', value: true },
      { key: 'next', value: true },
    ],
    position: { x: 0, y: 0 },
    connections: [],
    ...overrides,
  };
}

describe('computeNodeDiff', () => {
  it('detects figure metadata being added without changing the sprite file', () => {
    const before = [figureNode()];
    const after = [figureNode({
      figureCharacter: '最上静香',
      figureEmotion: 'default',
    })];

    const diff = computeNodeDiff(before, after);

    expect(diff).toHaveLength(1);
    expect(diff[0].kind).toBe('modified');
    expect(diff[0].before?.asset).toBe('shizuka_default.webp');
    expect(diff[0].after?.asset).toBe('shizuka_default.webp');
    expect(diff[0].after?.figureCharacter).toBe('最上静香');
    expect(summarizeNodeDiff(diff)).toEqual({ added: 0, modified: 1, removed: 0 });
  });

  it('detects figure emotion changes as a node modification', () => {
    const before = [figureNode({
      figureCharacter: '最上静香',
      figureEmotion: 'default',
    })];
    const after = [figureNode({
      figureCharacter: '最上静香',
      figureEmotion: 'embarrassed',
    })];

    expect(computeFullNodeDiff(before, after)).toMatchObject([
      {
        kind: 'modified',
        before: { figureEmotion: 'default' },
        after: { figureEmotion: 'embarrassed' },
      },
    ]);
  });
});
