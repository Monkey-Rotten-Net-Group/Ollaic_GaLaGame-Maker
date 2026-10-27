import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { Bot, FileText, FolderOpen, GitBranch, Loader2, PanelRightClose, PanelRightOpen, Play, X } from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AppSettingsDialog, loadAppSettings } from './AppSettingsDialog';
import { ProjectMetadataDialog } from './ProjectMetadataDialog';
import { SnapshotManagerDialog } from './SnapshotManagerDialog';
import { SceneManagerPanel } from './SceneManagerPanel';
import type { WebGalNode } from '../lib/webgal-types';
import {
  parseScene, serializeScene, saveScene, loadScene, sceneDisplayName,
  openProject, getScenePath, createScene,
  setRuntimeTemplateDir,
  writeFileText, deleteScene, renameScene,
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
import { OllaicTopBar } from './OllaicChrome';
import { FlowBoardView } from './FlowBoard';
import { useFlowRunController } from '../hooks/useFlowRunController';
import { useRuntimePreview } from '../hooks/useRuntimePreview';
import { RuntimePreviewPanel, type PreviewLayout } from './story-editor/RuntimePreviewPanel';
import { AiAssistantPanel } from './story-editor/AiAssistantPanel';
import { FullScreenWorldline } from './story-editor/SceneWorldline';
import { ScriptCommandStream } from './story-editor/ScriptCommandStream';
import { NewSceneDialog } from './story-editor/NewSceneDialog';
import { useSceneDocument } from './story-editor/useSceneDocument';
import { useSceneGraphIndex } from './story-editor/useSceneGraphIndex';
import { useProjectSnapshots } from './story-editor/useProjectSnapshots';
import { useProjectExport } from './story-editor/useProjectExport';
import { getProjectEditorCommitCoordinator } from './story-editor/editor-commit-coordinator';

// Fixed auto-save cadence (ms). Auto-save is toggled on/off from the top-bar
// switch; there is no user-configurable interval.
const AUTO_SAVE_INTERVAL_MS = 3_000;

export function StoryEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedScene = searchParams.get('scene');
  const requestedSceneName = requestedScene || 'start.txt';
  const viewMode = searchParams.get('view');
  const agentMode = searchParams.get('agent') === 'workflow' ? 'workflow' : 'edit';
  const [agentOpen, setAgentOpen] = useState(true);
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout>('hidden');
  const [preferredDockLayout, setPreferredDockLayout] = useState<'split' | 'float'>('split');
  const [previewStarted, setPreviewStarted] = useState(false);
  const changePreviewLayout = useCallback((layout: PreviewLayout) => {
    setPreviewLayout(layout);
    if (layout === 'split' || layout === 'float') {
      setPreferredDockLayout(layout);
    }
    if (layout !== 'hidden') setPreviewStarted(true);
  }, []);

  const DEFAULT_BOTTOM_DOCK_HEIGHT = 350;
  const DOCK_HEIGHT_STORAGE_KEY = 'ollaic_webgal_preview_dock_height';
  const [bottomDockHeight, setBottomDockHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_BOTTOM_DOCK_HEIGHT;
    try {
      const raw = localStorage.getItem(DOCK_HEIGHT_STORAGE_KEY);
      if (raw) {
        const parsed = Number(raw);
        // Layout caps the displayed height; larger saved sizes remain valid on tall windows.
        if (Number.isFinite(parsed) && parsed >= 180) return parsed;
      }
    } catch {}
    return DEFAULT_BOTTOM_DOCK_HEIGHT;
  });
  const [isResizingDock, setIsResizingDock] = useState(false);
  const [dockDragMoved, setDockDragMoved] = useState(false);
  const dockResizeRef = useRef<{ startY: number; startHeight: number; maxHeight: number } | null>(null);

  const handleDockResizeStart = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const stage = event.currentTarget.parentElement;
    const panel = stage?.querySelector<HTMLElement>(':scope > .editor-preview-pane');
    if (!stage || !panel) return;
    const panelStyle = window.getComputedStyle(panel);
    const cssMaxHeight = Number.parseFloat(panelStyle.maxHeight);
    const stageHeight = stage.clientHeight;
    const maxHeight = Number.isFinite(cssMaxHeight)
      ? (panelStyle.maxHeight.endsWith('%') ? stageHeight * cssMaxHeight / 100 : cssMaxHeight)
      : stageHeight;
    event.preventDefault();
    setIsResizingDock(true);
    setDockDragMoved(false);
    dockResizeRef.current = {
      startY: event.clientY,
      startHeight: panel.getBoundingClientRect().height,
      // Use the same bounds as the rendered panel, including CSS's minimum winning over its maximum.
      maxHeight: Math.max(180, maxHeight),
    };
  };

  useEffect(() => {
    if (!isResizingDock) return;
    let latestHeight = bottomDockHeight;
    let moved = dockDragMoved;
    const finishResize = () => {
      if (!dockResizeRef.current) return;
      dockResizeRef.current = null;
      setIsResizingDock(false);
      setDockDragMoved(false);
      if (moved) {
        try {
          localStorage.setItem(DOCK_HEIGHT_STORAGE_KEY, String(latestHeight));
        } catch {}
      }
    };
    const handleMouseMove = (event: MouseEvent) => {
      if ((event.buttons & 1) === 0) {
        finishResize();
        return;
      }
      if (!dockResizeRef.current) return;
      const dy = event.clientY - dockResizeRef.current.startY;
      // Arm the drag on press, but keep clicks available until the pointer moves.
      if (!moved && Math.abs(dy) < 3) return;
      moved = true;
      setDockDragMoved(true);
      const nextHeight = Math.max(180, Math.min(dockResizeRef.current.maxHeight, dockResizeRef.current.startHeight - dy));
      latestHeight = nextHeight;
      setBottomDockHeight(nextHeight);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', finishResize);
    window.addEventListener('blur', finishResize);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', finishResize);
      window.removeEventListener('blur', finishResize);
    };
  }, [isResizingDock, bottomDockHeight, dockDragMoved]);
  const setAgentMode = (mode: 'workflow' | 'edit') => {
    const next = new URLSearchParams(searchParams);
    next.set('agent', mode);
    setSearchParams(next, { replace: true });
  };
  const toggleSceneGraph = () => {
    const next = new URLSearchParams(searchParams);
    if (viewMode === 'worldline') next.delete('view');
    else { next.set('view', 'worldline'); changePreviewLayout('hidden'); }
    setSearchParams(next, { replace: true });
  };

  // Project state
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const flow = useFlowRunController(projectPath ?? '');
  const [workflowPreparing, setWorkflowPreparing] = useState(false);
  const [workflowRefreshing, setWorkflowRefreshing] = useState(false);
  const [workflowSyncRequired, setWorkflowSyncRequired] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const workflowOwnsProject = workflowSyncRequired || flow.loading || flow.busy || workflowPreparing || workflowRefreshing
    || flow.state.runStatus === 'running' || flow.state.runStatus === 'paused';
  const workflowOwnsProjectRef = useRef(workflowOwnsProject);
  workflowOwnsProjectRef.current = workflowOwnsProject;
  const editAgentBusyRef = useRef(false);
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
  const [scriptMode, setScriptMode] = useState<'compact' | 'stream' | 'script'>('compact');
  const showScript = scriptMode === 'script';
  const setShowScript = useCallback((show: boolean) => {
    setScriptMode((prev) => (show ? 'script' : prev === 'script' ? 'compact' : prev));
  }, []);
  const [commandSearchQuery, setCommandSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const runtimePreview = useRuntimePreview(projectPath, scriptSource, previewStarted);

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
  // commit path. Ownership must also survive leaving and reopening this page.
  const editorCommitCoordinator = getProjectEditorCommitCoordinator(projectId ?? projectPath ?? 'demo');

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
            const scenePath = await getScenePath(storedPath, sceneName);
            try {
              await editorCommitCoordinator.waitForCommit(sceneName);
              const loaded = await loadScene(scenePath);
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
          setProjectInfo(info);
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
  }, [projectId, requestedSceneName, requestedScene, chooseInitialScene, editorCommitCoordinator, loadCharacterColors, refreshSceneGraph, setDirty, setNodes, setScriptSource]);

  // ---------------------------------------------------------------------------
  // 同步节点到脚本文本
  // ---------------------------------------------------------------------------
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
  const handleSave = useCallback(async (forWorkflow = false): Promise<boolean> => {
    if (loading) return false;
    if (workflowOwnsProjectRef.current && !forWorkflow) return false;
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
        const scenePath = await getScenePath(projectPath, currentSceneName);
        await saveScene(scenePath, nodesToSave);
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
        await saveScene(selected, nodesToSave);
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
    loading,
    refreshSceneGraph,
    updateSceneLinks,
    nodes,
    projectInfo?.scenes,
    projectPath,
    scriptSource,
    showScript,
    syncSceneBackgroundCard, nodesRef, setDirty, setNodes, setSaveStatus, setSelectedNode,
  ]);

  const jumpToNode = useCallback(async (index: number) => {
    if (dirtyRef.current && !await handleSave()) return;
    setPreviewLayout((prev) => (prev === 'hidden' ? preferredDockLayout : prev));
    setPreviewStarted(true);
    runtimePreview.jump(currentSceneName, index + 1);
  }, [dirtyRef, handleSave, preferredDockLayout, runtimePreview, currentSceneName]);

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
  }, [setDirty]);

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
      if (workflowOwnsProjectRef.current) return;
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
      if (workflowOwnsProjectRef.current) return;
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
  }, [autoSaveEnabled, projectPath, dirtyRef]);

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

      const scenePath = await getScenePath(selected, sceneName);
      try {
        await editorCommitCoordinator.waitForCommit(sceneName);
        const loaded = await loadScene(scenePath);
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
  }, [projectId, editorCommitCoordinator, refreshSceneGraph, chooseInitialScene, loadCharacterColors, setDirty, setNodes, setScriptSource]);

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
    const scenePath = await getScenePath(projectPath, sceneName);
    try {
      await editorCommitCoordinator.waitForCommit(sceneName);
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
        const loaded = await loadScene(scenePath);
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
  }, [projectPath, currentSceneName, dirty, editorCommitCoordinator, nodes, setDirty, setNodes, setScriptSource, setSelectedNode]);

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
      const path = await getScenePath(projectPath, sceneName);
      await deleteScene(path);
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
      const path = await getScenePath(projectPath, oldName);
      await renameScene(path, finalName);
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
  }, [markDirty, setNodes, setScriptSource, setSelectedNode]);

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
      await writeFileText(savePath, text);

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
  const handleApplyScript = useCallback(async () => {
    const parsed = await parseScene(scriptSource);
    setNodes(parsed);
    setSelectedNode(null);
    setShowScript(false);
    markDirty();
  }, [scriptSource, markDirty, setNodes, setSelectedNode]);

  const projectName = projectInfo?.config.Game_name || projectPath?.split('/').pop() || '未命名项目';

  const reloadAfterSnapshot = useCallback(async () => {
    if (!projectPath) return;
    const token = ++sceneLoadTokenRef.current;
    const info = await openProject(projectPath);
    const restoredSceneName = info.scenes.includes(currentSceneName)
      ? currentSceneName : (info.scenes[0] ?? 'start.txt');
    const scenePath = await getScenePath(projectPath, restoredSceneName);
    const loaded = await loadScene(scenePath);
    const source = await serializeScene(loaded);
    if (sceneLoadTokenRef.current !== token) return;
    setProjectInfo(info);
    setCurrentSceneName(restoredSceneName);
    nodesRef.current = loaded;
    setNodes(loaded);
    setScriptSource(source);
    editorCommitCoordinator.clearDrafts();
    setDirty(false);
    setSelectedNode(null);
    setAiUploadsRevision((revision) => revision + 1);
    await Promise.all([refreshSceneGraph(projectPath, info.scenes), refreshCharactersForAi()]);
  }, [currentSceneName, editorCommitCoordinator, projectPath, refreshCharactersForAi,
    refreshSceneGraph, setDirty, setNodes, setScriptSource, setSelectedNode, nodesRef]);

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
  const handleOpenRuntime = useCallback(() => changePreviewLayout('large'), [changePreviewLayout]);

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
    documentReady: !loading,
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
    onCommitSettled: (applied, sceneFiles) => {
      if (applied) sceneFiles.forEach((scene) => {
        try { sessionStorage.removeItem(`scene-draft-${projectId}-${scene}`); } catch {}
      });
      editorCommitCoordinator.settleCommit(applied);
    },
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

  const editingAgentBlocked = aiAgent.busy || aiAgent.committing || aiAgent.pendingChangeSet?.status === 'pending';
  editAgentBusyRef.current = Boolean(editingAgentBlocked);
  const handleAiSend = useCallback((text: string) => {
    if (!workflowOwnsProjectRef.current) void aiAgent.sendPrompt(text);
  }, [aiAgent]);

  const prepareWorkflow = async (stepIds: string[]) => {
    if (workflowOwnsProjectRef.current || editAgentBusyRef.current) return false;
    workflowOwnsProjectRef.current = true;
    setWorkflowPreparing(true);
    setWorkspaceError(null);
    try {
      if (dirtyRef.current && !await handleSave(true)) return false;
      for (const scene of projectInfo?.scenes ?? []) {
        const draft = editorCommitCoordinator.getDraft<WebGalNode[]>(scene);
        if (!draft || !projectPath) continue;
        await saveScene(await getScenePath(projectPath, scene), draft);
        editorCommitCoordinator.deleteDraft(scene);
      }
      await editorCommitCoordinator.beginCommit(projectInfo?.scenes ?? [currentSceneName]);
      return await flow.start(stepIds);
    } catch (err) {
      setWorkspaceError(`准备生产失败：${String(err)}`);
      return false;
    } finally {
      editorCommitCoordinator.settleCommit();
      setWorkflowPreparing(false);
    }
  };

  // Both Agent panels stay mounted. One project writer is admitted at a time,
  // regardless of which panel is visible; production output refreshes the editor.
  const previousWorkflow = useRef<{ project: string | null; key: string; active: boolean } | null>(null);
  const workflowOutputKey = JSON.stringify([
    flow.state.steps.filter((step) => step.status === 'succeeded' && ['character', 'scene', 'assetQueue'].includes(step.id))
      .map((step) => [step.id, step.status, step.attempt, step.finishedAt]),
    flow.assetQueue?.tasks.map((task) => [task.id, task.assetFile]),
  ]);
  const reloadWorkflowRef = useRef(reloadAfterSnapshot);
  reloadWorkflowRef.current = reloadAfterSnapshot;
  const workflowRefreshToken = useRef(0);
  useEffect(() => {
    workflowRefreshToken.current += 1;
    previousWorkflow.current = null;
    setWorkflowRefreshing(false);
    setWorkflowSyncRequired(false);
    setWorkspaceError(null);
  }, [projectPath]);
  useEffect(() => {
    if (loading || flow.loading || !projectPath) return;
    const active = flow.state.runStatus === 'running' || flow.state.runStatus === 'paused';
    const previous = previousWorkflow.current;
    previousWorkflow.current = { project: projectPath, key: workflowOutputKey, active };
    if (!previous || previous.project !== projectPath || (previous.key === workflowOutputKey && !(previous.active && !active))) return;
    if (dirtyRef.current || editAgentBusyRef.current) {
      setWorkflowSyncRequired(true);
      setWorkspaceError('生产结果与未保存的编辑同时存在。请先复制当前草稿，再读取生产结果。');
      return;
    }
    const token = ++workflowRefreshToken.current;
    workflowOwnsProjectRef.current = true;
    setWorkflowRefreshing(true);
    void reloadWorkflowRef.current().catch((err) => {
      if (token === workflowRefreshToken.current) { setWorkflowSyncRequired(true); setWorkspaceError(`生产结果刷新失败：${String(err)}`); }
    }).finally(() => { if (token === workflowRefreshToken.current) setWorkflowRefreshing(false); });
  }, [flow.loading, flow.state.runStatus, loading, projectPath, workflowOutputKey, dirtyRef]);

  const workflowController = {
    ...flow,
    start: prepareWorkflow,
    busy: flow.busy || workflowPreparing || workflowRefreshing,
  };

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
          projectId={projectId}
          activeSection="edit"
          onBeforeNavigate={guardedNavigate}
          title="编辑"
          onUndo={workflowOwnsProject ? undefined : undo}
          onRedo={workflowOwnsProject ? undefined : redo}
          onPublish={handleExportProject}
          onSave={workflowOwnsProject ? undefined : () => { void handleSave(); }}
          onImport={workflowOwnsProject ? undefined : () => guardedNavigate(handleImport)}
          onExport={handleExport}
          onOpenProject={() => guardedNavigate(handleOpenProject)}
          onSnapshots={workflowOwnsProject ? undefined : handleOpenSnapshotManager}
          onSearchChange={setCommandSearchQuery}
          searchValue={commandSearchQuery}
          searchPlaceholder="搜索指令 / 角色 / 内容..."
          saveStatus={saveStatus}
          autoSave={autoSaveEnabled}
          onAutoSaveChange={setAutoSaveEnabled}
          onSettings={() => setAppSettingsOpen(true)}
        />

        <main className="ollaic-workspace flex min-w-0 flex-col">
          <header className="editor-workspace-toolbar">
            <div className="flex min-w-0 items-center gap-2">
              <select aria-label="当前场景" value={currentSceneName} disabled={workflowOwnsProject} onChange={(event) => stableSwitchScene(event.target.value)} className="min-w-0 max-w-48 rounded-md border border-border bg-surface-container-lowest px-2 py-1.5 text-xs">
                {(projectInfo?.scenes.length ? projectInfo.scenes : [currentSceneName]).map((scene) => <option key={scene} value={scene}>{sceneHeaders[scene]?.chapter || sceneHeaders[scene]?.outline ? `${sceneDisplayName(scene, sceneHeaders[scene])} · ${scene}` : scene}</option>)}
              </select>
              <button type="button" className="ollaic-icon-button" disabled={workflowOwnsProject} onClick={() => setSceneManagerOpen(true)} aria-label="场景管理" title="场景管理"><FolderOpen className="size-4" /></button>
              <select
                aria-label="编辑器视图模式"
                value={scriptMode}
                disabled={workflowOwnsProject}
                onChange={(event) => setScriptMode(event.target.value as 'compact' | 'stream' | 'script')}
                className="min-w-0 rounded-md border border-border bg-surface-container-lowest px-2 py-1.5 text-xs text-foreground"
              >
                <option value="compact">剧本视图</option>
                <option value="stream">指令卡片</option>
                <option value="script">脚本源码</option>
              </select>
              <button
                type="button"
                className="sr-only"
                onClick={() => setScriptMode((m) => (m === 'script' ? 'compact' : 'script'))}
                aria-label={scriptMode === 'script' ? '切换到指令流视图' : '切换到脚本编辑器'}
              >
                {scriptMode === 'script' ? '指令视图' : '脚本源码'}
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" className={`ollaic-top-action ${previewLayout !== 'hidden' ? 'bg-primary/12 text-primary' : ''}`} aria-pressed={previewLayout !== 'hidden'} onClick={() => changePreviewLayout(previewLayout === 'hidden' ? preferredDockLayout : 'hidden')}><Play className="size-4" /><span className="hidden sm:inline">实时预览</span><span className="sr-only sm:hidden">实时预览</span></button>
              <button type="button" className={`ollaic-top-action ${viewMode === 'worldline' ? 'bg-primary/12 text-primary' : ''}`} aria-pressed={viewMode === 'worldline'} onClick={toggleSceneGraph}><GitBranch className="size-4" /><span className="hidden sm:inline">场景图</span><span className="sr-only sm:hidden">场景图</span></button>
              <button type="button" className="ollaic-icon-button" onClick={() => setAgentOpen((value) => !value)} aria-label={agentOpen ? '收起 Agent 面板' : '打开 Agent 面板'} aria-expanded={agentOpen} title={agentOpen ? '收起 Agent 面板' : '打开 Agent 面板'}>{agentOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}</button>
            </div>
          </header>
          {workspaceError && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">{workspaceError}{dirty && <button type="button" className="ml-3 underline" onClick={() => { void navigator.clipboard.writeText(scriptSource).catch((err) => setWorkspaceError(`复制草稿失败：${String(err)}`)); }}>复制当前草稿</button>}<button type="button" className="ml-3 underline" onClick={() => { void reloadAfterSnapshot().then(() => { setWorkspaceError(null); setWorkflowSyncRequired(false); }).catch((err) => setWorkspaceError(String(err))); }}>{dirty ? '读取生产结果（放弃当前草稿）' : '重新读取'}</button>{!workflowSyncRequired && <button type="button" className="ml-3 underline" onClick={() => setWorkspaceError(null)}>关闭提示</button>}</div>}
          {isResizingDock && dockDragMoved && (
            <div className="fixed inset-0 z-[100] cursor-row-resize select-none" />
          )}
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {workflowOwnsProject && <div role="status" className="shrink-0 border-b border-primary/15 bg-primary/5 px-4 py-2 text-xs text-muted-foreground">{workflowSyncRequired ? '请先处理上方提示，再继续编辑。' : workflowRefreshing ? '正在同步生产结果…' : 'Workflow 正在管理项目，脚本暂时只读。停止生产后可继续编辑。'}</div>}
              <div className={`editor-stage editor-stage-${previewLayout}`}>
                <div className={`relative min-h-0 min-w-0 flex-1 flex-col ${previewLayout === 'large' ? 'hidden' : 'flex'}`}>
                  <div className={`min-h-0 flex-1 flex-col ${viewMode === 'worldline' ? 'hidden' : 'flex'}`} ref={(element) => { element?.toggleAttribute('inert', workflowOwnsProject); }}>
                    {showScript ? (
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background/50">
                        <div className="flex items-center justify-between gap-2 border-b border-border p-3 text-xs">
                          <span className="truncate text-muted-foreground">脚本源码 · {currentSceneName}</span>
                          <button type="button" onClick={handleApplyScript} className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-primary-foreground">应用更改</button>
                        </div>
                        <textarea value={scriptSource} onChange={(event) => { setScriptSource(event.target.value); markDirty(); }} className="min-h-0 w-full flex-1 resize-none bg-transparent p-4 text-sm leading-relaxed outline-none font-mono-family" spellCheck={false} aria-label="WebGAL 脚本编辑器" />
                      </div>
                    ) : (
                      <ScriptCommandStream displayMode={scriptMode === 'compact' ? 'compact' : 'stream'} nodes={nodes} selectedNode={selectedNode} currentSceneName={currentSceneName} sceneHeaders={sceneHeaders}
                        onSelectNode={setSelectedNode} onInsertNode={insertNode} onDeleteNode={deleteNode} onCopyNode={copyNode} onCutNode={cutNode} onPasteNode={pasteNode} onReorderNodes={reorderNodes} onJumpToIndex={jumpToNode} onCreateUnlockNode={createUnlockNode}
                        clipboardNode={clipboardNode} characterColors={characterColors} characters={charactersForAi} searchQuery={commandSearchQuery} previewEntries={aiPreviewEntries} projectPath={projectPath ?? undefined} />
                    )}
                    {selectedNode && !showScript && <div className="absolute inset-y-0 right-0 z-30 w-full max-w-80 border-l border-border bg-surface-container-lowest shadow-[-8px_0_24px_var(--shadow-soft)]">
                      <DetailPanel node={selectedNode} onUpdateNode={updateSelectedNode} onDeleteNode={deleteSelectedNode} onClose={() => setSelectedNode(null)} characterNames={charactersForAi.map((character) => character.name)} projectPath={projectPath ?? undefined} characters={charactersForAi} projectId={projectId} scenes={projectInfo?.scenes ?? []} sceneHeaders={sceneHeaders} />
                    </div>}
                  </div>
                  {viewMode === 'worldline' && <div className="min-h-0 flex-1" ref={(element) => { element?.toggleAttribute('inert', workflowOwnsProject); }}>
                    <FullScreenWorldline scenes={projectInfo?.scenes ?? [currentSceneName]} currentSceneName={currentSceneName} sceneHeaders={sceneHeaders} sceneLinkMap={sceneLinkMap} nodes={nodes} selectedNode={selectedNode} onSelectNode={setSelectedNode} onOpenScene={stableSwitchScene} onClose={toggleSceneGraph}
                      characterColors={characterColors} onNewScene={handleNewScene} onDeleteScene={handleDeleteScene} onRenameScene={handleRenameScene} onOpenSceneManager={() => setSceneManagerOpen(true)} onDeleteNode={deleteNode} onJumpToIndex={jumpToNode} />
                  </div>}
                </div>
                {previewStarted && previewLayout === 'split' && (
                  <div
                    className={`editor-dock-resizer ${isResizingDock && dockDragMoved ? 'is-resizing' : ''}`}
                    onMouseDown={handleDockResizeStart}
                    onDoubleClick={() => {
                      setBottomDockHeight(DEFAULT_BOTTOM_DOCK_HEIGHT);
                      try { localStorage.setItem(DOCK_HEIGHT_STORAGE_KEY, String(DEFAULT_BOTTOM_DOCK_HEIGHT)); } catch {}
                    }}
                    title="按住上下拖动调整预览窗口高度，双击恢复默认"
                  >
                    <div className="editor-dock-resizer-line" />
                  </div>
                )}
                {previewStarted && (
                  <RuntimePreviewPanel
                    preview={runtimePreview}
                    layout={previewLayout}
                    dockLayout={preferredDockLayout}
                    height={bottomDockHeight}
                    sceneName={currentSceneName}
                    dirty={dirty}
                    onLayoutChange={changePreviewLayout}
                    onSettings={() => setAppSettingsOpen(true)}
                  />
                )}
              </div>
              <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-4 text-[10px] text-muted-foreground"><span>{scriptSource.length.toLocaleString()} 字</span><span className="hidden sm:inline">约 {Math.max(1, Math.ceil(scriptSource.length / 380))} 分钟阅读</span><span className="ml-auto">WebGAL</span></footer>
            </div>
            <aside aria-label="Agent 面板" className={`editor-agent-dock ${agentOpen ? '' : 'hidden'}`}>
              <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
                <Bot className="size-4 shrink-0 text-primary" />
                <div className="flex min-w-0 flex-1 gap-1 rounded-lg bg-surface-container-low p-1" role="tablist" aria-label="Agent 模式" onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const mode = event.key === 'Home' ? 'workflow' : event.key === 'End' ? 'edit' : agentMode === 'edit' ? 'workflow' : 'edit';
                  setAgentMode(mode);
                  document.getElementById(mode === 'workflow' ? 'workflow-agent-tab' : 'editing-agent-tab')?.focus();
                }}>
                  <button id="workflow-agent-tab" role="tab" type="button" aria-selected={agentMode === 'workflow'} tabIndex={agentMode === 'workflow' ? 0 : -1} aria-controls="workflow-agent-panel" onClick={() => setAgentMode('workflow')} className={`flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-xs ${agentMode === 'workflow' ? 'bg-surface-container-lowest font-semibold text-primary shadow-sm' : 'text-muted-foreground'}`}>Workflow Agent</button>
                  <button id="editing-agent-tab" role="tab" type="button" aria-selected={agentMode === 'edit'} tabIndex={agentMode === 'edit' ? 0 : -1} aria-controls="editing-agent-panel" onClick={() => setAgentMode('edit')} className={`flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-xs ${agentMode === 'edit' ? 'bg-surface-container-lowest font-semibold text-primary shadow-sm' : 'text-muted-foreground'}`}>编辑 Agent</button>
                </div>
                <button type="button" className="ollaic-icon-button lg:hidden" onClick={() => setAgentOpen(false)} aria-label="关闭 Agent 面板"><X className="size-4" /></button>
              </header>
              <div id="workflow-agent-panel" role="tabpanel" aria-labelledby="workflow-agent-tab" className={`min-h-0 flex-1 flex-col ${agentMode === 'workflow' ? 'flex' : 'hidden'}`}>
                {editingAgentBlocked && <p role="status" className="border-b border-border bg-primary/5 px-4 py-2 text-xs text-muted-foreground">请先完成编辑 Agent 的生成和修改确认，再运行生产。</p>}
                {projectPath ? <FlowBoardView key={projectPath} projectPath={projectPath} controller={workflowController} embedded blocked={Boolean(editingAgentBlocked || workflowSyncRequired || (dirty && ['running', 'paused'].includes(flow.state.runStatus)))} onOpenArtifact={(step, plan) => {
                  if (step.kind === 'character' || step.kind === 'asset') guardedNavigate(() => navigate(`/editor/${projectId}/assets${step.kind === 'character' ? '?tab=character' : ''}`));
                  else if (step.id === 'scene') {
                    const scene = plan?.scenePlans.find((candidate) => candidate.id === plan.branches.entryScene)?.file ?? plan?.scenes[0];
                    if (scene) stableSwitchScene(scene);
                    setAgentMode('edit');
                  }
                }} /> : <p className="p-4 text-sm text-muted-foreground">打开项目后即可安排生产。</p>}
              </div>
              <div id="editing-agent-panel" role="tabpanel" aria-labelledby="editing-agent-tab" className={`min-h-0 flex-1 flex-col ${agentMode === 'edit' ? 'flex' : 'hidden'}`} ref={(element) => { element?.toggleAttribute('inert', workflowOwnsProject); }}>
                {workflowOwnsProject && <p className="border-b border-border bg-primary/5 px-4 py-2 text-xs text-muted-foreground">生产期间可查看对话。停止生产后可发送编辑请求。</p>}
                <AiAssistantPanel embedded disabled={workflowOwnsProject} aiAgent={aiAgent} projectPath={projectPath} sceneHeaders={sceneHeaders} onOpenSettings={() => setAiSettingsOpen(true)} onOpenMemory={() => guardedNavigate(() => navigate(`/editor/${projectId}/memory`))} onSend={handleAiSend} />
              </div>
            </aside>
          </div>
        </main>

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
          onClose={() => { setAppSettingsOpen(false); if (previewStarted) runtimePreview.reconnect(); }}
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
