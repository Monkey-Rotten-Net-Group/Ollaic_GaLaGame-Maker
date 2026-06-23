import type { Character, CharacterRelation, CharacterSprite } from './character-types';

const CHARACTER_COLOR_COUNT = 8;
const CHARACTER_COLORS = Array.from(
  { length: CHARACTER_COLOR_COUNT },
  (_, i) => `var(--color-character-${i + 1})`,
);

export function characterColor(index: number): string {
  return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
}

function newDraftId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `tmp_${crypto.randomUUID()}`
    : `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function createDraftCharacter(index: number, id = newDraftId()): Character {
  return {
    id,
    name: '',
    aliases: [],
    description: '',
    personality: '',
    stance: '',
    keywords: [],
    dialogueStyle: '',
    gender: '',
    age: '',
    sprites: [],
    defaultVoice: undefined,
    voiceTimbre: undefined,
    referenceImages: [],
    relations: [],
    colorTheme: characterColor(index),
    notes: '',
  };
}

export function referenceSpriteIndex(character: Character): number {
  const explicit = character.sprites.findIndex((sprite) => sprite.emotion === '主体参考');
  if (explicit >= 0) return explicit;
  const fallback = character.sprites.findIndex(
    (sprite) => sprite.emotion === '默认' || sprite.emotion === 'default',
  );
  if (fallback >= 0) return fallback;
  return character.sprites.length > 0 ? 0 : -1;
}

export function patchCharacter(
  characters: Character[],
  id: string,
  partial: Partial<Character>,
): Character[] {
  return characters.map((character) =>
    character.id === id ? { ...character, ...partial } : character,
  );
}

export function updateCharacterSprite(
  characters: Character[],
  characterId: string,
  index: number,
  field: keyof CharacterSprite,
  value: string,
): Character[] {
  return characters.map((character) => {
    if (character.id !== characterId) return character;
    const sprites = [...character.sprites];
    sprites[index] = { ...sprites[index], [field]: value };
    return { ...character, sprites };
  });
}

export function appendCharacterSprite(
  characters: Character[],
  characterId: string,
  emotion = '',
  prompt = '',
): Character[] {
  return characters.map((character) =>
    character.id === characterId
      ? { ...character, sprites: [...character.sprites, { emotion, file: '', prompt: prompt || undefined }] }
      : character,
  );
}

export function appendEmotionPreset(
  characters: Character[],
  characterId: string,
  emotion: string,
  prompt = '',
): Character[] {
  const trimmed = emotion.trim();
  if (!trimmed) return characters;
  return characters.map((character) => {
    if (character.id !== characterId) return character;
    if (character.sprites.some((sprite) => sprite.emotion === trimmed)) return character;
    return { ...character, sprites: [...character.sprites, { emotion: trimmed, file: '', prompt: prompt || undefined }] };
  });
}

export function withReferenceSprite(character: Character, filename: string): Character {
  const index = referenceSpriteIndex(character);
  const sprites = [...character.sprites];
  if (index >= 0) {
    sprites[index] = { ...sprites[index], emotion: '主体参考', file: filename };
  } else {
    sprites.unshift({ emotion: '主体参考', file: filename });
  }
  return { ...character, sprites };
}

export function removeCharacterSprite(
  characters: Character[],
  characterId: string,
  index: number,
): Character[] {
  return characters.map((character) =>
    character.id === characterId
      ? { ...character, sprites: character.sprites.filter((_, i) => i !== index) }
      : character,
  );
}

export function updateCharacterRelation(
  characters: Character[],
  characterId: string,
  index: number,
  field: keyof CharacterRelation,
  value: string,
): Character[] {
  return characters.map((character) => {
    if (character.id !== characterId) return character;
    const relations = [...character.relations];
    relations[index] = { ...relations[index], [field]: value };
    return { ...character, relations };
  });
}

export function appendCharacterRelation(characters: Character[], characterId: string): Character[] {
  return characters.map((character) =>
    character.id === characterId
      ? {
          ...character,
          relations: [
            ...character.relations,
            { targetId: '', relationType: '', description: '' },
          ],
        }
      : character,
  );
}

export function removeCharacterRelation(
  characters: Character[],
  characterId: string,
  index: number,
): Character[] {
  return characters.map((character) =>
    character.id === characterId
      ? { ...character, relations: character.relations.filter((_, i) => i !== index) }
      : character,
  );
}
