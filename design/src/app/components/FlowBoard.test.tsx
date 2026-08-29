import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as React from 'react';
import type { PipelineEvent, RunState } from '../lib/pipeline-types';
import { flowLayoutStorageKey } from '../lib/flow-layout';
import { FlowBoard } from './FlowBoard';

// React Flow's real renderer needs DOM measurements jsdom doesn't provide.
// Mock it as a passthrough that renders each node through its `nodeTypes`
// component, so we test our wiring + StepNode, not the library.
vi.mock('reactflow', () => ({
  default: ({ nodes, edges, nodeTypes, onNodeClick, onNodesChange, onNodeDragStop, onEdgesDelete }: { nodes: any[]; edges: any[]; nodeTypes: Record<string, any>; onNodeClick?: Function; onNodesChange?: Function; onNodeDragStop?: Function; onEdgesDelete?: Function }) =>
    React.createElement(
      'div',
      { 'data-testid': 'reactflow-mock' },
      ...nodes.flatMap((n) => nodeTypes?.[n.type] ? [
        React.createElement(
          'button',
          { key: `open-${n.id}`, 'aria-label': `open-${n.id}`, onClick: (event) => onNodeClick?.(event, n) },
          React.createElement(nodeTypes[n.type], { data: n.data }),
        ),
        React.createElement('button', {
          key: `move-${n.id}`,
          'aria-label': `move-${n.id}`,
          onClick: () => {
            const moved = { ...n, position: { x: 410, y: 220 } };
            onNodesChange?.([{ id: n.id, type: 'position', position: moved.position }]);
            onNodeDragStop?.({}, moved);
          },
        }),
      ] : []),
      edges[0] ? React.createElement('button', {
        key: 'delete-edge',
        'aria-label': 'delete-first-edge',
        onClick: () => onEdgesDelete?.([edges[0]]),
      }) : null,
      nodes[1] ? React.createElement('button', {
        key: 'drop-node',
        'aria-label': 'drop-second-on-first',
        onClick: () => {
          const moved = { ...nodes[1], position: nodes[0].position };
          onNodesChange?.([{ id: moved.id, type: 'position', position: moved.position }]);
          onNodeDragStop?.({}, moved);
        },
      }) : null,
    ),
  useNodesState: (initialNodes: any[]) => {
    const [nodes, setNodes] = React.useState(initialNodes);
    const onNodesChange = React.useCallback((changes: any[]) => {
      setNodes((current: any[]) => current.map((node) => {
        const change = changes.find((candidate) => candidate.id === node.id);
        return change?.position ? { ...node, position: change.position } : node;
      }));
    }, []);
    return [nodes, setNodes, onNodesChange];
  },
  Handle: () => null,
  Background: () => null,
  Controls: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

let lastListenHandler: ((event: { payload: PipelineEvent }) => void) | null = null;
let listenHandlers: Array<(event: { payload: PipelineEvent }) => void> = [];

function runState(status: RunState['status'] = 'running'): RunState {
  return {
    runId: 'run_1',
    projectPath: '/tmp/proj',
    prompt: 'brief',
    status,
    startedAt: 1,
    updatedAt: 2,
    pinned: false,
    allowLocalFallback: false,
    steps: [
      {
        def: { id: 'plan', kind: 'plan', dependsOn: [], agent: null, prompt: '' },
        status: status === 'completed' ? 'succeeded' : 'pending',
        attempt: status === 'completed' ? 1 : 0,
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
      {
        def: { id: 'outline', kind: 'outline', dependsOn: ['plan'], agent: null, prompt: '' },
        status: status === 'completed' ? 'succeeded' : 'pending',
        attempt: status === 'completed' ? 1 : 0,
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  lastListenHandler = null;
  listenHandlers = [];
  mockedInvoke.mockReset();
  mockedListen.mockReset();
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
    if (cmd === 'pipeline_get_state') return Promise.resolve(runState() as unknown);
    if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
    return Promise.resolve(undefined);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedListen.mockImplementation((_channel: string, handler: any) => {
    lastListenHandler = handler as typeof lastListenHandler;
    listenHandlers.push(handler as (event: { payload: PipelineEvent }) => void);
    return Promise.resolve((() => {}) as unknown as ReturnType<typeof listen>);
  });
});

function emit(event: PipelineEvent) {
  // The listen callback fires outside a React event handler; wrap in act so
  // the dispatched state update flushes before the next assertion.
  act(() => {
    lastListenHandler?.({ payload: event });
  });
}

function stepStatus(id: string): string | null {
  return document.querySelector(`[data-step-id="${id}"]`)?.getAttribute('data-step-status') ?? null;
}

describe('FlowBoard', () => {
  it('starts a run and updates step statuses from streamed events', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.type(screen.getByLabelText('production brief'), '赛博朋克校园恋爱');
    await user.click(screen.getByRole('button', { name: '创建流程' }));

    // pipeline_start was invoked with the brief; an event subscription opened.
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalled());
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_start', {
      projectPath: '/tmp/proj',
      prompt: '赛博朋克校园恋爱',
      allowLocalFallback: false,
    });
    expect(mockedListen).toHaveBeenCalledWith('pipeline:run_1', expect.any(Function));

    // Initially both steps are pending.
    expect(stepStatus('plan')).toBe('pending');
    expect(stepStatus('outline')).toBe('pending');

    // Stream the happy path: plan runs and succeeds, then outline, then done.
    emit({ type: 'runStarted', runId: 'run_1' });
    emit({ type: 'stepStarted', runId: 'run_1', stepId: 'plan', kind: 'plan' });
    expect(stepStatus('plan')).toBe('running');

    emit({ type: 'stepSucceeded', runId: 'run_1', stepId: 'plan', output: null });
    expect(stepStatus('plan')).toBe('succeeded');

    emit({ type: 'stepStarted', runId: 'run_1', stepId: 'outline', kind: 'outline' });
    emit({ type: 'stepSucceeded', runId: 'run_1', stepId: 'outline', output: null });
    expect(stepStatus('outline')).toBe('succeeded');

    emit({ type: 'runCompleted', runId: 'run_1' });
    expect(screen.getByTestId('flow-run-status')).toHaveTextContent('已完成');
  });

  it('shows live asset queue progress and refreshes it on the asset event', async () => {
    const user = userEvent.setup();
    const queued = runState('running');
    queued.steps.push({
      def: { id: 'media-production', kind: 'asset', dependsOn: ['outline'], agent: 'assetQueue', prompt: '' },
      status: 'running',
      attempt: 1,
      output: null,
      error: null,
      startedAt: 2,
      finishedAt: null,
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.resolve([queued] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(queued as unknown);
      if (cmd === 'asset_queue_get' || cmd === 'asset_queue_promote_artifact') return Promise.resolve({
        runId: 'run_1',
        updatedAt: 3,
        tasks: [
          {
            id: 'bg', kind: 'background', targetStem: 'bg', prompt: '背景', status: 'succeeded',
            attempts: [{ attempt: 1, artifact: '.ollaic/artifacts/bg/1.png' }],
            assetFile: cmd === 'asset_queue_promote_artifact' ? 'bg-promoted.png' : 'bg.png',
          },
          { id: 'voice', kind: 'tts', targetStem: 'voice', prompt: '对白', status: 'running', attempts: [{ attempt: 1 }] },
        ],
      } as unknown);
      return Promise.resolve(undefined);
    });

    render(<FlowBoard projectPath="/tmp/proj" />);

    expect(await screen.findByText('1/2 已处理')).toBeInTheDocument();
    expect(mockedInvoke).toHaveBeenCalledWith('asset_queue_get', { projectPath: '/tmp/proj' });
    expect(screen.getByLabelText('media-production 步骤进度')).toHaveAttribute('aria-valuenow', '50');
    await user.click(screen.getByRole('button', { name: 'open-media-production' }));
    await user.click(screen.getByRole('tab', { name: '输出' }));
    await user.click(screen.getByRole('button', { name: '提升 bg 候选 1' }));
    expect(mockedInvoke).toHaveBeenCalledWith('asset_queue_promote_artifact', {
      projectPath: '/tmp/proj', taskId: 'bg', attempt: 1,
    });
    expect(await screen.findByText('正式素材 bg-promoted.png')).toBeInTheDocument();
    const callsBeforeEvent = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'asset_queue_get').length;
    emit({ type: 'stepSucceeded', runId: 'run_1', stepId: 'media-production', output: '{"tasks":2}' });
    await vi.waitFor(() => expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'asset_queue_get').length,
    ).toBeGreaterThan(callsBeforeEvent));
  });

  it('disables run while the brief is empty', () => {
    render(<FlowBoard projectPath="/tmp/proj" />);
    expect(screen.getByRole('button', { name: '创建流程' })).toBeDisabled();
  });

  it('requires an explicit user choice before allowing local fallback', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await user.type(screen.getByLabelText('production brief'), '校园悬疑');
    await user.click(screen.getByLabelText('允许本地内容降级'));
    await user.click(screen.getByRole('button', { name: '创建流程' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_start', {
      projectPath: '/tmp/proj',
      prompt: '校园悬疑',
      allowLocalFallback: true,
    });
  });

  it('prepares a paused flow before the user starts execution', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '创建流程' }));
    await user.click(await screen.findByRole('button', { name: '运行' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_resume', {
      runId: 'run_1',
      projectPath: '/tmp/proj',
    });
  });

  it('switches to pause/resume controls while running and paused', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '创建流程' }));
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalled());

    emit({ type: 'runStarted', runId: 'run_1' });
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建流程' })).not.toBeInTheDocument();

    emit({ type: 'stepStarted', runId: 'run_1', stepId: 'plan', kind: 'plan' });
    emit({ type: 'runPaused', runId: 'run_1' });
    expect(screen.getByRole('button', { name: '继续运行' })).toBeInTheDocument();
  });

  it('hydrates completed state when fast steps finished before event subscription', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('completed') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '创建流程' }));

    await vi.waitFor(() => expect(screen.getByTestId('flow-run-status')).toHaveTextContent('已完成'));
    expect(stepStatus('plan')).toBe('succeeded');
    expect(stepStatus('outline')).toBe('succeeded');
  });

  it('discovers a persisted paused run and resumes it through crash recovery', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.resolve([runState('paused')] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    const resume = await screen.findByRole('button', { name: '恢复运行' });
    await user.click(resume);

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_resume_run', {
      projectPath: '/tmp/proj',
      runId: 'run_1',
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith('pipeline_resume', {
      runId: 'run_1',
      projectPath: '/tmp/proj',
    });
  });

  it('recognizes a run that is still live in the current process', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.resolve([runState('paused')] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: '运行' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_resume', {
      runId: 'run_1',
      projectPath: '/tmp/proj',
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith('pipeline_resume_run', expect.anything());
  });

  it('retries a selected failed step with enough context to attach a persisted run', async () => {
    const failed = runState('failed');
    failed.steps[0].status = 'failed';
    failed.steps[0].error = 'boom';
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.resolve([failed] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(failed as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: 'open-plan' }));
    await user.click(screen.getByRole('button', { name: '从此步重跑' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_retry_step', {
      runId: 'run_1',
      stepId: 'plan',
      projectPath: '/tmp/proj',
    });
  });

  it('persists a dragged node position for the current project and run', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: 'move-plan' }));

    expect(JSON.parse(localStorage.getItem(flowLayoutStorageKey('/tmp/proj', null)) ?? '{}')).toMatchObject({
      plan: { x: 410, y: 220 },
    });
  });

  it('supports dependency deletion while a prepared run is locally paused', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '创建流程' }));
    await user.click(await screen.findByRole('button', { name: 'delete-first-edge' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_update_dependencies', {
      runId: 'run_1',
      stepId: 'outline',
      dependsOn: [],
      projectPath: '/tmp/proj',
    });
  });

  it('adds a dependency when a pending node is dropped onto another node', async () => {
    const prepared = runState('paused');
    prepared.steps[1].def.dependsOn = [];
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(prepared as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '创建流程' }));
    await user.click(await screen.findByRole('button', { name: 'drop-second-on-first' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_update_dependencies', {
      runId: 'run_1',
      stepId: 'outline',
      dependsOn: ['plan'],
      projectPath: '/tmp/proj',
    });
  });

  it('exposes stop and single-step execution as deterministic controls', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '创建流程' }));
    await user.click(await screen.findByRole('button', { name: '单步' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_step_once', {
      runId: 'run_1',
      projectPath: '/tmp/proj',
    });

    emit({ type: 'runResumed', runId: 'run_1' });
    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_stop', {
      runId: 'run_1',
      projectPath: '/tmp/proj',
    });
  });

  it('edits a step prompt and reruns it from the inspector', async () => {
    const failed = runState('failed');
    failed.steps[0].status = 'failed';
    failed.steps[0].def.prompt = '旧提示词';
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.resolve([failed] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(failed as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: 'open-plan' }));
    const promptEditor = screen.getByLabelText('plan 步骤 Prompt');
    await user.clear(promptEditor);
    await user.type(promptEditor, '突出女主冲突与选择');
    await user.click(screen.getByRole('button', { name: '保存并重跑' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_update_step_prompt', {
      runId: 'run_1',
      stepId: 'plan',
      prompt: '突出女主冲突与选择',
      projectPath: '/tmp/proj',
    });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_retry_step', {
      runId: 'run_1',
      stepId: 'plan',
      projectPath: '/tmp/proj',
    });
  });

  it('shows StoryPlan summary and a recoverable loading error', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.reject(new Error('disk unavailable'));
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('disk unavailable');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.resolve([runState('completed')] as unknown);
      if (cmd === 'pipeline_get_plan') return Promise.resolve({
        version: 2,
        prompt: 'brief',
        synopsis: '两位创作者在共同制作游戏时重新理解彼此。',
        memory: { worldbook: '' },
        chapters: [{ id: 'c1', title: '重逢', summary: '' }],
        scenes: ['scene-1'],
        pipelineRuns: [],
      } as unknown);
      return Promise.resolve(undefined);
    });
    await user.click(screen.getByRole('button', { name: '重试加载' }));

    expect(await screen.findByText('两位创作者在共同制作游戏时重新理解彼此。')).toBeInTheDocument();
    expect(screen.getByText('0 角色 / 1 场景 / 0 资产需求')).toBeInTheDocument();
  });

  it('pins, exports, and manually clears retained run history', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_list_runs') return Promise.resolve([runState('completed')] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('completed') as unknown);
      return Promise.resolve(undefined);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: '固定运行记录' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_set_run_pinned', {
      runId: 'run_1', pinned: true, projectPath: '/tmp/proj',
    });
    expect(screen.getByRole('button', { name: '导出运行记录' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除运行记录' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_clear_run_history', {
      runId: 'run_1', projectPath: '/tmp/proj',
    });
  });

  it('ignores stale project loads and events after navigation', async () => {
    let resolveOldRuns: (runs: RunState[]) => void = () => {};
    const oldRuns = new Promise<RunState[]>((resolve) => { resolveOldRuns = resolve; });
    const old = runState('paused');
    old.runId = 'run_old';
    old.projectPath = '/tmp/old';
    old.prompt = 'old brief';
    const current = runState('paused');
    current.runId = 'run_current';
    current.projectPath = '/tmp/current';
    current.prompt = 'current brief';
    mockedInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'pipeline_list_runs') {
        const projectPath = (args as { projectPath?: string } | undefined)?.projectPath;
        return (projectPath === '/tmp/old' ? oldRuns : Promise.resolve([current])) as Promise<never>;
      }
      if (cmd === 'pipeline_get_plan') return Promise.resolve(null as never);
      return Promise.resolve(undefined);
    });

    const view = render(<FlowBoard projectPath="/tmp/old" />);
    view.rerender(<FlowBoard projectPath="/tmp/current" />);
    expect(await screen.findByDisplayValue('current brief')).toBeInTheDocument();
    await vi.waitFor(() => expect(listenHandlers.length).toBe(1));

    resolveOldRuns([old]);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByDisplayValue('current brief')).toBeInTheDocument();
    expect(screen.queryByText('old brief')).not.toBeInTheDocument();

    act(() => {
      listenHandlers[0]?.({ payload: { type: 'stepFailed', runId: 'run_old', stepId: 'plan', error: 'stale run error' } });
    });
    expect(screen.queryByText(/stale run error/)).not.toBeInTheDocument();
  });

  it('uses the current project for controls and refreshes after navigation', async () => {
    const old = runState('running');
    old.runId = 'run_old';
    old.projectPath = '/tmp/old';
    old.prompt = 'old brief';
    const current = runState('running');
    current.runId = 'run_current';
    current.projectPath = '/tmp/current';
    current.prompt = 'current brief';
    let currentStatus: RunState['status'] = 'running';
    mockedInvoke.mockImplementation((cmd, args) => {
      const projectPath = (args as { projectPath?: string } | undefined)?.projectPath;
      if (cmd === 'pipeline_list_runs') {
        return Promise.resolve([projectPath === '/tmp/old' ? old : { ...current, status: currentStatus }]) as Promise<never>;
      }
      if (cmd === 'pipeline_get_state') {
        const snapshot = projectPath === '/tmp/old' ? old : { ...current, status: currentStatus };
        return Promise.resolve(snapshot) as Promise<never>;
      }
      if (cmd === 'pipeline_pause') currentStatus = 'paused';
      if (cmd === 'pipeline_stop') currentStatus = 'cancelled';
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();

    const view = render(<FlowBoard projectPath="/tmp/old" />);
    expect(await screen.findByDisplayValue('old brief')).toBeInTheDocument();
    view.rerender(<FlowBoard projectPath="/tmp/current" />);
    expect(await screen.findByDisplayValue('current brief')).toBeInTheDocument();
    mockedInvoke.mockClear();

    await user.click(screen.getByRole('button', { name: '暂停' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_pause', {
      runId: 'run_current', projectPath: '/tmp/current',
    });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_get_state', {
      runId: 'run_current', projectPath: '/tmp/current',
    });

    await user.click(await screen.findByRole('button', { name: 'open-plan' }));
    await user.click(screen.getByRole('button', { name: '跳过' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_skip_step', {
      runId: 'run_current', stepId: 'plan', projectPath: '/tmp/current',
    });

    currentStatus = 'paused';
    emit({ type: 'runPaused', runId: 'run_current' });
    await user.click(screen.getByRole('button', { name: 'delete-first-edge' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_update_dependencies', {
      runId: 'run_current', stepId: 'outline', dependsOn: [], projectPath: '/tmp/current',
    });

    currentStatus = 'running';
    emit({ type: 'runResumed', runId: 'run_current' });
    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_stop', {
      runId: 'run_current', projectPath: '/tmp/current',
    });
    expect(mockedInvoke.mock.calls.filter(([cmd, args]) => (
      cmd === 'pipeline_get_state'
      && (args as { projectPath?: string } | undefined)?.projectPath === '/tmp/current'
    ))).toHaveLength(4);
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ projectPath: '/tmp/old' }),
    );
  });
});
