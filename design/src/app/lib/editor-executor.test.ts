import { describe, expect, it } from 'vitest';
import {
  applyEditorPatch,
  applyEditorPatches,
  resolveLineWithAnchor,
} from './editor-executor';
import type { EditorPatch } from './editor-patch';

const SCRIPT = ['line1;', 'line2;', 'line3;', 'line4;'].join('\n');

describe('resolveLineWithAnchor', () => {
  const lines = ['a;', 'b;', 'c;', 'd;'];

  it('returns the line as-is when no anchor is given', () => {
    expect(resolveLineWithAnchor(lines, 2)).toEqual({ line: 2, corrected: false });
  });

  it('does not correct when the anchor already matches', () => {
    expect(resolveLineWithAnchor(lines, 3, 'c;')).toEqual({ line: 3, corrected: false });
  });

  it('corrects a drifted line number using a nearby anchor', () => {
    expect(resolveLineWithAnchor(lines, 2, 'c;')).toEqual({ line: 3, corrected: true });
  });

  it('throws on an out-of-range line without an anchor', () => {
    expect(() => resolveLineWithAnchor(lines, 99)).toThrow();
  });

  it('throws when the anchor matches multiple lines ambiguously', () => {
    expect(() => resolveLineWithAnchor(['x;', 'x;', 'y;'], 1, 'x;')).not.toThrow(); // exact match at 1
    expect(() => resolveLineWithAnchor(['p;', 'x;', 'q;', 'x;'], 9, 'x;')).toThrow();
  });
});

describe('applyEditorPatch', () => {
  it('inserts after a line', () => {
    const patch: EditorPatch = { type: 'insert', file: 'a.txt', afterLine: 2, text: 'NEW;' };
    expect(applyEditorPatch(SCRIPT, patch).content).toBe(['line1;', 'line2;', 'NEW;', 'line3;', 'line4;'].join('\n'));
  });

  it('appends at end', () => {
    const patch: EditorPatch = { type: 'insert', file: 'a.txt', afterLine: 'end', text: 'TAIL;' };
    const applied = applyEditorPatch(SCRIPT, patch);
    expect(applied.content.endsWith('TAIL;')).toBe(true);
    expect(applied.lineDelta).toBe(1);
  });

  it('deletes a range', () => {
    const patch: EditorPatch = { type: 'delete', file: 'a.txt', startLine: 2, endLine: 3 };
    const applied = applyEditorPatch(SCRIPT, patch);
    expect(applied.content).toBe(['line1;', 'line4;'].join('\n'));
    expect(applied.lineDelta).toBe(-2);
  });

  it('replaces a line', () => {
    const patch: EditorPatch = { type: 'replace', file: 'a.txt', startLine: 1, endLine: 1, text: 'R;' };
    expect(applyEditorPatch(SCRIPT, patch).content).toBe(['R;', 'line2;', 'line3;', 'line4;'].join('\n'));
  });
});

describe('applyEditorPatches (multi-patch offset composition)', () => {
  it('keeps later original-based line numbers correct after an earlier insert shifts them', () => {
    // Both patches use line numbers against the ORIGINAL script. The first
    // insert adds a line, so the second delete must be offset to still hit line4.
    const patches: EditorPatch[] = [
      { type: 'insert', file: 'a.txt', afterLine: 1, text: 'INS;' },
      { type: 'delete', file: 'a.txt', startLine: 4, endLine: 4 },
    ];
    const { content } = applyEditorPatches(SCRIPT, patches);
    expect(content).toBe(['line1;', 'INS;', 'line2;', 'line3;'].join('\n'));
  });

  it('counts corrected anchors', () => {
    const patches: EditorPatch[] = [
      { type: 'replace', file: 'a.txt', startLine: 1, endLine: 1, text: 'R;', anchorText: 'line3;' },
    ];
    const { content, correctedAnchors } = applyEditorPatches(SCRIPT, patches);
    expect(correctedAnchors).toBe(1);
    expect(content).toBe(['line1;', 'line2;', 'R;', 'line4;'].join('\n'));
  });
});
