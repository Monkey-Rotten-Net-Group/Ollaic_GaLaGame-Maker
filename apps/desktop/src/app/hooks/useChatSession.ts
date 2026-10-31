import { useCallback, useMemo } from 'react';
import { projectAiRef, useProjectAiState } from '../lib/project-ai-runtime';

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
  arguments?: Record<string, unknown>;
  resultSummary?: string;
}

/** One turn of the agent loop: the model's text and/or the tools it called. */
export interface AssistantStep {
  text?: string;
  toolCalls?: StepToolCall[];
}

/** A reference file attached to one user message. */
export interface ChatAttachment {
  id: string;
  name: string;
  lineCount: number;
  size: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Scene snapshot this message was created against. */
  sceneName?: string;
  /** Per-turn blocks (text + tool calls) for rich rendering of multi-step replies. */
  steps?: AssistantStep[];
  stopped?: boolean;
  diff?: ChatDiffLine[];
  /** role === 'user': reference files sent along with this message. */
  attachments?: ChatAttachment[];
}

export interface SessionDigest {
  version: 1;
  goal: string;
  decisions: string[];
  completed: string[];
  openQuestions: string[];
  nextStep: string;
  sourceMessageIds: string[];
  updatedAt: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isSessionDigest(value: unknown): value is SessionDigest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SessionDigest>;
  return item.version === 1
    && typeof item.goal === 'string'
    && isStringArray(item.decisions)
    && isStringArray(item.completed)
    && isStringArray(item.openQuestions)
    && typeof item.nextStep === 'string'
    && isStringArray(item.sourceMessageIds)
    && typeof item.updatedAt === 'string';
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
  digest?: SessionDigest;
  lastUpdatedAt: string;
}

const MAX_PERSISTED_MESSAGES = 200;
const RECENT_MESSAGES_AFTER_COMPACTION = 24;
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

function digestText(message: ChatMessage): string {
  const text = message.content.trim().replace(/\s+/g, ' ');
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

export function buildLocalSessionDigest(previous: SessionDigest | null, messages: ChatMessage[]): SessionDigest {
  const meaningful = messages.filter((message) => message.id !== '1' && message.content.trim());
  const users = meaningful.filter((message) => message.role === 'user');
  const assistants = meaningful.filter((message) => message.role === 'assistant');
  const decisions = assistants.slice(-8).map(digestText).filter(Boolean);
  const completed = assistants
    .flatMap((message) => (message.steps ?? []).flatMap((step) => (step.toolCalls ?? []).map((call) => `${call.name}: ${call.ok === false ? '失败' : '完成'}`)))
    .slice(-12);
  return {
    version: 1,
    goal: digestText(users[0] ?? meaningful[0] ?? { id: '', role: 'user', content: '' }),
    decisions: [...(previous?.decisions ?? []), ...decisions].slice(-12),
    completed: [...(previous?.completed ?? []), ...completed].slice(-16),
    openQuestions: previous?.openQuestions ?? [],
    nextStep: digestText(users[users.length - 1] ?? { id: '', role: 'user', content: '' }),
    sourceMessageIds: [...(previous?.sourceMessageIds ?? []), ...meaningful.map((message) => message.id)].slice(-40),
    updatedAt: nowIso(),
  };
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
    const parsed = JSON.parse(raw) as Partial<PersistedChatSession> | null;
    const persisted = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return [initialMessage, ...trimMessages(persisted)];
  } catch {
    return [initialMessage];
  }
}

function loadSessionDigest(projectId: string | undefined, sessionId: string): SessionDigest | null {
  try {
    const raw = localStorage.getItem(sessionKey(projectId, sessionId));
    const parsed = raw ? JSON.parse(raw) as PersistedChatSession : null;
    return isSessionDigest(parsed?.digest) ? parsed.digest : null;
  } catch {
    return null;
  }
}

/**
 * Project-level multi-session chat store (localStorage).
 * Sessions are shared across scenes; the active scene is conveyed separately
 * via the system prompt, not by switching sessions.
 */
export function useChatSession(projectId: string | undefined, initialMessage: ChatMessage) {
  const projectKey = `chat:${projectId ?? 'demo'}`;
  // Resolve / bootstrap the session index for this project.
  const [index, setIndex] = useProjectAiState<SessionIndex>(projectKey, 'index', () => {
    const existing = readIndex(projectId) ?? migrateLegacy(projectId);
    if (existing) return existing;
    const meta = makeMeta();
    const fresh: SessionIndex = { activeId: meta.id, sessions: [meta] };
    writeIndex(projectId, fresh);
    return fresh;
  });

  const [messages, setMessagesState] = useProjectAiState<ChatMessage[]>(projectKey, 'messages', () =>
    loadSessionMessages(projectId, index.activeId, initialMessage),
  );
  const [digest, setDigestState] = useProjectAiState<SessionDigest | null>(projectKey, 'digest', () =>
    loadSessionDigest(projectId, index.activeId),
  );

  const activeIdRef = projectAiRef(projectKey, 'activeId', index.activeId);
  const digestRef = projectAiRef<SessionDigest | null>(projectKey, 'digest', digest);
  activeIdRef.current = index.activeId;
  digestRef.current = digest;

  const persistMessages = useCallback((sessionId: string, next: ChatMessage[]): ChatMessage[] => {
    const greeting = next.filter((m) => m.id === initialMessage.id);
    const all = next.filter((m) => m.id !== initialMessage.id);
    const body = all.length > MAX_PERSISTED_MESSAGES
      ? all.slice(-RECENT_MESSAGES_AFTER_COMPACTION)
      : trimMessages(all);
    const nextDigest = all.length > MAX_PERSISTED_MESSAGES
      ? buildLocalSessionDigest(digestRef.current, all.slice(0, -RECENT_MESSAGES_AFTER_COMPACTION))
      : digestRef.current;
    if (nextDigest !== digestRef.current) {
      digestRef.current = nextDigest;
      setDigestState(nextDigest);
    }
    const ts = nowIso();
    safeSetItem(
      sessionKey(projectId, sessionId),
      JSON.stringify({ messages: body, digest: nextDigest ?? undefined, lastUpdatedAt: ts } satisfies PersistedChatSession),
    );
    setIndex((prev) => {
      const updated = { ...prev, sessions: prev.sessions.map((s) => (s.id === sessionId ? { ...s, updatedAt: ts } : s)) };
      writeIndex(projectId, updated);
      return updated;
    });
    return [...greeting, ...body];
  }, [initialMessage.id, projectId, setDigestState]);

  const setMessages = useCallback((next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      return persistMessages(activeIdRef.current, resolved);
    });
  }, [persistMessages]);

  const setDigest = useCallback((next: SessionDigest | null) => {
    digestRef.current = next;
    setDigestState(next);
    const sessionId = activeIdRef.current;
    const current = loadSessionMessages(projectId, sessionId, initialMessage).filter((message) => message.id !== initialMessage.id);
    safeSetItem(sessionKey(projectId, sessionId), JSON.stringify({
      messages: trimMessages(current),
      digest: next ?? undefined,
      lastUpdatedAt: nowIso(),
    } satisfies PersistedChatSession));
  }, [initialMessage, projectId, setDigestState]);

  const compactMessages = useCallback((compactedIds?: ReadonlySet<string>) => {
    setMessagesState((prev) => {
      const retained = compactedIds && compactedIds.size > 0
        ? prev.filter((message) => message.id === initialMessage.id || !compactedIds.has(message.id))
        : [
          ...prev.filter((message) => message.id === initialMessage.id),
          ...prev.filter((message) => message.id !== initialMessage.id).slice(-RECENT_MESSAGES_AFTER_COMPACTION),
        ];
      return persistMessages(activeIdRef.current, retained);
    });
  }, [initialMessage.id, persistMessages]);

  const switchSession = useCallback((id: string) => {
    if (id === activeIdRef.current) return;
    setIndex((prev) => {
      if (!prev.sessions.some((s) => s.id === id)) return prev;
      const updated = { ...prev, activeId: id };
      writeIndex(projectId, updated);
      return updated;
    });
    setMessagesState(loadSessionMessages(projectId, id, initialMessage));
    const nextDigest = loadSessionDigest(projectId, id);
    digestRef.current = nextDigest;
    setDigestState(nextDigest);
  }, [initialMessage, projectId]);

  const newSession = useCallback(() => {
    const meta = makeMeta();
    setIndex((prev) => {
      const updated: SessionIndex = { activeId: meta.id, sessions: [meta, ...prev.sessions] };
      writeIndex(projectId, updated);
      return updated;
    });
    setMessagesState([initialMessage]);
    digestRef.current = null;
    setDigestState(null);
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
        digestRef.current = null;
        setDigestState(null);
        return fresh;
      }
      const nextActive = prev.activeId === id ? remaining[0].id : prev.activeId;
      const updated: SessionIndex = { activeId: nextActive, sessions: remaining };
      writeIndex(projectId, updated);
      if (prev.activeId === id) {
        setMessagesState(loadSessionMessages(projectId, nextActive, initialMessage));
        const nextDigest = loadSessionDigest(projectId, nextActive);
        digestRef.current = nextDigest;
        setDigestState(nextDigest);
      }
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
    digest,
    setDigest,
    compactMessages,
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
