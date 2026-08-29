import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AppSettingsDialog, loadAppSettings } from './AppSettingsDialog';
import { ProjectMetadataDialog } from './ProjectMetadataDialog';
import { SnapshotManagerDialog } from './SnapshotManagerDialog';
import { SceneManagerPanel } from './SceneManagerPanel';
import type { WebGalNode } from '../lib/webgal-types';
import {
  parseScene, serializeScene, saveScene, loadScene,
  openProject, createScene,
  setRuntimeProject, setRuntimeTemplateDir, getRuntimeUrl, jumpToSentence, openInBrowser,
  readFileText, exportSceneFile, deleteScene, renameScene,
  type ProjectInfo,
} from '../lib/webgal-ipc';
import { listCharacters, listCharacterNames } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import { characterColor } from '../lib/character-editing';
import { useAiAgent } from '../hooks/useAiAgent';
import { listAssets, syncSceneVoiceCards } from '../lib/assets-ipc';
import {
  ensureSceneCard,
  extractSceneBackgroundAssets,
  loadAssetMetadata,
  saveAssetMetadata,
  syncSceneCardsFromBackgrounds,
} from '../lib/asset-metadata';
import { computeFullNodeDiff } from '../lib/node-diff';
import type { SceneEdit } from '../lib/change-set';
import { DetailPanel } from './DetailPanel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { OllaicSideNav, OllaicTopBar } from './OllaicChrome';
import { PerformanceTimeline } from './PerformanceTimeline';
import { AiAssistantPanel } from './story-editor/AiAssistantPanel';
import { FullScreenWorldline, SceneWorldlinePanel } from './story-editor/SceneWorldline';
import { ScriptCommandStream } from './story-editor/ScriptCommandStream';
import { NewSceneDialog } from './story-editor/NewSceneDialog';
import { useSceneDocument } from './story-editor/useSceneDocument';
import { useSceneGraphIndex } from './story-editor/useSceneGraphIndex';
import { useProjectSnapshots } from './story-editor/useProjectSnapshots';
import { useProjectExport } from './story-editor/useProjectExport';
import { createEditorCommitCoordinator } from './story-editor/editor-commit-coordinator';

// Fixed auto-save cadence (ms). Auto-save is toggled on/off from the top-bar
// switch; there is no user-configurable interval.
const AUTO_SAVE_INTERVAL_MS = 3_000;

export function StoryEditor() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedScene = searchParams.get('scene');
  const requestedSceneName = requestedScene || 'start.txt';
  const viewMode = searchParams.get('view'); // 'worldline' = full-screen scene graph

  // Project state
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [currentSceneName, setCurrentSceneName] = useState('start.txt');

  // Editor state
  const {
    nodes, setNodes, nodesRef,
    selectedNode, setSelectedNode,
    scriptSource, setScriptSource,
    dirty, setDirty, dirtyRef,
    saveStatus, setSaveStatus,
    clipboardNode,
    markDirty,
    pushHistory,
    undo, redo,
    insertNode, createUnlockNode, updateSelectedNode,
    deleteSelectedNode, deleteNode, copyNode, cutNode, reorderNodes, pasteNode,
  } = useSceneDocument();
  const {
    headers: sceneHeaders,
    links: sceneLinkMap,
    refresh: refreshSceneGraph,
    updateHeader: handleHeaderUpdated,
    updateCurrentLinks: updateSceneLinks,
  } = useSceneGraphIndex(currentSceneName, nodes);
  const [showScript, setShowScript] = useState(false);
  const [commandSearchQuery, setCommandSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  // AI state
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiUploadsRevision, setAiUploadsRevision] = useState(0);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  // Transient success toast for single-scene export, rendered by React so its
  // dismissal timer is cleaned up on unmount (no stray DOM nodes).
  const [exportToast, setExportToast] = useState<string | null>(null);
  const exportToastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [sceneManagerOpen, setSceneManagerOpen] = useState(false);
  const [newSceneOpen, setNewSceneOpen] = useState(false);
  const [charactersForAi, setCharactersForAi] = useState<Character[]>([]);
  const [characterColors, setCharacterColors] = useState<Record<string, string>>({});


  const loadCharacterColors = useCallback(async (projectPath: string) => {
    try {
      const refs = await listCharacterNames(projectPath);
      const map: Record<string, string> = {};
      refs.forEach((ref, idx) => {
        map[ref.name] = characterColor(idx);
      });
      setCharacterColors(map);
    } catch {
      setCharacterColors({});
    }
  }, []);

  const refreshCharactersForAi = useCallback(async () => {
    if (!projectPath) return;
    try {
      const chars = await listCharacters(projectPath);
      setCharactersForAi(chars);
    } catch {
      setCharactersForAi([]);
    }
    void loadCharacterColors(projectPath);
  }, [loadCharacterColors, projectPath]);


  const chooseInitialScene = useCallback((scenes: string[], requested: string | null): string => {
    if (requested && scenes.includes(requested)) return requested;
    if (scenes.includes('start.txt')) return 'start.txt';
    return scenes[0] ?? 'start.txt';
  }, []);

  const refreshProjectInfo = useCallback(async () => {
    if (!projectPath) return;
    try {
      const info = await openProject(projectPath);
      setProjectInfo(info);
      void refreshSceneGraph(projectPath, info.scenes);
    } catch {}
  }, [projectPath, refreshSceneGraph]);

  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  // Synchronous ownership gate shared by autosave, cached drafts, and the AI
  // commit seam. A ref makes commit-start visible before React can re-render.
  const editorCommitCoordinatorRef = useRef(createEditorCommitCoordinator());
  const editorCommitCoordinator = editorCommitCoordinatorRef.current;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const autoSaveRef = useRef<ReturnType<typeof setInterval>>();
  // Monotonic token guarding async scene loads (switch/open) against out-of-order
  // completion — only the most recent load is allowed to commit to state.
  const sceneLoadTokenRef = useRef(0);

  // Auto-save wiring. The cadence is fixed; users toggle it on/off from the
  // top-bar switch (autoSaveEnabled). There is no separate interval setting.
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);

  useEffect(() => {
    const settings = loadAppSettings();
    if (settings.runtimeTemplateDir) {
      setRuntimeTemplateDir(settings.runtimeTemplateDir).catch((e) => {
        console.warn('[runtime] failed to set template dir from app settings:', e);
      });
    }
  }, []);

  useEffect(() => {
    getRuntimeUrl()
      .then((url) => console.info(`[runtime] preview URL: ${url}`))
      .catch((e) => console.warn('[runtime] URL unavailable:', e));
    (window as unknown as { __jumpTo?: typeof jumpToSentence }).__jumpTo = jumpToSentence;
  }, []);

  useEffect(() => {
    setRuntimeProject(projectPath).catch((e) =>
      console.warn('[runtime] failed to sync project path:', e),
    );
  }, [projectPath]);

  // ---------------------------------------------------------------------------
  // Initialization: try to load project from localStorage or URL params
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      // Try to restore project path from localStorage
      const storedPath = localStorage.getItem(`project-path-${projectId}`);
      const sceneName = requestedSceneName;
      setCurrentSceneName(sceneName);

      if (storedPath) {
        try {
          const info = await openProject(storedPath);
          setProjectPath(storedPath);
          setProjectInfo(info);
          const initialSceneName = chooseInitialScene(info.scenes, requestedScene);
          const sceneCandidates = Array.from(new Set([
            initialSceneName,
            ...info.scenes,
          ])).filter(Boolean);

          let loadedInitialScene = false;
          for (const sceneName of sceneCandidates) {
            try {
              const loaded = await loadScene(storedPath, sceneName);
              setCurrentSceneName(sceneName);
            // Restore sessionStorage draft left by assets-page navigation
            const draftKey = `scene-draft-${projectId}-${sceneName}`;
            const draftJson = sessionStorage.getItem(draftKey);
            if (draftJson) {
              try {
                const draft = JSON.parse(draftJson) as WebGalNode[];
                setNodes(draft);
                const text = await serializeScene(draft);
                setScriptSource(text);
                setDirty(true);
              } catch {
                setNodes(loaded);
                const text = await serializeScene(loaded);
                setScriptSource(text);
              }
              sessionStorage.removeItem(draftKey);
            } else {
              setNodes(loaded);
              const text = await serializeScene(loaded);
              setScriptSource(text);
            }
              loadedInitialScene = true;
              break;
            } catch (e) {
              console.warn(`[project] failed to load scene ${sceneName}:`, e);
            }
          }

          if (!loadedInitialScene) {
            const sceneName = initialSceneName || info.scenes[0] || 'start.txt';
            setCurrentSceneName(sceneName);
            setNodes([]);
            setScriptSource('');
            setDirty(false);
          }
        } catch (e) {
          // Keep the stored path visible so a transient project-load failure does
          // not make the editor forget the project and render a blank workspace.
          console.error('Restore project failed:', e);
          setProjectPath(storedPath);
          setProjectInfo(null);
          setNodes([]);
          setScriptSource('');
          setDirty(false);
        }

        // Load character names for autocomplete
        try {
          const chars = await listCharacters(storedPath);
          setCharactersForAi(chars);
        } catch {
          setCharactersForAi([]);
        }
        void loadCharacterColors(storedPath);

        // Load scene header comments + outgoing scene-jump map for the graph view
        const info = await openProject(storedPath).catch(() => null);
        if (info) {
          void refreshSceneGraph(storedPath, info.scenes);
        }
      } else {
        // No project path yet; keep the editor empty until a project is opened.
        setCurrentSceneName(requestedScene || 'start.txt');
        setNodes([]);
        setScriptSource('');
        setDirty(false);
      }

      setLoading(false);
    };
    init();
  }, [projectId, requestedSceneName]);

  // ---------------------------------------------------------------------------
  // 同步节点到脚本文本
  // ---------------------------------------------------------------------------
  const jumpToNode = useCallback((index: number) => {
    if (!currentSceneName) return;
    void jumpToSentence(currentSceneName, index + 1).catch((e) =>
      console.warn('[runtime] jumpToSentence failed:', e),
    );
  }, [currentSceneName]);

  const syncSceneBackgroundCard = useCallback(async (sceneFile: string, sceneNodes: WebGalNode[]) => {
    if (!projectPath) return;
    try {
      const backgroundAssets = await listAssets(projectPath, 'background');
      const availableBackgrounds = new Set(backgroundAssets.map((asset) => asset.name));
      const backgroundFilenames = extractSceneBackgroundAssets(sceneNodes);
      if (backgroundFilenames.length === 0) return;
      const metadata = await loadAssetMetadata(projectPath, projectId);
      const next = syncSceneCardsFromBackgrounds(
        metadata,
        sceneFile,
        backgroundFilenames,
        availableBackgrounds,
      );
      if (next !== metadata) await saveAssetMetadata(projectPath, next);
    } catch (e) {
      console.warn('[asset] sync scene background card failed:', e);
    }
  }, [projectId, projectPath]);

  // 场景背景卡片同步只在保存时进行（见 handleSave），避免用户逐字输入文件名
  // 时把 t / te / tes 等中间状态都建成卡片。

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async (): Promise<boolean> => {
    const finishSave = editorCommitCoordinator.startSave(currentSceneName);
    if (!finishSave) return false;
    setSaveStatus('saving');
    try {
      let nodesToSave = nodesRef.current.length > 0 ? nodesRef.current : nodes;
      if (showScript) {
        nodesToSave = await parseScene(scriptSource);
        nodesRef.current = nodesToSave;
        setNodes(nodesToSave);
        setSelectedNode(null);
      }
      if (projectPath) {
        // Save to project's game/scene/ directory
        await saveScene(projectPath, currentSceneName, nodesToSave);
        await syncSceneBackgroundCard(currentSceneName, nodesToSave);
      } else {
        // No project open, prompt user to pick a save location.
        const selected = await saveDialog({
          title: '保存场景文件',
          defaultPath: currentSceneName,
          filters: [{ name: 'WebGAL Scene', extensions: ['txt'] }],
        });
        if (!selected) {
          setSaveStatus('idle');
          return false;
        }
        await exportSceneFile(selected, nodesToSave);
      }
      setDirty(false);
      editorCommitCoordinator.deleteDraft(currentSceneName);
      // Refresh header + scene-graph link entry for the saved scene
      if (projectPath) void refreshSceneGraph(projectPath, projectInfo?.scenes ?? [currentSceneName]);
      // Sync voice cards from the dialogue lines
      if (projectPath) {
        syncSceneVoiceCards(projectPath, currentSceneName).catch((e) =>
          console.warn('[voice] sync voice cards failed:', e),
        );
      }
      updateSceneLinks(currentSceneName, nodesToSave);
      setSaveStatus('saved');
      // Reset status after 2s
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      return true;
    } catch (e) {
      console.error('Save failed:', e);
      setSaveStatus('error');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      return false;
    } finally {
      finishSave();
    }
  }, [
    currentSceneName,
    editorCommitCoordinator,
    refreshSceneGraph,
    updateSceneLinks,
    nodes,
    projectInfo?.scenes,
    projectPath,
    scriptSource,
    showScript,
    syncSceneBackgroundCard,
  ]);

  // Guard navigation that would discard unsaved changes (back to home, window close)
  const guardedNavigate = useCallback((action: () => void) => {
    if (dirty) {
      pendingActionRef.current = action;
      setUnsavedConfirmOpen(true);
    } else {
      action();
    }
  }, [dirty]);

  const handleUnsavedSaveAndLeave = useCallback(async () => {
    const action = pendingActionRef.current;
    if (await handleSave()) {
      pendingActionRef.current = null;
      setUnsavedConfirmOpen(false);
      action?.();
    }
  }, [handleSave]);

  const handleUnsavedDiscard = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setDirty(false);
    setUnsavedConfirmOpen(false);
    action?.();
  }, []);

  const handleUnsavedCancel = useCallback(() => {
    setUnsavedConfirmOpen(false);
    pendingActionRef.current = null;
  }, []);

  // Warn on window/tab close when dirty (web fallback)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Intercept Tauri native window close when dirty
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let appWindow: ReturnType<typeof getCurrentWindow>;
    try {
      appWindow = getCurrentWindow();
    } catch {
      return undefined;
    }
    appWindow.onCloseRequested((event) => {
      if (dirtyRef.current) {
        event.preventDefault();
        pendingActionRef.current = () => void appWindow.destroy();
        setUnsavedConfirmOpen(true);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+S / Cmd+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Undo/Redo shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // Clipboard shortcuts (Ctrl+C/X/V)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (e.key === 'c' && selectedNode) {
          e.preventDefault();
          copyNode(selectedNode.id);
        } else if (e.key === 'x' && selectedNode) {
          e.preventDefault();
          cutNode(selectedNode.id);
        } else if (e.key === 'v' && clipboardNode) {
          e.preventDefault();
          const currentIndex = nodes.findIndex((n) => n.id === selectedNode?.id);
          pasteNode(currentIndex >= 0 ? currentIndex : nodes.length);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNode, clipboardNode, nodes, copyNode, cutNode, pasteNode]);

  // Auto-save: periodic save when dirty.
  // Use refs to avoid recreating the interval on every dirty/handleSave change.
  const handleSaveRef = useRef(handleSave);
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  useEffect(() => {
    if (!autoSaveEnabled || !projectPath) return;
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    autoSaveRef.current = setInterval(() => {
      if (dirtyRef.current) {
        handleSaveRef.current();
      }
    }, AUTO_SAVE_INTERVAL_MS);
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [autoSaveEnabled, projectPath]);

  // Clear the export-toast dismissal timer on unmount.
  useEffect(() => () => {
    if (exportToastTimerRef.current) clearTimeout(exportToastTimerRef.current);
  }, []);

  // ---------------------------------------------------------------------------
  // Open project folder
  // ---------------------------------------------------------------------------
  const handleOpenProject = useCallback(async () => {
    const selected = await openDialog({
      title: '选择 WebGAL 项目文件夹',
      directory: true,
    });
    if (!selected) return;

    try {
      const info = await openProject(selected);
      setProjectPath(selected);
      setProjectInfo(info);
      localStorage.setItem(`project-path-${projectId}`, selected);

      // Load start.txt or first available scene
      const sceneName = chooseInitialScene(info.scenes, null);
      const myToken = sceneLoadTokenRef.current + 1;
      sceneLoadTokenRef.current = myToken;
      setCurrentSceneName(sceneName);

      try {
        const loaded = await loadScene(selected, sceneName);
        const text = await serializeScene(loaded);
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes(loaded);
        setScriptSource(text);
        setDirty(false);
      } catch {
        // empty scene
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes([]);
        setScriptSource('');
      }

      // Load character names for autocomplete
      try {
        const chars = await listCharacters(selected);
        setCharactersForAi(chars);
      } catch {
        setCharactersForAi([]);
      }
      void loadCharacterColors(selected);

      void refreshSceneGraph(selected, info.scenes);
    } catch (e) {
      console.error('Open project failed:', e);
    }
  }, [projectId, refreshSceneGraph, chooseInitialScene]);

  // ---------------------------------------------------------------------------
  // Switch scene within project
  // ---------------------------------------------------------------------------
  const handleSwitchScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;

    // Stash current unsaved nodes in the in-memory draft cache. A pending AI
    // preview no longer lives in `nodes`, so `dirty` means real user edits.
    if (dirty) {
      editorCommitCoordinator.cacheDraft(currentSceneName, nodes);
    }

    // Guard against out-of-order async results: a fast A→B→A switch must not
    // let B's (slower) load overwrite A's. Only the latest token may commit.
    const myToken = sceneLoadTokenRef.current + 1;
    sceneLoadTokenRef.current = myToken;
    setCurrentSceneName(sceneName);
    try {
      // Prefer a cached draft over the saved file
      const draft = editorCommitCoordinator.getDraft<WebGalNode[]>(sceneName);
      if (draft) {
        const text = await serializeScene(draft);
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes(draft);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(true);
      } else {
        const loaded = await loadScene(projectPath, sceneName);
        const text = await serializeScene(loaded);
        if (sceneLoadTokenRef.current !== myToken) return;
        setNodes(loaded);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(false);
      }
    } catch {
      if (sceneLoadTokenRef.current !== myToken) return;
      setNodes([]);
      setScriptSource('');
    }
  }, [projectPath, currentSceneName, dirty, editorCommitCoordinator, nodes]);

  // Stable wrapper for child components (SceneGraph) so they can be memoized —
  // the underlying handleSwitchScene closes over `nodes`/`dirty` and changes
  // on every edit, but the click target only needs the latest implementation.
  const handleSwitchSceneRef = useRef(handleSwitchScene);
  handleSwitchSceneRef.current = handleSwitchScene;
  const stableSwitchScene = useCallback((name: string) => {
    void handleSwitchSceneRef.current(name);
  }, []);

  // ---------------------------------------------------------------------------
  // Create new scene
  // ---------------------------------------------------------------------------
  const handleNewScene = useCallback(async () => {
    if (!projectPath) return;
    setNewSceneOpen(true);
  }, [projectPath]);

  const handleCreateScene = useCallback(async (sceneName: string) => {
    if (!projectPath) throw new Error('项目路径不可用');
    const baseName = sceneName.replace(/\.txt$/i, '');
    await createScene(projectPath, baseName);
    const info = await openProject(projectPath);
    setProjectInfo(info);
    try {
      const metadata = await loadAssetMetadata(projectPath, projectId);
      const index = Object.keys(metadata.sceneCards ?? {}).length + 1;
      const next = ensureSceneCard(metadata, sceneName, index);
      if (next !== metadata) await saveAssetMetadata(projectPath, next);
    } catch (error) {
      console.error('Create scene card failed:', error);
    }
    await handleSwitchScene(sceneName);
  }, [handleSwitchScene, projectId, projectPath]);

  const handleDeleteScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;
    const ok = window.confirm(`确定删除场景 "${sceneName}" 吗？此操作不可恢复。`);
    if (!ok) return;
    try {
      await deleteScene(projectPath, sceneName);
      // If deleting the current scene, switch to another
      if (sceneName === currentSceneName) {
        const info = await openProject(projectPath);
        const remaining = info.scenes.filter((s) => s !== sceneName);
        if (remaining.length > 0) {
          await handleSwitchScene(remaining[0]);
        }
      }
      void refreshProjectInfo();
    } catch (e) {
      console.error('Delete scene failed:', e);
      alert(`删除场景失败: ${e}`);
    }
  }, [projectPath, currentSceneName, handleSwitchScene, refreshProjectInfo]);

  const handleRenameScene = useCallback(async (oldName: string) => {
    if (!projectPath) return;
    const newName = prompt(`重命名 "${oldName}" 为:`, oldName.replace(/\.txt$/, ''));
    if (!newName || newName === oldName) return;
    const finalName = newName.endsWith('.txt') ? newName : `${newName}.txt`;
    try {
      await renameScene(projectPath, oldName, finalName);
      void refreshProjectInfo();
      if (oldName === currentSceneName) {
        setCurrentSceneName(finalName);
      }
    } catch (e) {
      console.error('Rename scene failed:', e);
      alert(`重命名场景失败: ${e}`);
    }
  }, [projectPath, currentSceneName, refreshProjectInfo]);

  // ---------------------------------------------------------------------------
  // Import / Export / Apply script
  // ---------------------------------------------------------------------------
  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      setScriptSource(text);
      const parsed = await parseScene(text);
      setNodes(parsed);
      setSelectedNode(null);
      markDirty();
    };
    input.click();
  }, [markDirty]);

  const handleExport = useCallback(async () => {
    try {
      console.log('开始导出场景:', currentSceneName, '节点数:', nodes.length);

      // Ensure filename has .txt extension
      const filename = currentSceneName.endsWith('.txt') ? currentSceneName : `${currentSceneName}.txt`;

      // Let user choose where to save
      const savePath = await saveDialog({
        title: '导出场景',
        defaultPath: filename,
        filters: [{
          name: 'WebGAL 场景文件',
          extensions: ['txt']
        }]
      });

      if (!savePath) {
        console.log('用户取消了导出');
        return;
      }

      console.log('用户选择保存到:', savePath);

      const text = await serializeScene(nodes);
      console.log('序列化完成，文本长度:', text.length);

      // Write to file using Tauri
      await exportSceneFile(savePath, nodes);

      console.log('导出成功:', savePath);

      // Show success notification (React-rendered; timer cleared on unmount).
      setExportToast(`✓ 已导出: ${filename}`);
      if (exportToastTimerRef.current) clearTimeout(exportToastTimerRef.current);
      exportToastTimerRef.current = setTimeout(() => setExportToast(null), 3000);
    } catch (e) {
      console.error('导出场景失败:', e);
      alert(`导出场景失败: ${e}`);
    }
  }, [nodes, currentSceneName]);

  // Handle node selection from scene index with auto-scroll to the node
  const handleSelectNodeWithScroll = useCallback((node: WebGalNode) => {
    setSelectedNode(node);

    // Scroll to the corresponding node in the command stream
    // Use a small delay to ensure the selection state is updated first
    setTimeout(() => {
      const cardElement = document.querySelector(`[data-node-id="${node.id}"]`);
      if (cardElement) {
        cardElement.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
    }, 50);
  }, []);

  const handleApplyScript = useCallback(async () => {
    const parsed = await parseScene(scriptSource);
    setNodes(parsed);
    setSelectedNode(null);
    setShowScript(false);
    markDirty();
  }, [scriptSource, markDirty]);

  const projectName = projectInfo?.config.Game_name || projectPath?.split('/').pop() || '未命名项目';

  const reloadAfterSnapshot = useCallback(async () => {
    if (!projectPath) return;
    const info = await openProject(projectPath);
    setProjectInfo(info);
    await refreshSceneGraph(projectPath, info.scenes);
    const restoredSceneName = info.scenes.includes(currentSceneName)
      ? currentSceneName
      : (info.scenes[0] ?? 'start.txt');
    setCurrentSceneName(restoredSceneName);
    const loaded = await loadScene(projectPath, restoredSceneName);
    setNodes(loaded);
    setScriptSource(await serializeScene(loaded));
    editorCommitCoordinator.clearDrafts();
    setDirty(false);
    setSelectedNode(null);
    setAiUploadsRevision((revision) => revision + 1);
    await refreshCharactersForAi();
  }, [
    currentSceneName,
    editorCommitCoordinator,
    projectPath,
    refreshCharactersForAi,
    refreshSceneGraph,
    setDirty,
    setNodes,
    setScriptSource,
    setSelectedNode,
  ]);

  const ensureSaved = useCallback(
    async () => !dirty || handleSave(),
    [dirty, handleSave],
  );

  const {
    open: projectMetadataOpen,
    setOpen: setProjectMetadataOpen,
    metadata: projectMetadata,
    saving: metadataSaving,
    task: exportTask,
    saveMetadata: handleSaveProjectMetadata,
    exportWithMetadata: handleExportProjectWithMetadata,
    retry: handleRetryExportProject,
    openDialog: handleExportProject,
  } = useProjectExport({ projectPath, ensureSaved });

  const {
    open: snapshotManagerOpen,
    setOpen: setSnapshotManagerOpen,
    snapshots,
    busy: snapshotBusy,
    error: snapshotError,
    status: snapshotStatus,
    refresh: refreshSnapshots,
    openManager: handleOpenSnapshotManager,
    create: handleCreateSnapshot,
    restore: handleRestoreSnapshot,
    rename: handleRenameSnapshot,
    remove: handleDeleteSnapshot,
    createExportCandidate: handleCreateExportCandidateSnapshot,
  } = useProjectSnapshots({
    projectPath,
    ensureSaved,
    onRestored: reloadAfterSnapshot,
  });
  const handleOpenRuntime = useCallback(async () => {
    try {
      const url = await getRuntimeUrl();
      await openInBrowser(url);
    } catch (e) {
      console.warn('[runtime] failed to open browser:', e);
      alert(`无法打开预览窗口: ${e}`);
    }
  }, []);

  useEffect(() => {
    const action = searchParams.get('action');
    if (!action || loading || !projectPath) return;

    if (action === 'preview') {
      void handleOpenRuntime();
    } else if (action === 'export') {
      handleExportProject();
    } else {
      return;
    }

    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [
    handleExportProject,
    handleOpenRuntime,
    loading,
    projectPath,
    searchParams,
    setSearchParams,
  ]);

  const readCachedSceneDraft = useCallback(async (sceneFile: string) => {
    const draft = editorCommitCoordinator.getDraft<WebGalNode[]>(sceneFile);
    return draft ? serializeScene(draft) : undefined;
  }, [editorCommitCoordinator]);

  const reconcileCurrentAiScene = useCallback((edit: SceneEdit) => {
    pushHistory(nodesRef.current);
    nodesRef.current = edit.afterNodes;
    dirtyRef.current = false;
    setNodes(edit.afterNodes);
    setScriptSource(edit.afterContent);
    setSelectedNode(null);
    setDirty(false);
    setSaveStatus('saved');
    editorCommitCoordinator.deleteDraft(edit.file);
  }, [
    dirtyRef,
    editorCommitCoordinator,
    nodesRef,
    pushHistory,
    setDirty,
    setNodes,
    setSaveStatus,
    setScriptSource,
    setSelectedNode,
  ]);

  const aiAgent = useAiAgent({
    projectId,
    projectPath,
    uploadsRevision: aiUploadsRevision,
    currentSceneName,
    sceneHeaders,
    nodes,
    selectedNode,
    scriptSource,
    dirty,
    characters: charactersForAi,
    setNodes,
    setScriptSource,
    setDirty,
    setSaveStatus,
    setSelectedNode,
    setShowScript,
    pushHistory,
    onCommitStart: (sceneFiles) => editorCommitCoordinator.beginCommit(sceneFiles),
    onCommitSettled: () => editorCommitCoordinator.settleCommit(),
    readSceneDraft: readCachedSceneDraft,
    reconcileCurrentScene: reconcileCurrentAiScene,
    onScenesChanged: async () => {
      if (!projectPath) return;
      const info = await openProject(projectPath);
      setProjectInfo(info);
      // Refresh the relationship graph for AI edits that touch other scenes'
      // jump/choose nodes.
      void refreshSceneGraph(projectPath, info.scenes);
    },
    onCharactersChanged: refreshCharactersForAi,
  });

  // While an AI change set is pending, if it edits the currently-open scene,
  // render the canvas as a read-only node diff (green added / red deleted /
  // yellow modified) instead of the editable list.
  const aiPreviewEntries = useMemo(() => {
    const set = aiAgent.pendingChangeSet;
    if (!set || set.status !== 'pending') return undefined;
    const sceneEdit = set.edits.find(
      (e): e is SceneEdit => e.kind === 'scene' && e.file === currentSceneName,
    );
    if (!sceneEdit) return undefined;
    return computeFullNodeDiff(sceneEdit.beforeNodes, sceneEdit.afterNodes);
  }, [aiAgent.pendingChangeSet, currentSceneName]);

  const handleAiSend = useCallback((text: string) => { void aiAgent.sendPrompt(text); }, [aiAgent.sendPrompt]);
  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const gameName = projectInfo?.config?.Game_name || `项目 ${projectId ?? ''}`;

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="h-full story-shell">
        {exportToast && (
          <div
            role="status"
            className="fixed top-20 right-5 z-[9999] rounded-lg px-5 py-3 text-sm text-white shadow-lg"
            style={{ background: 'rgba(34, 197, 94, 0.9)' }}
          >
            {exportToast}
          </div>
        )}
        <OllaicTopBar
          onUndo={undo}
          onRedo={redo}
          onRun={handleOpenRuntime}
          onPublish={handleExportProject}
          onSave={handleSave}
          onImport={() => guardedNavigate(handleImport)}
          onExport={handleExport}
          onOpenProject={() => guardedNavigate(handleOpenProject)}
          onSnapshots={handleOpenSnapshotManager}
          onToggleScript={() => setShowScript(!showScript)}
          scriptMode={showScript}
          onSearchChange={setCommandSearchQuery}
          searchValue={commandSearchQuery}
          searchPlaceholder="搜索指令 / 角色 / 内容..."
          saveStatus={saveStatus}
          autoSave={autoSaveEnabled}
          onAutoSaveChange={setAutoSaveEnabled}
          onSettings={() => setAppSettingsOpen(true)}
        />
        <OllaicSideNav
          active={viewMode === 'worldline' ? 'world' : 'script'}
          projectId={projectId}
          projectLabel={gameName}
          onCreate={handleNewScene}
          onBeforeNavigate={guardedNavigate}
        />

        <div className="ollaic-workspace flex flex-col">
        {viewMode === 'worldline' ? (
          <FullScreenWorldline
            scenes={projectInfo?.scenes ?? [currentSceneName]}
            currentSceneName={currentSceneName}
            sceneHeaders={sceneHeaders}
            sceneLinkMap={sceneLinkMap}
            nodes={nodes}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onOpenScene={stableSwitchScene}
            onClose={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('view');
              setSearchParams(next, { replace: true });
            }}
            characterColors={characterColors}
            onNewScene={handleNewScene}
            onDeleteScene={handleDeleteScene}
            onRenameScene={handleRenameScene}
            onOpenSceneManager={() => setSceneManagerOpen(true)}
            onDeleteNode={deleteNode}
            onJumpToIndex={jumpToNode}
          />
        ) : (
          <>
        {/* Main Content */}
        <div className="relative flex-1 flex overflow-hidden">
          <SceneWorldlinePanel
            scenes={projectInfo?.scenes ?? [currentSceneName]}
            currentSceneName={currentSceneName}
            sceneHeaders={sceneHeaders}
            sceneLinkMap={sceneLinkMap}
            nodes={nodes}
            selectedNode={selectedNode}
            onSelectNode={handleSelectNodeWithScroll}
            onOpenScene={stableSwitchScene}
            onOpenSceneManager={() => setSceneManagerOpen(true)}
            characterColors={characterColors}
            onDeleteNode={deleteNode}
            onJumpToIndex={jumpToNode}
          />

          {/* Center - Script Command Stream / Script Source */}
          {showScript ? (
            <div className="flex-1 flex flex-col bg-background/50">
              <div className="p-3 border-b border-border flex items-center justify-between">
                <span className="text-sm text-muted-foreground font-mono-family">
                  WebGAL 脚本编辑器 - {currentSceneName}
                </span>
                <button
                  onClick={handleApplyScript}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all text-sm"
                >
                  应用更改
                </button>
              </div>
              <textarea
                value={scriptSource}
                onChange={(e) => {
                  setScriptSource(e.target.value);
                  markDirty();
                }}
                className="flex-1 p-4 bg-transparent resize-none focus:outline-none text-sm leading-relaxed font-mono-family"
                spellCheck={false}
                aria-label="WebGAL 脚本编辑器"
              />
            </div>
          ) : (
            <ScriptCommandStream
              nodes={nodes}
              selectedNode={selectedNode}
              currentSceneName={currentSceneName}
              sceneHeaders={sceneHeaders}
              onSelectNode={setSelectedNode}
              onInsertNode={insertNode}
              onDeleteNode={deleteNode}
              onCopyNode={copyNode}
              onCutNode={cutNode}
              onPasteNode={pasteNode}
              onReorderNodes={reorderNodes}
              onJumpToIndex={jumpToNode}
              onCreateUnlockNode={createUnlockNode}
              clipboardNode={clipboardNode}
              characterColors={characterColors}
              characters={charactersForAi}
              searchQuery={commandSearchQuery}
              previewEntries={aiPreviewEntries}
              projectPath={projectPath ?? undefined}
            />
          )}

          <AiAssistantPanel
            aiAgent={aiAgent}
            projectPath={projectPath}
            sceneHeaders={sceneHeaders}
            onOpenSettings={() => setAiSettingsOpen(true)}
            onSend={handleAiSend}
          />

          {selectedNode && !showScript && (
            <div className="absolute bottom-0 right-80 top-0 z-30 w-80 border-l border-border bg-surface-container-lowest shadow-[-8px_0_24px_var(--shadow-soft)]">
              <DetailPanel
                node={selectedNode}
                onUpdateNode={updateSelectedNode}
                onDeleteNode={deleteSelectedNode}
                onClose={() => setSelectedNode(null)}
                characterNames={charactersForAi.map((character) => character.name)}
                projectPath={projectPath ?? undefined}
                characters={charactersForAi}
                projectId={projectId}
                scenes={projectInfo?.scenes ?? []}
                sceneHeaders={sceneHeaders}
              />
            </div>
          )}
        </div>

          <PerformanceTimeline
            nodes={nodes}
            selectedNodeId={selectedNode?.id}
            onSelectNode={(id) => {
              const found = nodes.find((node) => node.id === id);
              if (found) setSelectedNode(found);
            }}
          />
          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-outline-variant bg-surface-container px-4 text-[10px] text-on-surface-variant/40">
            <div className="flex items-center gap-4">
              <span>{scriptSource.length.toLocaleString()} 字</span>
              <span>约 {Math.max(1, Math.ceil(scriptSource.length / 380))} 分钟阅读量</span>
              <span className="h-3 w-px bg-outline-variant/30" />
              <span>UTF-8 | LF | Engine: WebGAL</span>
            </div>
          </footer>
          </>
        )}
        </div>

        <AiSettingsDialog
          open={aiSettingsOpen}
          onClose={() => setAiSettingsOpen(false)}
        />

        <ProjectMetadataDialog
          open={projectMetadataOpen}
          projectName={projectName}
          initialMetadata={projectMetadata}
          saving={metadataSaving}
          exportTask={exportTask}
          onClose={() => setProjectMetadataOpen(false)}
          onSave={handleSaveProjectMetadata}
          onExport={handleExportProjectWithMetadata}
          onRetryExport={handleRetryExportProject}
        />

        <SnapshotManagerDialog
          open={snapshotManagerOpen}
          snapshots={snapshots}
          busy={snapshotBusy}
          error={snapshotError}
          status={snapshotStatus}
          onClose={() => setSnapshotManagerOpen(false)}
          onRefresh={refreshSnapshots}
          onCreate={handleCreateSnapshot}
          onCreateExportCandidate={handleCreateExportCandidateSnapshot}
          onRestore={handleRestoreSnapshot}
          onRename={handleRenameSnapshot}
          onDelete={handleDeleteSnapshot}
        />

        <SceneManagerPanel
          open={sceneManagerOpen}
          onClose={() => setSceneManagerOpen(false)}
          projectPath={projectPath ?? ''}
          projectInfo={projectInfo}
          currentSceneName={currentSceneName}
          sceneHeaders={sceneHeaders}
          onSwitchScene={stableSwitchScene}
          onHeaderUpdated={handleHeaderUpdated}
          onRefreshProject={refreshProjectInfo}
          onNewScene={handleNewScene}
          onDeleteScene={handleDeleteScene}
        />

        <NewSceneDialog
          open={newSceneOpen}
          existingScenes={projectInfo?.scenes ?? []}
          onOpenChange={setNewSceneOpen}
          onCreate={handleCreateScene}
        />
        <AppSettingsDialog
          open={appSettingsOpen}
          onClose={() => setAppSettingsOpen(false)}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
          onApplyRuntimeTemplateDir={(dir) => setRuntimeTemplateDir(dir)}
        />

        <AlertDialog open={unsavedConfirmOpen} onOpenChange={(open) => { if (!open) handleUnsavedCancel(); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>有未保存的更改</AlertDialogTitle>
              <AlertDialogDescription>
                当前场景有未保存的内容，离开后将会丢失。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleUnsavedCancel}>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { void handleUnsavedSaveAndLeave(); }}
                className="bg-primary text-primary-foreground"
              >
                保存并离开
              </AlertDialogAction>
              <AlertDialogAction
                onClick={handleUnsavedDiscard}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                直接离开
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

      </div>
    </DndProvider>
  );
}
