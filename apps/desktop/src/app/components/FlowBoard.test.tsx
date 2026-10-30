import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PipelineEvent, RunState } from '../lib/pipeline-types';
import { DEFAULT_RECIPE_STEPS } from '../lib/flow-state';
import { FlowBoard } from './FlowBoard';

const CONTENT_STEP_IDS = DEFAULT_RECIPE_STEPS.filter((step) => step.id !== 'assetQueue').map((step) => step.id);
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
    if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
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
  it('opens the current AI settings tab from the pre-run check', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: 'AI 设置' }));

    expect(await screen.findByRole('heading', { name: '编辑器设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI 模型服务' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('only requires media capabilities when material production is selected', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), '只生成故事与场景');
    const prepare = screen.getByRole('button', { name: '准备流程' });
    await vi.waitFor(() => expect(prepare).toBeEnabled());
    expect(screen.getByLabelText('执行素材生成与绑定')).not.toBeChecked();
    await user.click(screen.getByLabelText('执行素材生成与绑定'));
    expect(prepare).toBeDisabled();
    expect(screen.getByText('素材制作：未配置素材接口')).toBeInTheDocument();
    await user.click(screen.getByLabelText('执行素材生成与绑定'));
    expect(prepare).toBeEnabled();
    await user.click(prepare);
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_start', expect.objectContaining({
      selectedStepIds: CONTENT_STEP_IDS, allowLocalFallback: false,
    }));
  });

  it('keeps a deselected prerequisite off and requires an explicit dependency repair', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), '先做故事规划');
    await user.click(screen.getByLabelText('执行世界观设定'));
    expect(screen.getByLabelText('执行世界观设定')).not.toBeChecked();
    expect(screen.getByLabelText('执行章节大纲')).toBeChecked();
    expect(screen.getByRole('button', { name: '准备流程' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('章节大纲需要世界观设定的结果');
    await user.click(screen.getByRole('button', { name: '取消相关后续步骤' }));
    expect(screen.getByLabelText('执行世界观设定')).not.toBeChecked();
    expect(screen.getByLabelText('执行章节大纲')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: '准备流程' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_start', expect.objectContaining({ selectedStepIds: ['plan'] }));
  });

  it('can explicitly restore the prerequisites before preparation', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), '完整内容');
    await user.click(screen.getByLabelText('执行故事规划'));
    await user.click(screen.getByRole('button', { name: '补选前置步骤' }));
    expect(screen.getByLabelText('执行故事规划')).toBeChecked();
    expect(screen.getByRole('button', { name: '准备流程' })).toBeEnabled();
  });

  it('blocks missing chat configuration until local fallback is explicitly allowed', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: '未配置对话模型', assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), '本地草稿');
    expect(screen.getByRole('button', { name: '准备流程' })).toBeDisabled();
    await user.click(screen.getByText('高级选项'));
    await user.click(screen.getByLabelText('允许本地内容降级'));
    expect(screen.getByRole('button', { name: '准备流程' })).toBeEnabled();
  });

  it('preserves the draft when preparation fails', async () => {
    const initial = mockedInvoke.getMockImplementation()!;
    mockedInvoke.mockImplementation((cmd: string, args) => cmd === 'pipeline_start'
      ? Promise.reject(new Error('项目已有故事内容')) : initial(cmd, args));
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), '保留这份目标');
    await user.click(screen.getByLabelText('执行场景编排'));
    await user.click(screen.getByRole('button', { name: '准备流程' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('项目已有故事内容');
    expect(screen.getByLabelText('production brief')).toHaveValue('保留这份目标');
    expect(screen.getByLabelText('执行场景编排')).not.toBeChecked();
  });

  it('starts a run and updates step statuses from streamed events', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), '赛博朋克校园恋爱');
    await user.click(screen.getByRole('button', { name: '准备流程' }));

    // pipeline_start was invoked with the brief; an event subscription opened.
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalled());
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_start', {
      projectPath: '/tmp/proj',
      prompt: '赛博朋克校园恋爱',
      allowLocalFallback: false,
      selectedStepIds: CONTENT_STEP_IDS,
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
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
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
    await user.click(screen.getByRole('button', { name: '查看media-production' }));
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
    expect(screen.getByRole('button', { name: '准备流程' })).toBeDisabled();
  });

  it('requires an explicit user choice before allowing local fallback', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), '校园悬疑');
    await user.click(screen.getByText('高级选项'));
    await user.click(screen.getByLabelText('允许本地内容降级'));
    await user.click(screen.getByRole('button', { name: '准备流程' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_start', {
      projectPath: '/tmp/proj',
      prompt: '校园悬疑',
      allowLocalFallback: true,
      selectedStepIds: CONTENT_STEP_IDS,
    });
  });

  it('prepares a paused flow before the user starts execution', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '准备流程' }));
    await user.click(await screen.findByRole('button', { name: '开始生产' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_resume', {
      runId: 'run_1',
      projectPath: '/tmp/proj',
    });
  });

  it('switches to pause/resume controls while running and paused', async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '准备流程' }));
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalled());

    emit({ type: 'runStarted', runId: 'run_1' });
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '准备流程' })).not.toBeInTheDocument();

    emit({ type: 'stepStarted', runId: 'run_1', stepId: 'plan', kind: 'plan' });
    emit({ type: 'runPaused', runId: 'run_1' });
    expect(screen.getByRole('button', { name: '继续运行' })).toBeInTheDocument();
  });

  it('hydrates completed state when fast steps finished before event subscription', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('completed') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '准备流程' }));

    await vi.waitFor(() => expect(screen.getByTestId('flow-run-status')).toHaveTextContent('已完成'));
    expect(stepStatus('plan')).toBe('succeeded');
    expect(stepStatus('outline')).toBe('succeeded');
  });

  it('discovers a persisted paused run and resumes it through crash recovery', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
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
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([runState('paused')] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: '开始生产' }));

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
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([failed] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(failed as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: '查看故事规划' }));
    await user.click(screen.getByRole('button', { name: '从此步重跑' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_retry_step', {
      runId: 'run_1',
      stepId: 'plan',
      projectPath: '/tmp/proj',
    });
  });

  it('supports dependency deletion while a prepared run is locally paused', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '准备流程' }));
    await user.click(await screen.findByRole('button', { name: '查看章节大纲' }));
    await user.click(screen.getByText('调整前置步骤'));
    await user.click(screen.getByLabelText('等待故事规划'));
    await user.click(screen.getByRole('button', { name: '保存前置步骤' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_update_dependencies', {
      runId: 'run_1',
      stepId: 'outline',
      dependsOn: [],
      projectPath: '/tmp/proj',
    });
  });

  it('adds a dependency through the pending step form', async () => {
    const prepared = runState('paused');
    prepared.steps[1].def.dependsOn = [];
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(prepared as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '准备流程' }));
    await user.click(await screen.findByRole('button', { name: '查看章节大纲' }));
    await user.click(screen.getByText('调整前置步骤'));
    await user.click(screen.getByLabelText('等待故事规划'));
    await user.click(screen.getByRole('button', { name: '保存前置步骤' }));

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_update_dependencies', {
      runId: 'run_1',
      stepId: 'outline',
      dependsOn: ['plan'],
      projectPath: '/tmp/proj',
    });
  });

  it('exposes stop and single-step execution as deterministic controls', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_start') return Promise.resolve('run_1' as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('paused') as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await vi.waitFor(() => expect(screen.getByLabelText('production brief')).toBeEnabled());
    await user.type(screen.getByLabelText('production brief'), 'x');
    await user.click(screen.getByRole('button', { name: '准备流程' }));
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
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([failed] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(failed as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByRole('button', { name: '查看故事规划' }));
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
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.reject(new Error('disk unavailable'));
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('disk unavailable');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
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
      if (cmd === 'pipeline_get_capabilities') return Promise.resolve({ chatError: null, assetError: '未配置素材接口' } as unknown);
      if (cmd === 'pipeline_list_runs') return Promise.resolve([runState('completed')] as unknown);
      if (cmd === 'pipeline_get_state') return Promise.resolve(runState('completed') as unknown);
      return Promise.resolve(undefined);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(await screen.findByText('运行信息与记录管理'));
    await user.click(screen.getByRole('button', { name: '固定运行记录' }));
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
    expect(await screen.findByText('current brief')).toBeInTheDocument();
    await vi.waitFor(() => expect(listenHandlers.length).toBe(1));

    resolveOldRuns([old]);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('current brief')).toBeInTheDocument();
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
    expect(await screen.findByText('old brief')).toBeInTheDocument();
    view.rerender(<FlowBoard projectPath="/tmp/current" />);
    expect(await screen.findByText('current brief')).toBeInTheDocument();
    mockedInvoke.mockClear();

    await user.click(screen.getByRole('button', { name: '暂停' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_pause', {
      runId: 'run_current', projectPath: '/tmp/current',
    });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_get_state', {
      runId: 'run_current', projectPath: '/tmp/current',
    });

    await user.click(await screen.findByRole('button', { name: '查看故事规划' }));
    await user.click(screen.getByRole('button', { name: '跳过' }));
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_skip_step', {
      runId: 'run_current', stepId: 'plan', projectPath: '/tmp/current',
    });

    currentStatus = 'paused';
    emit({ type: 'runPaused', runId: 'run_current' });
    await user.click(screen.getByRole('button', { name: '关闭步骤检查器' }));
    await user.click(screen.getByRole('button', { name: '查看章节大纲' }));
    await user.click(screen.getByText('调整前置步骤'));
    await user.click(screen.getByLabelText('等待故事规划'));
    await user.click(screen.getByRole('button', { name: '保存前置步骤' }));
    await user.click(screen.getByRole('button', { name: '关闭步骤检查器' }));
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
