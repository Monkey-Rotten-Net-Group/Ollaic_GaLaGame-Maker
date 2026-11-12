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

vi.mock('../lib/project-memory', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/project-memory')>(),
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
  parseScene: vi.fn(async () => []),
  serializeScene: vi.fn(async () => ''),
  getScenePath: vi.fn(async (_p: string, n: string) => `/tmp/${n}`),
  readFileText: vi.fn(async () => ''),
  listScenes: vi.fn(async () => []),
  saveScene: vi.fn(async () => {}),
  createScene: vi.fn(async () => '/tmp/new.txt'),
  deleteScene: vi.fn(async () => {}),
  updateSceneHeader: vi.fn(async () => {}),
  sceneDisplayName: (f: string) => f,
}));

vi.mock('../lib/ai-uploads-ipc', () => ({
  listAiUploads: vi.fn(async () => []),
  readAiUpload: vi.fn(async () => null),
  importAiUpload: vi.fn(async () => ({})),
  buildInlineUploadContext: vi.fn(async () => ''),
  buildUploadContext: vi.fn(() => ''),
  deleteAiUpload: vi.fn(async () => {}),
}));

import { useAiAgent } from './useAiAgent';
import { clearProjectAiRuntime } from '../lib/project-ai-runtime';
import { aiChatTurn, appendAiAgentTrace, getAiProviderCapability } from '../lib/ai-ipc';
import type { WebGalNode } from '../lib/webgal-types';

function makeNode(id: string, content: string): WebGalNode {
  return {
    id,
    type: 'dialogue',
    character: '林夏',
    content,
    flags: [],
    position: { x: 0, y: 0 },
    connections: [],
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'scope-test',
    projectPath: '/tmp/proj-scope',
    currentSceneName: 'start.txt',
    sceneHeaders: {},
    nodes: [makeNode('n1', '第一句'), makeNode('n2', '第二句')],
    selectedNode: null,
    defaultEditScope: 'scene' as const,
    scriptSource: '林夏:第一句;\n林夏:第二句;',
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

beforeEach(() => {
  vi.clearAllMocks();
  clearProjectAiRuntime();
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
});

describe('useAiAgent edit scope isolation and reactivity', () => {
  it('keeps user message bubble and session title clean while passing scene scope in model context', async () => {
    vi.mocked(aiChatTurn).mockResolvedValueOnce({ text: '收到', toolCalls: [] });
    const { result } = renderHook(() => useAiAgent(makeParams()), { wrapper: MemoryRouter });

    expect(result.current.editScope).toBe('scene');
    await act(async () => {
      await result.current.sendPrompt('1');
    });

    const userMsg = result.current.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('1');
    expect(result.current.sessions[0]?.title).toBe('1');

    const sentMessages = vi.mocked(aiChatTurn).mock.calls[0][1];
    expect(sentMessages[0]?.content).toContain('仅当前场景（start.txt）');
    expect(sentMessages[sentMessages.length - 1]?.content).toContain('仅编辑当前场景 start.txt');
    expect(sentMessages[sentMessages.length - 1]?.content).toContain('1');
  });

  it('uses the updated scope when retrying after a failed turn', async () => {
    vi.mocked(aiChatTurn)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ text: '已按全剧范围处理', toolCalls: [] });

    const { result } = renderHook(() => useAiAgent(makeParams()), { wrapper: MemoryRouter });

    await act(async () => {
      await result.current.sendPrompt('1');
    });
    expect(result.current.status).toBe('error');

    act(() => {
      result.current.setEditScope('full');
    });
    expect(result.current.editScope).toBe('full');

    await act(async () => {
      result.current.retry();
    });

    expect(vi.mocked(aiChatTurn)).toHaveBeenCalledTimes(2);
    const retryMessages = vi.mocked(aiChatTurn).mock.calls[1][1];
    expect(retryMessages[0]?.content).toContain('全剧范围');
    expect(retryMessages[0]?.content).not.toContain('仅当前场景（start.txt）');
    expect(retryMessages[retryMessages.length - 1]?.content).toContain('全剧范围');

    const userMessages = result.current.messages.filter((m) => m.role === 'user');
    expect(userMessages.map((m) => m.content)).toEqual(['1', '1']);
  });

  it('activates node scope on selection, falls back to scene on clear, and preserves manual full scope', async () => {
    vi.mocked(aiChatTurn).mockResolvedValue({ text: 'ok', toolCalls: [] });
    const node2 = makeNode('n2', '第二句');
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof makeParams>) => useAiAgent(props),
      { initialProps: makeParams(), wrapper: MemoryRouter },
    );

    expect(result.current.editScope).toBe('scene');

    rerender(makeParams({ selectedNode: node2 }));
    expect(result.current.editScope).toBe('node');

    await act(async () => {
      await result.current.sendPrompt('改温柔点');
    });
    const nodeTurnMessages = vi.mocked(aiChatTurn).mock.calls[0][1];
    expect(nodeTurnMessages[0]?.content).toContain('行级聚焦');
    expect(nodeTurnMessages[0]?.content).toContain('第 2 条指令');
    expect(nodeTurnMessages[0]?.content).toContain('第二句');
    expect(result.current.messages.find((m) => m.role === 'user')?.content).toBe('改温柔点');

    rerender(makeParams({ selectedNode: null }));
    expect(result.current.editScope).toBe('scene');

    rerender(makeParams({ selectedNode: node2 }));
    expect(result.current.editScope).toBe('node');

    act(() => {
      result.current.setEditScope('full');
    });
    expect(result.current.editScope).toBe('full');

    rerender(makeParams({ selectedNode: null }));
    expect(result.current.editScope).toBe('full');
  });

  it('omits scope wrapper when defaultEditScope is unset (cassette harness compatibility)', async () => {
    vi.mocked(aiChatTurn).mockResolvedValueOnce({ text: 'ok', toolCalls: [] });
    const { result } = renderHook(
      () => useAiAgent(makeParams({ defaultEditScope: undefined })),
      { wrapper: MemoryRouter },
    );

    expect(result.current.editScope).toBeUndefined();
    await act(async () => {
      await result.current.sendPrompt('Update the narration');
    });

    const sentMessages = vi.mocked(aiChatTurn).mock.calls[0][1];
    expect(sentMessages[0]?.content).not.toContain('当前编辑范围');
    expect(sentMessages[sentMessages.length - 1]?.content).toBe('Update the narration');
  });
});
