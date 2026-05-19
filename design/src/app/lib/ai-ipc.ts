import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
export { extractWebGalJson, webGalJsonToScript } from './webgal-schema';
export type { WebGalScene } from './webgal-schema';

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
  system_prompt: string;
}

export interface AiValidationResult {
  ok: boolean;
  provider: string;
  model: string;
  endpoint: string;
  message: string;
}

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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

export async function getDefaultSystemPrompt(): Promise<string> {
  return invoke<string>('default_ai_system_prompt');
}

export async function validateAiConfig(config: AiConfig): Promise<AiValidationResult> {
  return invoke<AiValidationResult>('validate_ai_config', { config });
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
