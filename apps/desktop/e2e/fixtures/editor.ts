import { expect, type Page } from '@playwright/test';

export async function openFlowBoard(page: Page, viewport: { width: number; height: number }, mode: 'existing' | 'draft' = 'existing') {
  await page.setViewportSize(viewport);
  await page.addInitScript((mode) => {
    const now = Date.now();
    const run = {
      runId: 'run_qa',
      projectPath: '/tmp/flow-qa',
      prompt: '近未来校园中，两位创作者共同完成一部视觉小说',
      status: 'paused',
      startedAt: now - 32_000,
      updatedAt: now - 2_000,
      pinned: false,
      allowLocalFallback: false,
      steps: [
        {
          def: { id: 'plan', kind: 'plan', dependsOn: [], agent: null, prompt: '提炼故事冲突' },
          status: 'succeeded',
          attempt: 1,
          output: '{"synopsis":"共同创作让两人重新理解彼此"}',
          error: null,
          startedAt: now - 30_000,
          finishedAt: now - 22_000,
          history: [{
            attempt: 1,
            inputSnapshot: '{"prompt":"近未来校园"}',
            output: '{"synopsis":"共同创作让两人重新理解彼此"}',
            error: null,
            startedAt: now - 30_000,
            finishedAt: now - 22_000,
            durationMs: 8_000,
            diff: 'synopsis updated',
            cost: 0.003,
            warnings: [],
            downgrade: null,
          }],
        },
        {
          def: { id: 'memory', kind: 'memory', dependsOn: ['plan'], agent: null, prompt: '' },
          status: 'succeeded', attempt: 1, output: '{"worldbook":"创作者使用记忆编辑终端完成视觉小说"}', error: null,
          startedAt: now - 22_000, finishedAt: now - 19_000, history: [],
        },
        {
          def: { id: 'outline', kind: 'outline', dependsOn: ['memory'], agent: null, prompt: '生成三章结构' },
          status: 'succeeded', attempt: 1, output: '{"chapters":[{"title":"重逢"},{"title":"共写"},{"title":"首映"}]}', error: null,
          startedAt: now - 19_000, finishedAt: now - 15_000, history: [],
        },
        {
          def: { id: 'character', kind: 'character', dependsOn: ['outline'], agent: null, prompt: '' },
          status: 'succeeded', attempt: 1, output: '{"characters":[{"name":"陆川"},{"name":"林夏"}]}', error: null,
          startedAt: now - 15_000, finishedAt: now - 12_000, history: [],
        },
        {
          def: { id: 'dialogist', kind: 'scene', dependsOn: ['character'], agent: 'dialogist', prompt: '' },
          status: 'pending', attempt: 0, output: null, error: null, startedAt: null, finishedAt: null, history: [],
        },
        {
          def: { id: 'assetPlan', kind: 'asset', dependsOn: ['dialogist'], agent: 'assetPlanner', prompt: '' },
          status: 'pending', attempt: 0, output: null, error: null, startedAt: null, finishedAt: null, history: [],
        },
        {
          def: { id: 'scene', kind: 'scene', dependsOn: ['assetPlan'], agent: 'sceneScript', prompt: '' },
          status: 'pending',
          attempt: 0,
          output: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          history: [],
        },
      ],
    };
    const plan = {
      version: 1,
      prompt: run.prompt,
      synopsis: '共同创作让两位主角重新理解彼此。',
      memory: { worldbook: '创作者使用记忆编辑终端完成视觉小说', glossary: {} },
      chapters: [{ id: 'chapter-1', title: '重逢', summary: '制作开始' }],
      characters: [{ id: 'hero', name: '陆川' }, { id: 'heroine', name: '林夏' }],
      scenePlans: [{ id: 'opening', file: 'start.txt', chapterId: 'chapter-1', title: '重逢', summary: '制作开始', characterIds: ['hero', 'heroine'] }],
      branches: { entryScene: 'opening', edges: [] },
      sceneDrafts: [],
      assetPlan: [{ id: 'bg_opening', kind: 'background', targetStem: 'bg_opening', prompt: '工作室', sceneRef: 'opening', status: 'pending' }],
      scenes: ['start.txt'],
      pipelineRuns: [],
    };

    localStorage.setItem('project-path-alpha', '/tmp/flow-qa');
    let productionVersion = 0;
    let hasRun = mode === 'existing';
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    (window as unknown as { __flowCalls: typeof calls }).__flowCalls = calls;
    let callbackId = 1;
    const callbacks = new Map<number, ((data: unknown) => void) | undefined>();
    const runtime = window as typeof window & {
      __TAURI_INTERNALS__: Record<string, unknown>;
      __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
    };
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback: ((data: unknown) => void) | undefined) {
        const id = callbackId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: Record<string, unknown> = {}) {
        calls.push({ command, args });
        if (command === 'open_project') return { path: '/tmp/flow-qa', config: { Game_name: '共同创作' }, scenes: ['start.txt', 'chapter2.txt'] };
        if (command === 'get_scene_path') return `/tmp/flow-qa/game/scene/${args.sceneName}`;
        if (command === 'load_scene') return [{ id: 'line-1', type: 'dialogue', character: '林夏', content: productionVersion ? '生产之后的场景。' : '从这里开始我们的故事。', flags: [] }];
        if (command === 'serialize_scene') return (args.nodes as { character?: string; content: string }[]).map((node) => `${node.character ?? ''}:${node.content};`).join('\n');
        if (command === 'parse_scene') return [{ id: 'line-1', type: 'narrator', content: String(args.source), flags: [] }];
        if (command === 'read_file_text') return '; 章节: 第一章\n林夏:从这里开始我们的故事。;';
        if (command === 'get_runtime_info') return { installed: true, path: '/tmp/runtime', version: 'test' };
        if (command === 'get_runtime_url') return (window as unknown as { __runtimeTestUrl?: string }).__runtimeTestUrl ?? 'http://127.0.0.1:1420/__runtime-test';
        if (command === 'load_asset_metadata') return { version: 1, characters: {}, sceneCards: {}, voices: {} };
        if (command === 'list_ai_providers') return { chat: [], image: [], tts: [], video: [] };
        if (command.startsWith('list_') || command === 'sync_scene_voice_cards') return [];
        if (command === 'read_project_memory') return null;
        if (command === 'pipeline_stop') { run.status = 'cancelled'; productionVersion++; }
        if (command === 'pipeline_get_capabilities') return { chatError: null, assetError: '未配置素材接口' };
        if (command === 'pipeline_list_runs') return hasRun ? [run] : [];
        if (command === 'pipeline_get_plan') return hasRun ? plan : null;
        if (command === 'pipeline_start') {
          hasRun = true;
          run.prompt = String(args.prompt);
          run.steps = run.steps.filter((step) => (args.selectedStepIds as string[]).includes(step.def.id)).map((step) => ({ ...step, status: 'pending', attempt: 0, output: null, error: null, startedAt: null, finishedAt: null, history: [] })) as typeof run.steps;
          return run.runId;
        }
        if (command === 'pipeline_resume') run.status = 'running';
        if (command === 'pipeline_update_dependencies') {
          const step = run.steps.find((step) => step.def.id === args.stepId);
          if (step) step.def.dependsOn = args.dependsOn as string[];
        }
        if (command === 'pipeline_get_state') return run;
        if (command === 'plugin:event|listen') return args.handler;
        if (command === 'plugin:event|unlisten') return undefined;
        return undefined;
      },
      convertFileSrc(path: string) { return path; },
    };
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event: string, id: number) { callbacks.delete(id); },
    };
  }, mode);
  await page.goto('/#/flow/alpha');
  if (mode === 'existing') await expect(page.getByTestId('flow-run-status')).toContainText('已暂停');
  else await expect(page.getByRole('heading', { name: '安排这次生产' })).toBeVisible();
}
