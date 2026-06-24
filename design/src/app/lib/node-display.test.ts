import { describe, expect, it } from 'vitest';
import { getNodeSummary } from './node-display';
import type { WebGalNode } from './webgal-types';

function figureNode(overrides: Partial<WebGalNode>): WebGalNode {
  return {
    id: '1',
    type: 'changeFigure',
    content: 'shizuka_default.webp',
    asset: 'shizuka_default.webp',
    flags: [],
    position: { x: 0, y: 0 },
    connections: [],
    ...overrides,
  };
}

describe('getNodeSummary', () => {
  it('includes figure metadata and execution flags in changeFigure summaries', () => {
    expect(getNodeSummary(figureNode({
      figureCharacter: '最上静香',
      figureEmotion: 'default',
      figurePosition: 'center',
      next: true,
    }))).toBe('最上静香：default · shizuka_default.webp [center, next]');
  });

  it('makes figure metadata-only changes visible in preview summaries', () => {
    const before = getNodeSummary(figureNode({
      figureCharacter: '最上静香',
      figureEmotion: 'default',
      figurePosition: 'center',
      next: true,
    }));
    const after = getNodeSummary(figureNode({
      figureCharacter: '最上静香',
      figureEmotion: 'embarrassed',
      figurePosition: 'center',
      next: true,
    }));
    expect(after).not.toBe(before);
    expect(after).toContain('embarrassed');
  });
});
