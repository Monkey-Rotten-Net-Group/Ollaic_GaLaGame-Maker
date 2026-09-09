import type { Character, CharacterRef } from './character-types';
import type { StagingDraft } from './change-set';

export interface StagingProjectReadAdapter {
  listSceneFiles: () => Promise<string[]>;
  readSceneContent: (file: string) => Promise<string>;
  listCharacters: () => Promise<Character[]>;
}

export interface StagingProjectView {
  readonly disposed: boolean;
  listScenes(): Promise<string[]>;
  readScene(file: string): Promise<string>;
  listCharacters(): Promise<CharacterRef[]>;
  getCharacter(identity: string): Promise<Character>;
  dispose(): void;
}

function identity(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sceneOrder(left: string, right: string): number {
  return identity(left).localeCompare(identity(right)) || left.localeCompare(right);
}

function characterOrder(left: Character, right: Character): number {
  return identity(left.name).localeCompare(identity(right.name))
    || identity(left.id).localeCompare(identity(right.id))
    || left.id.localeCompare(right.id);
}

class PerRunStagingProjectView implements StagingProjectView {
  private isDisposed = false;

  constructor(
    private readonly draft: StagingDraft,
    private readonly adapter: StagingProjectReadAdapter,
  ) {}

  get disposed(): boolean {
    return this.isDisposed;
  }

  private assertActive(): void {
    if (this.isDisposed) throw new Error('本轮暂存项目视图已销毁。');
  }

  listScenes(): Promise<string[]> {
    this.assertActive();
    return this.collectScenes();
  }

  private async collectScenes(): Promise<string[]> {
    const merged = new Map<string, string>();
    for (const file of await this.adapter.listSceneFiles()) merged.set(identity(file), file);
    for (const file of this.draft.sceneFiles.keys()) merged.set(identity(file), file);
    return [...merged.values()].sort(sceneOrder);
  }

  readScene(file: string): Promise<string> {
    this.assertActive();
    const key = identity(file);
    const staged = [...this.draft.sceneFiles.entries()].find(([name]) => identity(name) === key);
    return staged ? Promise.resolve(staged[1]) : this.adapter.readSceneContent(file);
  }

  listCharacters(): Promise<CharacterRef[]> {
    this.assertActive();
    return this.collectCharacters().then((characters) => characters.map(({ id, name }) => ({ id, name })));
  }

  getCharacter(query: string): Promise<Character> {
    this.assertActive();
    return this.resolveCharacter(query);
  }

  private async collectCharacters(): Promise<Character[]> {
    const merged = new Map<string, Character>();
    for (const character of await this.adapter.listCharacters()) merged.set(identity(character.id), character);
    for (const character of this.draft.characters.values()) merged.set(identity(character.id), character);
    return [...merged.values()].sort(characterOrder);
  }

  private async resolveCharacter(query: string): Promise<Character> {
    const needle = identity(query);
    const matches = (await this.collectCharacters()).filter((character) =>
      identity(character.id) === needle
      || identity(character.name) === needle
      || character.aliases.some((alias) => identity(alias) === needle),
    );
    if (matches.length === 0) throw new Error(`找不到角色：${query}`);
    if (matches.length > 1) {
      throw new Error(`角色身份「${query}」存在冲突：${matches.map(({ id, name }) => `${name} (${id})`).join('、')}`);
    }
    return matches[0];
  }

  dispose(): void {
    this.isDisposed = true;
  }
}

export function createStagingProjectView(
  draft: StagingDraft,
  adapter: StagingProjectReadAdapter,
): StagingProjectView {
  return new PerRunStagingProjectView(draft, adapter);
}
