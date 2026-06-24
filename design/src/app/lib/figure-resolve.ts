/**
 * Figure sprite → writable filename resolution.
 *
 * A character立绘 in a script is referenced by a figure file under
 * `game/figure/`. Main sprites store the filename directly in `sprite.file`;
 * variant sprites leave `sprite.file` empty and live in the per-character
 * subdirectory `figure/<characterId>/`, resolved by emotion-prefixed filename.
 *
 * This module centralizes that resolution so both the manual editor
 * (DetailPanel) and the AI staging layer (change-set) map a
 * character + emotion to the exact qualified filename to write into a script.
 */

import type { AssetInfo } from './assets-ipc';
import type { Character, CharacterSprite } from './character-types';

export function sanitizeFilenamePart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

/** Filename prefix variant sprites are generated with: `<角色>_<情绪>_`. */
export function spritePrefix(character: Character, emotion: string): string {
  const characterPart = sanitizeFilenamePart(character.name || character.id, 'character');
  return `${characterPart}_${sanitizeFilenamePart(emotion, 'sprite')}_`;
}

/** The basename of a (possibly subdir-qualified) figure path. */
export function figureFileTail(file: string): string {
  if (!file) return '';
  const slash = file.lastIndexOf('/');
  return slash >= 0 ? file.slice(slash + 1) : file;
}

/**
 * Resolve a sprite to the qualified filename to write into a script, e.g.
 * `<角色ID>/xxx.png` (variant) or the stored `sprite.file` (main/legacy).
 * Returns '' when a variant sprite has no matching generated image yet.
 */
export function resolveSpriteFile(
  character: Character,
  sprite: CharacterSprite,
  assets: AssetInfo[],
): string {
  if (sprite.file) return sprite.file;
  const prefix = spritePrefix(character, sprite.emotion);
  const newest = assets
    .filter((asset) => figureFileTail(asset.name).startsWith(prefix))
    .sort((a, b) => figureFileTail(b.name).localeCompare(figureFileTail(a.name)))[0];
  if (!newest) return '';
  return `${character.id}/${figureFileTail(newest.name)}`;
}

/** Match a character by id, name, or alias (case-insensitive). */
export function findCharacter(characters: Character[], charNameOrId: string): Character | undefined {
  const needle = charNameOrId.trim().toLowerCase();
  if (!needle) return undefined;
  return characters.find((c) => {
    if (c.id.toLowerCase() === needle) return true;
    if ((c.name || '').toLowerCase() === needle) return true;
    return (c.aliases ?? []).some((a) => a.toLowerCase() === needle);
  });
}

/** Match a sprite within a character by emotion name (case-insensitive). */
export function findSprite(character: Character, emotion: string): CharacterSprite | undefined {
  const needle = emotion.trim().toLowerCase();
  if (!needle) return undefined;
  return character.sprites.find((s) => (s.emotion || '').trim().toLowerCase() === needle);
}

export interface ResolvedFigure {
  file: string;
  character: Character;
  sprite: CharacterSprite;
}

/**
 * Resolve a (character, emotion) intent to a concrete figure file.
 * Returns null when the character or the emotion's sprite can't be found, or
 * when a variant sprite has no generated image yet — callers should then leave
 * the script reference untouched so missing-asset validation surfaces it.
 */
export function resolveFigureByEmotion(
  characters: Character[],
  charNameOrId: string,
  emotion: string,
  assets: AssetInfo[],
): ResolvedFigure | null {
  const character = findCharacter(characters, charNameOrId);
  if (!character) return null;
  const sprite = findSprite(character, emotion);
  if (!sprite) return null;
  const file = resolveSpriteFile(character, sprite, assets);
  if (!file) return null;
  return { file, character, sprite };
}
