import { describe, expect, it } from 'vitest';
import { minimizeAgentTrace, TRACE_RETENTION } from '../lib/agent-trace';

const SECRET = 'sk-live-nonstandard-secret-987654321';
const SCENE = 'SENTINEL_FULL_SCENE_PROSE_不应写入追踪';
const UPLOAD = 'SENTINEL_UPLOAD_CONTENT_不应写入追踪';

function sourceTrace() {
  return {
    traceId: 'trace-1',
    createdAt: '2026-08-23T00:00:00.000Z',
    projectId: 'project-secret-name',
    currentSceneName: 'start.txt',
    assistantId: 'assistant-1',
    prompt: `${SCENE}\n${UPLOAD}\nBearer ${SECRET}`,
    mode: 'function_calling' as const,
    turns: [{
      turn: 0,
      modelText: `${SCENE} model answer`,
      toolCalls: [{
        id: 'call-1',
        name: 'read_scene',
        arguments: { apiKey: SECRET, scene: SCENE },
        label: '读取场景',
        ok: true,
        result: { upload: UPLOAD, authorization: `Bearer ${SECRET}` },
      }],
    }],
    outcome: 'pending_preview',
    finalText: `${SCENE} final`,
    edits: [`修改 ${SCENE}`],
    assetCount: 4,
  };
}

describe('agent trace minimization', () => {
  it('keeps operational metadata while excluding all default content payloads', async () => {
    const record = await minimizeAgentTrace(sourceTrace());
    const serialized = JSON.stringify(record);

    expect(record.version).toBe(1);
    expect(record.classification).toBe('operational');
    expect(record.input.promptChars).toBeGreaterThan(0);
    expect(record.input.promptHash).toMatch(/^sha256:/);
    expect(record.output.responseHash).toMatch(/^sha256:/);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.tools).toEqual([expect.objectContaining({
      turn: 0,
      name: 'read_scene',
      ok: true,
      argumentBytes: expect.any(Number),
      resultBytes: expect.any(Number),
    })]);
    expect(record.retention).toEqual(TRACE_RETENTION);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SCENE);
    expect(serialized).not.toContain(UPLOAD);
    expect(serialized).not.toContain('project-secret-name');
    expect(serialized.length).toBeLessThan(2_500);
  });

  it('requires explicit opt-in and bounds diagnostic excerpts', async () => {
    const normal = await minimizeAgentTrace(sourceTrace());
    const diagnostic = await minimizeAgentTrace(sourceTrace(), {
      includeDiagnosticExcerpt: true,
      now: new Date('2026-08-23T01:00:00.000Z'),
    });

    expect(normal).not.toHaveProperty('diagnostic');
    expect(diagnostic.diagnostic?.enabled).toBe(true);
    expect(diagnostic.diagnostic?.excerpt.length).toBeLessThanOrEqual(
      TRACE_RETENTION.maxDiagnosticExcerptChars,
    );
    expect(diagnostic.diagnostic?.expiresAt).toBe('2026-08-24T01:00:00.000Z');
  });
});
