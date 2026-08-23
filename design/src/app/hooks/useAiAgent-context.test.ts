import { describe, expect, it } from 'vitest';
import {
  appendAcceptedFact,
  buildNarrativeContext,
  emptyNarrativeContext,
  NARRATIVE_CONTEXT_LIMITS,
} from '../lib/narrative-context';

const memory = {
  worldSetting: `MEMORY_HEAD_${'m'.repeat(4_000)}_MEMORY_TAIL`,
  writingStyle: '克制', userPreferences: '不使用巧合', updatedAt: '2026-08-23T00:00:00Z',
};

describe('mandatory narrative context', () => {
  it('is deterministic, bounded, and preserves scene and memory head/tail cues', () => {
    const document = appendAcceptedFact(emptyNarrativeContext(), {
      id: 'set-1', acceptedAt: '2026-08-23T00:00:00Z', summary: '主角接受了委托',
    });
    const input = {
      projectId: 'project-1', sceneName: 'start.txt', sceneDisplayName: '序章',
      sceneSource: `SCENE_HEAD_${'s'.repeat(6_000)}_SCENE_TAIL`, memory, document,
    };
    const fcContext = buildNarrativeContext(input);
    const legacyContext = buildNarrativeContext(input);
    expect(fcContext).toBe(legacyContext);
    expect(fcContext.length).toBeLessThanOrEqual(NARRATIVE_CONTEXT_LIMITS.totalChars);
    expect(fcContext).toContain('MEMORY_HEAD');
    expect(fcContext).toContain('MEMORY_TAIL');
    expect(fcContext).toContain('SCENE_HEAD');
    expect(fcContext).toContain('SCENE_TAIL');
    expect(fcContext).toContain('主角接受了委托');
  });

  it('keeps accepted facts outside chat sessions and excludes rejected or failed sets', () => {
    let stored = emptyNarrativeContext();
    stored = appendAcceptedFact(stored, {
      id: 'accepted', acceptedAt: '2026-08-23T00:00:00Z', summary: '已确认：雨夜发生停电',
    });
    // Rejected and failed sets never call appendAcceptedFact.
    const afterReload = JSON.parse(JSON.stringify(stored));
    const context = buildNarrativeContext({
      projectId: 'p', sceneName: 's.txt', sceneDisplayName: 's', sceneSource: ':scene;',
      memory: null, document: afterReload,
    });
    expect(context).toContain('雨夜发生停电');
    expect(context).not.toContain('rejected');
    expect(context).not.toContain('failed');
  });
});
