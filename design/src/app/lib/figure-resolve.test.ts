import { describe, expect, it } from 'vitest';
import type { Character } from './character-types';
import type { AssetInfo } from './assets-ipc';
import { resolveSpriteFile, resolveFigureByEmotion } from './figure-resolve';

function asset(name: string): AssetInfo {
  return { name, path: `/p/game/figure/${name}`, category: 'figure', size: 1, extension: 'png' };
}

const SHIZUKA: Character = {
  id: 'char_shizuka',
  name: '静香',
  aliases: ['小静'],
  description: '',
  personality: '',
  stance: '中立',
  keywords: [],
  dialogueStyle: '',
  gender: '女',
  age: '17',
  sprites: [
    { emotion: '默认', file: 'shizuka_default.png' }, // main sprite: explicit file
    { emotion: '生气', file: '' },                      // variant: resolved by prefix
  ],
  relations: [],
  notes: '',
};

describe('resolveSpriteFile', () => {
  it('returns the explicit file for a main sprite', () => {
    expect(resolveSpriteFile(SHIZUKA, SHIZUKA.sprites[0], [])).toBe('shizuka_default.png');
  });

  it('resolves a variant sprite (empty file) by emotion prefix to a qualified path', () => {
    const assets = [asset('char_shizuka/静香_生气_1700000000.png')];
    expect(resolveSpriteFile(SHIZUKA, SHIZUKA.sprites[1], assets)).toBe('char_shizuka/静香_生气_1700000000.png');
  });

  it('picks the newest variant image when several match the prefix', () => {
    const assets = [
      asset('char_shizuka/静香_生气_1700000000.png'),
      asset('char_shizuka/静香_生气_1700000009.png'),
    ];
    expect(resolveSpriteFile(SHIZUKA, SHIZUKA.sprites[1], assets)).toBe('char_shizuka/静香_生气_1700000009.png');
  });

  it('returns empty when a variant has no generated image yet', () => {
    expect(resolveSpriteFile(SHIZUKA, SHIZUKA.sprites[1], [])).toBe('');
  });
});

describe('resolveFigureByEmotion', () => {
  const assets = [asset('char_shizuka/静香_生气_1700000000.png')];

  it('matches a character by name and resolves the emotion file', () => {
    const r = resolveFigureByEmotion([SHIZUKA], '静香', '生气', assets);
    expect(r?.file).toBe('char_shizuka/静香_生气_1700000000.png');
  });

  it('matches a character by id and by alias', () => {
    expect(resolveFigureByEmotion([SHIZUKA], 'char_shizuka', '默认', assets)?.file).toBe('shizuka_default.png');
    expect(resolveFigureByEmotion([SHIZUKA], '小静', '默认', assets)?.file).toBe('shizuka_default.png');
  });

  it('is case-insensitive on emotion', () => {
    expect(resolveFigureByEmotion([SHIZUKA], '静香', '默认', assets)?.file).toBe('shizuka_default.png');
  });

  it('returns null for an unknown character or emotion', () => {
    expect(resolveFigureByEmotion([SHIZUKA], '未知', '生气', assets)).toBeNull();
    expect(resolveFigureByEmotion([SHIZUKA], '静香', '不存在', assets)).toBeNull();
  });

  it('returns null when a variant emotion has no image yet', () => {
    expect(resolveFigureByEmotion([SHIZUKA], '静香', '生气', [])).toBeNull();
  });
});
