import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type AiProvider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'groq'
  | 'xai'
  | 'ollama'
  | 'cohere'
  | 'custom';

export interface AiConfig {
  provider: AiProvider | string;
  model: string;
  api_key: string;
  base_url: string;
}

export type AiProviderConfig = AiConfig;

export interface AiValidationResult {
  ok: boolean;
  provider: string;
  model: string;
  endpoint: string;
  message: string;
}

export interface AiLogEntry {
  timestampMs: number;
  action: string;
  provider: string;
  model: string;
  endpoint: string;
  success: boolean;
  message: string;
}

export interface GeneratedMedia {
  base64Data: string;
  extension: string;
}

export interface AiMediaGenerationProgress {
  provider: string;
  model: string;
  phase: string;
  attempt: number;
  totalAttempts: number;
  message: string;
}

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Assistant turns that requested tools: replayed so the provider keeps context. */
  toolCalls?: AiToolCall[];
  /** role === 'tool': the originating tool call id this content answers. */
  toolCallId?: string;
}

/** A tool the model may call, described with a JSON Schema for its parameters. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

/** A tool call emitted by the model in one turn. */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of one non-streaming agent turn: either tool calls or final text. */
export interface AiTurnResult {
  text: string | null;
  toolCalls: AiToolCall[];
}

export type AiStreamEvent =
  | { type: 'start' }
  | { type: 'chunk'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export async function getAiConfig(): Promise<AiConfig> {
  return invoke<AiConfig>('get_ai_config');
}

export async function setAiConfig(config: AiConfig): Promise<void> {
  return invoke<void>('set_ai_config', { config });
}

export async function getAiImageConfig(): Promise<AiProviderConfig> {
  return invoke<AiProviderConfig>('get_ai_image_config');
}

export async function setAiImageConfig(config: AiProviderConfig): Promise<void> {
  return invoke<void>('set_ai_image_config', { config });
}

export async function getAiTtsConfig(): Promise<AiProviderConfig> {
  return invoke<AiProviderConfig>('get_ai_tts_config');
}

export async function setAiTtsConfig(config: AiProviderConfig): Promise<void> {
  return invoke<void>('set_ai_tts_config', { config });
}

export async function getAiMusicConfig(): Promise<AiProviderConfig> {
  return invoke<AiProviderConfig>('get_ai_music_config');
}

export async function setAiMusicConfig(config: AiProviderConfig): Promise<void> {
  return invoke<void>('set_ai_music_config', { config });
}

export async function validateAiConfig(config: AiConfig): Promise<AiValidationResult> {
  return invoke<AiValidationResult>('validate_ai_config', { config });
}

export async function aiGenerateImage(
  prompt: string,
  model: string,
  referenceImagePath?: string,
): Promise<GeneratedMedia> {
  return invoke<GeneratedMedia>('ai_generate_image', {
    prompt,
    model,
    referenceImagePath: referenceImagePath ?? null,
  });
}

/// 去除立绘背景：输入（含或不含 data URL 前缀的）base64 图像，返回带 alpha 通道的透明 PNG。
/// 由本地 ONNX 模型 isnet-anime 推理，不经过网络。
export async function removeBackground(base64Data: string): Promise<GeneratedMedia> {
  return invoke<GeneratedMedia>('remove_background', { base64Data });
}

export async function listenAiMediaGenerationProgress(
  handler: (progress: AiMediaGenerationProgress) => void,
): Promise<UnlistenFn> {
  return listen<AiMediaGenerationProgress>('ai-media-generation-progress', (event) => {
    handler(event.payload);
  });
}

export async function aiGenerateTts(
  text: string,
  voicePrompt: string,
  model: string,
  format: string,
): Promise<GeneratedMedia> {
  return invoke<GeneratedMedia>('ai_generate_tts', { text, voicePrompt, model, format });
}

export async function generateMusic(
  prompt: string,
  model: string,
  format: string,
): Promise<GeneratedMedia> {
  return invoke<GeneratedMedia>('generate_music', { prompt, model, format });
}

export async function listAiLogs(limit?: number): Promise<AiLogEntry[]> {
  return invoke<AiLogEntry[]>('list_ai_logs', { limit: limit ?? null });
}

export async function clearAiLogs(): Promise<void> {
  return invoke<void>('clear_ai_logs');
}

export async function getAiLogPath(): Promise<string> {
  return invoke<string>('get_ai_log_path');
}

export async function getAiAgentTracePath(): Promise<string> {
  return invoke<string>('get_ai_agent_trace_path');
}

export async function appendAiAgentTrace(payload: unknown): Promise<void> {
  return invoke<void>('append_ai_agent_trace', { payload });
}

// ── Batch TTS ──────────────────────────────────

export interface BatchTtsItem {
  voiceCardId: string;
  text: string;
  voicePrompt: string;
}

export interface BatchTtsProgress {
  voiceCardId: string;
  index: number;
  total: number;
  status: 'generating' | 'done' | 'error';
  message: string;
  assetName?: string | null;
}

export async function generateBatchTts(
  projectPath: string,
  items: BatchTtsItem[],
  model: string,
  format: string,
): Promise<BatchTtsProgress[]> {
  return invoke<BatchTtsProgress[]>('generate_batch_tts', { projectPath, items, model, format });
}

export async function listenBatchTtsProgress(
  handler: (progress: BatchTtsProgress) => void,
): Promise<UnlistenFn> {
  return listen<BatchTtsProgress>('batch-tts-progress', (event) => {
    handler(event.payload);
  });
}

export interface StreamHandlers {
  onChunk?: (content: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  onStart?: () => void;
}

export async function aiChatStream(
  messages: AiChatMessage[],
  handlers: StreamHandlers,
  characterContext?: string,
): Promise<{ requestId: string; cancel: () => void }> {
  const requestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventName = `ai-chat-${requestId}`;

  let unlisten: UnlistenFn | null = null;
  const stop = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  unlisten = await listen<AiStreamEvent>(eventName, (e) => {
    const payload = e.payload;
    switch (payload.type) {
      case 'start':
        handlers.onStart?.();
        break;
      case 'chunk':
        handlers.onChunk?.(payload.content);
        break;
      case 'done':
        handlers.onDone?.();
        stop();
        break;
      case 'error':
        handlers.onError?.(payload.message);
        stop();
        break;
    }
  });

  try {
    await invoke<void>('ai_chat_stream', { requestId, messages, characterContext });
  } catch (err) {
    stop();
    handlers.onError?.(String(err));
  }

  return { requestId, cancel: stop };
}

/**
 * One non-streaming agent turn. Sends conversation + available tools to the
 * model and returns either tool calls (to execute) or final text. Used by the
 * multi-step agent loop; pure-chat streaming still goes through aiChatStream.
 */
export async function aiChatTurn(
  messages: AiChatMessage[],
  tools: ToolDef[],
  characterContext?: string,
): Promise<AiTurnResult> {
  const wireMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_calls: m.toolCalls?.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) ?? null,
    tool_call_id: m.toolCallId ?? null,
  }));
  return invoke<AiTurnResult>('ai_chat_turn', {
    messages: wireMessages,
    tools,
    characterContext,
  });
}
