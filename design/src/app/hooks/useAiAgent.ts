import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { aiChatStream, type AiChatMessage } from '../lib/ai-ipc';
import { listAllAssets, type AssetInfo } from '../lib/assets-ipc';
import type { Character } from '../lib/character-types';
import { applyEditorPatches } from '../lib/editor-executor';
import {
  describeParseError,
  extractEditorResponse,
  extractPatchAssetRefs,
  summarizePatches,
  validatePatchText,
  type EditorPatch,
  type EditorResponse,
} from '../lib/editor-patch';
import { buildMemoryContext, emptyProjectMemory, readProjectMemory, saveProjectMemory, type ProjectMemory } from '../lib/project-memory';
import {
  buildNumberedScriptContext,
  buildAssetContext,
  createLineDiff,
  formatMissingAssetIssues,
  hasAssetContextTruncation,
  truncateContextMessages,
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

export const INITIAL_AI_MESSAGE: ChatMessage = {
  id: '1',
  role: 'assistant',
  content: '你好，我是故事编辑助手。你可以直接告诉我想续写剧情、调整对白、删除片段，或者一起讨论场景节奏和人物表现。',
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
      '你是 WebGAL txt 脚本编辑器助手。',
      '输出规则：只输出一个 JSON 对象，不要 Markdown 包裹，不要解释。',
      '需要修改脚本时返回 {"patches":[...]}；只聊天讨论时返回 {"type":"chat","message":"..."}。',
      'patch type 只能是 insert、delete、replace。file 必须是当前场景文件名。',
      'insert: {"type":"insert","file":"...","afterLine":正整数或"end","anchorText":"对应行原文","text":"WebGAL txt"}。',
      'delete: {"type":"delete","file":"...","startLine":正整数,"endLine":正整数,"anchorText":"起始行原文"}。',
      'replace: {"type":"replace","file":"...","startLine":正整数,"endLine":正整数,"anchorText":"起始行原文","text":"WebGAL txt"}。',
      '行号必须对应下方带行号脚本中的 txt 行号。anchorText 请原样复制目标行完整文本，用于行号漂移兜底。',
      'text 字段直接写 WebGAL txt 行，多行用 \\n 分隔，不要写 JSON 节点结构。',
      'WebGAL txt 格式：旁白 :文本; 对话 角色名:文本; 注释 ;注释内容 背景 changeBg:文件名 -next; 立绘 changeFigure:文件名 -left/-right/-center -next; BGM bgm:文件名; 音效 playEffect:文件名; 选择 choose:标签A:场景A.txt|标签B:场景B.txt; 跳转 changeScene:场景.txt;',
      '引用素材时只能使用当前素材库列表中的文件名。缺少素材时，返回 chat 说明，不要在 patch.text 中编造不存在的素材名。',
      '不要声称已经直接修改文件；系统会生成 diff preview，只有用户接受后才写入。',
      buildAssetContext(assets),
      buildCharacterContext(characters),
      buildMemoryContext(memory),
      `当前场景文件：${currentSceneName}`,
      `当前脚本（左侧数字是 txt 行号，不是可视化节点数，删除/替换必须使用这些行号）：\n${currentScript}`,
      buildSelectedNodeContext(scriptSource, selectedNode, nodes),
    ].filter(Boolean).join('\n\n');
  }, [assets, characters, currentSceneName, memory, nodes, scriptSource, selectedNode]);

  const buildPayload = useCallback((next: string, extraMessages: AiChatMessage[] = []): AiChatMessage[] => {
    const maxMessages = scriptSource.split('\n').length > 200 ? 6 : 12;
    return [
      { role: 'system', content: buildSystemContext() },
      ...truncateContextMessages(messages, maxMessages),
      { role: 'user', content: next },
      ...extraMessages,
    ];
  }, [buildSystemContext, messages, scriptSource]);

  const replaceAssistantMessage = useCallback((messageId: string, content: string, extra?: Partial<import('./useChatSession').ChatMessage>) => {
    setMessages(prev => prev.map(message => (
      message.id === messageId ? { ...message, content, ...extra } : message
    )));
  }, [setMessages]);

  const validatePatchAssets = useCallback((patches: EditorPatch[]): MissingAssetIssue[] => {
    const available = new Set(assets.map((asset) => `${asset.category}/${asset.name}`));
    const issues: MissingAssetIssue[] = [];
    for (const patch of patches) {
      if (patch.type === 'delete') continue;
      for (const ref of extractPatchAssetRefs(patch.text)) {
        if (!available.has(`${ref.expectedCategory}/${ref.file}`)) issues.push(ref);
      }
    }
    return issues;
  }, [assets]);

  const createPendingChangeFromEditorResponse = useCallback(async (response: EditorResponse, sourceMessageId: string, warnings: string[] = []) => {
    if (response.type === 'chat') {
      replaceAssistantMessage(sourceMessageId, response.message);
      setStatus('idle');
      setError(null);
      return;
    }

    const patches = response.patches;
    if (patches.length === 0) {
      setStatus('idle');
      return;
    }
    const wrongFile = patches.find((patch) => patch.file !== currentSceneName);
    if (wrongFile) {
      setStatus('error');
      setError({ kind: 'other', retryable: true, message: `AI patch 目标文件是 ${wrongFile.file}，但当前场景是 ${currentSceneName}。` });
      return;
    }
    const textErrors = patches.flatMap((patch) => (patch.type === 'insert' || patch.type === 'replace') ? validatePatchText(patch.text) : []);
    if (textErrors.length > 0) {
      setStatus('error');
      setError({ kind: 'other', retryable: true, message: `AI patch 中的 WebGAL txt 格式无效：\n${textErrors.join('\n')}` });
      return;
    }
    const missing = projectPath ? validatePatchAssets(patches) : [];
    if (missing.length > 0) {
      setMissingIssues(missing);
      setStatus('missing_assets');
      setError({ kind: 'other', retryable: false, message: `AI patch 引用了素材库中不存在的文件，已阻止写入。\n${formatMissingAssetIssues(missing)}` });
      return;
    }

    setStatus('validating');
    try {
      const beforeNodes = nodes;
      const beforeContent = scriptSource;
      const applied = applyEditorPatches(beforeContent, patches);
      const afterNodes = await parseScene(applied.content);
      const afterContent = await serializeScene(afterNodes);
      if (afterContent === beforeContent) {
        setStatus('error');
        setError({ kind: 'other', retryable: true, message: 'AI 返回了 patch，但应用后脚本没有任何变化。请让它基于当前 txt 行号重新生成。' });
        return;
      }
      const change: AiChangeRecord = {
        id: `change-${Date.now()}`,
        filePath: currentSceneName,
        beforeContent,
        afterContent,
        diff: createLineDiff(beforeContent, afterContent),
        summary: summarizePatches(patches),
        status: 'pending',
        createdAt: new Date().toISOString(),
        beforeNodes,
        afterNodes,
        baseDirty: dirty,
        sourceMessageId,
        warnings: applied.correctedAnchors > 0 ? [...warnings, `已通过 anchorText 修正 ${applied.correctedAnchors} 处行号漂移。`] : warnings,
      };
      replaceAssistantMessage(sourceMessageId, `已生成修改预览：${change.summary}`);
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
      setError({ kind: 'other', retryable: true, message: `AI patch 无法应用或无法通过 WebGAL 解析校验：${String(e)}` });
    }
  }, [currentSceneName, dirty, nodes, projectPath, replaceAssistantMessage, scriptSource, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode, setShowScript, validatePatchAssets]);

  const sendPrompt = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || busy || inFlightRef.current) return;
    if (pendingChange?.status === 'pending') {
      setError({ kind: 'other', retryable: false, message: '当前还有 AI 修改方案待确认。请先接受或撤销后再继续对话。' });
      return;
    }
    inFlightRef.current = true;
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

    const isJsonLike = (s: string) => s.trimStart().startsWith('{') || s.trimStart().startsWith('```');

    const appendChunk = (chunk: string) => {
      assistantContent += chunk;
      // JSON 输出不实时显示，等 onDone 后替换为人读摘要；聊天回复正常流式显示
      if (!isJsonLike(assistantContent)) {
        setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)));
      }
    };

    try {
      const { cancel } = await aiChatStream(buildPayload(text), {
        onChunk: appendChunk,
        onDone: async () => {
          cancelRef.current = null;
          streamingIdRef.current = null;
          const parsed = extractEditorResponse(assistantContent);
          if (parsed) {
            inFlightRef.current = false;
            setBusy(false);
            setRetryCount(0);
            await createPendingChangeFromEditorResponse(parsed, assistantId);
            return;
          }

          // 格式错误，静默重试一次，复用原气泡
          const retryPrompt = `你的输出无法解析：${describeParseError(assistantContent)}。请只输出合法 JSON，不要 Markdown，不要解释。`;
          let retryContent = '';
          streamingIdRef.current = assistantId;
          // 清空原气泡，继续显示"思考中..."
          setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: '' } : m)));
          try {
            const retryResult = await aiChatStream(buildPayload(text, [
              { role: 'assistant', content: assistantContent },
              { role: 'user', content: retryPrompt },
            ]), {
              onChunk: (chunk) => {
                retryContent += chunk;
                if (!isJsonLike(retryContent)) {
                  setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)));
                }
              },
              onDone: async () => {
                cancelRef.current = null;
                streamingIdRef.current = null;
                inFlightRef.current = false;
                setBusy(false);
                setRetryCount(0);
                const retryParsed = extractEditorResponse(retryContent);
                if (retryParsed) {
                  await createPendingChangeFromEditorResponse(retryParsed, assistantId);
                  return;
                }
                replaceAssistantMessage(assistantId, 'AI 没有返回可执行方案，请重新描述你的需求。');
                setStatus('idle');
                setError({ kind: 'other', retryable: true, message: 'AI 没有返回可执行方案，请重新描述你的需求。' });
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
              },
            });
            cancelRef.current = retryResult.cancel;
          } catch (e) {
            inFlightRef.current = false;
            setBusy(false);
            setStatus('error');
            setError(classifyAiError(String(e)));
          }
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
  }, [buildPayload, busy, createPendingChangeFromEditorResponse, messages, pendingChange, setMessages]);

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
    replaceAssistantMessage(pendingChange.sourceMessageId, `已接受修改：${pendingChange.summary}`, { diff: pendingChange.diff });
    setPendingChange({ ...pendingChange, status: 'accepted' });
    setStatus('accepted');
  }, [currentSceneName, pendingChange, projectPath, pushHistory, replaceAssistantMessage, scriptSource, setDirty, setSaveStatus]);

  const revertChange = useCallback(() => {
    if (!pendingChange) return;
    setNodes(pendingChange.beforeNodes);
    setScriptSource(pendingChange.beforeContent);
    setSelectedNode(null);
    setDirty(pendingChange.baseDirty);
    setSaveStatus('idle');
    replaceAssistantMessage(pendingChange.sourceMessageId, `已撤销：${pendingChange.summary}`);
    setPendingChange({ ...pendingChange, status: 'reverted' });
    setStatus('reverted');
  }, [pendingChange, replaceAssistantMessage, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode]);

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
    setStatus('idle');
    setError(null);
    setInput('请改用素材库中已有的文件名重新生成 patch。如果没有合适素材，请用 chat 说明缺少什么素材。');
  }, []);

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
