import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { StageError, resolveFigurePatchText, stageCharacterEdit, stageFigureInsert, stageMemoryEdit, type StagingContext } from './change-set';
import type { Character } from './character-types';
import type { AssetInfo } from './assets-ipc';
import { emptyProjectMemory } from './project-memory';

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, args) => {
    if (command === 'parse_scene') return [];
    if (command === 'serialize_scene') return String((args as { nodes?: unknown }).nodes ?? '');
    throw new Error(`unexpected invoke: ${command}`);
  });
});

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
    characters: [BASE_CHARACTER],
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

describe('resolveFigurePatchText', () => {
  const SHIZUKA: Character = {
    ...BASE_CHARACTER,
    id: 'char_shizuka',
    name: '静香',
    aliases: [],
    sprites: [
      { emotion: '默认', file: 'shizuka_default.png' },
      { emotion: '生气', file: '' },
    ],
  };
  const figure = (name: string): AssetInfo => ({ name, path: `/p/${name}`, category: 'figure', size: 1, extension: 'png' });
  const variantAssets = [figure('char_shizuka/静香_生气_1700000000.png')];

  it('fills/corrects the file from figureCharacter + figureEmotion flags', () => {
    const out = resolveFigurePatchText('changeFigure:placeholder -figureCharacter=静香 -figureEmotion=默认 -left -next;', [SHIZUKA], []);
    expect(out).toBe('changeFigure:shizuka_default.png -figureCharacter=静香 -figureEmotion=默认 -left -next;');
  });

  it('resolves a variant emotion to its qualified subdir path', () => {
    const out = resolveFigurePatchText('changeFigure:none -figureCharacter=静香 -figureEmotion=生气 -next;', [SHIZUKA], variantAssets);
    expect(out).toBe('changeFigure:char_shizuka/静香_生气_1700000000.png -figureCharacter=静香 -figureEmotion=生气 -next;');
  });

  it('treats a non-file asset token as the emotion when figureCharacter is present', () => {
    const out = resolveFigurePatchText('changeFigure:生气 -figureCharacter=静香 -left -next;', [SHIZUKA], variantAssets);
    expect(out).toBe('changeFigure:char_shizuka/静香_生气_1700000000.png -figureCharacter=静香 -left -next -figureEmotion=生气;');
  });

  it('does not treat a real filename as emotion when figureEmotion is missing', () => {
    const line = 'changeFigure:missing.png -figureCharacter=静香 -left -next;';
    expect(resolveFigurePatchText(line, [SHIZUKA], variantAssets)).toBe(line);
  });

  it('leaves the line untouched when the flags are absent', () => {
    const line = 'changeFigure:whatever.png -left -next;';
    expect(resolveFigurePatchText(line, [SHIZUKA], [])).toBe(line);
  });

  it('leaves the line untouched when character/emotion cannot be resolved', () => {
    const line = 'changeFigure:x.png -figureCharacter=路人 -figureEmotion=生气 -next;';
    expect(resolveFigurePatchText(line, [SHIZUKA], variantAssets)).toBe(line);
  });

  it('only rewrites changeFigure lines, leaving dialogue/other commands alone', () => {
    const text = '静香:你好;\nchangeFigure:bad -figureCharacter=静香 -figureEmotion=默认 -next;\nchangeBg:room.png;';
    const out = resolveFigurePatchText(text, [SHIZUKA], []);
    expect(out).toBe('静香:你好;\nchangeFigure:shizuka_default.png -figureCharacter=静香 -figureEmotion=默认 -next;\nchangeBg:room.png;');
  });
});

describe('stageFigureInsert', () => {
  const SHIZUKA: Character = {
    ...BASE_CHARACTER,
    id: 'char_shizuka',
    name: '静香',
    aliases: ['小静'],
    sprites: [
      { emotion: '默认', file: 'shizuka_default.png' },
      { emotion: '生气', file: '' },
    ],
  };
  const figure = (name: string): AssetInfo => ({ name, path: `/p/${name}`, category: 'figure', size: 1, extension: 'png' });

  it('builds a valid scene edit from character + emotion intent', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'parse_scene') return args.source.split('\n').map((line: string) => ({ id: line, type: 'comment', content: line, flags: [], position: { x: 0, y: 0 }, connections: [] }));
      if (command === 'serialize_scene') return args.nodes.map((node: { content: string }) => node.content).join('\n');
      throw new Error(`unexpected invoke: ${command}`);
    });

    const edit = await stageFigureInsert(
      undefined,
      {
        tool: 'insert_figure',
        file: 'start.txt',
        afterLine: 'end',
        character: '小静',
        emotion: '生气',
        position: 'left',
      },
      makeCtx({
        currentScriptSource: ':开场;',
        characters: [SHIZUKA],
        assets: [figure('char_shizuka/静香_生气_1700000000.png')],
      }),
    );

    expect(edit.afterContent).toContain('changeFigure:char_shizuka/静香_生气_1700000000.png');
    expect(edit.afterContent).toContain('-figureCharacter=静香');
    expect(edit.afterContent).toContain('-figureEmotion=生气');
    expect(edit.afterContent).toContain('-left');
    expect(edit.afterContent).toContain('-next');
  });

  it('surfaces a clear error when the requested emotion is not configured', async () => {
    await expect(stageFigureInsert(
      undefined,
      {
        tool: 'insert_figure',
        file: 'start.txt',
        afterLine: 'end',
        character: '静香',
        emotion: '困惑',
      },
      makeCtx({ currentScriptSource: ':开场;', characters: [SHIZUKA] }),
    )).rejects.toThrow('没有表情');
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
