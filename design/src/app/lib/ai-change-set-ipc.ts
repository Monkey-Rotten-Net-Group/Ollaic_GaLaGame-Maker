import { invoke } from '@tauri-apps/api/core';
import type { ChangeEdit, PendingChangeSet } from './change-set';

export interface CurrentSceneState {
  file: string;
  content: string;
}

export type ChangeSetRecovery =
  | { status: 'not_needed' }
  | { status: 'restored' }
  | { status: 'failed'; message: string; snapshotId: string };

export type ApplyChangeSetResult =
  | { outcome: 'applied' }
  | { outcome: 'conflict'; resources: string[] }
  | {
    outcome: 'failed';
    resource: string;
    message: string;
    recovery: ChangeSetRecovery;
  };

type PersistedEdit =
  | { kind: 'scene'; file: string; beforeContent: string; afterContent: string }
  | {
    kind: 'create_scene';
    file: string;
    chapter?: string;
    outline?: string;
    initialContent?: string;
  }
  | { kind: 'character'; before: Extract<ChangeEdit, { kind: 'character' }>['before']; after: Extract<ChangeEdit, { kind: 'character' }>['after'] }
  | { kind: 'create_character'; draft: Extract<ChangeEdit, { kind: 'create_character' }>['draft'] }
  | { kind: 'memory'; before: Extract<ChangeEdit, { kind: 'memory' }>['before']; after: Extract<ChangeEdit, { kind: 'memory' }>['after'] }
  | { kind: 'asset_plan'; cards: Extract<ChangeEdit, { kind: 'asset_plan' }>['cards'] };

function persistedEdit(edit: ChangeEdit): PersistedEdit {
  switch (edit.kind) {
    case 'scene':
      return {
        kind: edit.kind,
        file: edit.file,
        beforeContent: edit.beforeContent,
        afterContent: edit.afterContent,
      };
    case 'create_scene':
      return {
        kind: edit.kind,
        file: edit.file,
        chapter: edit.chapter,
        outline: edit.outline,
        initialContent: edit.initialContent,
      };
    case 'character':
      return { kind: edit.kind, before: edit.before, after: edit.after };
    case 'create_character':
      return { kind: edit.kind, draft: edit.draft };
    case 'memory':
      return { kind: edit.kind, before: edit.before, after: edit.after };
    case 'asset_plan':
      return { kind: edit.kind, cards: edit.cards };
  }
}

export async function applyAiChangeSet(
  projectPath: string,
  changeSet: PendingChangeSet,
  currentScene: CurrentSceneState,
  force: boolean,
): Promise<ApplyChangeSetResult> {
  return invoke<ApplyChangeSetResult>('apply_ai_change_set', {
    request: {
      projectPath,
      force,
      currentScene,
      edits: changeSet.edits.map(persistedEdit),
    },
  });
}
