import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import type { SceneApprovalStatus, StoryPlan } from '../lib/pipeline-types';
import { useFlowRunController } from './useFlowRunController';

function plan(status: SceneApprovalStatus): StoryPlan {
  return {
    version: 1,
    prompt: 'test',
    synopsis: '',
    memory: { worldbook: '', glossary: {} },
    chapters: [],
    characters: [],
    scenes: [],
    sceneDrafts: [],
    assetPlan: [],
    pipelineRuns: [],
    scenePlans: [
      {
        id: 'opening',
        file: 'start.txt',
        chapterId: 'c1',
        title: 'Opening',
        summary: '',
        characterIds: [],
        approvalStatus: status,
      },
    ],
    branches: { entryScene: 'opening', edges: [] },
    variables: [],
  };
}

describe('scene review races', () => {
  it.each(['approveScene', 'unlockScene'] as const)(
    'keeps %s results when an older plan refresh finishes last',
    async (action) => {
      let resolveRefresh: (value: StoryPlan) => void = () => {};
      const stale = new Promise<StoryPlan>((resolve) => {
        resolveRefresh = resolve;
      });
      let delayRefresh = false;
      const updated = plan(action === 'approveScene' ? 'approved' : 'drafted');
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'pipeline_list_runs') return [];
        if (command === 'pipeline_get_plan') return delayRefresh ? stale : plan('pending');
        if (command === 'pipeline_approve_scene' || command === 'pipeline_unlock_scene')
          return updated;
        return null;
      });
      const { result } = renderHook(() => useFlowRunController('/tmp/scene-review'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      delayRefresh = true;
      act(() => {
        void result.current.refreshPlan();
      });
      await act(async () => {
        await result.current[action]('opening');
      });
      await act(async () => {
        resolveRefresh(plan('pending'));
      });
      expect(result.current.plan).toEqual(updated);
    },
  );
});
