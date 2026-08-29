/**
 * Frontend IPC layer for the V2 Pipeline. Wraps Tauri invoke calls to the
 * Rust backend (`src-tauri/src/pipeline/commands.rs`) and the per-run event
 * channel `pipeline:{runId}` (ADR 0055). Command args use camelCase (Tauri
 * convention); return types mirror `pipeline-types.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AssetQueueState, PipelineEvent, RunState, StoryPlan } from './pipeline-types';

/** Start an Agent Flow for a project. Returns the new run id. */
export async function pipelineStart(projectPath: string, prompt: string, allowLocalFallback: boolean): Promise<string> {
  return invoke<string>('pipeline_start', { projectPath, prompt, allowLocalFallback });
}

/** Pause a live (in-memory) run before the next step. */
export async function pipelinePause(runId: string, projectPath: string): Promise<void> {
  return invoke<void>('pipeline_pause', { runId, projectPath });
}

/** Resume an in-memory paused run. */
export async function pipelineResume(runId: string, projectPath: string): Promise<void> {
  return invoke<void>('pipeline_resume', { runId, projectPath });
}

/** Cancel a live run. Any in-flight agent output is discarded. */
export async function pipelineStop(runId: string, projectPath: string): Promise<void> {
  return invoke<void>('pipeline_stop', { runId, projectPath });
}

/** Execute exactly one ready step, then return the run to paused state. */
export async function pipelineStepOnce(runId: string, projectPath: string): Promise<void> {
  return invoke<void>('pipeline_step_once', { runId, projectPath });
}

/** Crash-recovery: reload a persisted run from disk and drive it. Use this on
 * app start for any non-terminal `.ollaic/pipeline/*.json`, not `pipelineResume`. */
export async function pipelineResumeRun(projectPath: string, runId: string): Promise<void> {
  return invoke<void>('pipeline_resume_run', { projectPath, runId });
}

/** Re-run a step (resets it to pending and, if the run was failed, restarts it). */
export async function pipelineRetryStep(runId: string, stepId: string, projectPath: string): Promise<void> {
  return invoke<void>('pipeline_retry_step', { runId, stepId, projectPath });
}

/** Skip a pending step; downstream steps whose only dep is it become ready. */
export async function pipelineSkipStep(runId: string, stepId: string, projectPath: string): Promise<void> {
  return invoke<void>('pipeline_skip_step', { runId, stepId, projectPath });
}

export async function pipelineUpdateDependencies(
  runId: string,
  stepId: string,
  dependsOn: string[],
  projectPath: string,
): Promise<void> {
  return invoke<void>('pipeline_update_dependencies', { runId, stepId, dependsOn, projectPath });
}

export async function pipelineUpdateStepPrompt(
  runId: string,
  stepId: string,
  prompt: string,
  projectPath: string,
): Promise<void> {
  return invoke<void>('pipeline_update_step_prompt', { runId, stepId, prompt, projectPath });
}

export async function pipelineSetRunPinned(
  runId: string,
  pinned: boolean,
  projectPath: string,
): Promise<void> {
  return invoke<void>('pipeline_set_run_pinned', { runId, pinned, projectPath });
}

export async function pipelineClearRunHistory(runId: string, projectPath: string): Promise<void> {
  return invoke<void>('pipeline_clear_run_history', { runId, projectPath });
}

export async function pipelineExportRunHistory(runId: string, projectPath: string): Promise<string> {
  return invoke<string>('pipeline_export_run_history', { runId, projectPath });
}

/** Snapshot of a run's current state. */
export async function pipelineGetState(runId: string, projectPath: string): Promise<RunState | null> {
  return invoke<RunState | null>('pipeline_get_state', { runId, projectPath });
}

/** The project's StoryPlan (`.ollaic/plan.json`), if one exists. */
export async function pipelineGetPlan(projectPath: string): Promise<StoryPlan | null> {
  return invoke<StoryPlan | null>('pipeline_get_plan', { projectPath });
}

export async function assetQueueGet(projectPath: string): Promise<AssetQueueState | null> {
  return invoke<AssetQueueState | null>('asset_queue_get', { projectPath });
}

export async function assetQueuePreviewArtifact(
  projectPath: string,
  taskId: string,
  attempt: number,
): Promise<string> {
  return invoke<string>('asset_queue_preview_artifact', { projectPath, taskId, attempt });
}

export async function assetQueueDeleteArtifact(
  projectPath: string,
  taskId: string,
  attempt: number,
): Promise<AssetQueueState> {
  return invoke<AssetQueueState>('asset_queue_delete_artifact', { projectPath, taskId, attempt });
}

export async function assetQueuePromoteArtifact(
  projectPath: string,
  taskId: string,
  attempt: number,
): Promise<AssetQueueState> {
  return invoke<AssetQueueState>('asset_queue_promote_artifact', { projectPath, taskId, attempt });
}

/** Persisted runs for a project, newest first. */
export async function pipelineListRuns(projectPath: string): Promise<RunState[]> {
  return invoke<RunState[]>('pipeline_list_runs', { projectPath });
}

/** Subscribe to `pipeline:{runId}` events. Returns an unlisten function. */
export async function listenPipelineEvents(
  runId: string,
  handler: (event: PipelineEvent) => void,
): Promise<UnlistenFn> {
  return listen<PipelineEvent>(`pipeline:${runId}`, (event) => handler(event.payload));
}
