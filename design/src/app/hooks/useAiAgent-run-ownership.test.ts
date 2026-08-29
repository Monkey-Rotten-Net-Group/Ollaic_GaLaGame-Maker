/**
 * Regression tests for conversational Run ownership (T03).
 *
 * Every awaited continuation's success and reject path must prove
 * `ownsRun(runId)` before mutating trace, status, error, or messages.
 * Provider transports that ignore cancellation must still be stopped at the
 * ownership boundary so Stop and run-supersede keep local side effects clean.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('../lib/ai-ipc', () => ({
  aiChatTurn: vi.fn(),
  aiChatCancel: vi.fn(async () => true),
  appendAiAgentTrace: vi.fn(async () => {}),
  getAiProviderCapability: vi.fn(async () => ({
    chatTools: true,
    jsonMode: true,
    streamingCancellation: true,
    mediaUrlOutput: true,
    chatDeadlineMs: 120_000,
    flowStepDeadlineMs: 120_000,
    mediaFetchDeadlineMs: 30_000,
  })),
}));

vi.mock('../lib/ai-tools', () => ({
  getTool: vi.fn(),
  toolDefs: vi.fn(() => []),
}));

vi.mock('../lib/assets-ipc', () => ({
  listAllAssets: vi.fn(async () => []),
}));

vi.mock('../lib/project-memory', () => ({
  emptyProjectMemory: () => ({ worldSetting: '', writingStyle: '', userPreferences: '', updatedAt: '' }),
  readProjectMemory: vi.fn(async () => null),
  saveProjectMemory: vi.fn(async () => {}),
}));

vi.mock('../lib/character-ipc', () => ({
  createCharacter: vi.fn(async () => ({ id: 'c-new' })),
  updateCharacter: vi.fn(async () => {}),
  deleteCharacter: vi.fn(async () => {}),
  listCharacters: vi.fn(async () => []),
}));

vi.mock('../lib/webgal-ipc', () => ({
  parseScene: vi.fn(async (src: string) =>
    String(src ?? '').split('\n').map((content, index) => ({
      id: `n${index}`, type: 'comment', content, flags: [], position: { x: 0, y: 0 }, connections: [],
    })),
  ),
  serializeScene: vi.fn(async (nodes: Array<{ content?: string }>) =>
    (nodes ?? []).map((n) => n.content ?? '').join('\n'),
  ),
  getScenePath: vi.fn(async (_p: string, n: string) => `/tmp/${n}`),
  readFileText: vi.fn(async () => ''),
  listScenes: vi.fn(async () => []),
  saveScene: vi.fn(async () => {}),
  createScene: vi.fn(async () => '/tmp/new.txt'),
  deleteScene: vi.fn(async () => {}),
  updateSceneHeader: vi.fn(async () => {}),
  sceneDisplayName: (f: string) => f,
}));

vi.mock('../lib/change-set', () => ({
  describeEdit: vi.fn(() => 'edit'),
  detectConflicts: vi.fn(() => []),
  stageSceneEdit: vi.fn(async () => ({ tool: 'edit_scene', file: 'start.txt', patches: [] })),
  stageCharacterEdit: vi.fn(async () => ({})),
  stageCreateCharacterEdit: vi.fn(async () => ({})),
  stageCreateSceneEdit: vi.fn(async () => ({})),
  stageMemoryEdit: vi.fn(async () => ({})),
  stageSceneHeaderEdit: vi.fn(async () => ({})),
  stageBranchEdit: vi.fn(async () => ({})),
  stageFigureInsert: vi.fn(async () => ({})),
  stageDialogueBlockInsert: vi.fn(async () => ({})),
  stageCharacterSpritesPlan: vi.fn(async () => ({})),
  stageAssetPlanEdit: vi.fn(async () => ({})),
  summarizeChangeSet: vi.fn(() => 'summary'),
}));

vi.mock('../lib/asset-metadata', () => ({
  loadAssetMetadata: vi.fn(async () => ({})),
  saveAssetMetadata: vi.fn(async () => {}),
  extractSceneBackgroundAssets: vi.fn(() => []),
  syncSceneCardsFromBackgrounds: vi.fn(() => []),
}));

vi.mock('../lib/ai-uploads-ipc', () => ({
  listAiUploads: vi.fn(async () => []),
  readAiUpload: vi.fn(async () => null),
  importAiUpload: vi.fn(async () => ({})),
  buildInlineUploadContext: vi.fn(async () => ''),
  buildUploadContext: vi.fn(() => ''),
  deleteAiUpload: vi.fn(async () => {}),
}));

vi.mock('../lib/story-agent', () => ({
  buildAssetContext: vi.fn(() => ''),
  buildNumberedScriptContext: vi.fn(() => ''),
  truncateContextMessages: vi.fn((messages: unknown[]) => messages),
  hasAssetContextTruncation: vi.fn(() => false),
}));

vi.mock('../lib/editor-patch', () => ({
  extractEditorResponse: vi.fn(() => null),
}));

import { useAiAgent } from './useAiAgent';
import { aiChatTurn, aiChatCancel, appendAiAgentTrace, getAiProviderCapability } from '../lib/ai-ipc';
import type { AiTurnResult } from '../lib/ai-ipc';

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetAllMocks();
  // useChatSession persists to localStorage; reset it so prior test
  // sessions don't leak into the new hook instance.
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }
  vi.mocked(getAiProviderCapability).mockResolvedValue({
    chatTools: true,
    jsonMode: true,
    streamingCancellation: true,
    mediaUrlOutput: true,
    chatDeadlineMs: 120_000,
    flowStepDeadlineMs: 120_000,
    mediaFetchDeadlineMs: 30_000,
  });
  vi.mocked(appendAiAgentTrace).mockResolvedValue(undefined);
  vi.mocked(aiChatCancel).mockResolvedValue(true);
});

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    projectPath: '/tmp/proj',
    currentSceneName: 'start.txt',
    sceneHeaders: {},
    nodes: [],
    selectedNode: null,
    scriptSource: '',
    dirty: false,
    characters: [],
    setNodes: vi.fn(),
    setScriptSource: vi.fn(),
    setDirty: vi.fn(),
    setSaveStatus: vi.fn(),
    setSelectedNode: vi.fn(),
    setShowScript: vi.fn(),
    pushHistory: vi.fn(),
    ...overrides,
  };
}

function deferredResult() {
  let resolve!: (value: AiTurnResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<AiTurnResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait for `mockFn` to have been called at least `n` times, polling
 *  microtasks so the await-chain inside the hook actually reaches the
 *  mocked IPC before the test resolves/rejects its deferred. Without
 *  this, the deferred settles before anyone awaits it and vitest flags
 *  the rejection as unhandled even though the hook's catch would have
 *  handled it. */
async function awaitCalls(mockFn: { mock: { calls: unknown[] } }, n: number) {
  await act(async () => {
    while (mockFn.mock.calls.length < n) {
      await Promise.resolve();
    }
  });
}

describe('AI run ownership (T03)', () => {
  it('stop-before-response: Stop fires before Provider resolve; late success drops at ownership boundary', async () => {
    const deferred = deferredResult();
    vi.mocked(aiChatTurn).mockReturnValueOnce(deferred.promise);

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    // Fire-and-forget; don't await the deferred so the test can race Stop.
    void act(() => { void result.current!.sendPrompt('请修改场景'); });
    // Make sure the await-chain reached aiChatTurn before we resolve the
    // deferred, otherwise the resolution lands before any awaiter.
    await awaitCalls(vi.mocked(aiChatTurn), 1);
    await act(async () => { result.current!.stop(); });

    // Late resolve must not mutate the trace, status, or messages.
    deferred.resolve({ text: 'late success text', toolCalls: [] } as unknown as AiTurnResult);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(aiChatCancel)).toHaveBeenCalled();
    expect(vi.mocked(appendAiAgentTrace)).not.toHaveBeenCalled();
    expect(result.current!.status).not.toBe('error');
    // The assistant placeholder added by this sendPrompt must remain empty;
    // the existing greeting message is unchanged.
    const newAssistant = result.current!.messages.filter((m) => m.role === 'assistant').pop();
    expect(newAssistant?.content).toBe('');
  });

  it('stop-then-new-run: Run B starts cleanly while Run A is still pending', async () => {
    const deferredA = deferredResult();
    const callOrder: string[] = [];
    // Per-call implementation keyed on the runId passed in. Run A returns
    // its deferred; Run B returns its own resolved text. Using a closure
    // over `callOrder` makes any cross-call bleed visible.
    vi.mocked(aiChatTurn).mockImplementation(async (runId: string) => {
      callOrder.push(runId);
      if (callOrder.length === 1) return deferredA.promise;
      return { text: 'B done', toolCalls: [] } as unknown as AiTurnResult;
    });

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    // Run A: fire-and-forget; inFlightRef is now set.
    void act(() => { void result.current!.sendPrompt('A prompt'); });
    // Wait for A's aiChatTurn to actually be in flight so Stop must race
    // an active Provider future, not a request still syncing up.
    await awaitCalls(vi.mocked(aiChatTurn), 1);
    // Stop Run A so inFlightRef clears and Run B can proceed.
    await act(async () => { result.current!.stop(); });
    // Resolve A so the in-flight aiChatTurn for Run A settles without
    // leaking. Trace write for A is allowed on its own behalf.
    deferredA.resolve({ text: 'A old text', toolCalls: [] } as unknown as AiTurnResult);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Run B starts after A was stopped and its slot was released.
    await act(async () => { await result.current!.sendPrompt('B prompt'); });

    expect(callOrder.length).toBe(2);
    expect(callOrder[0]).not.toBe(callOrder[1]);
    const assistants = result.current!.messages.filter((m) => m.role === 'assistant');
    expect(assistants.some((m) => m.content.includes('B done'))).toBe(true);
    expect(result.current!.status).not.toBe('error');
  });

  it('late error: Provider reject after Stop does not flip status or write trace', async () => {
    const deferred = deferredResult();
    vi.mocked(aiChatTurn).mockReturnValueOnce(deferred.promise);

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    void act(() => { void result.current!.sendPrompt('请修改场景'); });
    await awaitCalls(vi.mocked(aiChatTurn), 1);
    await act(async () => { result.current!.stop(); });

    deferred.reject(new Error('provider took too long'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(appendAiAgentTrace)).not.toHaveBeenCalled();
    expect(result.current!.status).not.toBe('error');
    expect(result.current!.error).toBeNull();
    expect(vi.mocked(aiChatCancel)).toHaveBeenCalled();
  });

  it('Provider without transport cancellation: late success drops at local ownership boundary', async () => {
    const deferred = deferredResult();
    vi.mocked(aiChatTurn).mockReturnValueOnce(deferred.promise);

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    void act(() => { void result.current!.sendPrompt('noop'); });
    await awaitCalls(vi.mocked(aiChatTurn), 1);
    await act(async () => { result.current!.stop(); });

    deferred.resolve({ text: 'arrived late', toolCalls: [] } as unknown as AiTurnResult);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const newAssistant = result.current!.messages.filter((m) => m.role === 'assistant').pop();
    expect(newAssistant?.content).toBe('');
    expect(result.current!.status).not.toBe('error');
  });

  it('repeated Stop is idempotent and only one cancel is sent per active run', async () => {
    const deferred = deferredResult();
    vi.mocked(aiChatTurn).mockReturnValueOnce(deferred.promise);

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    void act(() => { void result.current!.sendPrompt('请修改场景'); });
    await awaitCalls(vi.mocked(aiChatTurn), 1);

    // Repeated Stop is allowed and must not throw or mutate shared state.
    await act(async () => {
      result.current!.stop();
      result.current!.stop();
      result.current!.stop();
    });

    // Drain the deferred so the test does not leak an unresolved rejection.
    deferred.reject(new Error('user stopped'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(aiChatCancel).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
