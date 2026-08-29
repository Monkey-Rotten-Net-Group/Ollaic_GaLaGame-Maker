import { describe, expect, it } from 'vitest';
import { initialFlowState, recordsFromSnapshot, reduceFlowEvent } from './flow-state';
import type { PipelineEvent, RunState } from './pipeline-types';

const ev = (e: PipelineEvent) => e;

describe('flow-state reducer', () => {
  it('starts with the default recipe pending and the run idle', () => {
    const s = initialFlowState();
    expect(s.runStatus).toBe('idle');
    expect(s.runId).toBeNull();
    expect(s.steps.map((x) => x.id)).toEqual([
      'plan', 'memory', 'outline', 'character', 'dialogist', 'assetPlan', 'scene', 'assetQueue',
    ]);
    expect(s.steps.every((x) => x.status === 'pending')).toBe(true);
  });

  it('runs the two-step recipe in order and completes', () => {
    let s = initialFlowState();
    s = reduceFlowEvent(s, ev({ type: 'runStarted', runId: 'run_1' }));
    expect(s.runId).toBe('run_1');
    expect(s.runStatus).toBe('running');

    s = reduceFlowEvent(s, ev({ type: 'stepStarted', runId: 'run_1', stepId: 'plan', kind: 'plan' }));
    expect(statusOf(s, 'plan')).toBe('running');

    s = reduceFlowEvent(s, ev({ type: 'stepSucceeded', runId: 'run_1', stepId: 'plan', output: null }));
    expect(statusOf(s, 'plan')).toBe('succeeded');

    s = reduceFlowEvent(s, ev({ type: 'stepStarted', runId: 'run_1', stepId: 'outline', kind: 'outline' }));
    expect(statusOf(s, 'outline')).toBe('running');

    s = reduceFlowEvent(s, ev({ type: 'stepSucceeded', runId: 'run_1', stepId: 'outline', output: null }));
    expect(statusOf(s, 'outline')).toBe('succeeded');

    s = reduceFlowEvent(s, ev({ type: 'runCompleted', runId: 'run_1' }));
    expect(s.runStatus).toBe('completed');
  });

  it('marks a step failed and the run failed', () => {
    let s = initialFlowState();
    s = reduceFlowEvent(s, ev({ type: 'runStarted', runId: 'run_1' }));
    s = reduceFlowEvent(s, ev({ type: 'stepStarted', runId: 'run_1', stepId: 'plan', kind: 'plan' }));
    s = reduceFlowEvent(s, ev({ type: 'stepFailed', runId: 'run_1', stepId: 'plan', error: 'boom' }));
    expect(statusOf(s, 'plan')).toBe('failed');
    s = reduceFlowEvent(s, ev({ type: 'runFailed', runId: 'run_1', error: 'boom' }));
    expect(s.runStatus).toBe('failed');
    // Downstream outline was never started.
    expect(statusOf(s, 'outline')).toBe('pending');
  });

  it('keeps a live timeout distinct from a generic failure', () => {
    let s = initialFlowState();
    s = reduceFlowEvent(s, ev({ type: 'runStarted', runId: 'run_1' }));
    s = reduceFlowEvent(s, ev({ type: 'runTimedOut', runId: 'run_1', error: 'step timed out' }));

    expect(s.runStatus).toBe('timeout');
  });

  it('restores a timeout event from a persisted snapshot', () => {
    const snapshot: RunState = {
      runId: 'run_timeout',
      projectPath: '/tmp/project',
      prompt: 'brief',
      status: 'timeout',
      startedAt: 10,
      updatedAt: 20,
      pinned: false,
      allowLocalFallback: false,
      steps: [],
    };

    const records = recordsFromSnapshot(snapshot);
    expect(records[records.length - 1]?.event).toEqual({
      type: 'runTimedOut',
      runId: 'run_timeout',
      error: '流程执行超时',
    });
  });

  it('pauses and resumes', () => {
    let s = initialFlowState();
    s = reduceFlowEvent(s, ev({ type: 'runStarted', runId: 'run_1' }));
    s = reduceFlowEvent(s, ev({ type: 'runPaused', runId: 'run_1' }));
    expect(s.runStatus).toBe('paused');
    s = reduceFlowEvent(s, ev({ type: 'runResumed', runId: 'run_1' }));
    expect(s.runStatus).toBe('running');
  });

  it('marks a stopped run as cancelled', () => {
    let s = initialFlowState();
    s = reduceFlowEvent(s, ev({ type: 'runStarted', runId: 'run_1' }));
    s = reduceFlowEvent(s, ev({ type: 'runStopped', runId: 'run_1' }));
    expect(s.runStatus).toBe('cancelled');
  });

  it('skips a step', () => {
    let s = initialFlowState();
    s = reduceFlowEvent(s, ev({ type: 'runStarted', runId: 'run_1' }));
    s = reduceFlowEvent(s, ev({ type: 'stepSkipped', runId: 'run_1', stepId: 'plan' }));
    expect(statusOf(s, 'plan')).toBe('skipped');
  });

  it('ignores events from a different run once bound', () => {
    let s = initialFlowState();
    s = reduceFlowEvent(s, ev({ type: 'runStarted', runId: 'run_1' }));
    s = reduceFlowEvent(s, ev({ type: 'stepStarted', runId: 'run_other', stepId: 'plan', kind: 'plan' }));
    expect(statusOf(s, 'plan')).toBe('pending');
  });

  it('hydrates the real DAG and completed statuses from a run snapshot', () => {
    const run: RunState = {
      runId: 'run_finished',
      projectPath: '/tmp/project',
      prompt: 'brief',
      status: 'completed',
      startedAt: 10,
      updatedAt: 20,
      pinned: true,
      allowLocalFallback: false,
      steps: [
        {
          def: { id: 'brief', kind: 'plan', dependsOn: [], agent: null, prompt: '' },
          status: 'succeeded',
          attempt: 1,
          output: '{"synopsis":"done"}',
          error: null,
          startedAt: 11,
          finishedAt: 12,
        },
        {
          def: { id: 'plot', kind: 'outline', dependsOn: ['brief'], agent: null, prompt: '' },
          status: 'succeeded',
          attempt: 1,
          output: null,
          error: null,
          startedAt: 13,
          finishedAt: 14,
        },
      ],
    };

    const s = reduceFlowEvent(initialFlowState(), { type: 'stateHydrated', state: run });
    expect(s.runId).toBe('run_finished');
    expect(s.runStatus).toBe('completed');
    expect(s.pinned).toBe(true);
    expect(s.steps.map((step) => step.id)).toEqual(['brief', 'plot']);
    expect(s.steps[1].dependsOn).toEqual(['brief']);
    expect(s.steps[0].output).toBe('{"synopsis":"done"}');
    expect(s.steps[0].agent).toBeNull();
  });
});

function statusOf(state: ReturnType<typeof initialFlowState>, id: string) {
  return state.steps.find((s) => s.id === id)?.status;
}
