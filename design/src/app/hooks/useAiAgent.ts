import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { aiChatStream, extractWebGalJson, webGalJsonToScript, type AiChatMessage } from '../lib/ai-ipc';
import { listAllAssets, type AssetInfo } from '../lib/assets-ipc';
import type { Character } from '../lib/character-types';
import { buildMemoryContext, emptyProjectMemory, readProjectMemory, saveProjectMemory, type ProjectMemory } from '../lib/project-memory';
import {
  applyStoryEditPlan,
  applyFallbackAssets,
  buildNumberedScriptContext,
  buildAssetContext,
  createLineDiff,
  extractStoryEditPlan,
  formatMissingAssetIssues,
  hasStoryEditJsonBlock,
  hasAssetContextTruncation,
  truncateContextMessages,
  validateSceneAssets,
  type DiffLine,
  type MissingAssetIssue,
} from '../lib/story-agent';
import { parseScene, serializeScene, saveScene, getScenePath } from '../lib/webgal-ipc';
import type { WebGalNode } from '../lib/webgal-types';
import { useChatSession, type ChatMessage } from './useChatSession';

export type AiPanelStatus =
  | 'idle'
  | 'generating'
  | 'validating'
  | 'pending'
  | 'accepted'
  | 'reverted'
  | 'conflict'
  | 'missing_assets'
  | 'error';

export interface AiChangeRecord {
  id: string;
  filePath: string;
  beforeContent: string;
  afterContent: string;
  diff: DiffLine[];
  summary: string;
  status: 'pending' | 'accepted' | 'reverted';
  createdAt: string;
  beforeNodes: WebGalNode[];
  afterNodes: WebGalNode[];
  baseDirty: boolean;
  sourceMessageId: string;
  warnings: string[];
}

export interface AiErrorState {
  message: string;
  kind: 'auth' | 'rate_limit' | 'timeout' | 'other';
  retryable: boolean;
}

type UserIntent = 'append' | 'edit';

export const INITIAL_AI_MESSAGE: ChatMessage = {
  id: '1',
  role: 'assistant',
  content: '你好，我是故事编织 Agent。直接告诉我你的创作想法，我会结合当前场景、角色设定和 WebGAL 格式给出建议；如果生成了可插入内容，会先进入待确认预览。',
};

interface UseAiAgentParams {
  projectId?: string;
  projectPath: string | null;
  currentSceneName: string;
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  scriptSource: string;
  dirty: boolean;
  characters: Character[];
  setNodes: (nodes: WebGalNode[]) => void;
  setScriptSource: (source: string) => void;
  setDirty: (dirty: boolean) => void;
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
  setSelectedNode: (node: WebGalNode | null) => void;
  setShowScript: (show: boolean) => void;
  pushHistory: (nodes: WebGalNode[]) => void;
}

function buildCharacterContext(chars: Character[]): string {
  if (chars.length === 0) return '';
  return chars.map(c => {
    const parts: string[] = [];
    parts.push(`- ${c.name}`);
    if (c.aliases.length > 0) parts.push(`  别名: ${c.aliases.join(', ')}`);
    if (c.personality) parts.push(`  性格: ${c.personality}`);
    if (c.description) parts.push(`  简介: ${c.description}`);
    if (c.dialogueStyle) parts.push(`  对话风格: ${c.dialogueStyle}`);
    return parts.join('\n');
  }).join('\n\n');
}

function findApproxSelectedLine(scriptSource: string, selectedNode: WebGalNode | null): number | null {
  if (!selectedNode) return null;
  const lines = scriptSource.split('\n');
  const candidates = [
    selectedNode.content,
    selectedNode.asset,
    selectedNode.character && selectedNode.content ? `${selectedNode.character}:${selectedNode.content}` : '',
    selectedNode.targetScene,
    selectedNode.labelName,
  ].filter((value): value is string => !!value && value.trim().length > 0);

  for (const candidate of candidates) {
    const index = lines.findIndex((line) => line.includes(candidate));
    if (index >= 0) return index + 1;
  }
  return null;
}

function buildSelectedNodeContext(scriptSource: string, selectedNode: WebGalNode | null, nodes: WebGalNode[]): string {
  if (!selectedNode) return '';
  const index = nodes.findIndex((node) => node.id === selectedNode.id);
  const lineNo = findApproxSelectedLine(scriptSource, selectedNode);
  return [
    `当前选中节点：${lineNo ? `推测 txt 行号 ${lineNo}` : `可视化节点序号 ${index >= 0 ? index + 1 : '未知'}`}。`,
    '如果用户说“这里”“这个节点”“当前选中内容”，优先处理该节点。',
    JSON.stringify({
      type: selectedNode.type,
      content: selectedNode.content,
      character: selectedNode.character,
      asset: selectedNode.asset,
      targetScene: selectedNode.targetScene,
      labelName: selectedNode.labelName,
      flags: selectedNode.flags,
    }, null, 2),
  ].join('\n');
}

function classifyAiError(raw: string): AiErrorState {
  const lower = raw.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return { kind: 'auth', retryable: false, message: 'API Key 无效，请前往设置重新配置' };
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return { kind: 'rate_limit', retryable: true, message: '上游 AI 服务返回 429 限流，请稍后再试。这通常是 API 厂商、模型服务或中转平台的速率/并发限制，不是本项目里的 AI 设置限制。' };
  }
  if (lower.includes('timeout') || lower.includes('connection refused')) {
    return { kind: 'timeout', retryable: true, message: '连接超时，请检查网络' };
  }
  return { kind: 'other', retryable: true, message: `AI 服务出错：${raw}` };
}

function detectUserIntent(prompt: string): UserIntent {
  const text = prompt.toLowerCase();
  const appendWords = ['新增', '追加', '续写', '加一段', '添加一段', '接着写', '插入到末尾', 'append'];
  const editWords = [
    '修改', '改成', '改一下', '完善', '优化', '调整', '替换', '删除', '删掉', '重写', '重新设计',
    '补充实现', '不是追加', '不要加在最后', '位置', '立绘切换', '没有变化', '没修改', '修正',
    'change', 'replace', 'delete', 'edit', 'rewrite',
  ];

  if (editWords.some((word) => text.includes(word))) return 'edit';
  if (appendWords.some((word) => text.includes(word))) return 'append';
  return 'append';
}

export function useAiAgent(params: UseAiAgentParams) {
  const navigate = useNavigate();
  const {
    projectId,
    projectPath,
    currentSceneName,
    nodes,
    selectedNode,
    scriptSource,
    dirty,
    characters,
    setNodes,
    setScriptSource,
    setDirty,
    setSaveStatus,
    setSelectedNode,
    setShowScript,
    pushHistory,
  } = params;

  const { messages, setMessages, clearMessages } = useChatSession(projectId, currentSceneName, INITIAL_AI_MESSAGE);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AiPanelStatus>('idle');
  const [pendingChange, setPendingChange] = useState<AiChangeRecord | null>(null);
  const [error, setError] = useState<AiErrorState | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [missingIssues, setMissingIssues] = useState<MissingAssetIssue[]>([]);
  const [lastScene, setLastScene] = useState<ReturnType<typeof extractWebGalJson> | null>(null);
  const [lastPrompt, setLastPrompt] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const cancelRef = useRef<(() => void) | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => () => { cancelRef.current?.(); }, []);

  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    streamingIdRef.current = null;
    inFlightRef.current = false;
    setBusy(false);
    setStatus('idle');
    setPendingChange(null);
    setError(null);
    setMissingIssues([]);
    setLastScene(null);
    setInput('');
  }, [currentSceneName]);

  useEffect(() => {
    if (!projectPath) {
      setAssets([]);
      setMemory(null);
      return;
    }
    let cancelled = false;
    listAllAssets(projectPath).then((list) => {
      if (!cancelled) setAssets(list);
    }).catch(() => {
      if (!cancelled) setAssets([]);
    });
    readProjectMemory(projectPath).then((value) => {
      if (!cancelled) setMemory(value);
    }).catch(() => {
      if (!cancelled) setMemory(null);
    });
    return () => { cancelled = true; };
  }, [projectPath]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const buildSystemContext = useCallback((): string => {
    const currentScript = buildNumberedScriptContext(scriptSource);
    return [
      '你是故事编织 Agent，负责把用户自然语言创作意图转换为安全的 WebGAL 创作建议。',
      '不要声称已经直接修改文件。若要提供可插入内容，必须只输出一个结构化 JSON 代码块，系统会负责转换、校验、预览和用户确认。',
      '结构化代码块必须是合法 JSON：必须使用双引号，不要尾随逗号，不要注释，不要 Markdown 列表，不要把说明文字写进 JSON 代码块。',
      '代码块外只写本次改动摘要和后续建议；不要在代码块外重复 WebGAL 脚本或 JSON。',
      '如果用户要求删除、替换、移动或改写当前脚本中的已有内容，必须使用 ```story-edit-json 代码块输出编辑方案，不要用 webgal-json 追加重复内容。',
      'story-edit-json 格式：{"type":"edit_script","summary":"...","operations":[{"kind":"delete_line","line":12},{"kind":"delete_range","startLine":12,"endLine":15},{"kind":"replace_line","line":12,"content":"角色:新台词;"},{"kind":"insert_after_line","line":12,"content":"新增内容;"}]}。行号必须对应下方带编号的当前脚本。',
      '如果用户要求新增内容或续写到末尾，使用 ```webgal-json 代码块。格式必须是 {"nodes":[...]}。支持节点：dialogue、narration、changeBg、changeFigure、miniAvatar、bgm、playEffect、playVideo、choice、changeScene、comment。',
      '引用素材时只能使用当前素材库列表中的文件名。缺少素材时，请在自然语言回复里说明缺口和可选操作，不要在 webgal-json 中编造不存在的素材名。',
      buildAssetContext(assets),
      buildCharacterContext(characters),
      buildMemoryContext(memory),
      `当前场景文件：${currentSceneName}`,
      `当前脚本（左侧数字是 txt 行号，不是可视化节点数，删除/替换必须使用这些行号）：\n${currentScript}`,
      buildSelectedNodeContext(scriptSource, selectedNode, nodes),
    ].filter(Boolean).join('\n\n');
  }, [assets, characters, currentSceneName, memory, nodes, scriptSource, selectedNode]);

  const buildPayload = useCallback((next: string): AiChatMessage[] => {
    const maxMessages = scriptSource.split('\n').length > 200 ? 6 : 12;
    const intent = detectUserIntent(next);
    return [
      { role: 'system', content: buildSystemContext() },
      ...(intent === 'edit'
        ? [{
            role: 'system' as const,
            content: [
              '本次用户请求被系统判定为“修改已有脚本”，不是追加。',
              '优先输出 story-edit-json，行号必须是当前脚本里的正整数 txt 行号。',
              '不要用 Markdown 表格描述修改，不要只写“我会修改/已修改”。必须给出可执行 JSON。',
              '如果你选择输出完整 webgal-json，系统会把它当作“替换整个当前场景”的预览，绝不会追加到末尾。',
            ].join('\n'),
          }]
        : [{
            role: 'system' as const,
            content: '本次请求若是新增剧情，才可以使用 webgal-json 追加；只要涉及已有内容变化，就必须使用 story-edit-json。',
          }]),
      ...truncateContextMessages(messages, maxMessages),
      { role: 'user', content: next },
    ];
  }, [buildSystemContext, messages, scriptSource]);

  const createPendingChangeFromContent = useCallback(async (content: string, sourceMessageId: string, warnings: string[] = [], intent: UserIntent = 'append') => {
    const editPlan = extractStoryEditPlan(content);
    if (editPlan) {
      setStatus('validating');
      try {
        const beforeNodes = nodes;
        const beforeContent = scriptSource;
        const editedContent = applyStoryEditPlan(beforeContent, editPlan);
        const afterNodes = await parseScene(editedContent);
        const afterContent = await serializeScene(afterNodes);
        if (afterContent === beforeContent) {
          setStatus('error');
          setError({ kind: 'other', retryable: true, message: 'AI 返回了编辑方案，但应用后脚本没有任何变化。请让它基于当前 txt 行号重新生成 story-edit-json。' });
          return;
        }
        const change: AiChangeRecord = {
          id: `change-${Date.now()}`,
          filePath: currentSceneName,
          beforeContent,
          afterContent,
          diff: createLineDiff(beforeContent, afterContent),
          summary: editPlan.summary || `AI 建议修改 ${currentSceneName}。`,
          status: 'pending',
          createdAt: new Date().toISOString(),
          beforeNodes,
          afterNodes,
          baseDirty: dirty,
          sourceMessageId,
          warnings,
        };
        setPendingChange(change);
        setNodes(afterNodes);
        setScriptSource(afterContent);
        setSelectedNode(null);
        setShowScript(false);
        setDirty(true);
        setSaveStatus('idle');
        setStatus('pending');
        setError(null);
      } catch (e) {
        setStatus('error');
        setError({ kind: 'other', retryable: true, message: `AI 编辑方案无法应用：${String(e)}` });
      }
      return;
    }

    if (intent === 'edit' && hasStoryEditJsonBlock(content)) {
      setStatus('error');
      setError({
        kind: 'other',
        retryable: true,
        message: 'AI 返回了 story-edit-json，但 JSON 格式或行号无效。请重试，系统会要求它使用当前 txt 正整数行号重新生成。',
      });
      return;
    }

    const scene = extractWebGalJson(content);
    setLastScene(scene);
    if (!scene) {
      if (intent === 'edit') {
        setStatus('error');
        setError({
          kind: 'other',
          retryable: true,
          message: 'AI 没有返回可执行修改方案。修改已有内容必须返回 story-edit-json；如果返回完整 webgal-json，系统会按替换当前场景预览处理。',
        });
        return;
      }
      setStatus('idle');
      return;
    }
    setStatus('validating');
    try {
      const missing = projectPath ? validateSceneAssets(scene, assets) : [];
      if (missing.length > 0) {
        setMissingIssues(missing);
        setStatus('missing_assets');
        setError({ kind: 'other', retryable: false, message: `AI 方案引用了素材库中不存在的文件，已阻止写入。\n${formatMissingAssetIssues(missing)}` });
        return;
      }

      const script = webGalJsonToScript(scene);
      const parsed = await parseScene(script);
      const beforeNodes = nodes;
      const beforeContent = scriptSource;
      const replacingWholeScene = intent === 'edit';
      const lastNode = beforeNodes[beforeNodes.length - 1];
      const startX = lastNode ? lastNode.position.x : 100;
      const startY = lastNode ? lastNode.position.y + 130 : 60;
      const imported = parsed.map((node, index) => ({
        ...node,
        id: `ai-${Date.now()}-${index}`,
        position: replacingWholeScene
          ? { x: 100, y: 60 + index * 110 }
          : { x: startX, y: startY + index * 110 },
      }));
      const afterNodes = replacingWholeScene ? imported : (imported.length > 0 ? [...beforeNodes, ...imported] : beforeNodes);
      const afterContent = await serializeScene(afterNodes);
      if (afterContent === beforeContent) {
        setStatus('error');
        setError({ kind: 'other', retryable: true, message: 'AI 生成了结构化内容，但转换后脚本没有任何变化。请让它重新输出可执行的修改方案。' });
        return;
      }
      const change: AiChangeRecord = {
        id: `change-${Date.now()}`,
        filePath: currentSceneName,
        beforeContent,
        afterContent,
        diff: createLineDiff(beforeContent, afterContent),
        summary: replacingWholeScene
          ? `AI 建议替换 ${currentSceneName} 的当前场景内容（由修改请求触发）。`
          : `AI 建议向 ${currentSceneName} 追加 ${imported.length} 个节点。`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        beforeNodes,
        afterNodes,
        baseDirty: dirty,
        sourceMessageId,
        warnings: replacingWholeScene
          ? [...warnings, '本次是修改类请求，AI 输出了完整 WebGAL 结构，系统已按“替换当前场景”生成预览，而不是追加到末尾。']
          : warnings,
      };
      setPendingChange(change);
      setNodes(afterNodes);
      setScriptSource(afterContent);
      setSelectedNode(null);
      setShowScript(false);
      setDirty(true);
      setSaveStatus('idle');
      setStatus('pending');
      setError(null);
    } catch (e) {
      setStatus('error');
      setError({ kind: 'other', retryable: true, message: `AI 修改方案无法通过 WebGAL 解析校验：${String(e)}` });
    }
  }, [assets, currentSceneName, dirty, nodes, projectPath, scriptSource, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode, setShowScript]);

  const sendPrompt = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || busy || inFlightRef.current) return;
    if (pendingChange?.status === 'pending') {
      setError({ kind: 'other', retryable: false, message: '当前还有 AI 修改方案待确认。请先接受或撤销后再继续对话。' });
      return;
    }
    inFlightRef.current = true;
    const intent = detectUserIntent(text);
    setLastPrompt(text);
    setError(null);
    setPendingChange(null);
    setMissingIssues([]);
    setStatus('generating');

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    streamingIdRef.current = assistantId;
    let assistantContent = '';
    setMessages([...messages, { id: userId, role: 'user', content: text }, { id: assistantId, role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    const appendChunk = (chunk: string) => {
      assistantContent += chunk;
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)));
    };

    try {
      const { cancel } = await aiChatStream(buildPayload(text), {
        onChunk: appendChunk,
        onDone: () => {
          cancelRef.current = null;
          streamingIdRef.current = null;
          inFlightRef.current = false;
          setBusy(false);
          setRetryCount(0);
          void createPendingChangeFromContent(assistantContent, assistantId, [], intent);
        },
        onError: (msg) => {
          cancelRef.current = null;
          streamingIdRef.current = null;
          inFlightRef.current = false;
          setBusy(false);
          setStatus('error');
          const classified = classifyAiError(msg);
          setError(classified);
          if (classified.kind === 'rate_limit') setCooldown(30);
          setMessages(prev => prev.map(m => m.id === assistantId && !m.content ? { ...m, content: `（错误：${classified.message}）` } : m));
        },
      });
      cancelRef.current = cancel;
    } catch (e) {
      inFlightRef.current = false;
      setBusy(false);
      setStatus('error');
      setError(classifyAiError(String(e)));
    }
  }, [buildPayload, busy, createPendingChangeFromContent, messages, pendingChange, setMessages]);

  const retry = useCallback(() => {
    if (!lastPrompt || busy || cooldown > 0) return;
    if (error?.kind === 'timeout' && retryCount >= 2) return;
    setRetryCount((value) => value + 1);
    void sendPrompt(lastPrompt);
  }, [busy, cooldown, error?.kind, lastPrompt, retryCount, sendPrompt]);

  const acceptChange = useCallback(async () => {
    if (!pendingChange || pendingChange.status !== 'pending') return;
    if (scriptSource !== pendingChange.afterContent) {
      setStatus('conflict');
      return;
    }
    pushHistory(pendingChange.beforeNodes);
    if (projectPath) {
      const scenePath = await getScenePath(projectPath, currentSceneName);
      await saveScene(scenePath, pendingChange.afterNodes);
      setDirty(false);
      setSaveStatus('saved');
    } else {
      setDirty(true);
      setSaveStatus('idle');
    }
    setPendingChange({ ...pendingChange, status: 'accepted' });
    setStatus('accepted');
  }, [currentSceneName, pendingChange, projectPath, pushHistory, scriptSource, setDirty, setSaveStatus]);

  const revertChange = useCallback(() => {
    if (!pendingChange) return;
    setNodes(pendingChange.beforeNodes);
    setScriptSource(pendingChange.beforeContent);
    setSelectedNode(null);
    setDirty(pendingChange.baseDirty);
    setSaveStatus('idle');
    setPendingChange({ ...pendingChange, status: 'reverted' });
    setStatus('reverted');
  }, [pendingChange, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode]);

  const forceApplyChange = useCallback(async () => {
    if (!pendingChange) return;
    pushHistory(nodes);
    setNodes(pendingChange.afterNodes);
    setScriptSource(pendingChange.afterContent);
    if (projectPath) {
      const scenePath = await getScenePath(projectPath, currentSceneName);
      await saveScene(scenePath, pendingChange.afterNodes);
      setDirty(false);
      setSaveStatus('saved');
    }
    setPendingChange({ ...pendingChange, status: 'accepted' });
    setStatus('accepted');
  }, [currentSceneName, nodes, pendingChange, projectPath, pushHistory, setDirty, setNodes, setSaveStatus, setScriptSource]);

  const regenerateAfterConflict = useCallback(() => {
    if (!pendingChange) return;
    setPendingChange({ ...pendingChange, status: 'reverted' });
    setStatus('idle');
    setInput('请基于我当前最新的脚本内容，重新生成一个不覆盖我手动修改的方案。');
  }, [pendingChange]);

  const useFallbackAssets = useCallback(() => {
    if (!lastScene) return;
    const result = applyFallbackAssets(lastScene, assets);
    if (result.unresolved.length > 0) {
      setMissingIssues(result.unresolved);
      return;
    }
    const content = `\`\`\`webgal-json\n${JSON.stringify(result.scene, null, 2)}\n\`\`\``;
    void createPendingChangeFromContent(content, `fallback-${Date.now()}`, result.replacements);
  }, [assets, createPendingChangeFromContent, lastScene]);

  const openAssets = useCallback(() => {
    if (projectId) navigate(`/editor/${projectId}/assets`);
  }, [navigate, projectId]);

  const retryWithExistingAssets = useCallback(() => {
    setStatus('idle');
    setError(null);
    setInput('请改用已有素材重新生成。');
  }, []);

  const clearConversation = useCallback(() => {
    if (busy) return;
    if (pendingChange?.status === 'pending') revertChange();
    clearMessages();
    setInput('');
    setError(null);
    setStatus('idle');
  }, [busy, clearMessages, pendingChange, revertChange]);

  const saveMemory = useCallback(async (next: ProjectMemory) => {
    if (!projectPath) return;
    const payload = next ?? emptyProjectMemory();
    await saveProjectMemory(projectPath, payload);
    setMemory(payload);
  }, [projectPath]);

  return {
    messages,
    input,
    setInput,
    busy,
    status,
    pendingChange,
    error,
    cooldown,
    hasAssetTruncation: hasAssetContextTruncation(assets),
    memory,
    missingIssues,
    streamingIdRef,
    sendPrompt,
    acceptChange,
    revertChange,
    forceApplyChange,
    regenerateAfterConflict,
    useFallbackAssets,
    openAssets,
    retryWithExistingAssets,
    retry,
    clearConversation,
    saveMemory,
    stop: () => {
      cancelRef.current?.();
      cancelRef.current = null;
      const stoppedId = streamingIdRef.current;
      streamingIdRef.current = null;
      inFlightRef.current = false;
      if (stoppedId) {
        setMessages(prev => prev.map(message => (
          message.id === stoppedId ? { ...message, stopped: true } : message
        )));
      }
      setBusy(false);
      setStatus('idle');
    },
  };
}
