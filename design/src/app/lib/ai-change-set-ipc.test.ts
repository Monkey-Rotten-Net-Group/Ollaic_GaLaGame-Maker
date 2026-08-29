import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedInvoke } = vi.hoisted(() => ({ mockedInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockedInvoke,
}));

import { applyAiChangeSet } from './ai-change-set-ipc';
import type { PendingChangeSet } from './change-set';

describe('AI change-set IPC', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue({ outcome: 'applied' });
  });

  it('sends one typed request without preview-only scene fields', async () => {
    const set: PendingChangeSet = {
      id: 'change-1',
      createdAt: '2026-08-28T00:00:00Z',
      sourceMessageId: 'assistant-1',
      status: 'pending',
      edits: [
        {
          kind: 'scene',
          file: 'start.txt',
          isCurrent: true,
          beforeContent: 'old',
          afterContent: 'new',
          beforeNodes: [],
          afterNodes: [],
          diff: [],
          summary: 'replace scene',
          warnings: [],
        },
        {
          kind: 'asset_plan',
          cards: [{
            id: 'bg:cafe.webp',
            category: 'background',
            title: 'Cafe',
            imageAsset: null,
            targetStem: 'cafe',
            prompt: 'quiet cafe',
            style: '',
            negativePrompt: '',
          }],
        },
      ],
    };

    await applyAiChangeSet(
      '/projects/story',
      set,
      { file: 'start.txt', content: 'manual buffer' },
      true,
    );

    expect(mockedInvoke).toHaveBeenCalledOnce();
    expect(mockedInvoke).toHaveBeenCalledWith('apply_ai_change_set', {
      request: {
        projectPath: '/projects/story',
        force: true,
        currentScene: { file: 'start.txt', content: 'manual buffer' },
        edits: [
          { kind: 'scene', file: 'start.txt', beforeContent: 'old', afterContent: 'new' },
          {
            kind: 'asset_plan',
            cards: [{
              id: 'bg:cafe.webp',
              category: 'background',
              title: 'Cafe',
              imageAsset: null,
              targetStem: 'cafe',
              prompt: 'quiet cafe',
              style: '',
              negativePrompt: '',
            }],
          },
        ],
      },
    });
  });
});
