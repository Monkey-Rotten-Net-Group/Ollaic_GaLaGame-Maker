import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import {
  Sparkles, Save, Play, Image, ArrowLeft, Send,
  Upload, Download, FileText, FolderOpen, Layers, Check, Loader2, SlidersHorizontal,
  Undo2, Redo2, Package, MoreHorizontal, PanelRightClose, PanelRightOpen,
  X, AlertTriangle,
} from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NodePanel } from './NodePanel';
import { FlowCanvas } from './FlowCanvas';
import { DetailPanel } from './DetailPanel';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AppSettingsDialog, loadAppSettings } from './AppSettingsDialog';
import { SceneManagerPanel } from './SceneManager';
import { AiMemoryPanel } from './AiMemoryPanel';
import { AiMessageBubble } from './AiMessageBubble';
import { AiPendingCard } from './AiPendingCard';
import { ConflictCard, ErrorCard, MissingAssetCard } from './AiStatusCard';
import type { WebGalNode, WebGalCommandType, SceneLink } from '../lib/webgal-types';
import { extractSceneLinks } from '../lib/webgal-types';
import {
  parseScene, serializeScene, saveScene, loadScene,
  openProject, getScenePath, createScene,
  exportProject,
  setRuntimeProject, setRuntimeTemplateDir, getRuntimeUrl, jumpToSentence, openInBrowser,
  readFileText, parseSceneHeader,
  type ProjectInfo, type SceneHeader,
} from '../lib/webgal-ipc';
import { listCharacterNames, listCharacters } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import { useAiAgent, type AiPanelStatus } from '../hooks/useAiAgent';
import {
  insertSceneNode,
  pasteSceneNode,
  removeSceneNode,
  reorderSceneNodes,
} from '../lib/scene-editing';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
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

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const aiStatusLabels: Record<AiPanelStatus, string> = {
  idle: '等待输入',
  generating: '生成中',
  validating: '校验中',
  pending: '待确认',
  accepted: '已接受',
  reverted: '已撤销',
  conflict: '有冲突',
  missing_assets: '缺少素材',
  error: '出错',
};

const DEMO_SCRIPT = `; 序章 - 安静的午后
changeBg:afternoon_park.webp -next;
bgm:peaceful_afternoon.mp3;
changeFigure:girl_smile.webp -left -next;
setAnimation:enter-from-left -target=fig-left -next;
未知少女:你好，我是……;
未知少女:你也是这个学校的学生吗？;
:一阵微风穿过庭院。;
choose:打招呼:branch_friendly.txt|保持沉默:branch_silent.txt;
`;

export function StoryEditor() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();

  // Project state
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [currentSceneName, setCurrentSceneName] = useState('start.txt');
  const [dirty, setDirty] = useState(false);
  const [sceneHeaders, setSceneHeaders] = useState<Record<string, SceneHeader>>({});
  const [sceneLinkMap, setSceneLinkMap] = useState<Record<string, SceneLink[]>>({});
  const [sceneManagerOpen, setSceneManagerOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  // Editor state
  const [nodes, setNodes] = useState<WebGalNode[]>([]);
  const nodesRef = useRef<WebGalNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<WebGalNode | null>(null);
  const [assetContextNoticeDismissed, setAssetContextNoticeDismissed] = useState(false);
  const [clipboardNode, setClipboardNode] = useState<WebGalNode | null>(null);
  const [scriptSource, setScriptSource] = useState(DEMO_SCRIPT);
  const [showScript, setShowScript] = useState(false);
  const [loading, setLoading] = useState(true);

  // AI state
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [characterNames, setCharacterNames] = useState<string[]>([]);
  const [characterColors, setCharacterColors] = useState<Record<string, string>>({});
  const [charactersForAi, setCharactersForAi] = useState<Character[]>([]);
  const [aiCollapsed, setAiCollapsed] = useState(() => localStorage.getItem(`story-ai-collapsed-${projectId}`) === '1');

  // Build character context for AI system prompt
  const buildCharacterContext = useCallback((chars: Character[]): string => {
    if (chars.length === 0) return '';
    return chars.map(c => {
      const parts: string[] = [];
      parts.push(`- ${c.name}`);
      if (c.aliases.length > 0) parts.push(`  别名: ${c.aliases.join(', ')}`);
      if (c.gender) parts.push(`  性别: ${c.gender}`);
      if (c.age) parts.push(`  年龄: ${c.age}`);
      if (c.personality) parts.push(`  性格: ${c.personality}`);
      if (c.stance) parts.push(`  立场: ${c.stance}`);
      if (c.keywords.length > 0) parts.push(`  关键词: ${c.keywords.join(', ')}`);
      if (c.description) parts.push(`  简介: ${c.description}`);
      if (c.dialogueStyle) parts.push(`  对话风格: ${c.dialogueStyle}`);
      if (c.relations.length > 0) {
        const rels = c.relations.map(r => `${r.relationType}->${r.targetId}`).join(', ');
        if (rels) parts.push(`  关系: ${rels}`);
      }
      return parts.join('\n');
    }).join('\n\n');
  }, []);

  const aiMessagesListRef = useRef<HTMLDivElement | null>(null);

  const loadSceneHeaders = useCallback(async (projectPath: string, scenes: string[]) => {
    const entries = await Promise.all(
      scenes.map(async (name) => {
        try {
          const path = await getScenePath(projectPath, name);
          const text = await readFileText(path);
          return [name, parseSceneHeader(text)] as const;
        } catch {
          return [name, {}] as const;
        }
      }),
    );
    setSceneHeaders(Object.fromEntries(entries));
  }, []);

  const loadSceneLinkMap = useCallback(async (projectPath: string, scenes: string[]) => {
    const entries = await Promise.all(
      scenes.map(async (name) => {
        try {
          const path = await getScenePath(projectPath, name);
          const nodes = await loadScene(path);
          return [name, extractSceneLinks(nodes)] as const;
        } catch {
          return [name, [] as SceneLink[]] as const;
        }
      }),
    );
    setSceneLinkMap(Object.fromEntries(entries));
  }, []);

  const handleHeaderUpdated = useCallback((name: string, header: SceneHeader) => {
    setSceneHeaders((prev) => ({ ...prev, [name]: header }));
  }, []);

  const refreshProjectInfo = useCallback(async () => {
    if (!projectPath) return;
    try {
      const info = await openProject(projectPath);
      setProjectInfo(info);
      void loadSceneHeaders(projectPath, info.scenes);
      void loadSceneLinkMap(projectPath, info.scenes);
    } catch {}
  }, [projectPath, loadSceneHeaders, loadSceneLinkMap]);

  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // In-memory draft cache: sceneName -> nodes snapshot for unsaved scenes
  const sceneDraftCache = useRef<Map<string, WebGalNode[]>>(new Map());
  const aiPendingPreviewRef = useRef(false);
  // Keep a ref in sync so the close-requested handler always sees current dirty state
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const autoSaveRef = useRef<ReturnType<typeof setInterval>>();

  // Auto-save wiring
  const [autoSaveInterval, setAutoSaveInterval] = useState(30);

  useEffect(() => {
    const settings = loadAppSettings();
    setAutoSaveInterval(settings.autoSaveInterval);
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

  useEffect(() => {
    localStorage.setItem(`story-ai-collapsed-${projectId}`, aiCollapsed ? '1' : '0');
  }, [aiCollapsed, projectId]);

  // ---------------------------------------------------------------------------
  // Initialization: try to load project from localStorage or URL params
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      // Try to restore project path from localStorage
      const storedPath = localStorage.getItem(`project-path-${projectId}`);
      const sceneName = searchParams.get('scene') || 'start.txt';
      setCurrentSceneName(sceneName);

      if (storedPath) {
        try {
          const info = await openProject(storedPath);
          setProjectPath(storedPath);
          setProjectInfo(info);

          // Load the scene file
          const scenePath = await getScenePath(storedPath, sceneName);
          try {
            const loaded = await loadScene(scenePath);
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
          } catch {
            // Scene doesn't exist yet, start with empty
            const parsed = await parseScene(DEMO_SCRIPT);
            setNodes(parsed);
            setScriptSource(DEMO_SCRIPT);
          }
        } catch {
          // Stored path no longer valid, fall back to demo.
          const parsed = await parseScene(DEMO_SCRIPT);
          setNodes(parsed);
        }

        // Load character names for autocomplete
        try {
          const refs = await listCharacterNames(storedPath);
          const chars = await listCharacters(storedPath);
          setCharacterNames(refs.map(r => r.name));
          const colors: Record<string, string> = {};
          for (const c of chars) {
            if (c.colorTheme) colors[c.name] = c.colorTheme;
          }
          setCharacterColors(colors);
          setCharactersForAi(chars);
        } catch {
          setCharacterNames([]);
          setCharacterColors({});
          setCharactersForAi([]);
        }

        // Load scene header comments + outgoing scene-jump map for the graph view
        const info = await openProject(storedPath).catch(() => null);
        if (info) {
          void loadSceneHeaders(storedPath, info.scenes);
          void loadSceneLinkMap(storedPath, info.scenes);
        }
      } else {
        // No project path, just load demo script.
        const parsed = await parseScene(DEMO_SCRIPT);
        setNodes(parsed);
      }

      setLoading(false);
    };
    init();
  }, [projectId, searchParams]);

  // ---------------------------------------------------------------------------
  // 同步节点到脚本文本
  // ---------------------------------------------------------------------------
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
  const updateNode = useCallback((id: string, updates: Partial<WebGalNode>) => {
    const current = nodesRef.current;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!pendingRecordRef.current) pendingRecordRef.current = current;
    debounceTimerRef.current = setTimeout(() => {
      if (pendingRecordRef.current) {
        pushHistory(pendingRecordRef.current);
        pendingRecordRef.current = null;
      }
    }, 500);

    const next = current.map(n => n.id === id ? { ...n, ...updates } : n);
    commitEditedNodes(next);
    setSelectedNode(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
  }, [commitEditedNodes, pushHistory]);

  const deleteNode = useCallback((id: string) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    commitEditedNodes(removeSceneNode(current, id));
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const copyNode = useCallback((node: WebGalNode) => {
    setClipboardNode({ ...node });
  }, []);

  const cutNode = useCallback((node: WebGalNode) => {
    setClipboardNode({ ...node });
    deleteNode(node.id);
  }, [deleteNode]);

  const pasteNode = useCallback((atIndex: number) => {
    if (!clipboardNode) return;
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    commitEditedNodes(pasteSceneNode(current, clipboardNode, atIndex, Date.now().toString()));
  }, [clipboardNode, commitEditedNodes, flushPendingHistory, pushHistory]);

  const reorderNodes = useCallback((fromIndex: number, toIndex: number) => {
    const current = nodesRef.current;
    const next = reorderSceneNodes(current, fromIndex, toIndex);
    if (next === current) return;
    flushPendingHistory();
    pushHistory(current);
    commitEditedNodes(next);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const insertNode = useCallback((type: WebGalCommandType, atIndex: number) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const { nodes: updated, inserted } = insertSceneNode(current, type, atIndex, Date.now().toString());
    commitEditedNodes(updated);
    setSelectedNode(inserted);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async (): Promise<boolean> => {
    setSaveStatus('saving');
    try {
      if (projectPath) {
        // Save to project's game/scene/ directory
        const scenePath = await getScenePath(projectPath, currentSceneName);
        await saveScene(scenePath, nodes);
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
        await saveScene(selected, nodes);
      }
      setDirty(false);
      sceneDraftCache.current.delete(currentSceneName);
      // Refresh header + scene-graph link entry for the saved scene
      if (projectPath) void loadSceneHeaders(projectPath, projectInfo?.scenes ?? [currentSceneName]);
      setSceneLinkMap((prev) => ({ ...prev, [currentSceneName]: extractSceneLinks(nodes) }));
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
    }
  }, [projectPath, currentSceneName, nodes]);

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
    getCurrentWindow().onCloseRequested((event) => {
      if (dirtyRef.current) {
        event.preventDefault();
        pendingActionRef.current = () => void getCurrentWindow().destroy();
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

  // Auto-save: periodic save when dirty
  useEffect(() => {
    if (autoSaveInterval <= 0 || !projectPath) return;
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    autoSaveRef.current = setInterval(() => {
      if (dirty) {
        handleSave();
      }
    }, autoSaveInterval * 1000);
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [autoSaveInterval, dirty, handleSave, projectPath]);

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
      const sceneName = info.scenes.includes('start.txt')
        ? 'start.txt'
        : info.scenes[0] || 'start.txt';
      setCurrentSceneName(sceneName);

      const scenePath = await getScenePath(selected, sceneName);
      try {
        const loaded = await loadScene(scenePath);
        setNodes(loaded);
        const text = await serializeScene(loaded);
        setScriptSource(text);
        setDirty(false);
      } catch {
        // empty scene
        setNodes([]);
        setScriptSource('');
      }

      // Load character names for autocomplete
      try {
        const refs = await listCharacterNames(selected);
        const chars = await listCharacters(selected);
        setCharacterNames(refs.map(r => r.name));
        const colors: Record<string, string> = {};
        for (const c of chars) {
          if (c.colorTheme) colors[c.name] = c.colorTheme;
        }
        setCharacterColors(colors);
        setCharactersForAi(chars);
      } catch {
        setCharacterNames([]);
        setCharacterColors({});
        setCharactersForAi([]);
      }

      void loadSceneHeaders(selected, info.scenes);
      void loadSceneLinkMap(selected, info.scenes);
    } catch (e) {
      console.error('Open project failed:', e);
    }
  }, [projectId, loadSceneHeaders, loadSceneLinkMap]);

  // ---------------------------------------------------------------------------
  // Switch scene within project
  // ---------------------------------------------------------------------------
  const handleSwitchScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;

    // Stash current unsaved nodes in the in-memory draft cache
    if (dirty && !aiPendingPreviewRef.current) {
      sceneDraftCache.current.set(currentSceneName, nodes);
    } else if (aiPendingPreviewRef.current) {
      sceneDraftCache.current.delete(currentSceneName);
    }

    setCurrentSceneName(sceneName);
    const scenePath = await getScenePath(projectPath, sceneName);
    try {
      // Prefer a cached draft over the saved file
      const draft = sceneDraftCache.current.get(sceneName);
      if (draft) {
        setNodes(draft);
        const text = await serializeScene(draft);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(true);
      } else {
        const loaded = await loadScene(scenePath);
        setNodes(loaded);
        const text = await serializeScene(loaded);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(false);
      }
    } catch {
      setNodes([]);
      setScriptSource('');
    }
  }, [projectPath, currentSceneName, dirty, nodes]);

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
    const name = prompt('新场景文件名（不含 .txt）:');
    if (!name) return;
    try {
      await createScene(projectPath, name);
      // Refresh project info
      const info = await openProject(projectPath);
      setProjectInfo(info);
      // Switch to new scene
      const sceneName = name.endsWith('.txt') ? name : `${name}.txt`;
      await handleSwitchScene(sceneName);
    } catch (e) {
      console.error('Create scene failed:', e);
    }
  }, [projectPath, handleSwitchScene]);

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
    const text = await serializeScene(nodes);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentSceneName;
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, currentSceneName]);

  const handleApplyScript = useCallback(async () => {
    const parsed = await parseScene(scriptSource);
    setNodes(parsed);
    setSelectedNode(null);
    setShowScript(false);
    markDirty();
  }, [scriptSource, markDirty]);

  // Export project to runnable WebGAL package
  const handleExportProject = useCallback(async () => {
    if (!projectPath) return;
    // Save current scene first
    if (dirty && !(await handleSave())) return;

    const dest = await saveDialog({
      title: 'Select export directory',
      directory: true,
    });
    if (!dest) return;

    try {
      const result = await exportProject(projectPath, dest, false);
      if (result.success) {
        let msg = `导出成功。游戏已保存到 ${dest}`;
        if (result.warnings.length > 0) {
          msg += `\n\n警告:\n${result.warnings.join('\n')}`;
        }
        alert(msg);
      }
    } catch (e) {
      alert(`导出失败: ${e}`);
    }
  }, [projectPath, dirty, handleSave]);

  const handleOpenRuntime = useCallback(async () => {
    try {
      const url = await getRuntimeUrl();
      await openInBrowser(url);
    } catch (e) {
      console.warn('[runtime] failed to open browser:', e);
      alert(`无法打开预览窗口: ${e}`);
    }
  }, []);

  const aiAgent = useAiAgent({
    projectId,
    projectPath,
    currentSceneName,
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
  });

  useEffect(() => {
    const list = aiMessagesListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [aiAgent.messages]);

  useEffect(() => {
    aiPendingPreviewRef.current = aiAgent.pendingChange?.status === 'pending';
    if (aiAgent.status === 'reverted' || aiAgent.status === 'accepted') {
      sceneDraftCache.current.delete(currentSceneName);
    }
  }, [aiAgent.pendingChange?.status, aiAgent.status, currentSceneName]);

  const handleAiSend = () => { void aiAgent.sendPrompt(aiAgent.input); };
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
  const selectedIndex = selectedNode ? nodes.findIndex((node) => node.id === selectedNode.id) : -1;
  const suggestedFigureCharacter =
    selectedNode?.type === 'changeFigure' &&
    selectedIndex > 0 &&
    nodes[selectedIndex - 1]?.type === 'dialogue'
      ? nodes[selectedIndex - 1].character
      : undefined;

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="h-full flex flex-col bg-background">
        {/* Header */}
        <header className="border-b border-border bg-card/50 backdrop-blur-sm">
          <div className="px-3 sm:px-6 py-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 xl:gap-4">
              <button
                onClick={() => guardedNavigate(() => navigate('/'))}
                className="p-2 rounded-md hover:bg-secondary/50 transition-colors"
                aria-label="返回主页"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="hidden xl:block h-6 w-px bg-border" />
              <h1 className="hidden xl:block text-2xl tracking-tight font-display-family">
                故事编织室
              </h1>
              <div className="hidden xl:block h-6 w-px bg-border" />
              <span className="min-w-0 max-w-[10rem] truncate text-sm text-muted-foreground font-mono-family">
                {gameName}
              </span>

              {/* Scene selector */}
              {projectInfo && projectInfo.scenes.length > 0 && (
                <>
                  <div className="hidden xl:block h-6 w-px bg-border" />
                  <select
                    value={currentSceneName}
                    onChange={(e) => handleSwitchScene(e.target.value)}
                    className="max-w-[9rem] sm:max-w-[12rem] px-2 py-1 text-sm bg-secondary border border-border rounded-md font-mono-family"
                    aria-label="选择场景"
                  >
                    {projectInfo.scenes.map((s) => {
                      const h = sceneHeaders[s];
                      const label = h?.chapter
                        ? (h.outline ? `${h.chapter} — ${h.outline}` : h.chapter)
                        : (h?.outline ?? s);
                      return <option key={s} value={s} title={s}>{label}</option>;
                    })}
                  </select>
                  <button
                    onClick={() => setSceneManagerOpen((v) => !v)}
                    className={`p-1.5 rounded-md transition-colors ${sceneManagerOpen ? 'bg-primary/10 text-primary' : 'hover:bg-secondary/50 text-muted-foreground'}`}
                    title="场景管理"
                    aria-label="场景管理"
                  >
                    <Layers className="w-4 h-4" />
                  </button>
                </>
              )}

              {dirty && (
                <span className="hidden xl:inline text-xs text-muted-foreground">未保存</span>
              )}
            </div>

            <div className="flex flex-shrink-0 items-center gap-1 xl:gap-2">
              <button
                onClick={handleOpenProject}
                className="hidden xl:flex px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/70 transition-colors items-center gap-2 text-sm"
                title="打开 WebGAL 项目文件夹"
                aria-label="打开 WebGAL 项目文件夹"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>打开</span>
              </button>
              <button
                onClick={handleImport}
                className="hidden xl:flex px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/70 transition-colors items-center gap-2 text-sm"
                aria-label="导入场景文件"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>导入</span>
              </button>
              <button
                onClick={handleExport}
                className="hidden xl:flex px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/70 transition-colors items-center gap-2 text-sm"
                aria-label="导出场景文件"
              >
                <Download className="w-3.5 h-3.5" />
                <span>导出</span>
              </button>
              <button
                onClick={() => setShowScript(!showScript)}
                className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-2 text-sm ${
                  showScript ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-secondary/70'
                }`}
                aria-label="切换脚本编辑器"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>脚本</span>
              </button>
              <div className="hidden sm:block h-6 w-px bg-border mx-1" />
              <button
                onClick={() => {
                  if (dirty) {
                    sessionStorage.setItem(
                      `scene-draft-${projectId}-${currentSceneName}`,
                      JSON.stringify(nodes),
                    );
                  }
                  navigate(`/editor/${projectId}/assets`);
                }}
                className="px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/70 transition-colors flex items-center gap-2 text-sm"
                aria-label="打开素材库"
              >
                <Image className="w-3.5 h-3.5" />
                <span>素材库</span>
              </button>
              <button
                onClick={() => setAppSettingsOpen(true)}
                className="p-2 rounded-md hover:bg-secondary/50 transition-colors"
                title="编辑器设置"
                aria-label="编辑器设置"
              >
                <SlidersHorizontal className="w-4 h-4" />
              </button>
              {/* Undo / Redo */}
              <button
                onClick={undo}
                disabled={history.length === 0 && pendingRecordRef.current === null}
                className="p-2 rounded-md hover:bg-secondary/50 transition-colors disabled:opacity-30"
                title="撤销 (Ctrl+Z)"
                aria-label="撤销"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                onClick={redo}
                disabled={redoHistory.length === 0}
                className="p-2 rounded-md hover:bg-secondary/50 transition-colors disabled:opacity-30"
                title="重做 (Ctrl+Shift+Z)"
                aria-label="重做"
              >
                <Redo2 className="w-4 h-4" />
              </button>
              <div className="hidden sm:block h-6 w-px bg-border mx-1" />
              {projectPath && (
                <button
                  onClick={handleExportProject}
                  className="hidden xl:flex px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/70 transition-colors items-center gap-2 text-sm"
                  title="导出可运行的 WebGAL 包"
                  aria-label="导出项目"
                >
                  <Package className="w-3.5 h-3.5" />
                  <span>打包</span>
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="xl:hidden p-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors"
                    aria-label="更多操作"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={handleOpenProject}>
                    <FolderOpen className="w-4 h-4" />
                    打开文件夹
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleImport}>
                    <Upload className="w-4 h-4" />
                    导入场景
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExport}>
                    <Download className="w-4 h-4" />
                    导出场景
                  </DropdownMenuItem>
                  {projectPath && (
                    <DropdownMenuItem onClick={handleExportProject}>
                      <Package className="w-4 h-4" />
                      打包
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                onClick={handleOpenRuntime}
                className="px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/70 transition-colors flex items-center gap-2 text-sm"
                title="在浏览器中打开 WebGAL 预览"
                aria-label="打开预览窗口"
              >
                <Play className="w-3.5 h-3.5" />
                <span>试玩</span>
              </button>

              {/* Save button with status */}
              <button
                onClick={handleSave}
                disabled={saveStatus === 'saving'}
                className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-2 text-sm ${
                  saveStatus === 'saved'
                    ? 'bg-chart-5/20 text-chart-5'
                    : saveStatus === 'error'
                    ? 'bg-destructive/20 text-destructive'
                    : dirty
                    ? 'bg-primary text-primary-foreground hover:opacity-90'
                    : 'bg-secondary hover:bg-secondary/70'
                }`}
              >
                {saveStatus === 'saving' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : saveStatus === 'saved' ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>
                  {saveStatus === 'saving' ? '保存中' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '保存失败' : '保存'}
                </span>
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <div className="relative flex-1 flex overflow-hidden">
          {/* Left Panel - Node List */}
          <div className="min-w-[200px] max-w-[260px] flex-shrink-0">
            <NodePanel
              nodes={nodes}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
              onInsertNode={insertNode}
              onReorderNodes={reorderNodes}
              characterColors={characterColors}
              onJumpToIndex={(i) =>
                jumpToSentence(currentSceneName, i + 1).catch((e) =>
                  console.warn('[runtime] jumpToSentence failed:', e),
                )
              }
              onDeleteNode={deleteNode}
              onCopyNode={copyNode}
              onCutNode={cutNode}
              onPasteNode={pasteNode}
              clipboardNode={clipboardNode}
              currentSceneName={currentSceneName}
              availableScenes={projectInfo?.scenes}
              sceneLinkMap={sceneLinkMap}
              sceneHeaders={sceneHeaders}
              onSwitchScene={stableSwitchScene}
            />
          </div>

          {/* Center - Detail Panel / Flow Canvas / Script Editor */}
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
                onChange={(e) => setScriptSource(e.target.value)}
                className="flex-1 p-4 bg-transparent resize-none focus:outline-none text-sm leading-relaxed font-mono-family"
                spellCheck={false}
                aria-label="WebGAL 脚本编辑器"
              />
            </div>
          ) : (
            <>
              {selectedNode && (
                <DetailPanel
                  node={selectedNode}
                  onUpdateNode={(updates) => updateNode(selectedNode.id, updates)}
                  onDeleteNode={() => deleteNode(selectedNode.id)}
                  onClose={() => setSelectedNode(null)}
                  characterNames={characterNames}
                  projectPath={projectPath || undefined}
                  characters={charactersForAi}
                  projectId={projectId}
                  suggestedFigureCharacter={suggestedFigureCharacter}
                />
              )}
              {/* Keep FlowCanvas always mounted to preserve scroll position */}
              <div className={selectedNode ? 'hidden' : 'flex-1 flex overflow-hidden'}>
                <FlowCanvas
                  nodes={nodes}
                  selectedNode={selectedNode}
                  onSelectNode={setSelectedNode}
                  onReorderNodes={reorderNodes}
                  characterColors={characterColors}
                  onDeleteNode={deleteNode}
                  onCopyNode={copyNode}
                  onCutNode={cutNode}
                  onPasteNode={pasteNode}
                  clipboardNode={clipboardNode}
                />
              </div>
            </>
          )}

          {/* Right Panel: Scene Manager or AI Chat */}
          {sceneManagerOpen && projectPath && projectInfo ? (
            <div className="w-80 border-l border-border flex flex-col">
              <SceneManagerPanel
                projectPath={projectPath}
                projectInfo={projectInfo}
                currentSceneName={currentSceneName}
                sceneHeaders={sceneHeaders}
                onSwitchScene={(name) => { void handleSwitchScene(name); }}
                onHeaderUpdated={handleHeaderUpdated}
                onSceneCreated={refreshProjectInfo}
                onClose={() => setSceneManagerOpen(false)}
              />
            </div>
          ) : (
          <div className={`${aiCollapsed ? 'w-10' : 'w-80'} border-l border-border bg-card/30 backdrop-blur-sm flex flex-col transition-[width] duration-200`}>
            <div className={`${aiCollapsed ? 'p-2 justify-center' : 'p-4'} border-b border-border flex items-center gap-3`}>
              <button
                type="button"
                onClick={() => setAiCollapsed((value) => !value)}
                className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors"
                title={aiCollapsed ? '展开 AI 助手' : '折叠 AI 助手'}
                aria-label={aiCollapsed ? '展开 AI 助手' : '折叠 AI 助手'}
              >
                {aiCollapsed ? <PanelRightOpen className="w-4 h-4" /> : <PanelRightClose className="w-4 h-4" />}
              </button>
              {!aiCollapsed && (
                <>
                  <div className="p-2 rounded-full bg-primary/20">
                    <Sparkles className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm uppercase tracking-widest text-muted-foreground font-mono-family">
                      AI 创作助手
                    </h3>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${
                        aiAgent.status === 'error' || aiAgent.status === 'conflict'
                          ? 'bg-destructive'
                          : aiAgent.status === 'pending'
                          ? 'bg-primary'
                          : aiAgent.status === 'accepted'
                          ? 'bg-chart-5'
                          : 'bg-muted-foreground/50'
                      }`} />
                      <span className="text-[10px] text-muted-foreground">
                        {aiStatusLabels[aiAgent.status]}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={aiAgent.clearConversation}
                    disabled={aiAgent.busy}
                    className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors disabled:opacity-40"
                    title="清空对话"
                    aria-label="清空 AI 对话"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>

            {/* Messages */}
            {!aiCollapsed && <div ref={aiMessagesListRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {aiAgent.hasAssetTruncation && !assetContextNoticeDismissed && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/35 px-3 py-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">素材库素材过多，AI 上下文中每类仅包含前 24 个，其余素材 AI 暂不可见。</div>
                  <button
                    type="button"
                    onClick={() => setAssetContextNoticeDismissed(true)}
                    className="rounded p-0.5 hover:bg-secondary"
                    aria-label="关闭素材提示"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {aiAgent.messages.map((msg) => {
                const isStreaming = aiAgent.busy && aiAgent.streamingIdRef.current === msg.id;
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <AiMessageBubble role={msg.role} content={msg.content} isStreaming={isStreaming} stopped={msg.stopped} />
                  </div>
                );
              })}
              {aiAgent.pendingChange && aiAgent.status !== 'conflict' && (
                <AiPendingCard
                  summary={aiAgent.pendingChange.summary}
                  status={aiAgent.pendingChange.status}
                  diff={aiAgent.pendingChange.diff}
                  warnings={aiAgent.pendingChange.warnings}
                  onAccept={() => { void aiAgent.acceptChange(); }}
                  onRevert={aiAgent.revertChange}
                />
              )}
              {aiAgent.status === 'missing_assets' && (
                <MissingAssetCard
                  issues={aiAgent.missingIssues}
                  onUseFallback={aiAgent.useFallbackAssets}
                  onOpenAssets={aiAgent.openAssets}
                  onRetryPrompt={aiAgent.retryWithExistingAssets}
                />
              )}
              {aiAgent.status === 'conflict' && (
                <ConflictCard
                  onKeepManual={aiAgent.revertChange}
                  onApplyAi={() => { void aiAgent.forceApplyChange(); }}
                  onRegenerate={aiAgent.regenerateAfterConflict}
                />
              )}
              {aiAgent.error && aiAgent.status === 'error' && (
                <ErrorCard
                  message={aiAgent.error.message}
                  canRetry={aiAgent.error.retryable}
                  cooldown={aiAgent.cooldown}
                  showSettings={aiAgent.error.kind === 'auth'}
                  onRetry={aiAgent.retry}
                  onOpenSettings={() => setAiSettingsOpen(true)}
                />
              )}
            </div>}

            {/* Input */}
            {!aiCollapsed && (
              <AiMemoryPanel
                memory={aiAgent.memory}
                disabled={!projectPath}
                onSave={aiAgent.saveMemory}
              />
            )}
            {!aiCollapsed && <div className="p-3 border-t border-border">
              <textarea
                value={aiAgent.input}
                onChange={(e) => aiAgent.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAiSend();
                  }
                }}
                disabled={aiAgent.busy || aiAgent.pendingChange?.status === 'pending'}
                className="w-full h-20 bg-input-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-60"
                placeholder={aiAgent.busy ? '生成中...' : aiAgent.pendingChange?.status === 'pending' ? '请先接受或撤销当前 AI 修改...' : '输入你的创作想法...'}
                aria-label="AI 创作输入"
              />
              {aiAgent.busy ? (
                <button
                  onClick={aiAgent.stop}
                  className="mt-2 w-full px-3 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-all flex items-center justify-center gap-2 text-sm"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>停止</span>
                </button>
              ) : (
                <button
                  onClick={handleAiSend}
                  disabled={!aiAgent.input.trim() || aiAgent.pendingChange?.status === 'pending'}
                  className="mt-2 w-full px-3 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center justify-center gap-2 text-sm disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>发送</span>
                </button>
              )}
            </div>}
          </div>
          )}
        </div>

        <AiSettingsDialog
          open={aiSettingsOpen}
          onClose={() => setAiSettingsOpen(false)}
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
