import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { aiChatTurn, aiChatCancel, appendAiAgentTrace, getAiProviderCapability, type AiChatMessage } from '../lib/ai-ipc';
import {
  buildInlineUploadContext,
  buildUploadContext,
  deleteAiUpload,
  importAiUpload,
  listAiUploads,
  readAiUpload,
  type AiUpload,
  type AiUploadContent,
} from '../lib/ai-uploads-ipc';
import { listAllAssets, type AssetInfo } from '../lib/assets-ipc';
import { listCharacters } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import { applyAiChangeSet, type ApplyChangeSetResult } from '../lib/ai-change-set-ipc';
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
  type StagingDraft,
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
import { getScenePath, listScenes, readFileText, sceneDisplayName, type SceneHeader } from '../lib/webgal-ipc';
import type { WebGalNode } from '../lib/webgal-types';
import { useChatSession, type AssistantStep, type ChatAttachment, type ChatMessage, type StepToolCall } from './useChatSession';

export type AiPanelStatus =
  | 'idle'
  | 'generating'
  | 'tooling'
  | 'pending'
  | 'accepted'
  | 'reverted'
  | 'conflict'
  | 'missing_assets'
  | 'error';

export interface AiErrorState {
  message: string;
  kind: 'auth' | 'rate_limit' | 'timeout' | 'other';
  retryable: boolean;
}

/** Maximum number of agent turns before the loop falls back to a closing
 *  message. Mirrors the backend default; an explicit bounded value keeps a
 *  misconfigured Provider from running an unbounded loop on the local UI. */
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
  uploadsRevision?: number;
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
  /** Blocks editor saves for affected scenes until the backend commit settles. */
  onCommitStart?: (sceneFiles: string[]) => Promise<void> | void;
  onCommitSettled?: () => void;
  /** Returns an unsaved non-current scene draft, when one exists. */
  readSceneDraft?: (sceneFile: string) => Promise<string | undefined>;
  /** Reconciles a committed edit with the currently visible scene buffer. */
  reconcileCurrentScene?: (edit: SceneEdit) => void;
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
    case 'list_reference_files': return '正在查看已上传的参考资料…';
    case 'read_reference_file': return `正在阅读参考资料「${String(args.id || '')}」…`;
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
    uploadsRevision = 0,
    currentSceneName,
    sceneHeaders,
    nodes,
    scriptSource,
    characters,
    setNodes,
    setScriptSource,
    setDirty,
    setSaveStatus,
    setSelectedNode,
    setShowScript,
    pushHistory,
    onCommitStart,
    onCommitSettled,
    readSceneDraft,
    reconcileCurrentScene,
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
  const [committing, setCommitting] = useState(false);
  const [status, setStatus] = useState<AiPanelStatus>('idle');
  const [stepLabel, setStepLabel] = useState('');
  const [pendingChangeSet, setPendingChangeSet] = useState<PendingChangeSet | null>(null);
  const [error, setError] = useState<AiErrorState | null>(null);
  const [missingIssues, setMissingIssues] = useState<MissingAssetIssue[]>([]);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  // Reference uploads: author-attached local files the agent may read.
  // `uploads` is the project's whole store; `attachedIds` is the subset the
  // user picked for the *next* message. Sending moves that subset onto the
  // user message and clears the tray, so attaching feels one-shot.
  const [uploads, setUploads] = useState<AiUpload[]>([]);
  const [attachedIds, setAttachedIds] = useState<string[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<{ prompt: string; attachmentIds: string[] } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const cancelledRef = useRef(false);
  const streamingIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const commitInFlightRef = useRef(false);
  // Monotonic token identifying the in-flight request. A new prompt bumps this;
  // an old request's finally only touches shared UI state when its token still
  // matches, so a stale request can't clobber a newer one.
  const requestTokenRef = useRef(0);
  /// Per-Run identity shared with the backend `ChatRunRegistry`. Every awaited
  /// continuation funnels through [`ownsRun`] before applying any side effect
  /// (write trace, set error/status, replace messages, execute tools, publish
  /// Preview) so a late success or late error from Run A cannot mutate the
  /// UI after Run B has started or after Stop has fired.
  const currentRunIdRef = useRef<string | null>(null);
  const ownsRun = useCallback((runId: string) => currentRunIdRef.current === runId, []);
  const currentSceneNameRef = useRef(currentSceneName);
  const currentSceneRevisionRef = useRef(0);
  const projectPathRef = useRef(projectPath);
  const previousProjectPathRef = useRef(projectPath);
  const activeSessionIdRef = useRef(activeId);
  projectPathRef.current = projectPath;
  activeSessionIdRef.current = activeId;

  // Sessions are shared across scenes, and a pending change set is cross-scene
  // (each edit carries its own file + before/after snapshots). So switching
  // scenes must NOT reload the conversation nor drop the pending preview — the
  // approval card stays usable. In-flight requests keep running against the
  // scene snapshot they started with; this ref is only used to decide whether a
  // finished preview should update the currently visible canvas.
  useLayoutEffect(() => {
    if (currentSceneNameRef.current !== currentSceneName) currentSceneRevisionRef.current += 1;
    currentSceneNameRef.current = currentSceneName;
  }, [currentSceneName]);

  useLayoutEffect(() => {
    if (previousProjectPathRef.current === projectPath) return;
    previousProjectPathRef.current = projectPath;
    currentSceneRevisionRef.current += 1;
    requestTokenRef.current += 1;
    const staleRunId = currentRunIdRef.current;
    currentRunIdRef.current = null;
    cancelledRef.current = true;
    inFlightRef.current = false;
    streamingIdRef.current = null;
    if (staleRunId) void aiChatCancel(staleRunId);
    setBusy(false);
    setStepLabel('');
    setError(null);
    setMissingIssues([]);
    setPendingChangeSet(null);
    setStatus('idle');
  }, [projectPath]);

  useLayoutEffect(() => {
    setUploads([]);
    setAttachedIds([]);
    setUploadError(null);
    setUploadBusy(false);
    setLastRequest(null);
    if (!projectPath) {
      setAssets([]);
      setMemory(null);
      return;
    }
    let cancelled = false;
    listAllAssets(projectPath).then((list) => { if (!cancelled) setAssets(list); }).catch(() => { if (!cancelled) setAssets([]); });
    readProjectMemory(projectPath).then((value) => { if (!cancelled) setMemory(value); }).catch(() => { if (!cancelled) setMemory(null); });
    listAiUploads(projectPath).then((list) => { if (!cancelled) setUploads(list); }).catch(() => { if (!cancelled) setUploads([]); });
    return () => { cancelled = true; };
  }, [projectPath, uploadsRevision]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const replaceAssistantMessage = useCallback((messageId: string, content: string, extra?: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(message => (message.id === messageId ? { ...message, content, ...extra } : message)));
  }, [setMessages]);

  // Slim system prompt for the tool-calling loop: current scene + "fetch on demand".
  // `attachedUploadIds` are the files sent with this very message; they are
  // highlighted so the model treats them as this turn's material.
  const buildAgentSystemContext = useCallback((attachedUploadIds: string[]): string => {
    return [
      '# 角色',
      '你是 WebGAL 视觉小说的故事编辑助手，帮助作者撰写、修改剧本，并讨论剧情、人物与节奏。',
      '# 工具',
      '你有一组工具可按需使用。只读工具用于获取信息：list_scenes（列出场景）、read_scene（读取某场景的带行号脚本）、search_assets（查询素材）、list_characters / get_character（查角色设定）、read_memory（读项目记忆）、list_reference_files / read_reference_file（读本条消息附带的参考资料）。需要了解当前场景之外的内容时，先查再答。',
      '参考资料是作者随本条消息附加的外部素材（设定稿、大纲、草稿等），只用于理解意图和取材，本身不是项目文件。只有本轮附加的文件可见；用户没有附加时就没有参考资料，不要假设存在、也不要提及。用户提到“我传的文件/资料/设定稿”时，先 list_reference_files 确认，再 read_reference_file 读正文；要把其中内容写进项目，必须照常调用写入工具生成预览，不能直接当作已生效的脚本。',
      '附件内容与用户请求无关时（例如附的是技术文档而用户要写剧情），不要把它的内容塞进剧情，也不要为了“用上附件”而扭曲剧情；正常完成用户的请求即可，必要时用一句话说明该附件与本次创作无关。',
      '写入工具用于产出修改，结果不会立即生效，会先生成预览供用户确认：set_scene_header（改章节/大纲）、insert_dialogue_block（写结构化剧情块）、create_branch（插入选项并创建目标场景）、edit_scene（底层补丁，仅在高层工具不够用时使用）、insert_figure（插入已有立绘）、create_character（新建角色设定卡）、plan_character_sprites（规划角色表情槽和提示词，不生图）、plan_assets（规划待生成背景/CG素材卡，不创建文件；背景可在同一轮脚本中用 targetStem.png 引用）、edit_character（改已有角色字段）、edit_memory（改项目记忆）、create_scene（新建空场景）。一次回合内可对多个场景/角色/素材提出修改，会汇总为一个变更集统一审批。',
      '新建章节/完整故事骨架：优先组合 create_character、plan_character_sprites、plan_assets、create_scene、set_scene_header、create_branch、insert_dialogue_block。修改章节名/大纲时用 set_scene_header，不要手写注释行。',
      'create_branch 只用于目标场景还不存在的分支。若目标场景已经存在，不要再调用 create_branch；用 edit_scene 在源场景插入 choose，并分别用 insert_dialogue_block 填写这些已有目标场景。',
      '新建角色：用户要求创建人物/角色卡时，调用 create_character，填写 name、description、personality、dialogueStyle、keywords 和可选 sprites 表情槽；给已有角色补表情和生图提示词时调用 plan_character_sprites。没有图片模型或素材时不要编造 file，只生成 emotion/prompt 框架。',
      '缺少背景/CG素材时，先调用 plan_assets 创建待生成素材卡（title、prompt、targetStem、sceneFile），再把需要切换背景的位置写成 `changeBg:<targetStem>.png -next;`；这就是脚本里的素材标记，不要用普通注释代替。缺少立绘素材时，调用 create_character 或 plan_character_sprites 生成角色/表情 prompt 框架，不要在脚本里写不存在的 changeFigure 文件。',
      '# 从零搭完整故事的方法论',
      '1. 先定可执行蓝图：主线目标、关键冲突、章节/分支结构、场景文件名、每个场景的用途。用户已给方向时直接沿用，不要停在提问。',
      '2. 先建人物：对主要说话角色调用 create_character；同时规划必要 sprites 表情槽和 prompt。玩家代入主角可以有角色卡和对白风格，但默认不安排立绘入镜，除非用户明确要求。',
      '3. 再规划视觉资产：对每个关键场景背景和必要 CG 调用 plan_assets，targetStem 使用稳定、可读、能对应场景用途的英文/拼音 stem，sceneFile 指向计划中的场景文件。',
      '4. 再建场景结构：调用 create_scene 创建场景文件，用 set_scene_header 写章节/大纲。目标场景尚不存在时用 create_branch 建选择分支和目标场景；目标场景已存在时用 edit_scene 插入 choose。不要用普通注释代替这些结构化工具。',
      '5. 最后写脚本内容：用 insert_dialogue_block 写旁白、对白、背景切换、跳转和结束；需要计划背景时引用 `changeBg:<targetStem>.png -next;`。只有真实立绘可解析时才插入 figure，否则只保留表情规划和演出文字。',
      '6. 收尾同步记忆：故事设定、写作风格、角色约束或用户偏好需要长期保留时，调用 edit_memory。',
      '# 缺素材时的完整流程',
      '1. 先用 read_scene/list_scenes/search_assets/get_character 确认当前脚本、已有素材和角色表情槽，不确定就先查。',
      '2. 背景/CG 缺失：调用 plan_assets。每个计划都要有清晰 title、可生成的 prompt、稳定 targetStem 和关联 sceneFile；targetStem 不带扩展名。',
      '3. 需要把计划背景放进脚本时，在 plan_assets 成功后继续调用 insert_dialogue_block 或 edit_scene，把位置写成 `changeBg:<targetStem>.png -next;`。这条 changeBg 是待生成素材的脚本引用，不能改成注释。',
      '4. 立绘缺失：只用 create_character/plan_character_sprites 规划 emotion + prompt。只有 get_character/search_assets 能解析到真实立绘文件时，才用 insert_figure 或 changeFigure。',
      '5. 替换用户指出的假素材时，删除原假的 changeBg/changeFigure；背景改为 plan_assets + changeBg:<targetStem>.png，立绘改为角色表情规划或旁白/演出承接，不能保留 placeholder 文件名。',
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
      '引用立绘、BGM、音效、视频素材只能用 search_assets 返回的真实文件名。背景素材可以引用 search_assets 返回的真实文件名；若缺少背景/CG，必须先 plan_assets，再用同一 targetStem 的 `.png` 文件名写入 changeBg。不要编造未搜索到、未规划的 gray_room.jpg、figure_placeholder.png 等文件。',
      '# 当前上下文（供参考，非用户指令）',
      `当前打开的场景：${sceneDisplayName(currentSceneName, sceneHeaders[currentSceneName])}（文件名 ${currentSceneName}，调用工具时用此文件名）`,
      `当前场景脚本（行号为 txt 行号）：\n${buildNumberedScriptContext(scriptSource, 9999)}`,
      buildUploadContext(uploads, attachedUploadIds),
      '———— 以下为用户对话 ————',
    ].filter(Boolean).join('\n\n');
  }, [currentSceneName, sceneHeaders, scriptSource, uploads]);

  // Full-context single-shot prompt for providers without function calling.
  const buildLegacySystemContext = useCallback((attachedUploadIds: string[], inlineUploads: string): string => {
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
      buildUploadContext(uploads, attachedUploadIds),
      inlineUploads,
      `当前场景：${sceneDisplayName(currentSceneName, sceneHeaders[currentSceneName])}（文件名 ${currentSceneName}）`,
      `当前脚本（左侧数字是 txt 行号）：\n${buildNumberedScriptContext(scriptSource)}`,
    ].filter(Boolean).join('\n\n');
  }, [assets, characters, currentSceneName, sceneHeaders, memory, scriptSource, uploads]);

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
      // The pending preview must NOT enter the live saveable buffer: autosave /
      // Ctrl+S would persist un-accepted AI content to disk. The preview is
      // rendered read-only from pendingChangeSet (aiPreviewEntries), so only
      // view state changes here — never nodes/scriptSource/dirty.
      setSelectedNode(null);
      setShowScript(false);
    }
    replaceAssistantMessage(sourceMessageId, `已生成修改预览：${summarizeChangeSet(changeSet, sceneHeaders)}`);
    setPendingChangeSet(changeSet);
    setStatus('pending');
    setError(null);
    setMissingIssues([]);
    return true;
  }, [sceneHeaders, replaceAssistantMessage, setSelectedNode, setShowScript]);

  // --- Function-calling agent loop ----------------------------------------
  const runAgentLoop = useCallback(async (runId: string, text: string, assistantId: string, attachedUploadIds: string[]) => {
    const trace: AiAgentTrace = {
      traceId: runId,
      createdAt: new Date().toISOString(),
      projectId,
      currentSceneName,
      assistantId,
      prompt: text,
      mode: 'function_calling',
      turns: [],
    };
    const freshAssets = projectPath ? await listAllAssets(projectPath).catch(() => assets) : assets;
    // A Stop or run-supersede arriving during the asset refresh must NOT leak
    // stale assets onto the next prompt's canvas, nor count them on the trace.
    if (!ownsRun(runId)) return;
    if (cancelledRef.current) return;
    if (freshAssets !== assets) setAssets(freshAssets);
    trace.assetCount = freshAssets.length;
    const plannedAssetKeys = new Set<string>();
    const draft: StagingDraft = { sceneFiles: new Map(), characters: new Map() };
    const stagingCtx = { ...buildStagingContext(freshAssets), plannedAssetKeys, draft };
    const sceneEdits = new Map<string, SceneEdit>();
    const charEdits = new Map<string, CharacterEdit>();
    const createCharEdits = new Map<string, CreateCharacterEdit>();
    const createSceneEdits = new Map<string, CreateSceneEdit>();
    const assetPlanEdits: ReturnType<typeof stageAssetPlanEdit>[] = [];
    const missingAssetsByScene = new Map<string, MissingAssetIssue[]>();
    let memEdit: MemoryEdit | undefined;

    const stage = async (staged: StagedWrite): Promise<{ content: string; ok: boolean; error?: string }> => {
      const stagedSceneFile = 'file' in staged && typeof staged.file === 'string' ? staged.file : null;
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
          for (const edit of result.createSceneEdits) {
            createSceneEdits.set(edit.file, edit);
            stagingCtx.draft?.sceneFiles.set(edit.file, edit.initialContent ?? '');
          }
        } else if (staged.tool === 'insert_figure') {
          sceneEdits.set(staged.file, await stageFigureInsert(sceneEdits.get(staged.file), staged, stagingCtx));
        } else if (staged.tool === 'create_character') {
          const edit = stageCreateCharacterEdit(staged, stagingCtx);
          createCharEdits.set(edit.draft.name, edit);
        } else if (staged.tool === 'plan_character_sprites') {
          const draftCharacters = stagingCtx.draft
            ? Array.from(stagingCtx.draft.characters.values())
            : [];
          const base = [...characters, ...draftCharacters].find((c) =>
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
          const edit = stageAssetPlanEdit(staged);
          assetPlanEdits.push(edit);
          for (const card of edit.cards) {
            if (card.category !== 'background') continue;
            const filename = `${card.targetStem}.png`;
            plannedAssetKeys.add(`background/${filename}`);
          }
          return {
            content: JSON.stringify({
              staged: true,
              message: '已暂存素材规划。需要把该背景放进脚本时，使用 returned scriptAsset 写 changeBg。',
              plannedAssets: edit.cards.map((card) => ({
                category: card.category,
                title: card.title,
                sceneFile: card.sceneFile,
                targetStem: card.targetStem,
                scriptAsset: card.category === 'background' ? `${card.targetStem}.png` : undefined,
              })),
            }),
            ok: true,
          };
        } else {
          memEdit = stageMemoryEdit(memEdit, staged, stagingCtx);
        }
        return { content: JSON.stringify({ staged: true, message: '已暂存，等待用户确认。' }), ok: true };
      } catch (e) {
        const msg = isStageError(e) ? e.message : String(e);
        if (stagedSceneFile && isStageError(e) && e.missingAssets?.length) {
          missingAssetsByScene.set(stagedSceneFile, e.missingAssets);
        }
        return { content: JSON.stringify({ staged: false, error: msg }), ok: false, error: msg };
      }
    };

    const convo: AiChatMessage[] = [
      { role: 'system', content: buildAgentSystemContext(attachedUploadIds) },
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
      if (!ownsRun(runId)) return;
      if (cancelledRef.current) return;
      setStatus(turn === 0 ? 'generating' : 'tooling');
      setStepLabel(turn === 0 ? '思考中…' : '继续分析…');
      let res: Awaited<ReturnType<typeof aiChatTurn>>;
      try {
        res = await aiChatTurn(runId, convo, toolDefs());
      } catch (e) {
        // Late reject (e.g. Provider returned *after* Stop, or after Run B
        // started): never write trace or surface an error unless this loop
        // still owns the run. Dropping the rejection (rather than
        // re-rejecting) also avoids an unhandled rejection when no one is
        // awaiting this loop anymore.
        if (!ownsRun(runId)) return;
        trace.outcome = 'error';
        trace.error = String(e);
        void writeAgentTrace(trace);
        throw e;
      }
      if (!ownsRun(runId)) return;
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
        if (!ownsRun(runId)) return;
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
            const staged = (await tool.run(call.arguments, { projectPath, currentSceneName, attachedUploadIds })) as StagedWrite;
            if (!ownsRun(runId)) return;
            const result = await stage(staged);
            if (!ownsRun(runId)) return;
            resultPayload = JSON.parse(result.content) as unknown;
            content = result.content;
            ok = result.ok;
            errMsg = result.error;
          } catch (e) {
            // Arg validation failure — feed the explicit message back so the
            // model can fix its patch instead of aborting the whole loop.
            if (!ownsRun(runId)) return;
            resultPayload = { staged: false, error: String(e) };
            content = JSON.stringify(resultPayload);
            ok = false;
            errMsg = String(e);
          }
        } else {
          try {
            resultPayload = await tool.run(call.arguments, { projectPath, currentSceneName, attachedUploadIds });
            if (!ownsRun(runId)) return;
            content = JSON.stringify(resultPayload);
          } catch (e) {
            if (!ownsRun(runId)) return;
            resultPayload = { error: String(e) };
            content = JSON.stringify(resultPayload);
            ok = false;
            errMsg = String(e);
          }
        }
        if (!ownsRun(runId)) return;
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
      if (!ownsRun(runId)) return;
      pushStep({ text: turnText || undefined, toolCalls: stepCalls });

      if (turn === MAX_TURNS - 1) {
        // Loop exhausted while still calling tools. Surface what happened.
        const recent = traceSummary.slice(-8).join('；');
        finalText = turnText
          || `已达到最大工具调用轮数（${MAX_TURNS}）仍未生成可确认的修改。工具调用轨迹：${recent || '无'}。`;
      }
    }

    // A resource created in this turn has no durable identity/path yet. Fold
    // all dependent edits into the create request so acceptance never tries to
    // update a temporary character id or save a scene before it exists.
    for (const [file, createEdit] of createSceneEdits) {
      const sceneEdit = sceneEdits.get(file);
      if (!sceneEdit) continue;
      createSceneEdits.set(file, {
        ...createEdit,
        initialContent: sceneEdit.afterContent,
        initialNodes: sceneEdit.afterNodes,
      });
      sceneEdits.delete(file);
    }
    for (const [name, createEdit] of createCharEdits) {
      const characterEdit = charEdits.get(createEdit.draft.id);
      if (!characterEdit) continue;
      createCharEdits.set(name, {
        ...createEdit,
        draft: characterEdit.after,
        changedFields: Array.from(new Set([
          ...createEdit.changedFields,
          ...characterEdit.changedFields,
        ])),
      });
      charEdits.delete(createEdit.draft.id);
      stagingCtx.draft?.characters.set(createEdit.draft.id, characterEdit.after);
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
    const unresolvedMissingAssets = Array.from(missingAssetsByScene.values()).flat();
    if (unresolvedMissingAssets.length > 0) {
      trace.outcome = 'missing_assets';
      trace.error = '修改方案引用了素材库中不存在的文件';
      setMissingIssues(unresolvedMissingAssets);
      setError(null);
      setStatus('missing_assets');
      void writeAgentTrace(trace);
      return;
    }
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
  }, [assets, buildAgentSystemContext, buildStagingContext, currentSceneName, ownsRun, projectId, sceneHeaders, finalizeChangeSet, messages, projectPath, setMessages]);

  // --- Legacy single-shot for providers without function calling ----------
  const runLegacyTurn = useCallback(async (runId: string, text: string, assistantId: string, attachedUploadIds: string[]) => {
    const trace: AiAgentTrace = {
      traceId: runId,
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
    // Legacy providers have no tools, so the attached text must be inlined or
    // the attachment would be invisible to them.
    const inlineUploads = projectPath && attachedUploadIds.length > 0
      ? await buildInlineUploadContext(projectPath, uploads, attachedUploadIds).catch(() => '')
      : '';
    // Stop or run-supersede during attachment inlining must NOT continue into
    // a Provider turn that will see stale uploads (or worse, use the inline
    // text after Stop).
    if (!ownsRun(runId)) return;
    if (cancelledRef.current) return;
    const convo: AiChatMessage[] = [
      { role: 'system', content: buildLegacySystemContext(attachedUploadIds, inlineUploads) },
      ...truncateContextMessages(messages, 8),
      { role: 'user', content: text },
    ];
    let res: Awaited<ReturnType<typeof aiChatTurn>>;
    try {
      res = await aiChatTurn(runId, convo, []);
    } catch (e) {
      // Late reject: do not mutate the trace or UI for a Stopped run or for
      // a run that has been superseded by Run B. Without this guard a
      // Provider that does not honor transport cancellation would still
      // flip the UI from `idle` back to `error` minutes later.
      if (!ownsRun(runId)) return;
      trace.outcome = 'error';
      trace.error = String(e);
      void writeAgentTrace(trace);
      throw e;
    }
    if (!ownsRun(runId)) return;
    if (cancelledRef.current) return;
    setStepLabel('');
    trace.turns.push({ turn: 0, modelText: res.text ?? '', toolCalls: [] });
    const parsed = res.text ? extractEditorResponse(res.text) : null;
    if (!ownsRun(runId)) return;
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
      if (!ownsRun(runId)) return;
      if (freshAssets !== assets) setAssets(freshAssets);
      trace.assetCount = freshAssets.length;
      const edit = await stageSceneEdit(
        undefined,
        { tool: 'edit_scene', file: currentSceneName, patches: parsed.patches },
        buildStagingContext(freshAssets),
      );
      if (!ownsRun(runId)) return;
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
      // Stage/edit failure must not flip UI to `error` once this run has
      // been Stopped or superseded. Without this guard a Provider that
      // races a Stop request would still write a stale trace row and a
      // misleading error banner.
      if (!ownsRun(runId)) return;
      const msg = isStageError(e) ? e.message : String(e);
      trace.outcome = 'stage_error';
      trace.error = msg;
      void writeAgentTrace(trace);
      if (isStageError(e) && e.missingAssets?.length) {
        setMissingIssues(e.missingAssets);
        setError(null);
        setStatus('missing_assets');
      } else {
        setStatus('error');
        setError({ kind: 'other', retryable: true, message: msg });
      }
    }
  }, [assets, buildLegacySystemContext, buildStagingContext, currentSceneName, ownsRun, projectId, projectPath, sceneHeaders, finalizeChangeSet, messages, replaceAssistantMessage]);

  const sendPrompt = useCallback(async (prompt: string, retryAttachmentIds?: string[]) => {
    const text = prompt.trim();
    if (!text || busy || inFlightRef.current || commitInFlightRef.current) return;
    if (pendingChangeSet?.status === 'pending') {
      setError({ kind: 'other', retryable: false, message: '当前还有 AI 修改方案待确认。请先同意或拒绝后再继续对话。' });
      return;
    }
    inFlightRef.current = true;
    cancelledRef.current = false;
    const myToken = requestTokenRef.current + 1;
    requestTokenRef.current = myToken;
    // Install the per-Run identity before any awaited IPC can resolve. Every
    // awaited continuation in runAgentLoop / runLegacyTurn reads this ref
    // through `ownsRun(runId)`. Replacing it on a new prompt instantly
    // invalidates every in-flight callback for the previous Run, so late
    // success/error cannot reach the UI.
    const myRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentRunIdRef.current = myRunId;
    setError(null);
    setMissingIssues([]);
    setPendingChangeSet(null);
    setStatus('generating');

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    streamingIdRef.current = assistantId;
    // Attachments belong to this message: record them on the bubble and clear
    // the input tray, so attaching reads as a one-shot "sent with it" action.
    // The files themselves stay in the project store and remain readable later.
    const requestedIds = retryAttachmentIds ?? attachedIds;
    const sentIds = requestedIds.filter((id) => uploads.some((upload) => upload.id === id));
    setLastRequest({ prompt: text, attachmentIds: sentIds });
    const sentAttachments: ChatAttachment[] = sentIds.map((id) => {
      const upload = uploads.find((value) => value.id === id)!;
      return { id: upload.id, name: upload.name, lineCount: upload.lineCount, size: upload.size };
    });
    setMessages([
      ...messages,
      { id: userId, role: 'user', content: text, ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}) },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setAttachedIds([]);
    ensureTitleFromFirstMessage(text);
    setInput('');
    setBusy(true);

    try {
      // Ask the backend for the resolved capability rather than routing off the
      // provider string locally, so settings (custom-endpoint tools flag, JSON
      // mode, streaming cancellation, media URL output, Flow/media deadlines)
      // and the conversational router share one source of truth. A Stop fired
      // between invoke and resolve must not flip a stale result into the UI.
      const capability = await getAiProviderCapability();
      if (!ownsRun(myRunId)) return;
      if (cancelledRef.current) return;
      if (capability.chatTools) await runAgentLoop(myRunId, text, assistantId, sentIds);
      else await runLegacyTurn(myRunId, text, assistantId, sentIds);
      setRetryCount(0);
    } catch (e) {
      if (!ownsRun(myRunId)) return;
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
        // Release the per-Run identity so any *late* Provider response that
        // arrives after this finally runs is correctly classified as
        // "superseded" by ownsRun checks inside runAgentLoop / runLegacyTurn.
        if (currentRunIdRef.current === myRunId) currentRunIdRef.current = null;
      }
    }
  }, [attachedIds, busy, ensureTitleFromFirstMessage, messages, pendingChangeSet, replaceAssistantMessage, runAgentLoop, runLegacyTurn, setMessages, uploads]);

  const retry = useCallback(() => {
    if (!lastRequest || busy || cooldown > 0) return;
    // Cap automatic retries for every retryable error class, not just timeouts,
    // so a persistently-failing request can't be retried without bound.
    if (retryCount >= 2) return;
    setRetryCount((value) => value + 1);
    void sendPrompt(lastRequest.prompt, lastRequest.attachmentIds);
  }, [busy, cooldown, lastRequest, retryCount, sendPrompt]);

  const persistChangeSet = useCallback(async (
    set: PendingChangeSet,
    options: { force: boolean; historyNodes?: WebGalNode[] },
  ) => {
    if (!projectPath) return;
    const operationProjectPath = projectPath;
    const operationSessionId = activeId;
    const sceneRevision = currentSceneRevisionRef.current;
    const currentSceneEdit = set.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.file === currentSceneName);
    let result: ApplyChangeSetResult;
    try {
      result = await applyAiChangeSet(
        operationProjectPath,
        set,
        { file: currentSceneName, content: scriptSource },
        options.force,
      );
    } catch (e) {
      if (projectPathRef.current !== operationProjectPath || activeSessionIdRef.current !== operationSessionId) return;
      setStatus('error');
      setError({
        kind: 'other',
        retryable: true,
        message: `无法确认修改是否提交成功。请重新打开项目核对磁盘内容后再重试：${String(e)}`,
      });
      return;
    }

    if (projectPathRef.current !== operationProjectPath || activeSessionIdRef.current !== operationSessionId) return;

    if (result.outcome === 'conflict') {
      setStatus('conflict');
      return;
    }
    if (result.outcome === 'failed') {
      setStatus('error');
      if (result.recovery.status === 'not_needed') {
        setError({
          kind: 'other',
          retryable: true,
          message: `修改在「${result.resource}」处提交前失败，项目尚未写入。请检查该资源后重试：${result.message}`,
        });
        return;
      }
      setPendingChangeSet({ ...set, status: 'failed' });
      if (result.recovery.status === 'restored') {
        setError({
          kind: 'other',
          retryable: false,
          message: `修改在「${result.resource}」处写入失败，项目已恢复到提交前状态。请排除写入问题后重新生成修改：${result.message}`,
        });
      } else {
        setError({
          kind: 'other',
          retryable: false,
          message: `修改在「${result.resource}」处写入失败，自动恢复也失败，项目可能只写入了一部分。恢复快照「${result.recovery.snapshotId}」已保留；请先在快照管理中恢复它。写入错误：${result.message}；恢复错误：${result.recovery.message}`,
        });
      }
      return;
    }

    if (currentSceneEdit && currentSceneRevisionRef.current === sceneRevision) {
      if (reconcileCurrentScene) {
        reconcileCurrentScene(currentSceneEdit);
      } else {
        pushHistory(options.historyNodes ?? currentSceneEdit.beforeNodes);
        setNodes(currentSceneEdit.afterNodes);
        setScriptSource(currentSceneEdit.afterContent);
        setSelectedNode(null);
        setDirty(false);
        setSaveStatus('saved');
      }
    }
    if (set.edits.some((edit) => edit.kind === 'create_scene')) onScenesChanged?.();
    if (set.edits.some((edit) => edit.kind === 'character' || edit.kind === 'create_character')) onCharactersChanged?.();
    const memoryEdit = set.edits.find((edit): edit is MemoryEdit => edit.kind === 'memory');
    if (memoryEdit) setMemory(memoryEdit.after);
    replaceAssistantMessage(set.sourceMessageId, `已同意修改：${summarizeChangeSet(set, sceneHeaders)}`, {
      diff: currentSceneEdit?.diff,
    });
    setPendingChangeSet({ ...set, status: 'accepted' });
    setStatus('accepted');
  }, [
    activeId,
    currentSceneName,
    sceneHeaders,
    onScenesChanged,
    onCharactersChanged,
    projectPath,
    pushHistory,
    reconcileCurrentScene,
    replaceAssistantMessage,
    setDirty,
    setNodes,
    setSaveStatus,
    setScriptSource,
    setSelectedNode,
    scriptSource,
  ]);

  const commitChangeSet = useCallback(async (
    set: PendingChangeSet,
    options: { force: boolean; historyNodes?: WebGalNode[] },
  ) => {
    if (commitInFlightRef.current) return;
    commitInFlightRef.current = true;
    setCommitting(true);
    const affectedSceneFiles = set.edits.flatMap((edit) =>
      edit.kind === 'scene' || edit.kind === 'create_scene' ? [edit.file] : [],
    );
    try {
      if (onCommitStart) await onCommitStart(affectedSceneFiles);
      await persistChangeSet(set, options);
    } finally {
      onCommitSettled?.();
      commitInFlightRef.current = false;
      setCommitting(false);
    }
  }, [onCommitSettled, onCommitStart, persistChangeSet]);

  const acceptChange = useCallback(async () => {
    if (!pendingChangeSet || pendingChangeSet.status !== 'pending' || !projectPath) return;
    for (const edit of pendingChangeSet.edits) {
      if (edit.kind !== 'scene' || edit.file === currentSceneName) continue;
      const draft = await readSceneDraft?.(edit.file);
      if (draft !== undefined && draft !== edit.beforeContent) {
        setStatus('conflict');
        return;
      }
    }
    await commitChangeSet(pendingChangeSet, { force: false });
  }, [commitChangeSet, currentSceneName, pendingChangeSet, projectPath, readSceneDraft]);

  const revertChange = useCallback(() => {
    if (!pendingChangeSet || commitInFlightRef.current) return;
    // The preview never entered the live buffer (see finalizeChangeSet), so
    // rejecting only marks the set reverted — no buffer/disk restore needed.
    replaceAssistantMessage(pendingChangeSet.sourceMessageId, `已拒绝：${summarizeChangeSet(pendingChangeSet, sceneHeaders)}`);
    setPendingChangeSet({ ...pendingChangeSet, status: 'reverted' });
    setStatus('reverted');
  }, [sceneHeaders, pendingChangeSet, replaceAssistantMessage]);

  const forceApplyChange = useCallback(async () => {
    if (!pendingChangeSet) return;
    await commitChangeSet(pendingChangeSet, { force: true, historyNodes: nodes });
  }, [commitChangeSet, nodes, pendingChangeSet]);

  const regenerateAfterConflict = useCallback(() => {
    if (!pendingChangeSet || commitInFlightRef.current) return;
    setPendingChangeSet({ ...pendingChangeSet, status: 'reverted' });
    setStatus('idle');
    setInput('请基于我当前最新的脚本内容，重新生成一个不覆盖我手动修改的方案。');
  }, [pendingChangeSet]);

  const openAssets = useCallback(() => {
    if (projectId) navigate(`/editor/${projectId}/assets`);
  }, [navigate, projectId]);

  const useFallbackAssets = useCallback(() => {
    setMissingIssues([]);
    setError(null);
    setStatus('idle');
    void sendPrompt('请把缺失素材替换为素材库中已有的同类素材，然后重新生成修改方案。');
  }, [sendPrompt]);

  const retryWithExistingAssets = useCallback(() => {
    setMissingIssues([]);
    setError(null);
    setStatus('idle');
    setInput(lastRequest?.prompt ?? '');
  }, [lastRequest]);

  // Reset transient UI state shared by all session-switching actions.
  const resetTransient = useCallback(() => {
    if (pendingChangeSet?.status === 'pending') revertChange();
    setInput('');
    setError(null);
    setMissingIssues([]);
    setStatus('idle');
    setPendingChangeSet(null);
  }, [pendingChangeSet, revertChange]);

  const startNewSession = useCallback(() => {
    if (busy || committing) return;
    resetTransient();
    newSession();
  }, [busy, committing, newSession, resetTransient]);

  const selectSession = useCallback((id: string) => {
    if (busy || committing) return;
    resetTransient();
    switchSession(id);
  }, [busy, committing, resetTransient, switchSession]);

  // Deletion confirmation and rename input are handled by in-app dialogs in the
  // UI layer (Tauri has no native prompt/confirm command). These just apply.
  const removeSession = useCallback((id: string) => {
    if (busy || committing) return;
    if (id === activeId) resetTransient();
    deleteSession(id);
  }, [activeId, busy, committing, deleteSession, resetTransient]);

  // --- Reference uploads ---------------------------------------------------
  // Import is per-file so one rejected file (unsupported type, too large,
  // not UTF-8) never discards the ones that succeeded; the failures are
  // reported together as an actionable message. Newly imported files are
  // attached to the pending message automatically — the user picked them to
  // send them now.
  const addUploads = useCallback(async (sourcePaths: string[]) => {
    if (!projectPath || sourcePaths.length === 0) return;
    const operationProjectPath = projectPath;
    setUploadBusy(true);
    setUploadError(null);
    const failures: string[] = [];
    const importedIds: string[] = [];
    try {
      for (const sourcePath of sourcePaths) {
        try {
          const imported = await importAiUpload(projectPath, sourcePath);
          importedIds.push(imported.id);
        } catch (e) {
          failures.push(String(e).replace(/^Error:\s*/, ''));
        }
      }
      const nextUploads = await listAiUploads(operationProjectPath).catch(() => []);
      if (projectPathRef.current !== operationProjectPath) return;
      setUploads(nextUploads);
      if (importedIds.length > 0) {
        setAttachedIds((prev) => [...prev, ...importedIds.filter((id) => !prev.includes(id))]);
      }
      if (failures.length > 0) setUploadError(failures.join('\n'));
    } finally {
      if (projectPathRef.current === operationProjectPath) setUploadBusy(false);
    }
  }, [projectPath]);

  /** Attach an already-stored reference file to the pending message. */
  const attachUpload = useCallback((id: string) => {
    setAttachedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  /** Detach from the pending message without deleting the stored file. */
  const detachUpload = useCallback((id: string) => {
    setAttachedIds((prev) => prev.filter((value) => value !== id));
  }, []);

  const removeUpload = useCallback(async (id: string) => {
    if (!projectPath) return;
    const operationProjectPath = projectPath;
    setUploadError(null);
    try {
      await deleteAiUpload(operationProjectPath, id);
      const nextUploads = await listAiUploads(operationProjectPath);
      if (projectPathRef.current !== operationProjectPath) return;
      setAttachedIds((prev) => prev.filter((value) => value !== id));
      setUploads(nextUploads);
    } catch (e) {
      if (projectPathRef.current === operationProjectPath) {
        setUploadError(String(e).replace(/^Error:\s*/, ''));
      }
    }
  }, [projectPath]);

  /** Fetch the head of a reference file so the user can inspect what the AI sees. */
  const previewUpload = useCallback(async (id: string): Promise<AiUploadContent | null> => {
    if (!projectPath) return null;
    const operationProjectPath = projectPath;
    try {
      const content = await readAiUpload(operationProjectPath, id, 1, 80);
      return projectPathRef.current === operationProjectPath ? content : null;
    } catch (e) {
      if (projectPathRef.current === operationProjectPath) {
        setUploadError(String(e).replace(/^Error:\s*/, ''));
      }
      return null;
    }
  }, [projectPath]);

  const clearUploadError = useCallback(() => setUploadError(null), []);

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
    // Revoke the active Run on the backend first; local ownership is also
    // flipped so any later Provider response (whether the transport honored
    // cancellation or not) is dropped by `ownsRun` checks before mutating UI.
    const stoppingRunId = currentRunIdRef.current;
    currentRunIdRef.current = null;
    if (stoppingRunId) {
      void aiChatCancel(stoppingRunId);
    }
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
    committing,
    status,
    stepLabel,
    pendingChangeSet,
    error,
    missingIssues,
    cooldown,
    hasAssetTruncation: hasAssetContextTruncation(assets),
    memory,
    uploads,
    attachedIds,
    uploadBusy,
    uploadError,
    addUploads,
    attachUpload,
    detachUpload,
    removeUpload,
    previewUpload,
    clearUploadError,
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
    useFallbackAssets,
    openAssets,
    retryWithExistingAssets,
    retry,
    saveMemory,
    stop,
  };
}
