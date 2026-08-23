import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  stageCreateCharacterEdit,
  stageCharacterEdit,
  stageCreateSceneEdit,
  stageCharacterSpritesPlan,
  stageSceneEdit,
  type StagingContext,
  type StagingDraft,
} from './change-set';
import { getTool, type StagedWrite } from './ai-tools';
import type { Character } from './character-types';
import { emptyProjectMemory } from './project-memory';
import { createStagingProjectView } from './staging-project-view';

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
    if (command === 'list_assets') return [];
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

function character(id: string, name: string, aliases: string[] = []): Character {
  return {
    id,
    name,
    aliases,
    description: '',
    personality: '',
    stance: '',
    keywords: [],
    dialogueStyle: '',
    gender: '',
    age: '',
    sprites: [],
    relations: [],
    notes: '',
  };
}

function tool(name: string) {
  const value = getTool(name);
  if (!value) throw new Error(`missing tool: ${name}`);
  return value;
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

describe('read-your-writes through real AgentTool.run interfaces', () => {
  it('makes a created and edited scene visible to list_scenes/read_scene without disk writes', async () => {
    const draft = makeDraft();
    const readSceneContent = vi.fn(async (file: string) => file === 'start.txt' ? '; 章节: 开场\nA:disk;' : '');
    const view = createStagingProjectView(draft, {
      listSceneFiles: async () => ['start.txt'],
      readSceneContent,
      listCharacters: async () => [],
    });
    const ctx = makeCtx({
      draft,
      listSceneFiles: () => view.listScenes(),
      readSceneContent: (file) => view.readScene(file),
    });
    const toolCtx = { projectPath: '/project', currentSceneName: 'start.txt', projectView: view };

    const create = await tool('create_scene').run({ name: 'chapter_02' }, toolCtx) as StagedWrite;
    await stageCreateSceneEdit(create as Extract<StagedWrite, { tool: 'create_scene' }>, ctx);

    await expect(tool('list_scenes').run({}, toolCtx)).resolves.toEqual({
      scenes: [
        { file: 'chapter_02.txt', chapter: '', outline: '' },
        { file: 'start.txt', chapter: '开场', outline: '' },
      ],
    });

    const edit = await tool('edit_scene').run({
      file: 'chapter_02.txt',
      patches: [{ type: 'insert', afterLine: 'end', text: 'B:staged;' }],
    }, toolCtx) as Extract<StagedWrite, { tool: 'edit_scene' }>;
    await stageSceneEdit(undefined, edit, ctx);

    const read = await tool('read_scene').run({ name: 'chapter_02.txt' }, toolCtx) as { text: string };
    expect(read.text).toContain('B:staged;');
    expect(readSceneContent).toHaveBeenCalledTimes(1);
    expect(readSceneContent).toHaveBeenCalledWith('start.txt');
  });

  it('makes character creates, edits, sprite plans, and aliases visible in deterministic order', async () => {
    const draft = makeDraft();
    const diskCharacters = [character('disk-z', '舟', ['船长'])];
    const view = createStagingProjectView(draft, {
      listSceneFiles: async () => [],
      readSceneContent: async () => '',
      listCharacters: async () => diskCharacters,
    });
    const ctx = makeCtx({
      draft,
      characters: diskCharacters,
      getCharacter: (id) => diskCharacters.find((entry) => entry.id === id),
    });
    const toolCtx = { projectPath: '/project', currentSceneName: 'start.txt', projectView: view };

    const create = await tool('create_character').run({
      name: '艾拉',
      aliases: ['小艾'],
      personality: '谨慎',
    }, toolCtx) as Extract<StagedWrite, { tool: 'create_character' }>;
    const created = stageCreateCharacterEdit(create, ctx);

    await expect(tool('list_characters').run({}, toolCtx)).resolves.toEqual({
      characters: [
        { id: 'disk-z', name: '舟' },
        { id: created.draft.id, name: '艾拉' },
      ],
    });
    await expect(tool('get_character').run({ id: '小艾' }, toolCtx)).resolves.toMatchObject({
      id: created.draft.id,
      name: '艾拉',
      personality: '谨慎',
    });

    const edit = (await tool('edit_character').run(
      { id: created.draft.id, partial: { personality: '果断' } },
      toolCtx,
    )) as Extract<StagedWrite, { tool: 'edit_character' }>;
    const edited = stageCharacterEdit(undefined, edit, ctx);
    const plan = (await tool('plan_character_sprites').run({
      character: '小艾',
      sprites: [{ emotion: '开心', prompt: 'smiling' }],
    }, toolCtx)) as Extract<StagedWrite, { tool: 'plan_character_sprites' }>;
    stageCharacterSpritesPlan(edited, plan, ctx);

    await expect(tool('get_character').run({ id: '小艾' }, toolCtx)).resolves.toMatchObject({
      personality: '果断',
      sprites: expect.arrayContaining([expect.objectContaining({ emotion: '开心', prompt: 'smiling' })]),
    });
  });

  it('rejects same-turn character identity conflicts and rejects reads after disposal', () => {
    const draft = makeDraft();
    const view = createStagingProjectView(draft, {
      listSceneFiles: async () => [],
      readSceneContent: async () => '',
      listCharacters: async () => [],
    });
    const ctx = makeCtx({ draft });

    stageCreateCharacterEdit({ tool: 'create_character', draft: { name: '艾拉', aliases: ['小艾'] } }, ctx);
    expect(() => stageCreateCharacterEdit({ tool: 'create_character', draft: { name: '小艾' } }, ctx))
      .toThrow(/身份.*冲突/);

    view.dispose();
    expect(view.disposed).toBe(true);
    expect(() => view.listScenes()).toThrow(/已销毁/);
  });
});
