import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { applyChangeSet, type ApplyChangeSetRequest } from './change-set-ipc';

const invokeMock = vi.mocked(invoke);

describe('applyChangeSet', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('serializes the typed request at the T01 Tauri command boundary', async () => {
    const request: ApplyChangeSetRequest = {
      projectPath: '/projects/story',
      operations: [
        {
          kind: 'scene',
          file: 'start.txt',
          baseline: 'A:old;',
          content: 'A:new;',
        },
        {
          kind: 'characters',
          baseline: { version: 1, characters: [] },
          document: { version: 1, characters: [{ id: 'hero', name: 'Hero' }] },
        },
        {
          kind: 'project_memory',
          baseline: { worldSetting: '' },
          memory: { worldSetting: 'Harbor' },
        },
        {
          kind: 'asset_metadata',
          baseline: { aliases: {} },
          metadata: { aliases: { 'background/port.png': 'Port' } },
        },
        {
          kind: 'create_scene',
          file: 'chapter-2.txt',
          content: '; chapter 2',
        },
      ],
    };
    invokeMock.mockResolvedValue({
      status: 'committed',
      resources: [{ kind: 'scene', file: 'start.txt' }],
    });

    await expect(applyChangeSet(request)).resolves.toEqual({
      status: 'committed',
      resources: [{ kind: 'scene', file: 'start.txt' }],
    });
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith('apply_change_set', { request });
  });

  it('normalizes T01 snake_case rollback fields for frontend consumers', async () => {
    invokeMock.mockResolvedValue({
      status: 'rollback-failed',
      failed_resource: { kind: 'characters' },
      residual_resources: [{ kind: 'scene', file: 'start.txt' }],
      message: 'restore failed',
    });

    await expect(applyChangeSet({ projectPath: '/project', operations: [] })).resolves.toEqual({
      status: 'rollback-failed',
      failedResource: { kind: 'characters' },
      residualResources: [{ kind: 'scene', file: 'start.txt' }],
      message: 'restore failed',
    });
  });
});
