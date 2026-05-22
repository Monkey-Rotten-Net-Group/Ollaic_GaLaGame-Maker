import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import {
  Sparkles, Save, Play, Image, ArrowLeft, Send,
  Upload, Download, FileText, FolderOpen, FilePlus, Check, Loader2, SlidersHorizontal,
  Undo2, Redo2, Package, MoreHorizontal, PanelRightClose, PanelRightOpen,
} from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { NodePanel } from './NodePanel';
import { FlowCanvas } from './FlowCanvas';
import { DetailPanel } from './DetailPanel';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AppSettingsDialog, loadAppSettings } from './AppSettingsDialog';
import type { WebGalNode, WebGalCommandType } from '../lib/webgal-types';
import {
  parseScene, serializeScene, saveScene, loadScene,
  openProject, getScenePath, createScene,
  exportProject,
  setRuntimeProject, setRuntimeTemplateDir, getRuntimeUrl, jumpToSentence, openInBrowser,
  type ProjectInfo,
} from '../lib/webgal-ipc';
import {
  aiChatStream,
  extractWebGalJson,
  webGalJsonToScript,
  type AiChatMessage,
} from '../lib/ai-ipc';
import { listCharacterNames, listCharacters } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const TERMINAL_TYPES = new Set<WebGalCommandType>(['choose', 'changeScene', 'end', 'jumpLabel']);

/** Rebuild visual `connections` purely from sequential order. */
function rewireConnections(nodes: WebGalNode[]): WebGalNode[] {
  return nodes.map((node, i) => {
    const next = nodes[i + 1];
    const connections = next && !TERMINAL_TYPES.has(node.type) ? [next.id] : [];
    if (
      connections.length === node.connections.length &&
      connections.every((c, idx) => c === node.connections[idx])
    ) {
      return node;
    }
    return { ...node, connections };
  });
}

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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  // Editor state
  const [nodes, setNodes] = useState<WebGalNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<WebGalNode | null>(null);
  const [scriptSource, setScriptSource] = useState(DEMO_SCRIPT);
  const [showScript, setShowScript] = useState(false);
  const [loading, setLoading] = useState(true);

  // AI state
  const [aiInput, setAiInput] = useState('');
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: '你好，我是 AI 创作助手。可以帮你生成 WebGAL 对话、场景切换、分支选项，并输出可插入脚本的 webgal-json 结构。',
    },
  ]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
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

  const aiCancelRef = useRef<(() => void) | null>(null);
  const aiStreamingIdRef = useRef<string | null>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement | null>(null);

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
            setNodes(loaded);
            const text = await serializeScene(loaded);
            setScriptSource(text);
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

  // Undo / Redo
  const [history, setHistory] = useState<WebGalNode[][]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  const pushHistory = useCallback((nodesSnapshot: WebGalNode[]) => {
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIdx + 1);
      const next = [...trimmed, nodesSnapshot];
      if (next.length > 50) next.shift();
      return next;
    });
    setHistoryIdx(prev => Math.min(prev + 1, 49));
  }, [historyIdx]);

  const undo = useCallback(() => {
    if (historyIdx < 0) return;
    const prevNodes = history[historyIdx];
    setNodes(prevNodes);
    syncScript(prevNodes);
    setSelectedNode(null);
    setDirty(true);
    setSaveStatus('idle');
    setHistoryIdx(i => i - 1);
  }, [historyIdx, history, syncScript]);

  const redo = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    const nextIdx = historyIdx + 1;
    const nextNodes = history[nextIdx];
    setNodes(nextNodes);
    syncScript(nextNodes);
    setSelectedNode(null);
    setDirty(true);
    setSaveStatus('idle');
    setHistoryIdx(nextIdx);
  }, [historyIdx, history, syncScript]);

  // Record history before mutation
  const recordHistory = useCallback((currentNodes: WebGalNode[]) => {
    pushHistory(currentNodes);
  }, [pushHistory]);

  // Debounce timer for merging successive updateNode calls to the same node
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingRecordRef = useRef<WebGalNode[] | null>(null);

  // ---------------------------------------------------------------------------
  // Node CRUD
  // ---------------------------------------------------------------------------
  const updateNode = useCallback((id: string, updates: Partial<WebGalNode>) => {
    setNodes(prev => {
      // Record history (debounced: same-node updates within 500ms are merged)
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (!pendingRecordRef.current) {
        pendingRecordRef.current = prev;
      }
      debounceTimerRef.current = setTimeout(() => {
        if (pendingRecordRef.current) {
          pushHistory(pendingRecordRef.current);
          pendingRecordRef.current = null;
        }
      }, 500);

      const next = prev.map(n => n.id === id ? { ...n, ...updates } : n);
      syncScript(next);
      return next;
    });
    setSelectedNode(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
    markDirty();
  }, [syncScript, markDirty, pushHistory]);

  const deleteNode = useCallback((id: string) => {
    setNodes(prev => {
      pushHistory(prev);
      const next = rewireConnections(prev.filter(n => n.id !== id));
      syncScript(next);
      return next;
    });
    setSelectedNode(null);
    markDirty();
  }, [syncScript, markDirty, pushHistory]);

  const reorderNodes = useCallback((fromIndex: number, toIndex: number) => {
    setNodes(prev => {
      if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= prev.length) return prev;
      const clampedTo = Math.max(0, Math.min(toIndex, prev.length - 1));
      pushHistory(prev);
      const moved = [...prev];
      const [node] = moved.splice(fromIndex, 1);
      moved.splice(clampedTo, 0, node);
      const next = rewireConnections(moved);
      syncScript(next);
      return next;
    });
    markDirty();
  }, [syncScript, markDirty, pushHistory]);

  const insertNode = useCallback((type: WebGalCommandType, atIndex: number) => {
    setNodes(prev => {
      pushHistory(prev);
      const idx = Math.max(0, Math.min(atIndex, prev.length));
      const id = Date.now().toString();
      const newNode: WebGalNode = {
        id,
        type,
        content: '',
        flags: [],
        position: { x: 100, y: 60 + idx * 110 },
        connections: [],
      };
      if (type === 'dialogue') newNode.character = '';
      if (type === 'choose') newNode.choices = [{ text: '选项 1', target: '' }];
      if (type === 'intro') newNode.introLines = [''];
      if (type === 'setVar') { newNode.varName = ''; newNode.varValue = ''; }

      const updated = rewireConnections([...prev.slice(0, idx), newNode, ...prev.slice(idx)]);
      syncScript(updated);
      const insertedNode = updated.find(n => n.id === id) ?? newNode;
      setSelectedNode(insertedNode);
      return updated;
    });
    markDirty();
  }, [syncScript, markDirty, pushHistory]);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async () => {
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
          return;
        }
        await saveScene(selected, nodes);
      }
      setDirty(false);
      setSaveStatus('saved');
      // Reset status after 2s
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (e) {
      console.error('Save failed:', e);
      setSaveStatus('error');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [projectPath, currentSceneName, nodes]);

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
    } catch (e) {
      console.error('Open project failed:', e);
    }
  }, [projectId]);

  // ---------------------------------------------------------------------------
  // Switch scene within project
  // ---------------------------------------------------------------------------
  const handleSwitchScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;
    // Auto-save current if dirty
    if (dirty) {
      const scenePath = await getScenePath(projectPath, currentSceneName);
      await saveScene(scenePath, nodes);
    }

    setCurrentSceneName(sceneName);
    const scenePath = await getScenePath(projectPath, sceneName);
    try {
      const loaded = await loadScene(scenePath);
      setNodes(loaded);
      const text = await serializeScene(loaded);
      setScriptSource(text);
      setSelectedNode(null);
      setDirty(false);
    } catch {
      setNodes([]);
      setScriptSource('');
    }
  }, [projectPath, currentSceneName, dirty, nodes]);

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
    if (dirty) await handleSave();

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

  // ---------------------------------------------------------------------------
  // AI chat
  // ---------------------------------------------------------------------------
  useEffect(() => {
    aiMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [aiMessages]);

  // Cancel in-flight stream on unmount
  useEffect(() => () => { aiCancelRef.current?.(); }, []);

  const buildAiPayload = useCallback(
    (history: AiMessage[], next: string): AiChatMessage[] => {
      const recent = history.slice(-12); // cap context
      const payload: AiChatMessage[] = recent.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      payload.push({ role: 'user', content: next });
      return payload;
    },
    [],
  );

  const sendAiPrompt = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || aiBusy) return;
    setAiError(null);

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    aiStreamingIdRef.current = assistantId;

    const newHistory: AiMessage[] = [
      ...aiMessages,
      { id: userId, role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '' },
    ];
    setAiMessages(newHistory);
    setAiInput('');
    setAiBusy(true);

    const appendChunk = (chunk: string) => {
      setAiMessages(prev =>
        prev.map(m => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)),
      );
    };

    try {
      const charCtx = buildCharacterContext(charactersForAi);
      const { cancel } = await aiChatStream(buildAiPayload(aiMessages, text), {
        onChunk: appendChunk,
        onDone: () => {
          aiCancelRef.current = null;
          aiStreamingIdRef.current = null;
          setAiBusy(false);
        },
        onError: (msg) => {
          aiCancelRef.current = null;
          aiStreamingIdRef.current = null;
          setAiBusy(false);
          setAiError(msg);
          setAiMessages(prev =>
            prev.map(m =>
              m.id === assistantId && !m.content
                ? { ...m, content: `（错误：${msg}）` }
                : m,
            ),
          );
        },
      }, charCtx || undefined);
      aiCancelRef.current = cancel;
    } catch (e) {
      setAiBusy(false);
      setAiError(String(e));
    }
  }, [aiBusy, aiMessages, buildAiPayload, buildCharacterContext, charactersForAi]);

  const handleAiSend = () => { void sendAiPrompt(aiInput); };

  const handleInsertAiScene = useCallback(async (content: string) => {
    const scene = extractWebGalJson(content);
    if (!scene) return;
    try {
      const script = webGalJsonToScript(scene);
      const parsed = await parseScene(script);
      setNodes((prev) => {
        pushHistory(prev);
        const lastNode = prev[prev.length - 1];
        const startX = lastNode ? lastNode.position.x : 100;
        const startY = lastNode ? lastNode.position.y + 130 : 60;
        const imported = parsed.map((node, index) => ({
          ...node,
          id: `ai-${Date.now()}-${index}`,
          position: { x: startX, y: startY + index * 110 },
        }));
        const next = [...prev, ...imported];
        if (lastNode && imported.length > 0) {
          const lastIndex = next.findIndex((node) => node.id === lastNode.id);
          if (lastIndex >= 0) {
            next[lastIndex] = {
              ...next[lastIndex],
              connections: [...next[lastIndex].connections, imported[0].id],
            };
          }
        }
        syncScript(next);
        return next;
      });
      setShowScript(false);
      markDirty();
    } catch (e) {
      setAiError(String(e));
    }
  }, [markDirty, pushHistory, syncScript]);

  const handleQuickAction = (text: string) => {
    if (aiBusy) return;
    setAiInput(text);
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
                onClick={() => navigate('/')}
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
                    {projectInfo.scenes.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleNewScene}
                    className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors"
                    title="新建场景"
                    aria-label="新建场景"
                  >
                    <FilePlus className="w-4 h-4 text-muted-foreground" />
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
                onClick={() => navigate(`/editor/${projectId}/assets`)}
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
                disabled={historyIdx < 0}
                className="p-2 rounded-md hover:bg-secondary/50 transition-colors disabled:opacity-30"
                title="撤销 (Ctrl+Z)"
                aria-label="撤销"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                onClick={redo}
                disabled={historyIdx >= history.length - 1}
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
          ) : selectedNode ? (
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
          ) : (
            <FlowCanvas
              nodes={nodes}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
              onReorderNodes={reorderNodes}
              characterColors={characterColors}
            />
          )}

          {/* Right Panel - AI Chat */}
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
              <h3 className="text-sm uppercase tracking-widest text-muted-foreground font-mono-family">
                AI 创作助手
              </h3>
                </>
              )}
            </div>

            {/* Quick Actions */}
            {!aiCollapsed && <div className="p-3 border-b border-border">
              <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: '生成对话', text: '请生成一段两位角色的日常对话，至少 6 行，并附带 webgal-json 结构块。' },
                    { label: '生成场景', text: '请生成一个开场场景，包含背景、BGM、立绘入场、旁白，并附带 webgal-json 结构块。' },
                    { label: '生成分支', text: '请生成一个 choose 分支，包含 2-3 个选项，并附带 webgal-json 结构块。' },
                    { label: '续写剧情', text: '请基于当前上下文续写约 8 行对话，并附带 webgal-json 结构块。' },
                  ].map((a) => (
                  <button
                    key={a.label}
                    onClick={() => handleQuickAction(a.text)}
                    disabled={aiBusy}
                    className="px-2 py-1.5 rounded text-xs bg-secondary hover:bg-secondary/70 transition-all border border-border disabled:opacity-50"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>}

            {/* Messages */}
            {!aiCollapsed && <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {aiMessages.map((msg) => {
                const isStreaming = aiBusy && aiStreamingIdRef.current === msg.id;
                const webGalScene = msg.role === 'assistant' ? extractWebGalJson(msg.content) : null;
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary border border-border'
                      } ${msg.role === 'assistant' ? 'font-mono-family' : 'font-body-family'}`}
                    >
                      {msg.content || (isStreaming ? '思考中...' : '')}
                      {isStreaming && msg.content && <span className="inline-block w-2 h-3 ml-1 bg-current align-middle animate-pulse" />}
                    </div>
                    {webGalScene && (
                      <button
                        onClick={() => handleInsertAiScene(msg.content)}
                        className="mt-2 px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs border border-primary/30"
                      >
                        插入到脚本
                      </button>
                    )}
                  </div>
                );
              })}
              {aiError && (
                <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                  {aiError}
                  <button
                    onClick={() => setAiSettingsOpen(true)}
                    className="ml-2 underline hover:no-underline"
                  >
                    打开设置
                  </button>
                </div>
              )}
              <div ref={aiMessagesEndRef} />
            </div>}

            {/* Input */}
            {!aiCollapsed && <div className="p-3 border-t border-border">
              <textarea
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAiSend();
                  }
                }}
                disabled={aiBusy}
                className="w-full h-20 bg-input-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-60"
                placeholder={aiBusy ? '生成中...' : '输入你的创作想法...'}
                aria-label="AI 创作输入"
              />
              {aiBusy ? (
                <button
                  onClick={() => { aiCancelRef.current?.(); aiCancelRef.current = null; aiStreamingIdRef.current = null; setAiBusy(false); }}
                  className="mt-2 w-full px-3 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-all flex items-center justify-center gap-2 text-sm"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>停止</span>
                </button>
              ) : (
                <button
                  onClick={handleAiSend}
                  disabled={!aiInput.trim()}
                  className="mt-2 w-full px-3 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center justify-center gap-2 text-sm disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>发送</span>
                </button>
              )}
            </div>}
          </div>
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

      </div>
    </DndProvider>
  );
}
