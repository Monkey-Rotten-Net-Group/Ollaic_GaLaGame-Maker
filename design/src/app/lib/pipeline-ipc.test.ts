import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedInvoke } = vi.hoisted(() => ({ mockedInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockedInvoke,
}));

import {
  pipelineGetState,
  pipelinePause,
  pipelineResume,
  pipelineSkipStep,
  pipelineStop,
  pipelineUpdateDependencies,
} from './pipeline-ipc';

describe('project-bound live run IPC', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it('sends the caller project path with every live-run command', async () => {
    const projectPath = '/projects/b';
    await (pipelinePause as (...args: string[]) => Promise<void>)('run_a', projectPath);
    await (pipelineResume as (...args: string[]) => Promise<void>)('run_a', projectPath);
    await (pipelineStop as (...args: string[]) => Promise<void>)('run_a', projectPath);
    await (pipelineSkipStep as (...args: string[]) => Promise<void>)('run_a', 'plan', projectPath);
    await (pipelineUpdateDependencies as (...args: unknown[]) => Promise<void>)(
      'run_a',
      'plan',
      ['memory'],
      projectPath,
    );
    await (pipelineGetState as (...args: string[]) => Promise<unknown>)('run_a', projectPath);

    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_pause', { runId: 'run_a', projectPath });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_resume', { runId: 'run_a', projectPath });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_stop', { runId: 'run_a', projectPath });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_skip_step', {
      runId: 'run_a',
      stepId: 'plan',
      projectPath,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_update_dependencies', {
      runId: 'run_a',
      stepId: 'plan',
      dependsOn: ['memory'],
      projectPath,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('pipeline_get_state', { runId: 'run_a', projectPath });
  });
});
