export const TRACE_RETENTION = Object.freeze({
  maxRecords: 200,
  diagnosticRetentionHours: 24,
  maxDiagnosticExcerptChars: 256,
});

export interface AgentTraceSource {
  traceId: string;
  createdAt: string;
  mode: 'function_calling' | 'legacy';
  prompt: string;
  turns: Array<{
    turn: number;
    modelText: string;
    toolCalls: Array<{
      name: string;
      arguments: unknown;
      ok: boolean;
      result?: unknown;
      error?: string;
    }>;
  }>;
  outcome?: string;
  finalText?: string;
  edits?: string[];
  error?: string;
  assetCount?: number;
}

export interface AgentTraceRecord {
  version: 1;
  classification: 'operational';
  traceId: string;
  createdAt: string;
  mode: 'function_calling' | 'legacy';
  outcome: string;
  input: { promptHash: string; promptChars: number; promptBytes: number };
  output: { responseHash: string; responseChars: number; responseBytes: number; editCount: number; assetCount: number };
  durationMs: number;
  tools: Array<{ turn: number; name: string; ok: boolean; argumentBytes: number; resultBytes: number }>;
  retention: typeof TRACE_RETENTION;
  diagnostic?: { enabled: true; excerpt: string; expiresAt: string };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value ?? null)).length;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
  }
  // Deterministic non-cryptographic fallback for restricted WebViews. It is
  // only an opaque correlation value; no security decision relies on it.
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `sha256:fallback-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export async function minimizeAgentTrace(
  source: AgentTraceSource,
  options: { includeDiagnosticExcerpt?: boolean; now?: Date } = {},
): Promise<AgentTraceRecord> {
  const response = source.finalText ?? source.turns.map(turn => turn.modelText).join('\n');
  const record: AgentTraceRecord = {
    version: 1,
    classification: 'operational',
    traceId: source.traceId,
    createdAt: source.createdAt,
    mode: source.mode,
    outcome: source.outcome ?? 'unknown',
    input: {
      promptHash: await sha256(source.prompt),
      promptChars: source.prompt.length,
      promptBytes: byteLength(source.prompt),
    },
    output: {
      responseHash: await sha256(response),
      responseChars: response.length,
      responseBytes: byteLength(response),
      editCount: source.edits?.length ?? 0,
      assetCount: source.assetCount ?? 0,
    },
    durationMs: Math.max(0, (options.now ?? new Date()).getTime() - new Date(source.createdAt).getTime()) || 0,
    tools: source.turns.flatMap(turn => turn.toolCalls.map(tool => ({
      turn: turn.turn,
      name: tool.name,
      ok: tool.ok,
      argumentBytes: byteLength(tool.arguments),
      resultBytes: byteLength(tool.result ?? tool.error ?? null),
    }))),
    retention: TRACE_RETENTION,
  };
  if (options.includeDiagnosticExcerpt) {
    const now = options.now ?? new Date();
    record.diagnostic = {
      enabled: true,
      excerpt: (source.error ?? response).slice(0, TRACE_RETENTION.maxDiagnosticExcerptChars),
      expiresAt: new Date(now.getTime() + TRACE_RETENTION.diagnosticRetentionHours * 60 * 60 * 1000).toISOString(),
    };
  }
  return record;
}
