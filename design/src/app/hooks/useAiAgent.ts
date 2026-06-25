import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { aiChatTurn, appendAiAgentTrace, getAiConfig, type AiChatMessage } from '../lib/ai-ipc';
import { listAllAssets, type AssetInfo } from '../lib/assets-ipc';
import {
  extractSceneBackgroundAssets,
  loadAssetMetadata,
  saveAssetMetadata,
  type AssetMetadata,
  syncSceneCardsFromBackgrounds,
} from '../lib/asset-metadata';
import { createCharacter, deleteCharacter, updateCharacter } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import {
  describeEdit,
  stageCharacterEdit,
  stageCharacterSpritesPlan,
  stageBranchEdit,
  stageCreateCharacterEdit,
  stageCreateSceneEdit,
  stageDialogueBlockInsert,
  stageFigureInsert,
  stageMemoryEdit,
  stageAssetPlanEdit,
  stageSceneEdit,
  stageSceneHeaderEdit,
  type AssetPlanEdit,
  summarizeChangeSet,
  type ChangeEdit,
  type CharacterEdit,
  type CreateCharacterEdit,
  type CreateSceneEdit,
  type MemoryEdit,
  type PendingChangeSet,
  type SceneEdit,
  type StageError,
  type StagingContext,
} from '../lib/change-set';
import { extractEditorResponse } from '../lib/editor-patch';
import { getTool, toolDefs, type StagedWrite } from '../lib/ai-tools';
import {
  buildMemoryContext,
  emptyProjectMemory,
  readProjectMemory,
  saveProjectMemory,
  type ProjectMemory,
} from '../lib/project-memory';
import {
  buildAssetContext,
  buildNumberedScriptContext,
  hasAssetContextTruncation,
  truncateContextMessages,
  type MissingAssetIssue,
} from '../lib/story-agent';
import { createScene, getScenePath, listScenes, parseScene, readFileText, saveScene, sceneDisplayName, updateSceneHeader, type SceneHeader } from '../lib/webgal-ipc';
import type { WebGalNode } from '../lib/webgal-types';
import { useChatSession, type AssistantStep, type ChatMessage, type StepToolCall } from './useChatSession';

export type AiPanelStatus =
  | 'idle'
  | 'generating'
  | 'tooling'
  | 'pending'
  | 'accepted'
  | 'reverted'
  | 'conflict'
  | 'error';

export interface AiErrorState {
  message: string;
  kind: 'auth' | 'rate_limit' | 'timeout' | 'other';
  retryable: boolean;
}

/** Providers with reliable native function-calling support. Others fall back. */
const FC_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'deepseek', 'groq', 'xai', 'cohere']);
const MAX_TURNS = 6;

interface AiAgentTraceTool {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  kind?: 'read' | 'write';
  label: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface AiAgentTraceTurn {
  turn: number;
  modelText: string;
  toolCalls: AiAgentTraceTool[];
}

interface AiAgentTrace {
  traceId: string;
  createdAt: string;
  projectId?: string;
  currentSceneName: string;
  assistantId: string;
  prompt: string;
  mode: 'function_calling' | 'legacy';
  turns: AiAgentTraceTurn[];
  outcome?: string;
  finalText?: string;
  edits?: string[];
  error?: string;
  assetCount?: number;
}

export const INITIAL_AI_MESSAGE: ChatMessage = {
  id: '1',
  role: 'assistant',
  content: '你好，我是故事编辑助手。你可以告诉我想续写剧情、调整对白、删除片段，或一起讨论场景节奏和人物表现。我可以查阅其他场景、素材库和角色设定，并跨场景/角色提出修改。',
};

interface UseAiAgentParams {
  projectId?: string;
  projectPath: string | null;
  currentSceneName: string;
  sceneHeaders: Record<string, SceneHeader>;
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
  /** Called after accepting a change set that created a new scene file. */
  onScenesChanged?: () => void;
  /** Called after accepting a change set that creates or updates characters. */
  onCharactersChanged?: () => void;
}

function buildCharacterContext(chars: Character[]): string {
  if (chars.length === 0) return '';
  return chars.map(c => {
    const parts: string[] = [`- ${c.name}（id: ${c.id}）`];
    if (c.aliases.length > 0) parts.push(`  别名: ${c.aliases.join(', ')}`);
    if (c.personality) parts.push(`  性格: ${c.personality}`);
    if (c.dialogueStyle) parts.push(`  对话风格: ${c.dialogueStyle}`);
    return parts.join('\n');
  }).join('\n');
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

const ASSET_CATEGORY_LABELS: Record<string, string> = {
  background: '背景',
  figure: '立绘',
  bgm: 'BGM',
  vocal: '语音 / 音效',
  video: '视频',
};

function searchAssetsLabel(args: Record<string, unknown>): string {
  const category = String(args.category ?? '').trim();
  const query = String(args.query ?? '').trim();
  const scope = category ? (ASSET_CATEGORY_LABELS[category] ?? category) : '全部素材';
  return query ? `正在查询${scope}中的「${query}」…` : `正在查询素材库（${scope}）…`;
}

function stepLabelForTool(name: string, args: Record<string, unknown>, headers: Record<string, SceneHeader>): string {
  const sceneName = (file: unknown) => sceneDisplayName(String(file ?? ''), headers[String(file ?? '')]);
  switch (name) {
    case 'list_scenes': return '正在列出场景…';
    case 'read_scene': return `正在读取场景「${sceneName(args.name)}」…`;
    case 'search_assets': return searchAssetsLabel(args);
    case 'list_characters': return '正在列出角色…';
    case 'get_character': return '正在读取角色设定…';
    case 'read_memory': return '正在读取项目记忆…';
    case 'edit_scene': return `正在准备修改场景「${sceneName(args.file)}」…`;
    case 'set_scene_header': return `正在整理场景「${sceneName(args.file)}」的章节信息…`;
    case 'insert_dialogue_block': return `正在写入场景「${sceneName(args.file)}」…`;
    case 'create_branch': return `正在创建分支场景「${sceneName(args.file)}」…`;
    case 'insert_figure': return `正在插入立绘「${String(args.character || '')} / ${String(args.emotion || '')}」…`;
    case 'create_character': return `正在准备新建角色「${String(args.name || '')}」…`;
    case 'plan_character_sprites': return `正在规划角色「${String(args.character || '')}」的表情槽…`;
    case 'plan_assets': return '正在规划待生成素材…';
    case 'edit_character': return '正在准备修改角色设定…';
    case 'edit_memory': return '正在准备更新项目记忆…';
    case 'create_scene': return `正在新建场景「${String(args.chapter || args.name || '')}」…`;
    default: return `正在执行 ${name}…`;
  }
}

function isStageError(value: unknown): value is StageError {
  return typeof value === 'object' && value !== null && typeof (value as StageError).message === 'string';
}

function applyAssetPlanEdit(metadata: AssetMetadata, edit: AssetPlanEdit): AssetMetadata {
  let changed = false;
  const sceneCards = { ...(metadata.sceneCards ?? {}) };
  const cgCards = { ...(metadata.cgCards ?? {}) };
  for (const card of edit.cards) {
    const { category, ...stored } = card;
    const target = category === 'cg' ? cgCards : sceneCards;
    const existing = target[card.id];
    target[card.id] = {
      ...existing,
      ...stored,
      imageAsset: existing?.imageAsset ?? stored.imageAsset ?? null,
    };
    changed = true;
  }
  return changed ? { ...metadata, sceneCards, cgCards } : metadata;
}

async function writeAgentTrace(trace: AiAgentTrace): Promise<void> {
  try {
    await appendAiAgentTrace(trace);
    console.info('[ai-agent-trace]', trace);
  } catch (e) {
    console.warn('[ai-agent-trace] write failed:', e, trace);
  }
}

export function useAiAgent(params: UseAiAgentParams) {
  const navigate = useNavigate();
  const {
    projectId,
    projectPath,
    currentSceneName,
    sceneHeaders,
    nodes,
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
    onScenesChanged,
    onCharactersChanged,
  } = params;

  const {
    messages,
    setMessages,
    sessions,
    activeId,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    ensureTitleFromFirstMessage,
  } = useChatSession(projectId, INITIAL_AI_MESSAGE);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AiPanelStatus>('idle');
  const [stepLabel, setStepLabel] = useState('');
  const [pendingChangeSet, setPendingChangeSet] = useState<PendingChangeSet | null>(null);
  const [error, setError] = useState<AiErrorState | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [lastPrompt, setLastPrompt] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const cancelledRef = useRef(false);
  const streamingIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  // Snapshot of `dirty` taken right before a preview forces it to true, so a
  // revert can restore the canvas to its real pre-preview modified state.
  const dirtyBeforePreviewRef = useRef(false);
  // Monotonic token identifying the in-flight request. A new prompt bumps this;
  // an old request's finally only touches shared UI state when its token still
  // matches, so a stale request can't clobber a newer one.
  const requestTokenRef = useRef(0);
  const currentSceneNameRef = useRef(currentSceneName);

  // Sessions are shared across scenes, and a pending change set is cross-scene
  // (each edit carries its own file + before/after snapshots). So switching
  // scenes must NOT reload the conversation nor drop the pending preview — the
  // approval card stays usable. In-flight requests keep running against the
  // scene snapshot they started with; this ref is only used to decide whether a
  // finished preview should update the currently visible canvas.
  useLayoutEffect(() => {
    currentSceneNameRef.current = currentSceneName;
  }, [currentSceneName]);

  useEffect(() => {
    if (!projectPath) {
      setAssets([]);
      setMemory(null);
      return;
    }
    let cancelled = false;
    listAllAssets(projectPath).then((list) => { if (!cancelled) setAssets(list); }).catch(() => { if (!cancelled) setAssets([]); });
    readProjectMemory(projectPath).then((value) => { if (!cancelled) setMemory(value); }).catch(() => { if (!cancelled) setMemory(null); });
    return () => { cancelled = true; };
  }, [projectPath]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const replaceAssistantMessage = useCallback((messageId: string, content: string, extra?: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(message => (message.id === messageId ? { ...message, content, ...extra } : message)));
  }, [setMessages]);

  // Slim system prompt for the tool-calling loop: current scene + "fetch on demand".
  const buildAgentSystemContext = useCallback((): string => {
    return [
      '# 角色',
      '你是 WebGAL 视觉小说的故事编辑助手，帮助作者撰写、修改剧本，并讨论剧情、人物与节奏。',
      '# 工具',
      '你有一组工具可按需使用。只读工具用于获取信息：list_scenes（列出场景）、read_scene（读取某场景的带行号脚本）、search_assets（查询素材）、list_characters / get_character（查角色设定）、read_memory（读项目记忆）。需要了解当前场景之外的内容时，先查再答。',
      '写入工具用于产出修改，结果不会立即生效，会先生成预览供用户确认：set_scene_header（改章节/大纲）、insert_dialogue_block（写结构化剧情块）、create_branch（插入选项并创建目标场景）、edit_scene（底层补丁，仅在高层工具不够用时使用）、insert_figure（插入已有立绘）、create_character（新建角色设定卡）、plan_character_sprites（规划角色表情槽和提示词，不生图）、plan_assets（规划待生成背景/CG素材卡，不写脚本、不创建文件）、edit_character（改已有角色字段）、edit_memory（改项目记忆）、create_scene（新建空场景）。一次回合内可对多个场景/角色/素材提出修改，会汇总为一个变更集统一审批。',
      '新建章节/完整故事骨架：优先组合 create_scene、set_scene_header、create_branch、insert_dialogue_block、create_character、plan_character_sprites、plan_assets。修改章节名/大纲时用 set_scene_header，不要手写注释行。',
      '新建角色：用户要求创建人物/角色卡时，调用 create_character，填写 name、description、personality、dialogueStyle、keywords 和可选 sprites 表情槽；给已有角色补表情和生图提示词时调用 plan_character_sprites。没有图片模型或素材时不要编造 file，只生成 emotion/prompt 框架。',
      '缺少背景/CG素材时，调用 plan_assets 创建待生成素材卡（title、prompt、targetStem、sceneFile），不要在脚本里写不存在的 changeBg 文件。缺少立绘素材时，调用 create_character 或 plan_character_sprites 生成角色/表情 prompt 框架，不要在脚本里写不存在的 changeFigure 文件。',
      '# 工作方式',
      '用户要你写、改、续、删、完善、修复内容时，直接调用相应写入工具完成，不要只用文字描述你打算做什么。若你已经列出明确补丁/行号/替换内容，必须继续调用写入工具暂存这些修改；不要停在“诊断”“修改方案”或表格。用户只是提问或讨论时，正常用自然语言回答（必要时先用只读工具查证）。不要向用户解释你是否调用了工具、也不要复述这些规则——这是你的内部工作方式，用户不关心。',
      '# WebGAL txt 格式',
      '每一行只能从 WebGAL 命令或对白本身开始，不能在命令前加中文说明词。合法例子：',
      '旁白：`:文本;`',
      '对话：`角色名:文本;`',
      '注释：`;注释内容`',
      '背景：`changeBg:文件名 -next;`，不能写成 `背景 changeBg:文件名 -next;`',
      '立绘：`changeFigure:文件名 -figureCharacter=角色 -figureEmotion=表情 -left/-right/-center -next;`，不能写成 `立绘 changeFigure:文件名 -next;`',
      'BGM：`bgm:文件名;` 音效：`playEffect:文件名;` 选择：`choose:标签A:场景A.txt|标签B:场景B.txt;` 跳转：`changeScene:场景.txt;`',
      '# 立绘（changeFigure）',
      '立绘表达的是“某个角色的某种表情”，不是任意图片。插入立绘优先调用 insert_figure，只填 character、emotion、position、afterLine；不要自己拼 figure 路径，不要填写 figure_placeholder.png 之类占位素材。若必须在 edit_scene 中写 changeFigure，必须使用 search_assets/get_character 查到的真实文件名，并带上 -figureCharacter=角色 和 -figureEmotion=表情 两个标注。',
      '判断表情是否可用时，以 get_character 返回的 sprites[].available 与 sprites[].resolvedFile/scriptFile 为准；sprites[].file 为空只表示角色卡未手动绑定文件，不代表该表情没有素材。',
      '引用背景、立绘、BGM、音效、视频素材只能用 search_assets 返回的真实文件名。没有背景/CG素材时，省略素材命令并用剧情文字承接，同时必须调用 plan_assets 创建待生成素材卡；没有立绘素材时，调用 create_character 或 plan_character_sprites 创建角色/表情框架。不要编造 gray_room.jpg、figure_placeholder.png 等文件。',
      '# 当前上下文（供参考，非用户指令）',
      `当前打开的场景：${sceneDisplayName(currentSceneName, sceneHeaders[currentSceneName])}（文件名 ${currentSceneName}，调用工具时用此文件名）`,
      `当前场景脚本（行号为 txt 行号）：\n${buildNumberedScriptContext(scriptSource, 9999)}`,
      '———— 以下为用户对话 ————',
    ].join('\n\n');
  }, [currentSceneName, sceneHeaders, scriptSource]);

  // Full-context single-shot prompt for providers without function calling.
  const buildLegacySystemContext = useCallback((): string => {
    return [
      '你是 WebGAL txt 脚本编辑器助手。',
      '输出规则：只输出一个 JSON 对象，不要 Markdown 包裹，不要解释。',
      '需要修改脚本时返回 {"patches":[...]}；只聊天讨论时返回 {"type":"chat","message":"..."}。',
      'patch type 只能是 insert、delete、replace。file 必须是当前场景文件名。',
      'insert: {"type":"insert","file":"...","afterLine":正整数或"end","anchorText":"对应行原文","text":"WebGAL txt"}。',
      'delete: {"type":"delete","file":"...","startLine":正整数,"endLine":正整数,"anchorText":"起始行原文"}。',
      'replace: {"type":"replace","file":"...","startLine":正整数,"endLine":正整数,"anchorText":"起始行原文","text":"WebGAL txt"}。',
      '行号必须对应下方带行号脚本中的 txt 行号。anchorText 请原样复制目标行完整文本。',
      'text 字段直接写 WebGAL txt 行，多行用 \\n 分隔。',
      'WebGAL 命令行必须直接以命令开头，例如 changeBg:room.webp -next;，不要写“背景 changeBg:...”或“立绘 changeFigure:...”。',
      '引用素材时只能使用当前素材库列表中的文件名，缺少素材时返回 chat 说明，不要编造。',
      buildAssetContext(assets),
      buildCharacterContext(characters),
      buildMemoryContext(memory),
      `当前场景：${sceneDisplayName(currentSceneName, sceneHeaders[currentSceneName])}（文件名 ${currentSceneName}）`,
      `当前脚本（左侧数字是 txt 行号）：\n${buildNumberedScriptContext(scriptSource)}`,
    ].filter(Boolean).join('\n\n');
  }, [assets, characters, currentSceneName, sceneHeaders, memory, scriptSource]);

  const buildStagingContext = useCallback((assetOverride?: AssetInfo[]): StagingContext => ({
    currentSceneName,
    currentScriptSource: scriptSource,
    currentNodes: nodes,
    assets: assetOverride ?? assets,
    characters,
    readSceneContent: async (file: string) => {
      if (!projectPath) throw new Error('当前没有打开的项目。');
      const path = await getScenePath(projectPath, file);
      return readFileText(path);
    },
    listSceneFiles: async () => {
      if (!projectPath) return [];
      return listScenes(`${projectPath}/game/scene`);
    },
    getCharacter: (id: string) => characters.find((c) => c.id === id),
    memory: memory ?? emptyProjectMemory(),
  }), [assets, characters, currentSceneName, memory, nodes, projectPath, scriptSource]);

  // Turn a finished set of staged edits into a pending change set + live preview.
  const finalizeChangeSet = useCallback((edits: ChangeEdit[], sourceMessageId: string) => {
    if (edits.length === 0) return false;
    const changeSet: PendingChangeSet = {
      id: `cs-${Date.now()}`,
      createdAt: new Date().toISOString(),
      sourceMessageId,
      status: 'pending',
      edits,
    };
    const liveSceneName = currentSceneNameRef.current;
    const currentSceneEdit = edits.find((e): e is SceneEdit => e.kind === 'scene' && e.file === liveSceneName);
    if (currentSceneEdit) {
      setNodes(currentSceneEdit.afterNodes);
      setScriptSource(currentSceneEdit.afterContent);
      setSelectedNode(null);
      setShowScript(false);
      dirtyBeforePreviewRef.current = dirty;
      setDirty(true);
      setSaveStatus('idle');
    }
    replaceAssistantMessage(sourceMessageId, `已生成修改预览：${summarizeChangeSet(changeSet, sceneHeaders)}`);
    setPendingChangeSet(changeSet);
    setStatus('pending');
    setError(null);
    return true;
  }, [dirty, sceneHeaders, replaceAssistantMessage, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode, setShowScript]);

  // --- Function-calling agent loop ----------------------------------------
  const runAgentLoop = useCallback(async (text: string, assistantId: string) => {
    const trace: AiAgentTrace = {
      traceId: `trace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      projectId,
      currentSceneName,
      assistantId,
      prompt: text,
      mode: 'function_calling',
      turns: [],
    };
    const freshAssets = projectPath ? await listAllAssets(projectPath).catch(() => assets) : assets;
    if (freshAssets !== assets) setAssets(freshAssets);
    trace.assetCount = freshAssets.length;
    const stagingCtx = buildStagingContext(freshAssets);
    const sceneEdits = new Map<string, SceneEdit>();
    const charEdits = new Map<string, CharacterEdit>();
    const createCharEdits = new Map<string, CreateCharacterEdit>();
    const createSceneEdits = new Map<string, CreateSceneEdit>();
    const assetPlanEdits: ReturnType<typeof stageAssetPlanEdit>[] = [];
    let memEdit: MemoryEdit | undefined;

    const stage = async (staged: StagedWrite): Promise<{ content: string; ok: boolean; error?: string }> => {
      try {
        if (staged.tool === 'edit_scene') {
          sceneEdits.set(staged.file, await stageSceneEdit(sceneEdits.get(staged.file), staged, stagingCtx));
        } else if (staged.tool === 'set_scene_header') {
          sceneEdits.set(staged.file, await stageSceneHeaderEdit(sceneEdits.get(staged.file), staged, stagingCtx));
        } else if (staged.tool === 'insert_dialogue_block') {
          sceneEdits.set(staged.file, await stageDialogueBlockInsert(sceneEdits.get(staged.file), staged, stagingCtx));
        } else if (staged.tool === 'create_branch') {
          const result = await stageBranchEdit(sceneEdits.get(staged.file), staged, stagingCtx);
          sceneEdits.set(staged.file, result.sourceEdit);
          for (const edit of result.createSceneEdits) createSceneEdits.set(edit.file, edit);
        } else if (staged.tool === 'insert_figure') {
          sceneEdits.set(staged.file, await stageFigureInsert(sceneEdits.get(staged.file), staged, stagingCtx));
        } else if (staged.tool === 'create_character') {
          const edit = stageCreateCharacterEdit(staged, stagingCtx);
          createCharEdits.set(edit.draft.name, edit);
        } else if (staged.tool === 'plan_character_sprites') {
          const base = characters.find((c) =>
            c.id === staged.character
            || c.name === staged.character
            || (c.aliases ?? []).includes(staged.character),
          );
          const edit = stageCharacterSpritesPlan(base ? charEdits.get(base.id) : undefined, staged, stagingCtx);
          charEdits.set(edit.id, edit);
        } else if (staged.tool === 'edit_character') {
          charEdits.set(staged.id, stageCharacterEdit(charEdits.get(staged.id), staged, stagingCtx));
        } else if (staged.tool === 'create_scene') {
          const edit = await stageCreateSceneEdit(staged, stagingCtx);
          createSceneEdits.set(edit.file, edit);
        } else if (staged.tool === 'plan_assets') {
          assetPlanEdits.push(stageAssetPlanEdit(staged));
        } else {
          memEdit = stageMemoryEdit(memEdit, staged, stagingCtx);
        }
        return { content: JSON.stringify({ staged: true, message: '已暂存，等待用户确认。' }), ok: true };
      } catch (e) {
        const msg = isStageError(e) ? e.message : String(e);
        return { content: JSON.stringify({ staged: false, error: msg }), ok: false, error: msg };
      }
    };

    const convo: AiChatMessage[] = [
      { role: 'system', content: buildAgentSystemContext() },
      ...truncateContextMessages(messages, 8),
      { role: 'user', content: text },
    ];

    // Append a finished turn (its text + tool calls) as a step on the assistant
    // message so text is never discarded and tool activity is shown inline.
    const pushStep = (step: AssistantStep) => {
      setMessages((prev) => prev.map((m) => {
        if (m.id !== assistantId) return m;
        const steps = [...(m.steps ?? []), step];
        const lastText = [...steps].reverse().find((s) => s.text)?.text ?? '';
        return { ...m, steps, content: lastText };
      }));
    };

    let finalText = '';
    const traceSummary: string[] = [];
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (cancelledRef.current) return;
      setStatus(turn === 0 ? 'generating' : 'tooling');
      setStepLabel(turn === 0 ? '思考中…' : '继续分析…');
      const res = await aiChatTurn(convo, toolDefs()).catch((e) => {
        trace.outcome = 'error';
        trace.error = String(e);
        void writeAgentTrace(trace);
        throw e;
      });
      if (cancelledRef.current) return;
      const turnText = res.text ?? '';
      const turnTrace: AiAgentTraceTurn = {
        turn,
        modelText: turnText,
        toolCalls: [],
      };
      trace.turns.push(turnTrace);

      // No tool calls → this turn's text is the final answer.
      if (res.toolCalls.length === 0) {
        if (turnText) pushStep({ text: turnText });
        finalText = turnText;
        break;
      }

      // Execute this turn's tool calls, recording each on the step for display.
      convo.push({ role: 'assistant', content: turnText, toolCalls: res.toolCalls });
      const stepCalls: StepToolCall[] = [];
      for (const call of res.toolCalls) {
        const label = stepLabelForTool(call.name, call.arguments, sceneHeaders);
        setStepLabel(label);
        const tool = getTool(call.name);
        let content: string;
        let ok = true;
        let errMsg: string | undefined;
        let resultPayload: unknown;
        if (!tool) {
          resultPayload = { error: `未知工具：${call.name}` };
          content = JSON.stringify(resultPayload);
          ok = false;
          errMsg = '未知工具';
        } else if (tool.kind === 'write') {
          try {
            const staged = (await tool.run(call.arguments, { projectPath, currentSceneName })) as StagedWrite;
            const result = await stage(staged);
            resultPayload = JSON.parse(result.content) as unknown;
            content = result.content;
            ok = result.ok;
            errMsg = result.error;
          } catch (e) {
            // Arg validation failure — feed the explicit message back so the
            // model can fix its patch instead of aborting the whole loop.
            resultPayload = { staged: false, error: String(e) };
            content = JSON.stringify(resultPayload);
            ok = false;
            errMsg = String(e);
          }
        } else {
          try {
            resultPayload = await tool.run(call.arguments, { projectPath, currentSceneName });
            content = JSON.stringify(resultPayload);
          } catch (e) {
            resultPayload = { error: String(e) };
            content = JSON.stringify(resultPayload);
            ok = false;
            errMsg = String(e);
          }
        }
        turnTrace.toolCalls.push({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          kind: tool?.kind,
          label,
          ok,
          result: resultPayload,
          error: errMsg,
        });
        stepCalls.push({ name: call.name, label, ok, error: errMsg });
        traceSummary.push(`${call.name}: ${ok ? 'ok' : `失败（${errMsg}）`}`);
        convo.push({ role: 'tool', content, toolCallId: call.id });
      }
      pushStep({ text: turnText || undefined, toolCalls: stepCalls });

      if (turn === MAX_TURNS - 1) {
        // Loop exhausted while still calling tools. Surface what happened.
        const recent = traceSummary.slice(-8).join('；');
        finalText = turnText
          || `已达到最大工具调用轮数（${MAX_TURNS}）仍未生成可确认的修改。工具调用轨迹：${recent || '无'}。`;
      }
    }

    const edits: ChangeEdit[] = [
      ...sceneEdits.values(),
      ...createCharEdits.values(),
      ...charEdits.values(),
      ...assetPlanEdits,
      ...(memEdit ? [memEdit] : []),
      ...createSceneEdits.values(),
    ];
    setStepLabel('');
    trace.finalText = finalText;
    trace.edits = edits.map((edit) => describeEdit(edit, sceneHeaders));
    if (!finalizeChangeSet(edits, assistantId)) {
      // No change set: ensure a closing text is visible. If the loop produced
      // no terminal text at all, fall back to a short note (steps still shown).
      // Read the latest messages via the functional updater — the assistant
      // placeholder was added this turn, so the captured `messages` closure
      // does not contain it and must not be used to test for steps.
      trace.outcome = finalText ? 'final_text_without_changes' : 'no_executable_changes';
      if (finalText) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: finalText } : m)));
      } else {
        setMessages((prev) => prev.map((m) => {
          if (m.id !== assistantId) return m;
          if (m.steps?.length) return m;
          return { ...m, content: '（无可执行的修改）' };
        }));
      }
      setStatus('idle');
    } else {
      trace.outcome = 'pending_preview';
    }
    void writeAgentTrace(trace);
  }, [assets, buildAgentSystemContext, buildStagingContext, currentSceneName, projectId, sceneHeaders, finalizeChangeSet, messages, projectPath, setMessages]);

  // --- Legacy single-shot for providers without function calling ----------
  const runLegacyTurn = useCallback(async (text: string, assistantId: string) => {
    const trace: AiAgentTrace = {
      traceId: `trace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      projectId,
      currentSceneName,
      assistantId,
      prompt: text,
      mode: 'legacy',
      turns: [],
    };
    setStatus('generating');
    setStepLabel('思考中…');
    const convo: AiChatMessage[] = [
      { role: 'system', content: buildLegacySystemContext() },
      ...truncateContextMessages(messages, 8),
      { role: 'user', content: text },
    ];
    const res = await aiChatTurn(convo, []).catch((e) => {
      trace.outcome = 'error';
      trace.error = String(e);
      void writeAgentTrace(trace);
      throw e;
    });
    if (cancelledRef.current) return;
    setStepLabel('');
    trace.turns.push({ turn: 0, modelText: res.text ?? '', toolCalls: [] });
    const parsed = res.text ? extractEditorResponse(res.text) : null;
    if (!parsed) {
      trace.outcome = 'invalid_legacy_response';
      trace.finalText = res.text ?? '';
      trace.error = 'AI 没有返回可执行方案';
      void writeAgentTrace(trace);
      replaceAssistantMessage(assistantId, res.text || 'AI 没有返回可执行方案，请重新描述你的需求。');
      setStatus('idle');
      return;
    }
    if (parsed.type === 'chat') {
      trace.outcome = 'final_text_without_changes';
      trace.finalText = parsed.message;
      void writeAgentTrace(trace);
      replaceAssistantMessage(assistantId, parsed.message);
      setStatus('idle');
      return;
    }
    try {
      const freshAssets = projectPath ? await listAllAssets(projectPath).catch(() => assets) : assets;
      if (freshAssets !== assets) setAssets(freshAssets);
      trace.assetCount = freshAssets.length;
      const edit = await stageSceneEdit(
        undefined,
        { tool: 'edit_scene', file: currentSceneName, patches: parsed.patches },
        buildStagingContext(freshAssets),
      );
      trace.edits = [describeEdit(edit, sceneHeaders)];
      if (!finalizeChangeSet([edit], assistantId)) {
        trace.outcome = 'no_executable_changes';
        void writeAgentTrace(trace);
        replaceAssistantMessage(assistantId, '（patch 应用后没有变化）');
        setStatus('idle');
      } else {
        trace.outcome = 'pending_preview';
        void writeAgentTrace(trace);
      }
    } catch (e) {
      const msg = isStageError(e) ? e.message : String(e);
      trace.outcome = 'stage_error';
      trace.error = msg;
      void writeAgentTrace(trace);
      setStatus('error');
      setError({ kind: 'other', retryable: true, message: msg });
    }
  }, [assets, buildLegacySystemContext, buildStagingContext, currentSceneName, projectId, projectPath, sceneHeaders, finalizeChangeSet, messages, replaceAssistantMessage]);

  const sendPrompt = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || busy || inFlightRef.current) return;
    if (pendingChangeSet?.status === 'pending') {
      setError({ kind: 'other', retryable: false, message: '当前还有 AI 修改方案待确认。请先同意或拒绝后再继续对话。' });
      return;
    }
    inFlightRef.current = true;
    cancelledRef.current = false;
    const myToken = requestTokenRef.current + 1;
    requestTokenRef.current = myToken;
    setLastPrompt(text);
    setError(null);
    setPendingChangeSet(null);
    setStatus('generating');

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    streamingIdRef.current = assistantId;
    setMessages([...messages, { id: userId, role: 'user', content: text }, { id: assistantId, role: 'assistant', content: '' }]);
    ensureTitleFromFirstMessage(text);
    setInput('');
    setBusy(true);

    try {
      const cfg = await getAiConfig();
      const useFc = FC_PROVIDERS.has(cfg.provider);
      if (useFc) await runAgentLoop(text, assistantId);
      else await runLegacyTurn(text, assistantId);
      setRetryCount(0);
    } catch (e) {
      if (!cancelledRef.current) {
        setStatus('error');
        const classified = classifyAiError(String(e));
        setError(classified);
        if (classified.kind === 'rate_limit') setCooldown(30);
        replaceAssistantMessage(assistantId, `（错误：${classified.message}）`);
      }
    } finally {
      // A newer request may have superseded us while we were awaiting. Only the
      // current owner of the token resets the shared UI state.
      if (requestTokenRef.current === myToken) {
        inFlightRef.current = false;
        streamingIdRef.current = null;
        setBusy(false);
        setStepLabel('');
      }
    }
  }, [busy, ensureTitleFromFirstMessage, messages, pendingChangeSet, replaceAssistantMessage, runAgentLoop, runLegacyTurn, setMessages]);

  const retry = useCallback(() => {
    if (!lastPrompt || busy || cooldown > 0) return;
    // Cap automatic retries for every retryable error class, not just timeouts,
    // so a persistently-failing request can't be retried without bound.
    if (retryCount >= 2) return;
    setRetryCount((value) => value + 1);
    void sendPrompt(lastPrompt);
  }, [busy, cooldown, lastPrompt, retryCount, sendPrompt]);

  const syncSceneBackgroundCard = useCallback(async (sceneFile: string, sceneNodes: WebGalNode[]) => {
    if (!projectPath) return;
    try {
      const backgroundAssets = (await listAllAssets(projectPath)).filter((asset) => asset.category === 'background');
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

  // Persist all edits atomically (all-or-rollback). No conflict guard — callers
  // decide whether the current scene's live buffer is allowed to differ.
  const persistChangeSet = useCallback(async (set: PendingChangeSet) => {
    if (!projectPath) return;
    const currentSceneEdit = set.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.file === currentSceneName);
    // Create scenes last so a failure in earlier edits never leaves an orphan
    // file (no delete_scene IPC to roll it back with). New characters can be
    // deleted during rollback, so they do not need special ordering.
    const ordered = [...set.edits].sort((a, b) => (a.kind === 'create_scene' ? 1 : 0) - (b.kind === 'create_scene' ? 1 : 0));
    let createdScene = false;
    let changedCharacters = false;
    const applied: ChangeEdit[] = [];
    const createdCharacterIds = new Map<CreateCharacterEdit, string>();
    const assetMetadataBefore = new Map<AssetPlanEdit, AssetMetadata>();
    try {
      for (const edit of ordered) {
        if (edit.kind === 'scene') {
          const path = await getScenePath(projectPath, edit.file);
          await saveScene(path, edit.afterNodes);
          await syncSceneBackgroundCard(edit.file, edit.afterNodes);
        } else if (edit.kind === 'create_character') {
          const saved = await createCharacter(projectPath, edit.draft);
          createdCharacterIds.set(edit, saved.id);
          changedCharacters = true;
        } else if (edit.kind === 'character') {
          await updateCharacter(projectPath, edit.after);
          changedCharacters = true;
        } else if (edit.kind === 'memory') {
          await saveProjectMemory(projectPath, edit.after);
          setMemory(edit.after);
        } else if (edit.kind === 'asset_plan') {
          const before = await loadAssetMetadata(projectPath, projectId);
          const after = applyAssetPlanEdit(before, edit);
          assetMetadataBefore.set(edit, before);
          if (after !== before) await saveAssetMetadata(projectPath, after);
        } else {
          // create_scene: make the file, then set its header if provided.
          await createScene(projectPath, edit.file);
          if (edit.chapter || edit.outline) {
            const path = await getScenePath(projectPath, edit.file);
            await updateSceneHeader(path, { chapter: edit.chapter, outline: edit.outline });
          }
          if (edit.initialNodes) {
            const path = await getScenePath(projectPath, edit.file);
            await saveScene(path, edit.initialNodes);
            await syncSceneBackgroundCard(edit.file, edit.initialNodes);
          }
          createdScene = true;
        }
        applied.push(edit);
      }
    } catch (e) {
      // Roll back everything already written, in reverse order. create_scene runs
      // last, so if we're here it never succeeded — nothing to delete.
      for (const edit of applied.reverse()) {
        try {
          if (edit.kind === 'scene') {
            const path = await getScenePath(projectPath, edit.file);
            await saveScene(path, edit.beforeNodes);
          } else if (edit.kind === 'create_character') {
            const savedId = createdCharacterIds.get(edit);
            if (savedId) await deleteCharacter(projectPath, savedId);
          } else if (edit.kind === 'character') {
            await updateCharacter(projectPath, edit.before);
          } else if (edit.kind === 'memory') {
            await saveProjectMemory(projectPath, edit.before);
            setMemory(edit.before);
          } else if (edit.kind === 'asset_plan') {
            const before = assetMetadataBefore.get(edit);
            if (before) await saveAssetMetadata(projectPath, before);
          }
        } catch { /* best-effort rollback */ }
      }
      setStatus('error');
      setError({ kind: 'other', retryable: false, message: `落盘失败，已回滚全部修改：${String(e)}` });
      setPendingChangeSet({ ...set, status: 'failed' });
      return;
    }

    if (currentSceneEdit) {
      pushHistory(currentSceneEdit.beforeNodes);
      setNodes(currentSceneEdit.afterNodes);
      setScriptSource(currentSceneEdit.afterContent);
      setSelectedNode(null);
      setDirty(false);
      setSaveStatus('saved');
    }
    if (createdScene) onScenesChanged?.();
    if (changedCharacters) onCharactersChanged?.();
    replaceAssistantMessage(set.sourceMessageId, `已同意修改：${summarizeChangeSet(set, sceneHeaders)}`, {
      diff: currentSceneEdit?.diff,
    });
    setPendingChangeSet({ ...set, status: 'accepted' });
    setStatus('accepted');
  }, [
    currentSceneName,
    sceneHeaders,
    onScenesChanged,
    onCharactersChanged,
    projectPath,
    pushHistory,
    replaceAssistantMessage,
    setDirty,
    setNodes,
    setSaveStatus,
    setScriptSource,
    setSelectedNode,
    syncSceneBackgroundCard,
  ]);

  const acceptChange = useCallback(async () => {
    if (!pendingChangeSet || pendingChangeSet.status !== 'pending' || !projectPath) return;
    // Conflict guard only applies when the edited scene is the one open now.
    // If the request finished while the user was on another scene, the buffer
    // may still be the original content; accepting should still apply the
    // preview. Anything else means the user changed the scene after staging.
    const currentSceneEdit = pendingChangeSet.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.file === currentSceneName);
    if (
      currentSceneEdit &&
      scriptSource !== currentSceneEdit.afterContent &&
      scriptSource !== currentSceneEdit.beforeContent
    ) {
      setStatus('conflict');
      return;
    }
    await persistChangeSet(pendingChangeSet);
  }, [currentSceneName, pendingChangeSet, persistChangeSet, projectPath, scriptSource]);

  const revertChange = useCallback(() => {
    if (!pendingChangeSet) return;
    // Only restore the live canvas if the edited scene is the one open now.
    const currentSceneEdit = pendingChangeSet.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.file === currentSceneName);
    if (currentSceneEdit) {
      setNodes(currentSceneEdit.beforeNodes);
      setScriptSource(currentSceneEdit.beforeContent);
      setSelectedNode(null);
      setDirty(dirtyBeforePreviewRef.current);
      setSaveStatus('idle');
    }
    replaceAssistantMessage(pendingChangeSet.sourceMessageId, `已拒绝：${summarizeChangeSet(pendingChangeSet, sceneHeaders)}`);
    setPendingChangeSet({ ...pendingChangeSet, status: 'reverted' });
    setStatus('reverted');
  }, [currentSceneName, sceneHeaders, pendingChangeSet, replaceAssistantMessage, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode]);

  const forceApplyChange = useCallback(async () => {
    if (!pendingChangeSet) return;
    // User chose to overwrite their manual edits with the AI preview.
    const currentSceneEdit = pendingChangeSet.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.file === currentSceneName);
    if (currentSceneEdit) {
      pushHistory(nodes);
      setNodes(currentSceneEdit.afterNodes);
      setScriptSource(currentSceneEdit.afterContent);
    }
    await persistChangeSet(pendingChangeSet);
  }, [currentSceneName, nodes, pendingChangeSet, persistChangeSet, pushHistory, setNodes, setScriptSource]);

  const regenerateAfterConflict = useCallback(() => {
    if (!pendingChangeSet) return;
    setPendingChangeSet({ ...pendingChangeSet, status: 'reverted' });
    setStatus('idle');
    setInput('请基于我当前最新的脚本内容，重新生成一个不覆盖我手动修改的方案。');
  }, [pendingChangeSet]);

  const openAssets = useCallback(() => {
    if (projectId) navigate(`/editor/${projectId}/assets`);
  }, [navigate, projectId]);

  // Reset transient UI state shared by all session-switching actions.
  const resetTransient = useCallback(() => {
    if (pendingChangeSet?.status === 'pending') revertChange();
    setInput('');
    setError(null);
    setStatus('idle');
    setPendingChangeSet(null);
  }, [pendingChangeSet, revertChange]);

  const startNewSession = useCallback(() => {
    if (busy) return;
    resetTransient();
    newSession();
  }, [busy, newSession, resetTransient]);

  const selectSession = useCallback((id: string) => {
    if (busy) return;
    resetTransient();
    switchSession(id);
  }, [busy, resetTransient, switchSession]);

  // Deletion confirmation and rename input are handled by in-app dialogs in the
  // UI layer (Tauri has no native prompt/confirm command). These just apply.
  const removeSession = useCallback((id: string) => {
    if (busy) return;
    if (id === activeId) resetTransient();
    deleteSession(id);
  }, [activeId, busy, deleteSession, resetTransient]);

  const saveMemory = useCallback(async (next: ProjectMemory) => {
    if (!projectPath) return;
    const payload = next ?? emptyProjectMemory();
    await saveProjectMemory(projectPath, payload);
    setMemory(payload);
  }, [projectPath]);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    const stoppedId = streamingIdRef.current;
    streamingIdRef.current = null;
    inFlightRef.current = false;
    if (stoppedId) {
      setMessages(prev => prev.map(message => (message.id === stoppedId ? { ...message, stopped: true } : message)));
    }
    setBusy(false);
    setStatus('idle');
    setStepLabel('');
  }, [setMessages]);

  return {
    messages,
    input,
    setInput,
    busy,
    status,
    stepLabel,
    pendingChangeSet,
    error,
    cooldown,
    hasAssetTruncation: hasAssetContextTruncation(assets),
    memory,
    streamingIdRef,
    describeEdit,
    sessions,
    activeId,
    startNewSession,
    selectSession,
    removeSession,
    renameSession,
    sendPrompt,
    acceptChange,
    revertChange,
    forceApplyChange,
    regenerateAfterConflict,
    openAssets,
    retry,
    saveMemory,
    stop,
  };
}
