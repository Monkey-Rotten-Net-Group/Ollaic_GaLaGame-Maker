import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { useAiAgent } from './useAiAgent';

vi.mock('../lib/ai-ipc', () => ({
  aiChatTurn: vi.fn(),
  aiChatCancel: vi.fn(async () => {}),
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

vi.mock('../lib/ai-change-set-ipc', () => ({
  applyAiChangeSet: vi.fn(async () => ({ outcome: 'applied' })),
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

import { aiChatCancel, aiChatTurn } from '../lib/ai-ipc';
import { applyAiChangeSet } from '../lib/ai-change-set-ipc';
import { getTool } from '../lib/ai-tools';
import { createCharacter, updateCharacter } from '../lib/character-ipc';
import { createScene, deleteScene, readFileText, saveScene, updateSceneHeader } from '../lib/webgal-ipc';
import type { AiTurnResult } from '../lib/ai-ipc';

afterEach(() => {
  vi.restoreAllMocks();
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

describe('AI pending preview isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('holds editor save coordination until the backend commit settles', async () => {
    let finishCommit!: (value: { outcome: 'applied' }) => void;
    vi.mocked(applyAiChangeSet).mockImplementationOnce(() => new Promise((resolve) => {
      finishCommit = resolve;
    }));
    const onCommitStart = vi.fn(async () => {});
    const onCommitSettled = vi.fn();
    const params = makeParams({ onCommitStart, onCommitSettled });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('请修改场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });

    let applyPromise!: Promise<void>;
    act(() => { applyPromise = result.current.acceptChange(); });
    await waitFor(() => { expect(onCommitStart).toHaveBeenCalledWith(['start.txt']); });
    expect(onCommitSettled).not.toHaveBeenCalled();

    await act(async () => {
      finishCommit({ outcome: 'applied' });
      await applyPromise;
    });
    expect(onCommitSettled).toHaveBeenCalledOnce();
  });

  it('keeps a non-current user draft reviewable instead of committing over it', async () => {
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
    const readSceneDraft = vi.fn(async () => 'author:unsaved draft;');
    const params = makeParams({ readSceneDraft });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('请修改第二章'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });
    vi.mocked(applyAiChangeSet).mockClear();

    await act(async () => { await result.current.acceptChange(); });

    expect(readSceneDraft).toHaveBeenCalledWith('chapter-2.txt');
    expect(applyAiChangeSet).not.toHaveBeenCalled();
    expect(result.current.status).toBe('conflict');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
  });

  it('does not replace the live buffer during force apply until the backend commit succeeds', async () => {
    let finishCommit!: (value: { outcome: 'applied' }) => void;
    vi.mocked(applyAiChangeSet).mockImplementationOnce(() => new Promise((resolve) => {
      finishCommit = resolve;
    }));
    const params = makeParams({
      nodes: [{ id: 'manual', type: 'comment', content: 'manual edit', flags: [], position: { x: 0, y: 0 }, connections: [] }],
      scriptSource: 'manual edit',
    });
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('请修改场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });

    let applyPromise!: Promise<void>;
    act(() => { applyPromise = result.current.forceApplyChange(); });

    expect(params.pushHistory).not.toHaveBeenCalled();
    expect(params.setNodes).not.toHaveBeenCalled();
    expect(params.setScriptSource).not.toHaveBeenCalled();

    await act(async () => {
      finishCommit({ outcome: 'applied' });
      await applyPromise;
    });
    expect(params.setNodes).toHaveBeenCalled();
    expect(params.setScriptSource).toHaveBeenCalled();
  });

  it('does not write a committed edit into a different scene after the user switches scenes', async () => {
    let finishCommit!: (value: { outcome: 'applied' }) => void;
    vi.mocked(applyAiChangeSet).mockImplementationOnce(() => new Promise((resolve) => {
      finishCommit = resolve;
    }));
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'edit_scene', arguments: {} },
          { id: 'c2', name: 'create_scene', arguments: {} },
        ],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockImplementation((name) => ({
      name,
      kind: 'write',
      schema: {},
      run: async () => name === 'create_scene'
        ? { tool: 'create_scene', name: 'chapter_03' }
        : {
          tool: 'edit_scene',
          file: 'start.txt',
          patches: [{ type: 'insert', file: 'start.txt', afterLine: 'end', text: 'B:world;' }],
        },
    }) as never);
    const onScenesChanged = vi.fn();
    const initialParams = makeParams({ onScenesChanged });
    let params = initialParams;
    const { result, rerender } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    await act(async () => { await result.current.sendPrompt('请修改场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });

    let applyPromise!: Promise<void>;
    act(() => { applyPromise = result.current.acceptChange(); });
    const nextParams = makeParams({
      currentSceneName: 'chapter_02.txt',
      scriptSource: 'chapter two',
      nodes: [{ id: 'chapter-two', type: 'comment', content: 'chapter two', flags: [], position: { x: 0, y: 0 }, connections: [] }],
      onScenesChanged,
    });
    params = nextParams;
    rerender();

    await act(async () => {
      finishCommit({ outcome: 'applied' });
      await applyPromise;
    });

    expect(initialParams.setNodes).not.toHaveBeenCalled();
    expect(initialParams.setScriptSource).not.toHaveBeenCalled();
    expect(initialParams.pushHistory).not.toHaveBeenCalled();
    expect(initialParams.setDirty).not.toHaveBeenCalled();
    expect(initialParams.setSaveStatus).not.toHaveBeenCalled();
    expect(nextParams.setNodes).not.toHaveBeenCalled();
    expect(onScenesChanged).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('accepted');
    expect(result.current.pendingChangeSet?.status).toBe('accepted');
  });

  it('does not publish an old project commit into the newly opened project', async () => {
    let finishCommit!: (value: { outcome: 'applied' }) => void;
    vi.mocked(applyAiChangeSet).mockImplementationOnce(() => new Promise((resolve) => {
      finishCommit = resolve;
    }));
    const oldProject = makeParams({ projectId: 'old', projectPath: '/tmp/old-project' });
    let params = oldProject;
    const { result, rerender } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    await act(async () => { await result.current.sendPrompt('请修改场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });

    let applyPromise!: Promise<void>;
    act(() => { applyPromise = result.current.acceptChange(); });
    const newProject = makeParams({
      projectId: 'new',
      projectPath: '/tmp/new-project',
      currentSceneName: 'start.txt',
      scriptSource: 'new project content',
    });
    params = newProject;
    rerender();

    await act(async () => {
      finishCommit({ outcome: 'applied' });
      await applyPromise;
    });

    expect(applyAiChangeSet).toHaveBeenCalledWith(
      '/tmp/old-project',
      expect.anything(),
      expect.anything(),
      false,
    );
    expect(oldProject.setNodes).not.toHaveBeenCalled();
    expect(oldProject.setScriptSource).not.toHaveBeenCalled();
    expect(newProject.setNodes).not.toHaveBeenCalled();
    expect(newProject.setScriptSource).not.toHaveBeenCalled();
  });

  it('drops a pending preview when the user opens another project', async () => {
    let params = makeParams({ projectId: 'old', projectPath: '/tmp/old-project' });
    const { result, rerender } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('请修改场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });

    params = makeParams({ projectId: 'new', projectPath: '/tmp/new-project' });
    rerender();

    expect(result.current.pendingChangeSet).toBeNull();
    expect(result.current.status).toBe('idle');
    await act(async () => { await result.current.acceptChange(); });
    expect(applyAiChangeSet).not.toHaveBeenCalled();
  });

  it('cancels and ignores generation that belongs to the previous project', async () => {
    let finishTurn!: (value: AiTurnResult) => void;
    vi.mocked(aiChatTurn).mockImplementationOnce(() => new Promise((resolve) => {
      finishTurn = resolve;
    }));
    let params = makeParams({ projectId: 'old', projectPath: '/tmp/old-project' });
    const { result, rerender } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    let promptPromise!: Promise<void>;
    act(() => { promptPromise = result.current.sendPrompt('请修改场景'); });
    await waitFor(() => { expect(result.current.busy).toBe(true); });

    params = makeParams({ projectId: 'new', projectPath: '/tmp/new-project' });
    rerender();
    expect(result.current.busy).toBe(false);
    expect(result.current.pendingChangeSet).toBeNull();
    expect(aiChatCancel).toHaveBeenCalledWith(expect.stringMatching(/^run-/));

    await act(async () => {
      finishTurn({ text: 'old project response', toolCalls: [] } as unknown as AiTurnResult);
      await promptPromise;
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.pendingChangeSet).toBeNull();
  });

  it('serializes acceptance attempts and allows retry after a commit error', async () => {
    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('请修改场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });

    let failCommit!: (reason: unknown) => void;
    vi.mocked(applyAiChangeSet).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failCommit = reject;
    }));

    let firstAttempt!: Promise<void>;
    let duplicateAttempt!: Promise<void>;
    act(() => {
      firstAttempt = result.current.acceptChange();
      duplicateAttempt = result.current.acceptChange();
    });

    expect(result.current.committing).toBe(true);
    expect(applyAiChangeSet).toHaveBeenCalledTimes(1);

    await act(async () => {
      failCommit(new Error('connection lost'));
      await Promise.all([firstAttempt, duplicateAttempt]);
    });

    expect(result.current.committing).toBe(false);
    expect(result.current.pendingChangeSet?.status).toBe('pending');

    vi.mocked(applyAiChangeSet).mockResolvedValueOnce({ outcome: 'applied' });
    await act(async () => { await result.current.acceptChange(); });
    expect(applyAiChangeSet).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('accepted');
  });
});

describe('backend change-set recovery', () => {
  it('reports a restored backend failure without attempting a second rollback in React', async () => {
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'create_scene', arguments: { name: 'chapter_02', chapter: '第一章' } }],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockReturnValue({
      name: 'create_scene',
      kind: 'write',
      schema: {},
      run: async () => ({ tool: 'create_scene', name: 'chapter_02', chapter: '第一章' }),
    } as never);
    vi.mocked(applyAiChangeSet).mockResolvedValueOnce({
      outcome: 'failed',
      resource: 'scene',
      message: 'disk full',
      recovery: { status: 'restored' },
    });

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    await act(async () => { await result.current.sendPrompt('创建场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('项目已恢复到提交前状态');
    expect(vi.mocked(deleteScene)).not.toHaveBeenCalled();
  });

  it('warns that the project may be partially written when snapshot recovery fails', async () => {
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'create_scene', arguments: { name: 'chapter_02' } }],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockReturnValue({
      name: 'create_scene',
      kind: 'write',
      schema: {},
      run: async () => ({ tool: 'create_scene', name: 'chapter_02' }),
    } as never);
    vi.mocked(applyAiChangeSet).mockResolvedValueOnce({
      outcome: 'failed',
      resource: 'memory',
      message: 'disk full',
      recovery: {
        status: 'failed',
        message: 'permission denied',
        snapshotId: 'rollback-123',
      },
    });

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('创建场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });
    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.error?.message).toContain('项目可能只写入了一部分');
    expect(result.current.error?.message).toContain('rollback-123');
    expect(result.current.error?.message).toContain('请先在快照管理中恢复它');
  });
});

describe('missing asset recovery', () => {
  it('preserves missing asset details instead of publishing a partial change set', async () => {
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
        patches: [{ type: 'insert', file: 'start.txt', afterLine: 'end', text: 'changeBg:missing-room.png -next;' }],
      }),
    } as never);

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('换一个背景'); });

    expect(result.current.status).toBe('missing_assets');
    expect(result.current.missingIssues).toEqual([{
      command: 'changeBg',
      file: 'missing-room.png',
      expectedCategory: 'background',
    }]);
    expect(result.current.pendingChangeSet).toBeNull();
  });

  it('does not hide a missing asset after an unrelated write succeeds in the same scene', async () => {
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'edit_scene', arguments: {} },
          { id: 'c2', name: 'set_scene_header', arguments: {} },
        ],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockImplementation((name) => ({
      name,
      kind: 'write',
      schema: {},
      run: async () => name === 'edit_scene'
        ? {
          tool: 'edit_scene',
          file: 'start.txt',
          patches: [{ type: 'insert', file: 'start.txt', afterLine: 'end', text: 'changeBg:missing-room.png -next;' }],
        }
        : { tool: 'set_scene_header', file: 'start.txt', chapter: '第二章' },
    }) as never);

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('换背景并修改章节'); });

    expect(result.current.status).toBe('missing_assets');
    expect(result.current.missingIssues).toHaveLength(1);
    expect(result.current.pendingChangeSet).toBeNull();
  });
});

describe('same-turn created resource acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createScene).mockResolvedValue('/tmp/proj/game/scene/chapter_02.txt');
    vi.mocked(saveScene).mockResolvedValue();
    vi.mocked(deleteScene).mockResolvedValue();
    vi.mocked(readFileText).mockResolvedValue('');
    vi.mocked(updateSceneHeader).mockResolvedValue();
    vi.mocked(createCharacter).mockResolvedValue({ id: 'c-new' } as never);
    vi.mocked(updateCharacter).mockResolvedValue({ id: 'c-updated' } as never);
  });

  it('creates a scene before applying its same-turn edit through acceptChange', async () => {
    let sceneExists = false;
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'create_scene', arguments: { name: 'chapter_02', chapter: '第一章' } },
          { id: 'c2', name: 'edit_scene', arguments: { file: 'chapter_02.txt' } },
        ],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockImplementation((name) => {
      if (name === 'create_scene') {
        return {
          name,
          kind: 'write',
          schema: {},
          run: async () => ({ tool: 'create_scene', name: 'chapter_02', chapter: '第一章' }),
        } as never;
      }
      if (name === 'edit_scene') {
        return {
          name,
          kind: 'write',
          schema: {},
          run: async () => ({
            tool: 'edit_scene',
            file: 'chapter_02.txt',
            patches: [{ type: 'insert', file: 'chapter_02.txt', afterLine: 'end', text: 'B:world;' }],
          }),
        } as never;
      }
      return undefined;
    });
    vi.mocked(createScene).mockImplementation(async () => {
      sceneExists = true;
      return '/tmp/proj/game/scene/chapter_02.txt';
    });
    vi.mocked(saveScene).mockImplementation(async () => {
      if (!sceneExists) throw new Error('scene path does not exist');
    });
    vi.mocked(updateSceneHeader).mockImplementation(async () => {
      if (!sceneExists) throw new Error('scene path does not exist');
    });

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    await act(async () => { await result.current.sendPrompt('创建并填写场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });
    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('accepted');
    expect(vi.mocked(applyAiChangeSet)).toHaveBeenCalledTimes(1);
    const persistedScene = vi.mocked(applyAiChangeSet).mock.calls[0]?.[1].edits
      .find((edit) => edit.kind === 'create_scene');
    expect(persistedScene).toEqual(expect.objectContaining({
      kind: 'create_scene',
      file: 'chapter_02.txt',
    }));
    expect(persistedScene?.kind === 'create_scene' ? persistedScene.initialContent : '').toContain('B:world;');
    expect(vi.mocked(createScene)).not.toHaveBeenCalled();
    expect(vi.mocked(saveScene)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteScene)).not.toHaveBeenCalled();
  });

  it('shows the backend recovery result when a newly created scene cannot be saved', async () => {
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'create_scene', arguments: { name: 'chapter_02' } },
          { id: 'c2', name: 'edit_scene', arguments: { file: 'chapter_02.txt' } },
        ],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockImplementation((name) => ({
      name,
      kind: 'write',
      schema: {},
      run: async () => name === 'create_scene'
        ? { tool: 'create_scene', name: 'chapter_02' }
        : {
          tool: 'edit_scene',
          file: 'chapter_02.txt',
          patches: [{ type: 'insert', file: 'chapter_02.txt', afterLine: 'end', text: 'B:world;' }],
        },
    }) as never);
    vi.mocked(applyAiChangeSet).mockResolvedValueOnce({
      outcome: 'failed',
      resource: 'scene',
      message: 'disk full',
      recovery: { status: 'restored' },
    });

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('创建并填写场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });
    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('项目已恢复到提交前状态');
    expect(vi.mocked(deleteScene)).not.toHaveBeenCalled();
  });

  it('keeps the pending change retryable when conflict re-read fails', async () => {
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'edit_scene', arguments: { file: 'other.txt' } }],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockReturnValue({
      name: 'edit_scene',
      kind: 'write',
      schema: {},
      run: async () => ({
        tool: 'edit_scene',
        file: 'other.txt',
        patches: [{ type: 'insert', file: 'other.txt', afterLine: 'end', text: 'B:world;' }],
      }),
    } as never);
    vi.mocked(readFileText).mockResolvedValueOnce('');
    vi.mocked(applyAiChangeSet).mockResolvedValueOnce({
      outcome: 'failed',
      resource: 'scene:other.txt',
      message: 'permission denied',
      recovery: { status: 'not_needed' },
    });

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });
    await act(async () => { await result.current.sendPrompt('修改其他场景'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });
    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toEqual(expect.objectContaining({ retryable: true }));
    expect(result.current.error?.message).toContain('项目尚未写入');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
    expect(vi.mocked(saveScene)).not.toHaveBeenCalled();
  });

  it('merges sprite planning and edits into a new character before the create IPC', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const temporaryId = `tmp_ai_1700000000000_${(0.5).toString(36).slice(2)}`;
    vi.mocked(aiChatTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'create_character', arguments: { name: '艾拉' } },
          { id: 'c2', name: 'plan_character_sprites', arguments: {} },
          { id: 'c3', name: 'edit_character', arguments: {} },
        ],
      } as unknown as AiTurnResult)
      .mockResolvedValue({ text: 'done', toolCalls: [] } as unknown as AiTurnResult);
    vi.mocked(getTool).mockImplementation((name) => {
      if (name === 'create_character') {
        return {
          name,
          kind: 'write',
          schema: {},
          run: async () => ({ tool: 'create_character', draft: { name: '艾拉' } }),
        } as never;
      }
      if (name === 'plan_character_sprites') {
        return {
          name,
          kind: 'write',
          schema: {},
          run: async () => ({
            tool: 'plan_character_sprites',
            character: temporaryId,
            sprites: [{ emotion: 'happy', prompt: 'smiling' }],
          }),
        } as never;
      }
      if (name === 'edit_character') {
        return {
          name,
          kind: 'write',
          schema: {},
          run: async () => ({
            tool: 'edit_character',
            id: temporaryId,
            partial: { personality: '勇敢' },
          }),
        } as never;
      }
      return undefined;
    });

    const params = makeParams();
    const { result } = renderHook(() => useAiAgent(params), { wrapper: MemoryRouter });

    await act(async () => { await result.current.sendPrompt('创建角色并完善设定'); });
    await waitFor(() => { expect(result.current.pendingChangeSet).toBeTruthy(); });
    const createEdit = result.current.pendingChangeSet?.edits.find((edit) => edit.kind === 'create_character');
    expect(createEdit?.kind).toBe('create_character');
    if (createEdit?.kind !== 'create_character') throw new Error('missing create edit');
    expect(createEdit.draft.id).toBe(temporaryId);

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('accepted');
    expect(vi.mocked(applyAiChangeSet)).toHaveBeenCalledTimes(1);
    const createdDraft = vi.mocked(applyAiChangeSet).mock.calls[0]?.[1].edits
      .find((edit) => edit.kind === 'create_character')?.draft;
    expect(createdDraft).toBeTruthy();
    if (!createdDraft) throw new Error('missing persisted create character edit');
    expect(createdDraft.personality).toBe('勇敢');
    expect(createdDraft.sprites).toEqual(expect.arrayContaining([
      expect.objectContaining({ emotion: 'happy', prompt: 'smiling' }),
    ]));
    expect(vi.mocked(createCharacter)).not.toHaveBeenCalled();
    expect(vi.mocked(updateCharacter)).not.toHaveBeenCalled();
    dateNow.mockRestore();
    random.mockRestore();
  });
});
