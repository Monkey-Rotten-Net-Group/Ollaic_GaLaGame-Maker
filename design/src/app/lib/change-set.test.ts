import { describe, expect, it } from 'vitest';
import { StageError, stageCharacterEdit, stageMemoryEdit, type StagingContext } from './change-set';
import type { Character } from './character-types';
import { emptyProjectMemory } from './project-memory';

const BASE_CHARACTER: Character = {
  id: 'c1',
  name: '小明',
  aliases: ['明明'],
  description: '',
  personality: '开朗',
  stance: '正义',
  keywords: [],
  dialogueStyle: '',
  gender: '男',
  age: '18',
  sprites: [],
  relations: [],
  notes: '',
};

function makeCtx(overrides: Partial<StagingContext> = {}): StagingContext {
  return {
    currentSceneName: 'start.txt',
    currentScriptSource: '',
    currentNodes: [],
    assets: [],
    readSceneContent: async () => '',
    listSceneFiles: async () => [],
    getCharacter: (id) => (id === BASE_CHARACTER.id ? BASE_CHARACTER : undefined),
    memory: emptyProjectMemory(),
    ...overrides,
  };
}

describe('StageError', () => {
  it('is a real Error subclass carrying a message', () => {
    const err = new StageError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
    expect(String(err)).toContain('boom');
  });
});

describe('stageCharacterEdit', () => {
  it('throws a StageError when the character is missing', () => {
    expect(() =>
      stageCharacterEdit(undefined, { tool: 'edit_character', id: 'nope', partial: {} }, makeCtx()),
    ).toThrow(StageError);
  });

  it('applies valid string and string[] fields', () => {
    const edit = stageCharacterEdit(
      undefined,
      { tool: 'edit_character', id: 'c1', partial: { personality: '内向', aliases: ['阿明'] } },
      makeCtx(),
    );
    expect(edit.after.personality).toBe('内向');
    expect(edit.after.aliases).toEqual(['阿明']);
    expect(edit.changedFields.sort()).toEqual(['aliases', 'personality']);
  });

  it('drops unknown fields and wrong-typed values supplied by the model', () => {
    const edit = stageCharacterEdit(
      undefined,
      {
        tool: 'edit_character',
        id: 'c1',
        // hacked: unknown field, wrong type for aliases, attempt to repoint id
        partial: { evil: 'x', aliases: 'not-an-array', id: 'c2', personality: 42 } as Record<string, unknown>,
      },
      makeCtx(),
    );
    expect((edit.after as Record<string, unknown>).evil).toBeUndefined();
    expect(edit.after.id).toBe('c1');           // id never changes
    expect(edit.after.aliases).toEqual(['明明']); // wrong type ignored, base kept
    expect(edit.after.personality).toBe('开朗');  // number ignored, base kept
    expect(edit.changedFields).toEqual([]);
  });
});

describe('stageMemoryEdit', () => {
  it('keeps only known string fields and refreshes updatedAt', () => {
    const edit = stageMemoryEdit(
      undefined,
      {
        tool: 'edit_memory',
        partial: { worldSetting: '魔法世界', junk: 'x', writingStyle: 7 } as Record<string, unknown>,
      },
      makeCtx(),
    );
    expect(edit.after.worldSetting).toBe('魔法世界');
    expect((edit.after as Record<string, unknown>).junk).toBeUndefined();
    expect(edit.after.writingStyle).toBe(''); // number ignored
    expect(edit.changedFields).toEqual(['worldSetting']); // updatedAt filtered out
  });
});
