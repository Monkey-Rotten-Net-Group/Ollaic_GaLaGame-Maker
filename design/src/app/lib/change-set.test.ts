import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  StageError,
  resolveFigurePatchText,
  stageCharacterEdit,
  stageCharacterSpritesPlan,
  stageBranchEdit,
  stageCreateCharacterEdit,
  stageDialogueBlockInsert,
  stageFigureInsert,
  stageMemoryEdit,
  stageAssetPlanEdit,
  stageSceneEdit,
  stageSceneHeaderEdit,
  type StagingContext,
} from './change-set';
import type { Character } from './character-types';
import type { AssetInfo } from './assets-ipc';
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

describe('scene structure tools', () => {
  it('sets scene header without requiring the model to patch comment lines', async () => {
    const edit = await stageSceneHeaderEdit(
      undefined,
      { tool: 'set_scene_header', file: 'start.txt', chapter: '第一章', outline: '雨夜重逢' },
      makeCtx({ currentScriptSource: ':开场;' }),
    );

    expect(edit.afterContent).toContain('; 章节: 第一章');
    expect(edit.afterContent).toContain('; 大纲: 雨夜重逢');
    expect(edit.afterContent).toContain(':开场;');
  });

  it('turns structured dialogue lines into WebGAL txt', async () => {
    const edit = await stageDialogueBlockInsert(
      undefined,
      {
        tool: 'insert_dialogue_block',
        file: 'start.txt',
        afterLine: 'end',
        lines: [
          { type: 'narrator', text: '雨停了。' },
          { type: 'dialogue', character: '小明', text: '我们走吧。' },
          { type: 'jump', target: 'next' },
        ],
      },
      makeCtx({ currentScriptSource: '; 章节: 开端' }),
    );

    expect(edit.afterContent).toContain(':雨停了。;');
    expect(edit.afterContent).toContain('小明:我们走吧。;');
    expect(edit.afterContent).toContain('changeScene:next.txt;');
  });

  it('allows script background refs backed by a same-turn asset plan', async () => {
    const edit = await stageDialogueBlockInsert(
      undefined,
      {
        tool: 'insert_dialogue_block',
        file: 'start.txt',
        afterLine: 'end',
        lines: [
          { type: 'background', asset: 'gray_room_letter.png' },
          { type: 'narrator', text: '信纸边缘泛起冷光。' },
        ],
      },
      makeCtx({
        currentScriptSource: ':开场;',
        plannedAssetKeys: new Set(['background/gray_room_letter.png']),
      }),
    );

    expect(edit.afterContent).toContain('changeBg:gray_room_letter.png -next;');
    expect(edit.afterContent).toContain(':信纸边缘泛起冷光。;');
  });

  it('rejects missing background refs without an asset plan', async () => {
    await expect(stageSceneEdit(
      undefined,
      {
        tool: 'edit_scene',
        file: 'start.txt',
        patches: [{ type: 'insert', file: 'start.txt', afterLine: 'end', text: 'changeBg:fake_room.png -next;' }],
      },
      makeCtx({ currentScriptSource: ':开场;' }),
    )).rejects.toThrow('plan_assets');
  });

  it('creates branch targets with optional initial content', async () => {
    const result = await stageBranchEdit(
      undefined,
      {
        tool: 'create_branch',
        file: 'start.txt',
        afterLine: 'end',
        choices: [
          { text: '追上去', targetScene: 'chase', chapter: '追逐', contentLines: [{ type: 'narrator', text: '他冲进雨幕。' }] },
          { text: '留下来', targetScene: 'stay', outline: '选择等待' },
        ],
      },
      makeCtx({ currentScriptSource: ':选择时刻;' }),
    );

    expect(result.sourceEdit.afterContent).toContain('choose:追上去:chase.txt|留下来:stay.txt;');
    expect(result.createSceneEdits.map((edit) => edit.file)).toEqual(['chase.txt', 'stay.txt']);
    expect(result.createSceneEdits[0].chapter).toBe('追逐');
    expect(result.createSceneEdits[0].initialContent).toBe(':他冲进雨幕。;');
    expect(result.createSceneEdits[0].initialNodes?.length).toBe(1);
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

describe('stageCharacterSpritesPlan', () => {
  it('adds and updates sprite prompts without binding files', () => {
    const edit = stageCharacterSpritesPlan(
      undefined,
      {
        tool: 'plan_character_sprites',
        character: '小明',
        sprites: [
          { emotion: '默认', prompt: 'neutral standing pose' },
          { emotion: '微笑', prompt: 'gentle smile' },
        ],
      },
      makeCtx({ characters: [{ ...BASE_CHARACTER, sprites: [{ emotion: '默认', file: 'old.png' }] }] }),
    );

    expect(edit.after.sprites).toEqual([
      { emotion: '默认', file: 'old.png', prompt: 'neutral standing pose' },
      { emotion: '微笑', file: '', prompt: 'gentle smile' },
    ]);
    expect(edit.changedFields).toEqual(['sprites']);
  });
});

describe('stageAssetPlanEdit', () => {
  it('creates pending background and CG cards without script assets', () => {
    const edit = stageAssetPlanEdit({
      tool: 'plan_assets',
      assets: [
        {
          category: 'background',
          title: '灰色房间信件',
          sceneFile: 'letter_room',
          targetStem: 'gray_room_letter',
          prompt: '灰色房间, 桌上一封信, 阴天冷光, 视觉小说背景',
        },
        {
          category: 'cg',
          title: '信件特写',
          prompt: '手指按住泛黄信纸的特写, 浅景深',
        },
      ],
    });

    expect(edit.kind).toBe('asset_plan');
    expect(edit.cards).toHaveLength(2);
    expect(edit.cards[0]).toMatchObject({
      id: 'bg:gray_room_letter.png',
      category: 'background',
      title: '灰色房间信件',
      sceneFile: 'letter_room.txt',
      imageAsset: null,
      targetStem: 'gray_room_letter',
    });
    expect(edit.cards[1].category).toBe('cg');
    expect(edit.cards[1].prompt).toContain('信纸');
  });

  it('rejects figure asset planning because sprites own that flow', () => {
    expect(() =>
      stageAssetPlanEdit({
        tool: 'plan_assets',
        assets: [{ category: 'figure', title: '静香微笑', prompt: 'smile' }],
      }),
    ).toThrow('plan_character_sprites');
  });

  it('keeps duplicate asset plan titles as distinct cards', () => {
    const edit = stageAssetPlanEdit({
      tool: 'plan_assets',
      assets: [
        { category: 'background', title: '教室', prompt: 'classroom at noon' },
        { category: 'background', title: '教室', prompt: 'classroom at night' },
      ],
    });

    expect(new Set(edit.cards.map((card) => card.id)).size).toBe(2);
    expect(edit.cards.map((card) => card.targetStem)).toEqual(['ai_asset_01', 'ai_asset_02']);
  });
});

describe('stageCreateCharacterEdit', () => {
  it('creates a sanitized draft with a default sprite slot', () => {
    const edit = stageCreateCharacterEdit(
      {
        tool: 'create_character',
        draft: {
          id: 'model_id',
          name: '小红',
          personality: '冷静',
          keywords: ['学生', '侦探'],
          aliases: ['红'],
          referenceImages: ['fake.png'],
          defaultVoice: 'fake.wav',
          sprites: [
            { emotion: '微笑', prompt: 'gentle smile', file: 'should-not-pass.png' },
            { emotion: '', prompt: 'ignored' },
            { emotion: '微笑', prompt: 'duplicate' },
          ],
          relations: [{ targetId: 'x', relationType: '朋友', description: '' }],
          unknown: 'drop',
        },
      },
      makeCtx(),
    );

    expect(edit.kind).toBe('create_character');
    expect(edit.draft.id).not.toBe('model_id');
    expect(edit.draft.name).toBe('小红');
    expect(edit.draft.personality).toBe('冷静');
    expect(edit.draft.keywords).toEqual(['学生', '侦探']);
    expect(edit.draft.aliases).toEqual(['红']);
    expect(edit.draft.sprites).toEqual([
      { emotion: '默认', file: '' },
      { emotion: '微笑', file: '', prompt: 'gentle smile' },
    ]);
    expect(edit.draft.relations).toEqual([]);
    expect(edit.draft.referenceImages).toEqual([]);
    expect(edit.draft.defaultVoice).toBeUndefined();
    expect((edit.draft as unknown as Record<string, unknown>).unknown).toBeUndefined();
  });

  it('throws when the character name already exists', () => {
    expect(() =>
      stageCreateCharacterEdit(
        { tool: 'create_character', draft: { name: '小明' } },
        makeCtx(),
      ),
    ).toThrow(StageError);
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
