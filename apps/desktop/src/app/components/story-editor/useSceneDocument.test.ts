import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSceneDocument } from './useSceneDocument';

describe('useSceneDocument', () => {
  it('keeps edits and undo history behind the document interface', () => {
    const { result } = renderHook(() => useSceneDocument());

    act(() => result.current.insertNode('narrator', 0));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.dirty).toBe(true);
    expect(result.current.selectedNode?.type).toBe('narrator');

    act(() => result.current.undo());
    expect(result.current.nodes).toEqual([]);
    expect(result.current.selectedNode).toBeNull();
  });
  it('inserts and replaces parsed snippets with unique ids and independent undo steps', () => {
    const { result } = renderHook(() => useSceneDocument());
    const first = {
      id: '1',
      type: 'narrator' as const,
      content: 'Original first',
      flags: [],
      position: { x: 0, y: 0 },
      connections: [],
    };
    const second = { ...first, id: '2', content: 'Original second' };
    act(() => result.current.commitEditedNodes([first, second]));
    act(() => result.current.applySnippet([{ ...first, content: 'Inserted' }], '2'));
    expect(new Set(result.current.nodes.map((node) => node.id)).size).toBe(3);
    const inserted = result.current.nodes[2];
    act(() => result.current.deleteNode(inserted.id));
    expect(result.current.nodes.map((node) => node.content)).toEqual([
      'Original first',
      'Original second',
    ]);
    act(() => result.current.undo());
    expect(result.current.nodes.map((node) => node.content)).toEqual([
      'Original first',
      'Original second',
      'Inserted',
    ]);
    act(() => result.current.undo());
    expect(result.current.nodes).toEqual([first, second]);
    act(() => result.current.applySnippet([{ ...first, content: 'Replacement' }], '2', true));
    expect(result.current.nodes.map((node) => node.content)).toEqual([
      'Original first',
      'Replacement',
    ]);
    expect(new Set(result.current.nodes.map((node) => node.id)).size).toBe(2);
    act(() => result.current.undo());
    expect(result.current.nodes).toEqual([first, second]);
  });
});
