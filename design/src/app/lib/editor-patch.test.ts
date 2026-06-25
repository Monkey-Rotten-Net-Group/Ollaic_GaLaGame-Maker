import { describe, expect, it } from 'vitest';
import {
  extractEditorResponse,
  extractPatchAssetRefs,
  isEditorPatch,
  normalizePatchText,
  validateEditorResponse,
  validatePatchText,
} from './editor-patch';

describe('isEditorPatch', () => {
  it('accepts a well-formed insert patch', () => {
    expect(isEditorPatch({ type: 'insert', file: 'a.txt', afterLine: 3, text: 'x:hi;' })).toBe(true);
    expect(isEditorPatch({ type: 'insert', file: 'a.txt', afterLine: 'end', text: 'x:hi;' })).toBe(true);
  });

  it('accepts delete/replace with valid line ranges', () => {
    expect(isEditorPatch({ type: 'delete', file: 'a.txt', startLine: 1, endLine: 2 })).toBe(true);
    expect(isEditorPatch({ type: 'replace', file: 'a.txt', startLine: 2, endLine: 2, text: 'y;' })).toBe(true);
  });

  it('rejects non-positive / inverted / missing line numbers', () => {
    expect(isEditorPatch({ type: 'delete', file: 'a.txt', startLine: 0, endLine: 1 })).toBe(false);
    expect(isEditorPatch({ type: 'delete', file: 'a.txt', startLine: 3, endLine: 1 })).toBe(false);
    expect(isEditorPatch({ type: 'insert', file: 'a.txt', afterLine: 1 })).toBe(false);
    expect(isEditorPatch({ type: 'insert', file: '', afterLine: 1, text: 'x' })).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(isEditorPatch(null)).toBe(false);
    expect(isEditorPatch('insert')).toBe(false);
    expect(isEditorPatch([{ type: 'insert' }])).toBe(false);
  });
});

describe('validateEditorResponse', () => {
  it('accepts chat and patches responses', () => {
    expect(validateEditorResponse({ type: 'chat', message: 'hi' })).toEqual({ type: 'chat', message: 'hi' });
    const patches = [{ type: 'delete', file: 'a.txt', startLine: 1, endLine: 1 }];
    expect(validateEditorResponse({ patches })).toEqual({ type: 'patches', patches });
  });

  it('rejects a top-level array (regression: isRecord must exclude arrays)', () => {
    expect(validateEditorResponse([{ type: 'chat', message: 'hi' }])).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(validateEditorResponse({ patches: [{ type: 'insert' }] })).toBeNull();
    expect(validateEditorResponse(42)).toBeNull();
  });
});

describe('extractEditorResponse', () => {
  it('parses JSON wrapped in a fenced code block with trailing commas', () => {
    const raw = '```json\n{ "type": "chat", "message": "hello", }\n```';
    expect(extractEditorResponse(raw)).toEqual({ type: 'chat', message: 'hello' });
  });

  it('returns null on unparseable input', () => {
    expect(extractEditorResponse('not json at all')).toBeNull();
  });
});

describe('normalizePatchText', () => {
  it('normalizes CRLF and trims trailing whitespace lines', () => {
    expect(normalizePatchText('a;\r\nb;\r\n')).toBe('a;\nb;');
  });
});

describe('validatePatchText', () => {
  it('accepts narration (leading colon) and dialogue (speaker:text) lines', () => {
    expect(validatePatchText(':一段旁白;')).toEqual([]);
    expect(validatePatchText('角色:你好;')).toEqual([]);
  });

  it('flags a line that is neither narration nor speaker:text', () => {
    expect(validatePatchText('没有冒号的行;')).toHaveLength(1);
  });

  it('rejects command lines prefixed with descriptive labels', () => {
    expect(validatePatchText('背景 changeBg:gray_room_letter.jpg -next;')[0]).toContain('命令前不能加说明文字');
    expect(validatePatchText('立绘 changeFigure:figure_placeholder.png -next;')[0]).toContain('命令前不能加说明文字');
  });

  it('accepts bare WebGAL asset commands', () => {
    expect(validatePatchText('changeBg:room.webp -next;')).toEqual([]);
    expect(validatePatchText('changeFigure:hero.webp -figureCharacter=静香 -figureEmotion=默认 -left -next;')).toEqual([]);
  });
});

describe('extractPatchAssetRefs', () => {
  it('extracts a background reference from changeBg', () => {
    const refs = extractPatchAssetRefs('changeBg:room.png -next;');
    expect(refs).toEqual([{ command: 'changeBg', file: 'room.png', expectedCategory: 'background' }]);
  });
});
