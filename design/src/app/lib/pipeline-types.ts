/**
 * V2 Pipeline types. Mirror the Rust structs in src-tauri/src/pipeline and
 * src-tauri/src/story_plan. Field names are camelCase to match the Rust
 * `#[serde(rename_all = "camelCase")]` output (pinned by the
 * `ipc_contract_serializes_to_camel_case` Rust test).
 */

export type StepKind =
  | 'plan'
  | 'memory'
  | 'outline'
  | 'character'
  | 'scene'
  | 'asset'
  | 'lint'
  | 'review'
  | 'export'
  | 'userInput';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaitingInput'
  | 'skipped';

export type RunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'persistenceFailed';

export interface StepDef {
  id: string;
  kind: StepKind;
  dependsOn: string[];
  agent: string | null;
  prompt: string;
}

export type StepExecutor =
  | { type: 'agent' }
  | { type: 'namedAgent'; key: string }
  | { type: 'assetQueue' };

/** Normalize the legacy `agent` wire field at the IPC boundary. */
export function stepExecutor(step: Pick<StepDef, 'id' | 'agent'>): StepExecutor {
  if (step.agent === 'assetQueue' || (step.id === 'assetQueue' && step.agent == null)) {
    return { type: 'assetQueue' };
  }
  return step.agent == null
    ? { type: 'agent' }
    : { type: 'namedAgent', key: step.agent };
}

export function isAssetQueueStep(step: Pick<StepDef, 'id' | 'agent'>): boolean {
  return stepExecutor(step).type === 'assetQueue';
}

export interface StepState {
  def: StepDef;
  status: StepStatus;
  attempt: number;
  output?: string | null;
  error?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  history?: StepRunHistory[];
}

export interface StepRunHistory {
  attempt: number;
  inputSnapshot: string;
  output?: string | null;
  error?: string | null;
  startedAt: number;
  finishedAt?: number | null;
  durationMs?: number | null;
  diff?: string | null;
  cost?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  warnings: string[];
  downgrade?: string | null;
  rollbackSnapshot?: string | null;
}

export interface RunState {
  runId: string;
  projectPath: string;
  prompt: string;
  status: RunStatus;
  steps: StepState[];
  startedAt: number;
  updatedAt: number;
  pinned: boolean;
  allowLocalFallback: boolean;
}

export interface ChapterPlan {
  id: string;
  title: string;
  summary: string;
}

export interface StoryMemory {
  worldbook: string;
  glossary: Record<string, string>;
}

export interface StoryCharacter {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  personality: string;
  stance: string;
  keywords: string[];
  dialogueStyle: string;
  gender: string;
  age: string;
}

export interface ScenePlan {
  id: string;
  file: string;
  chapterId: string;
  title: string;
  summary: string;
  characterIds: string[];
}

export interface BranchEdge {
  from: string;
  to: string;
  choice?: string | null;
}

export interface BranchGraph {
  entryScene: string;
  edges: BranchEdge[];
}

export interface DialogueBeat {
  speaker?: string | null;
  text: string;
  figureCues?: FigureCue[];
}

export interface FigureCue {
  action: 'show' | 'hide';
  characterId: string;
  position?: 'left' | 'center' | 'right' | null;
  emotion?: string;
}

export interface SceneDraft {
  sceneId: string;
  title: string;
  stageManaged?: boolean;
  beats: DialogueBeat[];
}

export interface AssetTaskPlan {
  id: string;
  kind: string;
  targetStem: string;
  prompt: string;
  sceneRef?: string | null;
  characterRef?: string | null;
  emotion?: string | null;
  status: string;
}

export type AssetTaskStatus = 'pending' | 'running' | 'retrying' | 'succeeded' | 'failed';

export interface AssetTaskAttempt {
  attempt: number;
  artifact?: string | null;
  error?: string | null;
  usedLocalFallback?: boolean;
}

export interface AssetQueueTask {
  id: string;
  kind: string;
  targetStem: string;
  prompt: string;
  sceneRef?: string | null;
  characterRef?: string | null;
  status: AssetTaskStatus;
  attempts: AssetTaskAttempt[];
  assetFile?: string | null;
  error?: string | null;
  usedLocalFallback?: boolean;
}

export interface AssetQueueState {
  runId: string;
  tasks: AssetQueueTask[];
  updatedAt: number;
}

export interface PipelineRunSummary {
  runId: string;
  status: string;
  startedAt: number;
  updatedAt: number;
}

export interface StoryPlan {
  version: number;
  prompt: string;
  synopsis: string;
  memory: StoryMemory;
  chapters: ChapterPlan[];
  characters: StoryCharacter[];
  scenePlans: ScenePlan[];
  branches: BranchGraph;
  sceneDrafts: SceneDraft[];
  assetPlan: AssetTaskPlan[];
  scenes: string[];
  pipelineRuns: PipelineRunSummary[];
}

/** A pipeline event streamed on the `pipeline:{runId}` channel (ADR 0055). */
export type PipelineEvent =
  | { type: 'runStarted'; runId: string }
  | { type: 'stepStarted'; runId: string; stepId: string; kind: string }
  | { type: 'stepSucceeded'; runId: string; stepId: string; output: string | null }
  | { type: 'stepFailed'; runId: string; stepId: string; error: string }
  | { type: 'stepSkipped'; runId: string; stepId: string }
  | { type: 'runPaused'; runId: string }
  | { type: 'runResumed'; runId: string }
  | { type: 'runCompleted'; runId: string }
  | { type: 'runFailed'; runId: string; error: string }
  | { type: 'runTimedOut'; runId: string; error: string }
  | { type: 'runPersistenceFailed'; runId: string; error: string }
  | { type: 'runStopped'; runId: string };

export interface PipelineEventRecord {
  event: PipelineEvent;
  receivedAt: number;
}
