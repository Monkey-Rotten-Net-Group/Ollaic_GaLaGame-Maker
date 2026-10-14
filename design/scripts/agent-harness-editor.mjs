import readline from 'node:readline';
import { JSDOM } from 'jsdom';

const input = readline.createInterface({ input: process.stdin });
const pending = new Map();
let sequence = 0;
let start;
const scenarioReady = new Promise((resolve) => { start = resolve; });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.kind === 'scenario') start(message);
  else {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error !== undefined) request.reject(message.error);
    else request.resolve(message.value);
  }
});

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function invoke(command, args = {}) {
  const id = sequence++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'invoke', id, command, args });
  });
}

async function run({ scenario, projectPath }) {
  const dom = new JSDOM('', { url: 'http://editor-harness.local' });
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement', 'MutationObserver', 'CustomEvent']) {
    globalThis[key] = dom.window[key];
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // stdout carries RPC only; the app's verbose trace remains in the report.
  console.info = console.log = () => {};
  const calls = [];
  const chatCalls = [];
  const traces = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    async invoke(command, args = {}) {
      calls.push(command);
      if (command === 'ai_chat_turn_owned') chatCalls.push(args);
      if (command === 'append_ai_agent_trace') traces.push(args.payload);
      return invoke(command, args);
    },
  };

  const [{ act, renderHook, waitFor }, React, { MemoryRouter }, { useAiAgent }] = await Promise.all([
    import('@testing-library/react'), import('react'), import('react-router'), import('../src/app/hooks/useAiAgent.ts'),
  ]);
  const scriptSource = scenario.script;
  const nodes = await invoke('parse_scene', { source: scriptSource });
  let bufferWrites = 0;
  const noop = () => {};
  const write = () => { bufferWrites++; };
  const params = {
    projectId: 'editor-harness', projectPath, currentSceneName: scenario.scene,
    sceneHeaders: {}, nodes, selectedNode: null, scriptSource, dirty: false, characters: [],
    setNodes: write, setScriptSource: write, setDirty: write, setSaveStatus: noop,
    setSelectedNode: noop, setShowScript: noop, pushHistory: write,
  };
  const wrapper = ({ children }) => React.createElement(MemoryRouter, null, children);
  let hook;
  await act(async () => { hook = renderHook(() => useAiAgent(params), { wrapper }); });
  let first;
  act(() => { first = hook.result.current.sendPrompt(scenario.prompt); });
  if (scenario.stopAfterCall) {
    await waitFor(() => {
      if (chatCalls.length < scenario.stopAfterCall) throw new Error('waiting for the controlled turn');
    }, { timeout: 5000 });
    await act(async () => { hook.result.current.stop(); });
    if (scenario.nextPrompt) {
      await act(async () => { await hook.result.current.sendPrompt(scenario.nextPrompt); });
    }
  }
  await act(async () => { await first; });

  const agent = hook.result.current;
  const runIds = new Map();
  const report = {
    status: agent.status,
    error: agent.error?.message ?? null,
    missingAssets: agent.missingIssues,
    pendingEdits: (agent.pendingChangeSet?.edits ?? []).map((edit) => ({
      kind: edit.kind, file: edit.file, beforeContent: edit.beforeContent, afterContent: edit.afterContent,
    })),
    userMessages: agent.messages.filter((message) => message.role === 'user').map((message) => message.content),
    lastMessage: agent.messages.at(-1)?.content ?? '',
    bufferWrites,
    commitCalls: calls.filter((command) => command === 'save_scene' || command === 'apply_ai_change_set').length,
    chatRuns: chatCalls.map((call) => {
      if (!runIds.has(call.runId)) runIds.set(call.runId, runIds.size);
      return runIds.get(call.runId);
    }),
    traces: traces.map((trace) => ({
      mode: trace.mode, outcome: trace.outcome, turns: trace.turns.length,
      validationErrors: trace.turns.map((turn) => turn.validationError).filter(Boolean),
      failedTools: trace.turns.flatMap((turn) => turn.toolCalls.filter((call) => !call.ok).map((call) => call.name)),
    })),
  };
  hook.unmount();
  dom.window.close();
  return report;
}

try {
  send({ kind: 'report', report: await run(await scenarioReady) });
  input.close();
  process.exit(0);
} catch (error) {
  send({ kind: 'error', message: String(error?.stack ?? error) });
  process.exit(1);
}
