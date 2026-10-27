import { expect, test, type Page } from '@playwright/test';
import type { AiConfig } from '../src/app/lib/ai-ipc';
import { openFlowBoard } from './fixtures/editor';

interface SettingsTestState {
  configs: Record<string, AiConfig>;
  failChatWrite: boolean;
}

type SettingsWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __settingsTest: SettingsTestState;
};

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
});

async function openConfiguredEditor(page: Page) {
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.evaluate(() => {
    const runtime = (window as unknown as SettingsWindow).__TAURI_INTERNALS__;
    const originalInvoke = runtime.invoke.bind(runtime);
    const state: SettingsTestState = {
      configs: Object.fromEntries(
        ['ai', 'ai_image', 'ai_tts', 'ai_video'].map((kind) => [
          kind,
          { provider: 'test', model: 'model-a', api_key: 'old-test-key', base_url: '' },
        ]),
      ),
      failChatWrite: false,
    };
    (window as unknown as SettingsWindow).__settingsTest = state;
    runtime.invoke = async (command, args) => {
      if (command === 'list_ai_providers') {
        const option = {
          value: 'test',
          label: 'Test provider',
          defaultModel: 'model-a',
          models: ['model-a', 'model-b'],
          defaultBaseUrl: '',
          baseUrlPlaceholder: 'https://test.invalid/v1',
          needsBaseUrl: true,
          requiresApiKey: true,
        };
        const other = {
          ...option,
          value: 'other',
          label: 'Other provider',
          models: ['other-a', 'other-b'],
          defaultModel: 'other-a',
        };
        return { chat: [option, other], image: [option], tts: [option], video: [option] };
      }
      const read = command.match(/^get_(ai(?:_image|_tts|_video)?)_config$/);
      if (read) return { ...state.configs[read[1]] };
      const write = command.match(/^set_(ai(?:_image|_tts|_video)?)_config$/);
      if (write) {
        if (write[1] === 'ai' && state.failChatWrite)
          throw new Error('Test configuration write failed');
        state.configs[write[1]] = { ...(args?.config as AiConfig) };
        return;
      }
      return originalInvoke(command, args);
    };
  });
  const navigation = page.getByRole('navigation', { name: '核心视图' });
  await navigation.getByRole('button', { name: '资源库', exact: true }).click();
  await expect(page).toHaveURL(/\/editor\/alpha\/assets$/);
  await navigation.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page).toHaveURL(/\/editor\/alpha$/);
  await expect(page.getByLabel('当前场景')).toBeVisible();
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换对话模型' })).toContainText('model-a');
}

function settingsPanel(page: Page, title: string) {
  return page.locator('div.bg-card').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
}

async function readConfigs(page: Page) {
  return page.evaluate(() => (window as unknown as SettingsWindow).__settingsTest.configs);
}

test('model switching preserves credentials saved through its settings entry', async ({ page }) => {
  await openConfiguredEditor(page);
  await page.getByRole('button', { name: '切换对话模型' }).click();
  await page.getByRole('menuitem', { name: '配置更多服务商与模型…' }).click();
  const settings = settingsPanel(page, 'AI 设置');
  await settings.getByPlaceholder('sk-...').fill('new-test-key');
  await settings.getByPlaceholder('https://test.invalid/v1').fill('https://new.test.invalid/v1');
  await settings.getByRole('button', { name: '保存 AI 配置' }).click();
  await page.getByRole('button', { name: '切换对话模型' }).click();
  await page.getByRole('menuitem', { name: 'model-b', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换对话模型' })).toContainText('model-b');
  expect((await readConfigs(page)).ai).toEqual({
    provider: 'test',
    model: 'model-b',
    api_key: 'new-test-key',
    base_url: 'https://new.test.invalid/v1',
  });
});

test('model switching refreshes the provider after editor settings save', async ({ page }) => {
  await openConfiguredEditor(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = settingsPanel(page, '编辑器设置');
  await settings.getByRole('button', { name: 'AI 模型服务', exact: true }).click();
  await settings.getByLabel('选择 AI 供应商').selectOption('other');
  await settings.getByPlaceholder('sk-...').fill('other-test-key');
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '切换对话模型' }).click();
  await page.getByRole('menuitem', { name: 'other-b', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换对话模型' })).toContainText('other-b');
  expect((await readConfigs(page)).ai).toMatchObject({
    provider: 'other',
    model: 'other-b',
    api_key: 'other-test-key',
  });
});

test('failed model writes retain the persisted selection and show an error', async ({
  page,
}, testInfo) => {
  await openConfiguredEditor(page);
  await page.evaluate(() => {
    (window as unknown as SettingsWindow).__settingsTest.failChatWrite = true;
  });
  await page.getByRole('button', { name: '切换对话模型' }).click();
  await page.getByRole('menuitem', { name: 'model-b', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换对话模型' })).toContainText('model-a');
  await expect(page.getByRole('alert')).toContainText('切换模型失败');
  expect((await readConfigs(page)).ai.model).toBe('model-a');
  await page.screenshot({ path: testInfo.outputPath('model-switch-error.png') });
});

test('parent settings save preserves all configurations saved in the nested AI dialog', async ({
  page,
}) => {
  await openConfiguredEditor(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const parent = settingsPanel(page, '编辑器设置');
  await parent.getByRole('button', { name: '常规工程', exact: true }).click();
  await parent.getByRole('button', { name: '打开 AI 设置' }).click();
  const nested = settingsPanel(page, 'AI 设置');
  for (const name of ['聊天', '图片', '音频', '视频']) {
    await nested.getByRole('button', { name, exact: true }).click();
    await nested.getByPlaceholder('sk-...').fill(`new-${name}-test-key`);
  }
  await nested.getByRole('button', { name: '保存 AI 配置' }).click();
  const saved = await readConfigs(page);
  await parent.getByRole('button', { name: '保存', exact: true }).click();
  expect(await readConfigs(page)).toEqual(saved);
});

test('home applies saved appearance immediately', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = settingsPanel(page, '应用设置');
  await settings.getByRole('button', { name: '深色模式', exact: true }).click();
  await settings.getByRole('button', { name: '绯樱酒红主题' }).click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.ph-root')).toHaveAttribute('data-seed', 'crimson');
  await expect(page.locator('.ph-root')).toHaveClass(/dark/);
  await page.screenshot({ path: testInfo.outputPath('home-saved-appearance.png') });
});

test('editor restores saved appearance on reload', async ({ page }) => {
  await openConfiguredEditor(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = settingsPanel(page, '编辑器设置');
  await settings.getByRole('button', { name: '深色模式', exact: true }).click();
  await settings.getByRole('button', { name: '绯樱酒红主题' }).click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('当前场景')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).toHaveAttribute('data-seed', 'crimson');
});
