import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { useAiAgent } from '../hooks/useAiAgent';
import { createEditorCommitCoordinator } from '../components/story-editor/editor-commit-coordinator';
import type { AiTurnResult } from '../lib/ai-ipc';
import type { ApplyChangeSetRequest, ApplyChangeSetResult } from '../lib/change-set-ipc';
import type { WebGalNode } from '../lib/webgal-types';
import createEditChangeSet from './fixtures/create-edit-change-set.json';

vi.mock('../lib/ai-ipc', () => ({
  aiChatTurn: vi.fn(),
  aiChatCancel: vi.fn(async () => true),
  appendAiAgentTrace: vi.fn(async () => {}),
  getAiConfig: vi.fn(async () => ({ provider: 'openai', model: 'test', apiKey: '', baseUrl: '' })),
  getAiProviderCapability: vi.fn(async () => ({ chatTools: true, streamingCancellation: true })),
}));

import { aiChatCancel, aiChatTurn } from '../lib/ai-ipc';

interface HarnessProject {
  scenes: Map<string, string>;
  requests: ApplyChangeSetRequest[];
  persistenceResult: ApplyChangeSetResult;
}

const invokeMock = vi.mocked(invoke);
let project: HarnessProject;

const emptyMetadata = {
  aliases: {}, descriptions: {}, tags: {}, references: {},
  sceneCards: {}, cgCards: {}, voiceCards: {},
  deletedSceneCards: [], deletedCgCards: [], deletedVoiceCards: [],
};

function parseNodes(source: string): WebGalNode[] {
  return source.split('\n').map((content, index) => ({
    id: `node-${index}`,
    type: 'comment',
    content,
    flags: [],
    position: { x: 0, y: 0 },
    connections: [],
  }));
}

function persistenceResponse(request: ApplyChangeSetRequest): ApplyChangeSetResult | Record<string, unknown> {
  project.requests.push(structuredClone(request));
  if (project.persistenceResult.status === 'failed-and-rolled-back') {
    return {
      status: 'failed-and-rolled-back',
      failed_resource: project.persistenceResult.failedResource,
      message: project.persistenceResult.message,
    };
  }
  if (project.persistenceResult.status === 'rollback-failed') {
    return {
      status: 'rollback-failed',
      failed_resource: project.persistenceResult.failedResource,
      residual_resources: project.persistenceResult.residualResources,
      message: project.persistenceResult.message,
    };
  }
  return project.persistenceResult;
}

function installCommandSeam() {
  invokeMock.mockImplementation(async (command, args) => {
    if (command === 'list_all_assets' || command === 'list_assets') return [];
    if (command === 'list_ai_uploads') return [];
    if (command === 'read_project_memory') return null;
    if (command === 'load_asset_metadata') return emptyMetadata;
    if (command === 'list_characters') return [];
    if (command === 'list_character_names') return [];
    if (command === 'list_scenes') return [...project.scenes.keys()];
    if (command === 'read_file_text') {
      const file = (args as { sceneName: string }).sceneName;
      const content = project.scenes.get(file);
      if (content === undefined) throw new Error(`missing scene: ${file}`);
      return content;
    }
    if (command === 'parse_scene') return parseNodes(String((args as { source?: string }).source ?? ''));
    if (command === 'serialize_scene') {
      return ((args as { nodes: Array<{ content: string }> }).nodes ?? []).map((node) => node.content).join('\n');
    }
    if (command === 'apply_change_set') {
      return persistenceResponse((args as { request: ApplyChangeSetRequest }).request);
    }
    throw new Error(`unexpected command: ${command}`);
  });
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'integration-project',
    projectPath: '/virtual/project',
    currentSceneName: 'start.txt',
    sceneHeaders: {},
    nodes: parseNodes(project.scenes.get('start.txt') ?? ''),
    selectedNode: null,
    scriptSource: project.scenes.get('start.txt') ?? '',
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

function turns(...results: AiTurnResult[]) {
  vi.mocked(aiChatTurn).mockReset();
  for (const result of results) vi.mocked(aiChatTurn).mockResolvedValueOnce(result);
}

async function sendAndWait(result: { current: ReturnType<typeof useAiAgent> }) {
  await act(async () => { await result.current.sendPrompt('execute'); });
  await waitFor(() => expect(result.current.pendingChangeSet).toBeTruthy());
}

describe('AI conversational orchestration -> production change-set adapter contract', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    project = {
      scenes: new Map([['start.txt', 'A:old;']]),
      requests: [],
      persistenceResult: { status: 'committed', resources: [] },
    };
    installCommandSeam();
    vi.mocked(aiChatCancel).mockClear();
  });

  it('keeps create/edit/read in the staging overlay, then sends the shared command fixture on Accept', async () => {
    turns(
      { text: '', toolCalls: [{ id: 'create', name: 'create_scene', arguments: { name: 'chapter-2' } }] },
      { text: '', toolCalls: [{
        id: 'edit', name: 'edit_scene', arguments: {
          file: 'chapter-2.txt',
          patches: [{ type: 'insert', afterLine: 'end', text: 'B:staged;' }],
        },
      }] },
      { text: '', toolCalls: [{ id: 'read', name: 'read_scene', arguments: { name: 'chapter-2.txt' } }] },
      { text: 'done', toolCalls: [] },
    );
    const hookParams = params();
    const { result } = renderHook(() => useAiAgent(hookParams), { wrapper: MemoryRouter });

    await sendAndWait(result);
    expect(project.requests).toHaveLength(0);
    expect(project.scenes.has('chapter-2.txt')).toBe(false);
    const finalConversation = vi.mocked(aiChatTurn).mock.calls[3][1];
    expect(finalConversation[finalConversation.length - 1]).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('B:staged;'),
    });

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('accepted');
    expect(project.requests).toHaveLength(1);
    expect({
      ...project.requests[0],
      operations: project.requests[0].operations.filter((operation) => operation.kind !== 'narrative_context'),
    }).toEqual(createEditChangeSet as ApplyChangeSetRequest);
    expect(project.requests[0].operations).toHaveLength(2);
    expect(project.requests[0].operations[0]).toMatchObject({ kind: 'create_scene', file: 'chapter-2.txt' });
    expect(project.requests[0].operations[1]).toMatchObject({
      kind: 'narrative_context',
      document: expect.objectContaining({
        acceptedFacts: [expect.objectContaining({
          values: expect.arrayContaining([expect.stringContaining('场景 chapter-2.txt 初始内容：B:staged;')]),
        })],
      }),
    });
  });

  it('preserves a user write when the staged baseline is stale', async () => {
    turns(
      { text: '', toolCalls: [{ id: 'edit', name: 'edit_scene', arguments: {
        file: 'start.txt', patches: [{ type: 'insert', afterLine: 'end', text: 'AI:change;' }],
      } }] },
      { text: 'done', toolCalls: [] },
    );
    const { result } = renderHook(() => useAiAgent(params()), { wrapper: MemoryRouter });
    await sendAndWait(result);
    project.persistenceResult = {
      status: 'conflict',
      resources: [{ kind: 'scene', file: 'start.txt' }],
    };

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('conflict');
    expect(result.current.pendingChangeSet?.status).toBe('pending');
    expect(project.scenes.get('start.txt')).toBe('A:old;');
  });

  it.each([
    ['rolled-back', true, '已回滚全部修改'],
    ['rollback-failed', false, '部分资源可能已写入'],
  ] as const)('maps %s outcomes while retaining the pending review', async (failureMode, retryable, message) => {
    project.persistenceResult = failureMode === 'rolled-back'
      ? {
          status: 'failed-and-rolled-back',
          failedResource: { kind: 'scene', file: 'start.txt' },
          message: 'injected write failure',
        }
      : {
          status: 'rollback-failed',
          failedResource: { kind: 'scene', file: 'start.txt' },
          residualResources: [{ kind: 'scene', file: 'start.txt' }],
          message: 'injected rollback failure',
        };
    turns(
      { text: '', toolCalls: [{ id: 'edit', name: 'edit_scene', arguments: {
        file: 'start.txt', patches: [{ type: 'insert', afterLine: 'end', text: 'AI:change;' }],
      } }] },
      { text: 'done', toolCalls: [] },
    );
    const { result } = renderHook(() => useAiAgent(params()), { wrapper: MemoryRouter });
    await sendAndWait(result);

    await act(async () => { await result.current.acceptChange(); });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatchObject({ retryable, message: expect.stringContaining(message) });
    expect(result.current.pendingChangeSet?.status).toBe('pending');
    expect(project.scenes.get('start.txt')).toBe('A:old;');
  });

  it('revokes a stopped run before a late tool can read or write, then allows a new owner', async () => {
    let release!: (result: AiTurnResult) => void;
    vi.mocked(aiChatTurn).mockReset().mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useAiAgent(params()), { wrapper: MemoryRouter });
    let first!: Promise<void>;
    act(() => { first = result.current.sendPrompt('run A'); });
    await waitFor(() => expect(aiChatTurn).toHaveBeenCalledOnce());

    act(() => result.current.stop());
    release({ text: '', toolCalls: [{ id: 'late', name: 'edit_scene', arguments: {
      file: 'start.txt', patches: [{ type: 'insert', afterLine: 'end', text: 'B:LATE;' }],
    } }] });
    await act(async () => { await first; });
    expect(project.requests).toHaveLength(0);
    expect(result.current.pendingChangeSet).toBeNull();

    turns(
      { text: '', toolCalls: [{ id: 'new', name: 'edit_scene', arguments: {
        file: 'start.txt', patches: [{ type: 'insert', afterLine: 'end', text: 'B:NEW;' }],
      } }] },
      { text: 'done', toolCalls: [] },
    );
    await act(async () => { await result.current.sendPrompt('run B'); });
    expect(result.current.pendingChangeSet).toBeTruthy();
  });

  it('blocks autosave during commit and leaves unrelated cached drafts untouched', async () => {
    const coordinator = createEditorCommitCoordinator();
    const unrelatedDraft = parseNodes('AUTHOR:draft;');
    coordinator.cacheDraft('chapter-2.txt', unrelatedDraft);
    let releaseCommit!: () => void;
    const commandSeam = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => {
      if (command !== 'apply_change_set') return commandSeam(command, args);
      await new Promise<void>((resolve) => { releaseCommit = resolve; });
      return commandSeam(command, args);
    });
    turns(
      { text: '', toolCalls: [{ id: 'edit', name: 'edit_scene', arguments: {
        file: 'start.txt', patches: [{ type: 'insert', afterLine: 'end', text: 'AI:commit;' }],
      } }] },
      { text: 'done', toolCalls: [] },
    );
    const reconcileCurrentScene = vi.fn();
    const { result } = renderHook(() => useAiAgent(params({
      onCommitStart: (files: string[]) => coordinator.beginCommit(files),
      onCommitSettled: () => coordinator.settleCommit(),
      reconcileCurrentScene,
    })), { wrapper: MemoryRouter });
    await sendAndWait(result);

    let accepting!: Promise<void>;
    act(() => { accepting = result.current.acceptChange(); });
    await waitFor(() => expect(releaseCommit).toBeTypeOf('function'));
    expect(coordinator.startSave('start.txt')).toBeNull();
    expect(coordinator.getDraft('chapter-2.txt')).toBe(unrelatedDraft);

    await act(async () => { releaseCommit(); await accepting; });
    expect(coordinator.canSave('start.txt')).toBe(true);
    expect(coordinator.getDraft('chapter-2.txt')).toBe(unrelatedDraft);
    expect(reconcileCurrentScene).toHaveBeenCalledOnce();
  });
});
