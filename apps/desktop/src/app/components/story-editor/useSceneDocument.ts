import { useCallback, useEffect, useRef, useState } from 'react';
import { serializeScene } from '../../lib/webgal-ipc';
import type { WebGalCommandType, WebGalNode } from '../../lib/webgal-types';
import { insertSceneNode, pasteSceneNode, reorderSceneNodes } from '../../lib/scene-editing';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function useSceneDocument() {
  const [nodes, setNodes] = useState<WebGalNode[]>([]);
  const nodesRef = useRef<WebGalNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<WebGalNode | null>(null);
  const [scriptSource, setScriptSource] = useState('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [clipboardNode, setClipboardNode] = useState<WebGalNode | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const syncScript = useCallback(async (nextNodes: WebGalNode[]) => {
    try {
      const text = await serializeScene(nextNodes);
      setScriptSource(text);
    } catch {
      // keep stale
    }
  }, []);

  // Mark dirty on any node change
  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveStatus('idle');
  }, []);

  const commitEditedNodes = useCallback((nextNodes: WebGalNode[]) => {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    void syncScript(nextNodes);
    markDirty();
  }, [markDirty, syncScript]);

  // Undo / Redo
  const [history, setHistory] = useState<WebGalNode[][]>([]);
  const [redoHistory, setRedoHistory] = useState<WebGalNode[][]>([]);

  const pushHistory = useCallback((nodesSnapshot: WebGalNode[]) => {
    setHistory(prev => {
      const next = [...prev, nodesSnapshot];
      return next.length > 50 ? next.slice(-50) : next;
    });
    setRedoHistory([]);
  }, []);

  // Debounce timer for merging successive updateNode calls to the same node
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingRecordRef = useRef<WebGalNode[] | null>(null);

  const flushPendingHistory = useCallback((): WebGalNode[] | null => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const pending = pendingRecordRef.current;
    if (!pending) return null;
    pushHistory(pending);
    pendingRecordRef.current = null;
    return pending;
  }, [pushHistory]);

  const undo = useCallback(() => {
    const current = nodesRef.current;
    const pending = flushPendingHistory();
    if (pending) {
      setHistory(prev => prev.slice(0, -1));
      setRedoHistory(prev => [...prev, current].slice(-50));
      commitEditedNodes(pending);
      setSelectedNode(null);
      return;
    }
    const prevNodes = history[history.length - 1];
    if (!prevNodes) return;
    setHistory(prev => prev.slice(0, -1));
    setRedoHistory(prev => [...prev, current].slice(-50));
    commitEditedNodes(prevNodes);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, history]);

  const redo = useCallback(() => {
    if (flushPendingHistory()) return;
    const nextNodes = redoHistory[redoHistory.length - 1];
    if (!nextNodes) return;
    const current = nodesRef.current;
    setRedoHistory(prev => prev.slice(0, -1));
    setHistory(prev => [...prev, current].slice(-50));
    commitEditedNodes(nextNodes);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, redoHistory]);

  // ---------------------------------------------------------------------------
  // Node CRUD
  // ---------------------------------------------------------------------------
  const insertNode = useCallback((type: WebGalCommandType, atIndex: number) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const { nodes: updated, inserted } = insertSceneNode(current, type, atIndex, Date.now().toString());
    commitEditedNodes(updated);
    setSelectedNode(inserted);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const createUnlockNode = useCallback((sourceNode: WebGalNode, atIndex: number) => {
    const asset = (sourceNode.asset || sourceNode.content || '').trim();
    if (!asset || asset === 'none') return;
    const unlockType: WebGalCommandType | null = sourceNode.type === 'changeBg'
      ? 'unlockCg'
      : sourceNode.type === 'bgm'
        ? 'unlockBgm'
        : null;
    if (!unlockType) return;

    const current = nodesRef.current;
    const existing = current[atIndex];
    if (existing?.type === unlockType && (existing.asset || existing.content || '').trim() === asset) {
      setSelectedNode(existing);
      return;
    }

    const displayName = asset.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    flushPendingHistory();
    pushHistory(current);
    const { nodes: insertedNodes, inserted } = insertSceneNode(current, unlockType, atIndex, Date.now().toString());
    const updated = insertedNodes.map((node) => node.id === inserted.id
      ? {
          ...node,
          content: asset,
          asset,
          displayName,
        }
      : node);
    const selected = updated.find((node) => node.id === inserted.id) ?? inserted;
    commitEditedNodes(updated);
    setSelectedNode(selected);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const updateSelectedNode = useCallback((updates: Partial<WebGalNode>) => {
    const current = nodesRef.current;
    const selected = selectedNode;
    if (!selected) return;

    if (!pendingRecordRef.current) {
      pendingRecordRef.current = current;
    }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const pending = pendingRecordRef.current;
      if (pending) pushHistory(pending);
      pendingRecordRef.current = null;
    }, 800);

    let nextSelected: WebGalNode | null = null;
    const updated = current.map((node) => {
      if (node.id !== selected.id) return node;
      nextSelected = { ...node, ...updates };
      return nextSelected;
    });
    if (!nextSelected) return;
    nodesRef.current = updated;
    setNodes(updated);
    setSelectedNode(nextSelected);
    void syncScript(updated);
    markDirty();
  }, [markDirty, pushHistory, selectedNode, syncScript]);

  const deleteSelectedNode = useCallback(() => {
    const selected = selectedNode;
    if (!selected) return;
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = current.filter((node) => node.id !== selected.id);
    commitEditedNodes(updated);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, pushHistory, selectedNode]);

  // ---------------------------------------------------------------------------
  // Per-node operations (for context menu / drag handle)
  // ---------------------------------------------------------------------------
  const deleteNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = current.filter((node) => node.id !== nodeId);
    commitEditedNodes(updated);
    if (selectedNode?.id === nodeId) setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, pushHistory, selectedNode]);

  const copyNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    const target = current.find((node) => node.id === nodeId);
    if (!target) return;
    setClipboardNode({ ...target, id: `${target.id}__copy__${Date.now().toString()}` });
  }, []);

  const cutNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    const target = current.find((node) => node.id === nodeId);
    if (!target) return;
    setClipboardNode({ ...target, id: `${target.id}__cut__${Date.now().toString()}` });
    deleteNode(nodeId);
  }, [deleteNode]);

  const reorderNodes = useCallback((fromIndex: number, toIndex: number) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = reorderSceneNodes(current, fromIndex, toIndex);
    commitEditedNodes(updated);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const pasteNode = useCallback((atIndex: number) => {
    if (!clipboardNode) return;
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = pasteSceneNode(current, clipboardNode, atIndex, Date.now().toString());
    commitEditedNodes(updated);
  }, [clipboardNode, commitEditedNodes, flushPendingHistory, pushHistory]);


  return {
    nodes,
    setNodes,
    nodesRef,
    selectedNode,
    setSelectedNode,
    scriptSource,
    setScriptSource,
    dirty,
    setDirty,
    dirtyRef,
    saveStatus,
    setSaveStatus,
    clipboardNode,
    markDirty,
    pushHistory,
    undo,
    redo,
    commitEditedNodes,
    insertNode,
    createUnlockNode,
    updateSelectedNode,
    deleteSelectedNode,
    deleteNode,
    copyNode,
    cutNode,
    reorderNodes,
    pasteNode,
  };
}
