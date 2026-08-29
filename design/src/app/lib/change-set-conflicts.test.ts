import { describe, expect, it } from 'vitest';
import { detectConflicts, type PendingChangeSet } from './change-set';
import { emptyProjectMemory } from './project-memory';
import { emptyAssetMetadata } from './asset-metadata';
import type { Character } from './character-types';

function makeSceneEdit(file: string, beforeContent: string, afterContent: string) {
  return {
    kind: 'scene',
    file,
    isCurrent: false,
    beforeContent,
    afterContent,
    beforeNodes: [],
    afterNodes: [],
    diff: [],
    summary: '',
    warnings: [],
  } as const;
}

function makeCharacterEdit(id: string, before: Character) {
  return {
    kind: 'character',
    id,
    name: before.name,
    before,
    after: { ...before, description: 'changed' },
    changedFields: ['description'],
  } as const;
}

function makeMemoryEdit(before: ReturnType<typeof emptyProjectMemory>) {
  return {
    kind: 'memory',
    before,
    after: { ...before, worldSetting: 'changed' },
    changedFields: ['worldSetting'],
  } as const;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    currentSceneName: 'start.txt',
    currentScriptSource: 'A:start;',
    readSceneContent: async () => 'A:start;',
    listSceneFiles: async () => [],
    listCharacters: async () => [],
    loadAssetMetadata: async () => emptyAssetMetadata(),
    memory: emptyProjectMemory(),
    ...overrides,
  };
}

const BASE_CHARACTER: Character = {
  id: 'c1',
  name: '小明',
  aliases: [],
  description: 'original',
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

describe('detectConflicts', () => {
  it('returns empty when nothing changed since staging', async () => {
    const set = {
      edits: [makeSceneEdit('other.txt', 'A:other;', 'A:other; B:new;')],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({ readSceneContent: async () => 'A:other;' });
    await expect(detectConflicts(set, ctx)).resolves.toEqual([]);
  });

  it('detects a non-current scene changed since staging', async () => {
    const set = {
      edits: [makeSceneEdit('other.txt', 'A:other;', 'A:other; B:new;')],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({ readSceneContent: async () => 'USER EDITED;' });
    await expect(detectConflicts(set, ctx)).resolves.toEqual(['other.txt']);
  });

  it('detects a scene created by someone else after staging', async () => {
    const set = {
      edits: [{ kind: 'create_scene', file: 'chapter_02.txt' }],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({ listSceneFiles: async () => ['start.txt', 'CHAPTER_02.TXT'] });

    await expect(detectConflicts(set, ctx)).resolves.toEqual(['chapter_02.txt']);
  });

  it('aborts when a non-current scene cannot be read, even with an empty baseline', async () => {
    const set = {
      edits: [makeSceneEdit('other.txt', '', 'B:new;')],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({
      readSceneContent: async () => {
        throw new Error('permission denied');
      },
    });

    await expect(detectConflicts(set, ctx)).rejects.toThrow('permission denied');
  });

  it('detects the current scene edited during preview', async () => {
    const set = {
      edits: [makeSceneEdit('start.txt', 'A:start;', 'A:start; B:new;')],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({ currentScriptSource: 'USER TYPED;' });
    await expect(detectConflicts(set, ctx)).resolves.toEqual(['start.txt']);
  });

  it('does not flag the current scene when it matches before or after content', async () => {
    const set = {
      edits: [makeSceneEdit('start.txt', 'A:start;', 'A:start; B:new;')],
    } as unknown as PendingChangeSet;
    // buffer still equals beforeContent (user made no edits)
    await expect(detectConflicts(set, makeCtx({ currentScriptSource: 'A:start;' }))).resolves.toEqual([]);
    // buffer equals afterContent (preview already reflected)
    await expect(detectConflicts(set, makeCtx({ currentScriptSource: 'A:start; B:new;' }))).resolves.toEqual([]);
  });

  it('detects a character changed since staging', async () => {
    const set = {
      edits: [makeCharacterEdit('c1', BASE_CHARACTER)],
    } as unknown as PendingChangeSet;
    const changed = { ...BASE_CHARACTER, description: 'user edited' };
    const ctx = makeCtx({ listCharacters: async () => [changed] });
    await expect(detectConflicts(set, ctx)).resolves.toEqual(['c1']);
  });

  it('detects a same-name character created after staging', async () => {
    const draft = { ...BASE_CHARACTER, id: 'tmp_ai_1', name: '小明' };
    const set = {
      edits: [{ kind: 'create_character', draft, changedFields: ['name'] }],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({
      listCharacters: async () => [{ ...BASE_CHARACTER, id: 'char_concurrent', name: ' 小明 ' }],
    });

    await expect(detectConflicts(set, ctx)).resolves.toEqual(['character:小明']);
  });

  it('does not flag an unchanged character', async () => {
    const set = {
      edits: [makeCharacterEdit('c1', BASE_CHARACTER)],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({ listCharacters: async () => [BASE_CHARACTER] });
    await expect(detectConflicts(set, ctx)).resolves.toEqual([]);
  });

  it('detects a character deleted after staging', async () => {
    const set = {
      edits: [makeCharacterEdit('c1', BASE_CHARACTER)],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({
      listCharacters: async () => [],
    });

    await expect(detectConflicts(set, ctx)).resolves.toEqual(['c1']);
  });

  it('detects project memory changed since staging', async () => {
    const before = emptyProjectMemory();
    const set = {
      edits: [makeMemoryEdit(before)],
    } as unknown as PendingChangeSet;
    const ctx = makeCtx({ memory: { ...before, worldSetting: 'user edited' } });
    await expect(detectConflicts(set, ctx)).resolves.toEqual(['memory']);
  });

  it('detects asset plans whose id or target stem appeared after staging', async () => {
    const card = (id: string, targetStem: string) => ({
      id,
      category: 'background' as const,
      title: id,
      sceneFile: 'start.txt',
      imageAsset: null,
      targetStem,
      prompt: 'prompt',
      style: '',
      negativePrompt: '',
    });
    const set = {
      edits: [{
        kind: 'asset_plan',
        cards: [card('bg:duplicate.png', 'fresh'), card('bg:fresh.png', 'shared')],
      }],
    } as unknown as PendingChangeSet;
    const metadata = emptyAssetMetadata();
    metadata.sceneCards = {
      'bg:duplicate.png': card('bg:duplicate.png', 'existing'),
      existing: card('existing', 'shared'),
    };
    const ctx = makeCtx({ loadAssetMetadata: async () => metadata });

    await expect(detectConflicts(set, ctx)).resolves.toEqual([
      'asset:bg:duplicate.png',
      'asset:bg:fresh.png',
    ]);
  });
});
