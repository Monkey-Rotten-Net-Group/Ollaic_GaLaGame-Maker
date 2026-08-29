import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  stageCreateCharacterEdit,
  stageCreateSceneEdit,
  stageCharacterSpritesPlan,
  stageSceneEdit,
  type StagingContext,
  type StagingDraft,
} from './change-set';
import { emptyProjectMemory } from './project-memory';

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, args) => {
    if (command === 'parse_scene') {
      return String((args as { source?: string }).source ?? '')
        .split('\n')
        .map((content, index) => ({
          id: `n${index}`,
          type: 'comment',
          content,
          flags: [],
          position: { x: 0, y: 0 },
          connections: [],
        }));
    }
    if (command === 'serialize_scene') {
      return ((args as { nodes?: Array<{ content?: string }> }).nodes ?? [])
        .map((node) => node.content ?? '')
        .join('\n');
    }
    throw new Error(`unexpected invoke: ${command}`);
  });
});

function makeDraft(): StagingDraft {
  return { sceneFiles: new Map(), characters: new Map() };
}

function makeCtx(overrides: Partial<StagingContext> = {}): StagingContext {
  return {
    currentSceneName: 'start.txt',
    currentScriptSource: '',
    currentNodes: [],
    assets: [],
    characters: [],
    readSceneContent: async () => {
      throw new Error('disk read must not be used for a staged scene');
    },
    listSceneFiles: async () => [],
    getCharacter: () => undefined,
    memory: emptyProjectMemory(),
    ...overrides,
  };
}

describe('read-your-writes: create_scene → edit_scene in the same turn', () => {
  it('composes an edit against a scene staged for creation, without reading disk', async () => {
    const draft = makeDraft();
    const ctx = makeCtx({ draft });

    await stageCreateSceneEdit({ tool: 'create_scene', name: 'chapter_02' }, ctx);

    const edit = await stageSceneEdit(
      undefined,
      {
        tool: 'edit_scene',
        file: 'chapter_02.txt',
        patches: [{ type: 'insert', file: 'chapter_02.txt', afterLine: 'end', text: 'B:world;' }],
      },
      ctx,
    );

    expect(edit.afterContent).toContain('B:world');
  });

  it('rejects a duplicate create_scene for a scene staged earlier in the same turn', async () => {
    const draft = makeDraft();
    const ctx = makeCtx({ draft });

    await stageCreateSceneEdit({ tool: 'create_scene', name: 'chapter_02' }, ctx);

    await expect(
      stageCreateSceneEdit({ tool: 'create_scene', name: 'chapter_02.txt' }, ctx),
    ).rejects.toThrow(/已存在/);
  });
});

describe('read-your-writes: create_character → plan_character_sprites in the same turn', () => {
  it('resolves a staged draft character by its temporary id', () => {
    const draft = makeDraft();
    const ctx = makeCtx({ draft });

    const created = stageCreateCharacterEdit(
      { tool: 'create_character', draft: { name: '艾拉' } },
      ctx,
    );

    const planned = stageCharacterSpritesPlan(
      undefined,
      {
        tool: 'plan_character_sprites',
        character: created.draft.id,
        sprites: [{ emotion: 'happy', prompt: 'smiling' }],
      },
      ctx,
    );

    expect(planned.after.sprites.some((s) => s.emotion === 'happy')).toBe(true);
  });
});

describe('read-your-writes: overlay is optional (backward compatible)', () => {
  it('without a draft, edit_scene still reads through readSceneContent', async () => {
    const ctx = makeCtx({ readSceneContent: async () => 'A:on-disk;' });
    const edit = await stageSceneEdit(
      undefined,
      {
        tool: 'edit_scene',
        file: 'other.txt',
        patches: [{ type: 'insert', file: 'other.txt', afterLine: 'end', text: 'B:world;' }],
      },
      ctx,
    );
    expect(edit.afterContent).toContain('A:on-disk');
    expect(edit.afterContent).toContain('B:world');
  });
});
