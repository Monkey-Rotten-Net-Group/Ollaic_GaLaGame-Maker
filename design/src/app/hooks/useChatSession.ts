import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ChatDiffLine {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

/** One tool call surfaced in an assistant step. */
export interface StepToolCall {
  name: string;
  label: string;
  ok?: boolean;
  error?: string;
}

/** One turn of the agent loop: the model's text and/or the tools it called. */
export interface AssistantStep {
  text?: string;
  toolCalls?: StepToolCall[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Per-turn blocks (text + tool calls) for rich rendering of multi-step replies. */
  steps?: AssistantStep[];
  stopped?: boolean;
  diff?: ChatDiffLine[];
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionIndex {
  activeId: string;
  sessions: SessionMeta[];
}

interface PersistedChatSession {
  messages: ChatMessage[];
  lastUpdatedAt: string;
}

const MAX_PERSISTED_MESSAGES = 40;
const DEFAULT_TITLE = '新对话';

function indexKey(projectId: string | undefined): string {
  return `ai-sessions-${projectId ?? 'demo'}`;
}

function sessionKey(projectId: string | undefined, sessionId: string): string {
  return `ai-session-${projectId ?? 'demo'}-${sessionId}`;
}

function legacyKeyPrefix(projectId: string | undefined): string {
  return `ai-chat-${projectId ?? 'demo'}-`;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_PERSISTED_MESSAGES);
}

function makeMeta(title = DEFAULT_TITLE): SessionMeta {
  const ts = nowIso();
  return { id: newId(), title, createdAt: ts, updatedAt: ts };
}

function readIndex(projectId: string | undefined): SessionIndex | null {
  try {
    const raw = localStorage.getItem(indexKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionIndex;
    if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeIndex(projectId: string | undefined, index: SessionIndex): void {
  safeSetItem(indexKey(projectId), JSON.stringify(index));
}

/**
 * localStorage writes can throw (QuotaExceededError, private mode, disabled
 * storage). These run inside setState updaters, so an uncaught throw would
 * crash rendering. Persistence is best-effort — swallow and warn instead.
 */
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn('[chat] localStorage write failed:', e);
  }
}

function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.warn('[chat] localStorage remove failed:', e);
  }
}

/** Best-effort one-time migration of the old per-scene `ai-chat-*` storage. */
function migrateLegacy(projectId: string | undefined): SessionIndex | null {
  const prefix = legacyKeyPrefix(projectId);
  let legacyMessages: ChatMessage[] | null = null;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '');
      if (Array.isArray(parsed?.messages) && parsed.messages.length > 0) {
        legacyMessages = parsed.messages;
        break;
      }
    } catch { /* ignore */ }
  }
  if (!legacyMessages) return null;
  const meta = makeMeta('历史对话');
  const index: SessionIndex = { activeId: meta.id, sessions: [meta] };
  writeIndex(projectId, index);
  safeSetItem(
    sessionKey(projectId, meta.id),
    JSON.stringify({ messages: trimMessages(legacyMessages), lastUpdatedAt: nowIso() } satisfies PersistedChatSession),
  );
  return index;
}

function loadSessionMessages(
  projectId: string | undefined,
  sessionId: string,
  initialMessage: ChatMessage,
): ChatMessage[] {
  try {
    const raw = localStorage.getItem(sessionKey(projectId, sessionId));
    if (!raw) return [initialMessage];
    const parsed = JSON.parse(raw) as PersistedChatSession;
    return [initialMessage, ...trimMessages(parsed.messages ?? [])];
  } catch {
    return [initialMessage];
  }
}

/**
 * Project-level multi-session chat store (localStorage).
 * Sessions are shared across scenes; the active scene is conveyed separately
 * via the system prompt, not by switching sessions.
 */
export function useChatSession(projectId: string | undefined, initialMessage: ChatMessage) {
  // Resolve / bootstrap the session index for this project.
  const [index, setIndex] = useState<SessionIndex>(() => {
    const existing = readIndex(projectId) ?? migrateLegacy(projectId);
    if (existing) return existing;
    const meta = makeMeta();
    const fresh: SessionIndex = { activeId: meta.id, sessions: [meta] };
    writeIndex(projectId, fresh);
    return fresh;
  });

  const [messages, setMessagesState] = useState<ChatMessage[]>(() =>
    loadSessionMessages(projectId, index.activeId, initialMessage),
  );

  // Re-bootstrap when the project changes.
  useEffect(() => {
    const existing = readIndex(projectId) ?? migrateLegacy(projectId);
    const next = existing ?? (() => {
      const meta = makeMeta();
      const fresh: SessionIndex = { activeId: meta.id, sessions: [meta] };
      writeIndex(projectId, fresh);
      return fresh;
    })();
    setIndex(next);
    setMessagesState(loadSessionMessages(projectId, next.activeId, initialMessage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const activeIdRef = useRef(index.activeId);
  activeIdRef.current = index.activeId;

  const persistMessages = useCallback((sessionId: string, next: ChatMessage[]) => {
    const body = trimMessages(next.filter((m) => m.id !== initialMessage.id));
    const ts = nowIso();
    safeSetItem(
      sessionKey(projectId, sessionId),
      JSON.stringify({ messages: body, lastUpdatedAt: ts } satisfies PersistedChatSession),
    );
    setIndex((prev) => {
      const updated = { ...prev, sessions: prev.sessions.map((s) => (s.id === sessionId ? { ...s, updatedAt: ts } : s)) };
      writeIndex(projectId, updated);
      return updated;
    });
  }, [initialMessage.id, projectId]);

  const setMessages = useCallback((next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      persistMessages(activeIdRef.current, resolved);
      return resolved;
    });
  }, [persistMessages]);

  const switchSession = useCallback((id: string) => {
    if (id === activeIdRef.current) return;
    setIndex((prev) => {
      if (!prev.sessions.some((s) => s.id === id)) return prev;
      const updated = { ...prev, activeId: id };
      writeIndex(projectId, updated);
      return updated;
    });
    setMessagesState(loadSessionMessages(projectId, id, initialMessage));
  }, [initialMessage, projectId]);

  const newSession = useCallback(() => {
    const meta = makeMeta();
    setIndex((prev) => {
      const updated: SessionIndex = { activeId: meta.id, sessions: [meta, ...prev.sessions] };
      writeIndex(projectId, updated);
      return updated;
    });
    setMessagesState([initialMessage]);
  }, [initialMessage, projectId]);

  const deleteSession = useCallback((id: string) => {
    safeRemoveItem(sessionKey(projectId, id));
    setIndex((prev) => {
      const remaining = prev.sessions.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const meta = makeMeta();
        const fresh: SessionIndex = { activeId: meta.id, sessions: [meta] };
        writeIndex(projectId, fresh);
        setMessagesState([initialMessage]);
        return fresh;
      }
      const nextActive = prev.activeId === id ? remaining[0].id : prev.activeId;
      const updated: SessionIndex = { activeId: nextActive, sessions: remaining };
      writeIndex(projectId, updated);
      if (prev.activeId === id) setMessagesState(loadSessionMessages(projectId, nextActive, initialMessage));
      return updated;
    });
  }, [initialMessage, projectId]);

  const renameSession = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setIndex((prev) => {
      const updated = { ...prev, sessions: prev.sessions.map((s) => (s.id === id ? { ...s, title: trimmed } : s)) };
      writeIndex(projectId, updated);
      return updated;
    });
  }, [projectId]);

  /** Set the active session's title only if it is still the default placeholder. */
  const ensureTitleFromFirstMessage = useCallback((text: string) => {
    const snippet = text.trim().replace(/\s+/g, ' ').slice(0, 20);
    if (!snippet) return;
    setIndex((prev) => {
      const active = prev.sessions.find((s) => s.id === prev.activeId);
      if (!active || active.title !== DEFAULT_TITLE) return prev;
      const updated = { ...prev, sessions: prev.sessions.map((s) => (s.id === prev.activeId ? { ...s, title: snippet } : s)) };
      writeIndex(projectId, updated);
      return updated;
    });
  }, [projectId]);

  const sessions = useMemo(
    () => [...index.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [index.sessions],
  );

  return {
    messages,
    setMessages,
    sessions,
    activeId: index.activeId,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    ensureTitleFromFirstMessage,
  };
}
