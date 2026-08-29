import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { useAiAgent } from './useAiAgent';

vi.mock('../lib/ai-ipc', () => ({
  aiChatTurn: vi.fn(),
  aiChatCancel: vi.fn(async () => true),
  appendAiAgentTrace: vi.fn(async () => {}),
  getAiConfig: vi.fn(async () => ({ provider: 'openai', model: 'gpt-4o-mini', apiKey: '', baseUrl: '' })),
  getAiProviderCapability: vi.fn(async () => ({ chatTools: true })),
}));

vi.mock('../lib/ai-tools', () => ({
  getTool: vi.fn(),
  toolDefs: vi.fn(() => []),
}));

vi.mock('../lib/assets-ipc', () => ({
  listAllAssets: vi.fn(async () => []),
  loadProjectAssetMetadata: vi.fn(async () => ({
    aliases: {}, descriptions: {}, tags: {}, references: {},
    sceneCards: {}, cgCards: {}, voiceCards: {},
    deletedSceneCards: [], deletedCgCards: [], deletedVoiceCards: [],
  })),
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
  createScene: vi.fn(async () => 'new.txt'),
  deleteScene: vi.fn(async () => {}),
  updateSceneHeader: vi.fn(async () => {}),
  serializeSceneHeader: ({ chapter, outline }: { chapter?: string; outline?: string }) => [
    chapter ? `; 章节: ${chapter}` : '',
    outline ? `; 大纲: ${outline}` : '',
  ].filter(Boolean).join('\n') + (chapter || outline ? '\n' : ''),
  sceneDisplayName: (f: string) => f,
}));

import { aiChatTurn } from '../lib/ai-ipc';
import { getTool } from '../lib/ai-tools';
import type { AiTurnResult } from '../lib/ai-ipc';
import type { ChangeSetAdapter } from '../lib/change-set-ipc';

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

async function stagePendingChange(result: { current: ReturnType<typeof useAiAgent> }) {
  await act(async () => { await result.current.sendPrompt('修改场景'); });
  await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(aiChatTurn).mockReset();
  vi.mocked(getTool).mockReset();
  vi.mocked(aiChatTurn)
    .mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'c1', name: 'edit_scene', arguments: {} }],
    } as unknown as AiTurnResult)
    .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
  vi.mocked(getTool).mockReturnValue({
    name: 'edit_scene',
    kind: 'write',
    schema: {},
    run: async () => ({
      tool: 'edit_scene',
      file: 'start.txt',
      patches: [{ type: 'insert', file: 'start.txt', afterLine: 'end', text: 'B:world;' }],
    }),
  } as never);
});

describe('AI pending preview isolation', () => {

  it('does not write AI preview content into the saveable buffer (no setNodes/setScriptSource/setDirty)', async () => {
    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    await act(async () => {
      await result.current.sendPrompt('请修改场景');
    });

    await waitFor(() => {
      expect(result.current.pendingChangeSet).toBeTruthy();
    });

    expect(params.setNodes).not.toHaveBeenCalled();
    expect(params.setScriptSource).not.toHaveBeenCalled();
    expect(params.setDirty).not.toHaveBeenCalled();
  });
});

describe('AI change-set commit adapter', () => {
  it('updates the live scene only after Accept is committed by the backend', async () => {
    const changeSetAdapter = vi.fn<ChangeSetAdapter>().mockResolvedValue({
      status: 'committed',
      resources: [{ kind: 'scene', file: 'start.txt' }],
    });
    const params = makeParams({ changeSetAdapter });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    await stagePendingChange(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(changeSetAdapter).toHaveBeenCalledOnce();
    expect(changeSetAdapter).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      operations: [{
        kind: 'scene',
        file: 'start.txt',
        baseline: '',
        content: '\nB:world;',
      }],
    });
    expect(params.setNodes).toHaveBeenCalledOnce();
    expect(params.setScriptSource).toHaveBeenCalledWith('\nB:world;');
    expect(result.current.status).toBe('accepted');
  });

  it('keeps a conflicted change set reviewable without touching the live buffer', async () => {
    const changeSetAdapter = vi.fn<ChangeSetAdapter>().mockResolvedValue({
      status: 'conflict',
      resources: [{ kind: 'scene', file: 'start.txt' }],
    });
    const params = makeParams({ changeSetAdapter });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await stagePendingChange(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('conflict');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
    expect(params.setNodes).not.toHaveBeenCalled();
    expect(params.setScriptSource).not.toHaveBeenCalled();
    expect(params.setDirty).not.toHaveBeenCalled();
  });

  it('reports rollback failure while preserving the pending review', async () => {
    const changeSetAdapter = vi.fn<ChangeSetAdapter>().mockResolvedValue({
      status: 'rollback-failed',
      failedResource: { kind: 'characters' },
      residualResources: [{ kind: 'scene', file: 'start.txt' }],
      message: 'disk unavailable',
    });
    const params = makeParams({ changeSetAdapter });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await stagePendingChange(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.retryable).toBe(false);
    expect(result.current.error?.message).toContain('部分资源可能已写入');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
    expect(params.setNodes).not.toHaveBeenCalled();
  });

  it('reports a transport error and releases the unchanged pending review', async () => {
    const changeSetAdapter = vi.fn<ChangeSetAdapter>().mockRejectedValue(new Error('IPC disconnected'));
    const onCommitStart = vi.fn();
    const onCommitSettled = vi.fn();
    const params = makeParams({ changeSetAdapter, onCommitStart, onCommitSettled });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await stagePendingChange(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('IPC disconnected');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
    expect(params.setNodes).not.toHaveBeenCalled();
    expect(onCommitStart).toHaveBeenCalledOnce();
    expect(onCommitStart).toHaveBeenCalledWith(['start.txt']);
    expect(onCommitSettled).toHaveBeenCalledOnce();
  });

  it('maps a fully rolled-back backend failure without changing draft ownership', async () => {
    const changeSetAdapter = vi.fn<ChangeSetAdapter>().mockResolvedValue({
      status: 'failed-and-rolled-back',
      failedResource: { kind: 'scene', file: 'start.txt' },
      message: 'disk full',
    });
    const params = makeParams({ changeSetAdapter });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await stagePendingChange(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('已回滚全部修改');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
    expect(params.setNodes).not.toHaveBeenCalled();
  });

  it('treats a non-current cached user draft as a conflict before committing', async () => {
    vi.mocked(getTool).mockReturnValue({
      name: 'edit_scene',
      kind: 'write',
      schema: {},
      run: async () => ({
        tool: 'edit_scene',
        file: 'chapter-2.txt',
        patches: [{ type: 'insert', file: 'chapter-2.txt', afterLine: 'end', text: 'B:world;' }],
      }),
    } as never);
    const changeSetAdapter = vi.fn<ChangeSetAdapter>();
    const readSceneDraft = vi.fn(async (file: string) =>
      file === 'chapter-2.txt' ? 'author:unsaved draft;' : undefined,
    );
    const params = makeParams({ changeSetAdapter, readSceneDraft });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await stagePendingChange(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(readSceneDraft).toHaveBeenCalledWith('chapter-2.txt');
    expect(changeSetAdapter).not.toHaveBeenCalled();
    expect(result.current.status).toBe('conflict');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
  });

  it('uses the same deferred adapter for Force Apply and waits before updating the live buffer', async () => {
    let resolveCommit!: (value: Awaited<ReturnType<ChangeSetAdapter>>) => void;
    const changeSetAdapter = vi.fn<ChangeSetAdapter>().mockReturnValue(new Promise((resolve) => {
      resolveCommit = resolve;
    }));
    const params = makeParams({ changeSetAdapter });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await stagePendingChange(result);

    let forcePromise!: Promise<void>;
    act(() => { forcePromise = result.current.forceApplyChange(); });
    await waitFor(() => { expect(changeSetAdapter).toHaveBeenCalledOnce(); });
    expect(params.setNodes).not.toHaveBeenCalled();
    expect(params.setScriptSource).not.toHaveBeenCalled();

    await act(async () => {
      resolveCommit({ status: 'committed', resources: [{ kind: 'scene', file: 'start.txt' }] });
      await forcePromise;
    });

    expect(params.setNodes).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('accepted');
  });

  it('commits a composite set once and refreshes each affected frontend store once', async () => {
    vi.mocked(aiChatTurn)
      .mockReset()
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { id: 'scene', name: 'create_scene', arguments: {} },
          { id: 'character', name: 'create_character', arguments: {} },
          { id: 'memory', name: 'edit_memory', arguments: {} },
        ],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockImplementation((name) => ({
      name,
      kind: 'write',
      schema: {},
      run: async () => {
        if (name === 'create_scene') {
          return { tool: 'create_scene', name: 'chapter-2', chapter: '第二章' };
        }
        if (name === 'create_character') {
          return { tool: 'create_character', draft: { name: 'Hero' } };
        }
        return { tool: 'edit_memory', partial: { worldSetting: 'Harbor' } };
      },
    } as never));
    const changeSetAdapter = vi.fn<ChangeSetAdapter>().mockResolvedValue({
      status: 'committed',
      resources: [
        { kind: 'scene', file: 'chapter-2.txt' },
        { kind: 'characters' },
        { kind: 'project_memory' },
      ],
    });
    const onScenesChanged = vi.fn();
    const onCharactersChanged = vi.fn();
    const params = makeParams({ changeSetAdapter, onScenesChanged, onCharactersChanged });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await stagePendingChange(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(changeSetAdapter).toHaveBeenCalledOnce();
    const request = changeSetAdapter.mock.calls[0][0];
    expect(request.operations.map((operation) => operation.kind)).toEqual([
      'create_scene',
      'characters',
      'project_memory',
    ]);
    expect(request.operations[0]).toMatchObject({
      kind: 'create_scene',
      file: 'chapter-2.txt',
      content: '; 章节: 第二章\n',
    });
    const charactersOperation = request.operations.find((operation) => operation.kind === 'characters');
    expect(charactersOperation).toMatchObject({ kind: 'characters' });
    if (charactersOperation?.kind === 'characters') {
      const document = charactersOperation.document as { characters: Array<{ id: string }> };
      expect(document.characters[0].id).toMatch(/^char_/);
      expect(document.characters[0].id).not.toContain('tmp_ai_');
    }
    expect(onScenesChanged).toHaveBeenCalledOnce();
    expect(onCharactersChanged).toHaveBeenCalledOnce();
    expect(result.current.memory?.worldSetting).toBe('Harbor');
  });
});
