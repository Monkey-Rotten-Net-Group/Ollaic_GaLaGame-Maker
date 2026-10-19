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

  const [{ act, renderHook, waitFor }, React, { MemoryRouter }, { useAiAgent }, { getProjectEditorCommitCoordinator }] = await Promise.all([
    import('@testing-library/react'), import('react'), import('react-router'), import('../src/app/hooks/useAiAgent.ts'),
    import('../src/app/components/story-editor/editor-commit-coordinator.ts'),
  ]);
  const scriptSource = scenario.script;
  localStorage.setItem('project-path-editor-harness', projectPath);
  const nodes = await invoke('parse_scene', { source: scriptSource });
  let bufferWrites = 0;
  let bufferNodes = nodes;
  let bufferSource = scriptSource;
  let projectScenes;
  let refreshingScenes = Promise.resolve();
  const noop = () => {};
  const write = () => { bufferWrites++; };
  const params = {
    projectId: 'editor-harness', projectPath, currentSceneName: scenario.scene,
    sceneHeaders: {}, nodes, selectedNode: null, scriptSource, dirty: false, characters: [],
    setNodes: (value) => { write(); bufferNodes = value; },
    setScriptSource: (value) => { write(); bufferSource = value; },
    setDirty: write, setSaveStatus: noop,
    setSelectedNode: noop, setShowScript: noop, pushHistory: write,
    onScenesChanged: () => {
      refreshingScenes = invoke('list_scenes').then((scenes) => { projectScenes = scenes; });
    },
  };
  const wrapper = ({ children }) => React.createElement(MemoryRouter, null, children);
  let hook;
  const mount = async (initialProps) => {
    await act(async () => {
      hook = renderHook((props) => {
        const coordinator = getProjectEditorCommitCoordinator(props.projectId);
        return {
          ...useAiAgent({
            ...props,
            onCommitStart: (files) => coordinator.beginCommit(files),
            onCommitSettled: (applied) => coordinator.settleCommit(applied),
          }),
          coordinator,
        };
      }, { wrapper, initialProps });
    });
  };
  const returnToProject = async () => {
    await mount(scenario.loadingOnReturn ? { ...params, projectPath: null } : params);
    if (scenario.stalePathOnReturn) {
      await act(async () => { hook.rerender({ ...params, projectPath: `${projectPath}-previous-project` }); });
    }
    if (scenario.loadingOnReturn || scenario.stalePathOnReturn) {
      await act(async () => { hook.rerender(params); });
    }
  };
  await mount(params);
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
  const navigation = [];
  if (scenario.unmountAfterCall) {
    await waitFor(() => {
      if (chatCalls.length < scenario.unmountAfterCall) throw new Error('waiting to leave the editor');
    }, { timeout: 5000 });
    if (scenario.switchProject) {
      await act(async () => { hook.rerender({ ...params, projectId: 'another-project' }); });
      await act(async () => {
        hook.result.current.attachUpload('kept-attachment');
        hook.result.current.attachUpload('removed-attachment');
      });
      await act(async () => { hook.result.current.detachUpload('removed-attachment'); });
    } else {
      await act(async () => { hook.unmount(); });
    }
    if (scenario.returnBeforeResponse) {
      await returnToProject();
      navigation.push({ phase: 'returnedWhileRunning', busy: hook.result.current.busy });
    }
  }
  await act(async () => { await first; });
  if (scenario.unmountAfterCall && !scenario.returnBeforeResponse) {
    if (scenario.switchProject) {
      navigation.push({
        phase: 'anotherProject', busy: hook.result.current.busy,
        userMessages: hook.result.current.messages.filter((message) => message.role === 'user').length,
        pending: hook.result.current.pendingChangeSet !== null,
        attachedIds: hook.result.current.attachedIds,
      });
      await act(async () => { hook.unmount(); });
    }
    await returnToProject();
  }

  let commitNavigation;
  if (scenario.commitNavigation) {
    let accepting;
    act(() => { accepting = hook.result.current.acceptChange(); });
    await waitFor(() => {
      if (!calls.includes('apply_ai_change_set')) throw new Error('waiting for approval');
    });
    await act(async () => { hook.unmount(); });
    await mount({ ...params, documentReady: !scenario.loadingOnReturn });
    const saveBlocked = !hook.result.current.coordinator.canSave(scenario.scene);
    let path;
    await act(async () => {
      path = await invoke('get_scene_path', { sceneName: scenario.scene });
      projectScenes = await invoke('list_scenes');
    });
    const scenesBeforeCommit = projectScenes;
    let loadStarted = false;
    const restoring = scenario.loadingOnReturn ? (async () => {
      await hook.result.current.coordinator.waitForCommit(scenario.scene);
      loadStarted = true;
      const loaded = await window.__TAURI_INTERNALS__.invoke('load_scene', { path });
      const source = await invoke('serialize_scene', { nodes: loaded });
      params.setNodes(loaded);
      params.setScriptSource(source);
      hook.rerender({ ...params, nodes: loaded, scriptSource: source, documentReady: true });
    })() : Promise.resolve();
    await Promise.resolve();
    const loadBlocked = !loadStarted;
    await act(async () => {
      await invoke('release_editor_commit');
      await accepting;
      await restoring;
      await refreshingScenes;
    });
    const bufferContent = bufferSource;
    const finishSave = hook.result.current.coordinator.startSave(scenario.scene);
    if (!finishSave) throw new Error('commit did not release the save lock');
    try {
      await window.__TAURI_INTERNALS__.invoke('save_scene', { path, nodes: bufferNodes });
    } finally {
      finishSave();
    }
    commitNavigation = {
      saveBlocked, bufferContent, diskContent: await invoke('read_file_text', { path }),
      scenesBeforeCommit, projectScenes,
      ...(scenario.loadingOnReturn ? { loadBlocked } : {}),
    };
  }

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
    ...(navigation.length ? { navigation } : {}),
    ...(scenario.switchProject ? { attachedIds: agent.attachedIds } : {}),
    ...(commitNavigation ? { commitNavigation } : {}),
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
