import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface ChatDiffLine {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  stopped?: boolean;
  diff?: ChatDiffLine[];
}

interface PersistedChatSession {
  sceneName: string;
  messages: ChatMessage[];
  lastUpdatedAt: string;
}

const MAX_PERSISTED_MESSAGES = 40;

function storageKey(projectId: string | undefined, sceneName: string): string {
  return `ai-chat-${projectId ?? 'demo'}-${sceneName}`;
}

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_PERSISTED_MESSAGES);
}

function loadMessages(projectId: string | undefined, sceneName: string, initialMessage: ChatMessage): ChatMessage[] {
  const key = storageKey(projectId, sceneName);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [initialMessage];
    const parsed = JSON.parse(raw) as PersistedChatSession;
    return [initialMessage, ...trimMessages(parsed.messages ?? [])];
  } catch {
    return [initialMessage];
  }
}

export function useChatSession(
  projectId: string | undefined,
  sceneName: string,
  initialMessage: ChatMessage,
) {
  const keyRef = useRef(storageKey(projectId, sceneName));
  const [messages, setMessagesState] = useState<ChatMessage[]>(() => loadMessages(projectId, sceneName, initialMessage));

  const persist = useCallback((key: string, nextMessages: ChatMessage[]) => {
    const body = trimMessages(nextMessages.filter((message) => message.id !== initialMessage.id));
    if (body.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    const payload: PersistedChatSession = {
      sceneName,
      messages: body,
      lastUpdatedAt: new Date().toISOString(),
    };
    localStorage.setItem(key, JSON.stringify(payload));
  }, [initialMessage.id, sceneName]);

  useLayoutEffect(() => {
    const nextKey = storageKey(projectId, sceneName);
    keyRef.current = nextKey;
    setMessagesState(loadMessages(projectId, sceneName, initialMessage));
  }, [initialMessage, projectId, sceneName]);

  const setMessages = useCallback((next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      persist(keyRef.current, resolved);
      return resolved;
    });
  }, [persist]);

  const clearMessages = useCallback(() => {
    localStorage.removeItem(keyRef.current);
    setMessagesState([initialMessage]);
  }, [initialMessage]);

  return { messages, setMessages, clearMessages };
}
