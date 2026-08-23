import { invoke } from '@tauri-apps/api/core';

export type ChangeSetResource =
  | { kind: 'project' }
  | { kind: 'scene'; file: string }
  | { kind: 'characters' }
  | { kind: 'project_memory' }
  | { kind: 'asset_metadata' }
  | { kind: 'narrative_context' };

export type ChangeSetOperation =
  | { kind: 'scene'; file: string; baseline: string; content: string }
  | { kind: 'characters'; baseline: unknown; document: unknown }
  | { kind: 'project_memory'; baseline: unknown; memory: unknown }
  | { kind: 'asset_metadata'; baseline: unknown; metadata: unknown }
  | { kind: 'narrative_context'; baseline: unknown; document: unknown }
  | { kind: 'create_scene'; file: string; content: string };

export interface ApplyChangeSetRequest {
  projectPath: string;
  operations: ChangeSetOperation[];
}

export type ApplyChangeSetResult =
  | { status: 'committed'; resources: ChangeSetResource[] }
  | { status: 'conflict'; resources: ChangeSetResource[] }
  | { status: 'failed-and-rolled-back'; failedResource: ChangeSetResource; message: string }
  | {
    status: 'rollback-failed';
    failedResource: ChangeSetResource;
    residualResources: ChangeSetResource[];
    message: string;
  };

export type ChangeSetAdapter = (request: ApplyChangeSetRequest) => Promise<ApplyChangeSetResult>;

type RawApplyChangeSetResult =
  | Extract<ApplyChangeSetResult, { status: 'committed' | 'conflict' }>
  | {
    status: 'failed-and-rolled-back';
    failed_resource: ChangeSetResource;
    message: string;
  }
  | {
    status: 'rollback-failed';
    failed_resource: ChangeSetResource;
    residual_resources: ChangeSetResource[];
    message: string;
  };

export const applyChangeSet: ChangeSetAdapter = async (request) => {
  const result = await invoke<RawApplyChangeSetResult>('apply_change_set', { request });
  if (result.status === 'failed-and-rolled-back') {
    return {
      status: result.status,
      failedResource: result.failed_resource,
      message: result.message,
    };
  }
  if (result.status === 'rollback-failed') {
    return {
      status: result.status,
      failedResource: result.failed_resource,
      residualResources: result.residual_resources,
      message: result.message,
    };
  }
  return result;
};
