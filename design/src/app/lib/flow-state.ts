/**
 * Pure event->state reducer for the FlowBoard. This is the testable behavior
 * core: how pipeline events map to step/run statuses. The React Flow canvas
 * is presentation on top of this state.
 */

import type { PipelineEvent, PipelineEventRecord, RunState, RunStatus, StepRunHistory, StepStatus } from './pipeline-types';

export function recordsFromSnapshot(snapshot: RunState): PipelineEventRecord[] {
  const events: PipelineEventRecord[] = [{
    event: { type: 'runStarted', runId: snapshot.runId },
    receivedAt: snapshot.startedAt,
  }];

  for (const step of snapshot.steps) {
    if (step.startedAt != null) {
      events.push({
        event: { type: 'stepStarted', runId: snapshot.runId, stepId: step.def.id, kind: step.def.kind },
        receivedAt: step.startedAt,
      });
    }
    if (step.status === 'succeeded') {
      events.push({
        event: { type: 'stepSucceeded', runId: snapshot.runId, stepId: step.def.id, output: step.output ?? null },
        receivedAt: step.finishedAt ?? snapshot.updatedAt,
      });
    } else if (step.status === 'failed') {
      events.push({
        event: { type: 'stepFailed', runId: snapshot.runId, stepId: step.def.id, error: step.error ?? '未知错误' },
        receivedAt: step.finishedAt ?? snapshot.updatedAt,
      });
    } else if (step.status === 'skipped') {
      events.push({
        event: { type: 'stepSkipped', runId: snapshot.runId, stepId: step.def.id },
        receivedAt: step.finishedAt ?? snapshot.updatedAt,
      });
    }
  }

  const terminalEvent: PipelineEvent | null = snapshot.status === 'completed'
    ? { type: 'runCompleted', runId: snapshot.runId }
    : snapshot.status === 'failed'
      ? { type: 'runFailed', runId: snapshot.runId, error: snapshot.steps.find((step) => step.error)?.error ?? '流程失败' }
      : snapshot.status === 'timeout'
        ? { type: 'runTimedOut', runId: snapshot.runId, error: snapshot.steps.find((step) => step.error)?.error ?? '流程执行超时' }
        : snapshot.status === 'persistenceFailed'
          ? { type: 'runPersistenceFailed', runId: snapshot.runId, error: '流程状态保存失败。请重新打开项目，从上次已保存的进度恢复。' }
          : snapshot.status === 'cancelled'
            ? { type: 'runStopped', runId: snapshot.runId }
            : snapshot.status === 'paused'
              ? { type: 'runPaused', runId: snapshot.runId }
              : null;
  if (terminalEvent) events.push({ event: terminalEvent, receivedAt: snapshot.updatedAt });
  return events;
}

export interface FlowStepView {
  id: string;
  kind: string;
  agent: string | null;
  status: StepStatus;
  dependsOn: string[];
  attempt: number;
  prompt: string;
  output: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  history: StepRunHistory[];
}

export interface FlowState {
  runId: string | null;
  runStatus: RunStatus;
  startedAt: number | null;
  updatedAt: number | null;
  pinned: boolean;
  steps: FlowStepView[];
}

/** The P2 prompt-to-bound-assets production recipe. */
export const DEFAULT_RECIPE_STEPS: ReadonlyArray<{ id: string; kind: string; dependsOn: string[] }> = [
  { id: 'plan', kind: 'plan', dependsOn: [] },
  { id: 'memory', kind: 'memory', dependsOn: ['plan'] },
  { id: 'outline', kind: 'outline', dependsOn: ['memory'] },
  { id: 'character', kind: 'character', dependsOn: ['outline'] },
  { id: 'dialogist', kind: 'scene', dependsOn: ['character'] },
  { id: 'assetPlan', kind: 'asset', dependsOn: ['dialogist'] },
  { id: 'scene', kind: 'scene', dependsOn: ['assetPlan'] },
  { id: 'assetQueue', kind: 'asset', dependsOn: ['scene'] },
];

export function initialFlowState(): FlowState {
  return {
    runId: null,
    runStatus: 'idle',
    startedAt: null,
    updatedAt: null,
    pinned: false,
    steps: DEFAULT_RECIPE_STEPS.map((s) => ({
      id: s.id,
      kind: s.kind,
      agent: null,
      status: 'pending' as StepStatus,
      dependsOn: s.dependsOn,
      attempt: 0,
      prompt: '',
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      history: [],
    })),
  };
}

export type FlowAction = PipelineEvent
  | { type: 'stateHydrated'; state: RunState }
  | { type: 'reset' };

export function reduceFlowEvent(state: FlowState, event: FlowAction): FlowState {
  if (event.type === 'stateHydrated') {
    return {
      runId: event.state.runId,
      runStatus: event.state.status,
      startedAt: event.state.startedAt,
      updatedAt: event.state.updatedAt,
      pinned: event.state.pinned ?? false,
      steps: event.state.steps.map((step) => ({
        id: step.def.id,
        kind: step.def.kind,
        agent: step.def.agent,
        status: step.status,
        dependsOn: step.def.dependsOn,
        attempt: step.attempt,
        prompt: step.def.prompt,
        output: step.output ?? null,
        error: step.error ?? null,
        startedAt: step.startedAt ?? null,
        finishedAt: step.finishedAt ?? null,
        history: step.history ?? [],
      })),
    };
  }
  if (event.type === 'reset') return initialFlowState();
  // Once bound to a run, ignore events from a different run.
  if (state.runId !== null && event.runId !== state.runId) {
    return state;
  }
  switch (event.type) {
    case 'runStarted':
      return { ...state, runId: event.runId, runStatus: 'running' };
    case 'stepStarted':
      return {
        ...state,
        runStatus: 'running',
        steps: setStep(state.steps, event.stepId, 'running', {
          attempt: (state.steps.find((step) => step.id === event.stepId)?.attempt ?? 0) + 1,
          error: null,
        }),
      };
    case 'stepSucceeded':
      return {
        ...state,
        steps: setStep(state.steps, event.stepId, 'succeeded', { output: event.output }),
      };
    case 'stepFailed':
      return {
        ...state,
        steps: setStep(state.steps, event.stepId, 'failed', { error: event.error }),
      };
    case 'stepSkipped':
      return { ...state, steps: setStep(state.steps, event.stepId, 'skipped') };
    case 'runPaused':
      return { ...state, runStatus: 'paused' };
    case 'runResumed':
      return { ...state, runStatus: 'running' };
    case 'runCompleted':
      return { ...state, runStatus: 'completed' };
    case 'runFailed':
      return { ...state, runStatus: 'failed' };
    case 'runTimedOut':
      return { ...state, runStatus: 'timeout' };
    case 'runPersistenceFailed':
      return { ...state, runStatus: 'persistenceFailed' };
    case 'runStopped':
      return { ...state, runStatus: 'cancelled' };
    default:
      return state;
  }
}

function setStep(
  steps: FlowStepView[],
  id: string,
  status: StepStatus,
  patch: Partial<FlowStepView> = {},
): FlowStepView[] {
  return steps.map((s) => (s.id === id ? { ...s, status, ...patch } : s));
}
