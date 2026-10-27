import { expect, test } from '@playwright/test';
import { openFlowBoard } from './fixtures/editor';

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
});

for (const width of [390, 1100, 1440]) {
  test(`global navigation replaces the sidebar at ${width}px`, async ({ page }, testInfo) => {
    await openFlowBoard(page, { width, height: 900 }, 'draft');
    const navigation = page.getByRole('navigation', { name: '核心视图' });
    await expect(navigation.getByRole('button')).toHaveCount(2);
    await expect(page.locator('.ollaic-sidenav, .ollaic-avatar')).toHaveCount(0);
    const workspace = await page.locator('.ollaic-workspace').boundingBox();
    if (!workspace) throw new Error('Workspace is missing');
    expect(workspace.x).toBeLessThanOrEqual(18);
    expect(workspace.width).toBeGreaterThanOrEqual(width - 36);
    await expect(navigation).toHaveCSS('height', '42px');
    await expect(navigation.getByRole('button', { name: '编辑', exact: true })).toHaveCSS(
      'background-color',
      'rgb(158, 42, 71)',
    );
    await navigation.getByRole('button', { name: '资源库', exact: true }).click();
    await expect(page).toHaveURL(/\/editor\/alpha\/assets$/);
    await expect(navigation.getByRole('button', { name: '资源库', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await navigation.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page).toHaveURL(/\/editor\/alpha$/);
    await expect(page.getByLabel('当前场景')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`global-navigation-${width}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Ollaic GalGame Studio，返回首页', exact: true }).click();
    await expect(page).toHaveURL(/\/#\/$/);
  });
}

test('global navigation preserves the unsaved-edit confirmation', async ({ page }) => {
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.getByRole('switch', { name: '自动保存' }).uncheck();
  await page.getByLabel('编辑器视图模式').selectOption('script');
  await page.getByLabel('WebGAL 脚本编辑器').fill('林夏:保留未保存的内容。;');
  await page
    .getByRole('navigation', { name: '核心视图' })
    .getByRole('button', { name: '资源库', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('有未保存的更改');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('WebGAL 脚本编辑器')).toHaveValue('林夏:保留未保存的内容。;');
  await page.getByRole('button', { name: 'Ollaic GalGame Studio，返回首页', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('有未保存的更改');
  await page.getByRole('button', { name: '直接离开', exact: true }).click();
  await expect(page).toHaveURL(/\/#\/$/);
});

test('editor toolbar labels stay on one line at desktop widths', async ({ page }, testInfo) => {
  await openFlowBoard(page, { width: 1280, height: 900 }, 'draft');
  for (const width of [390, 768, 1024, 1100, 1280, 1440, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const wrappedLabels = await page.locator('.ollaic-topbar').evaluate((header) =>
      [...header.querySelectorAll('button span, .font-display-family, label span')]
        .filter((element) => {
          if (!element.getBoundingClientRect().width) return false;
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length > 1;
        })
        .map((element) => element.textContent),
    );
    expect(wrappedLabels, `Wrapped labels at ${width}px`).toEqual([]);
    const islands = await page.locator('.ollaic-topbar-island').evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .filter((bounds) => bounds.width > 0)
        .map((bounds) => ({ left: bounds.left, right: bounds.right })),
    );
    for (let index = 1; index < islands.length; index++) {
      expect(islands[index].left, `Toolbar overlap at ${width}px`).toBeGreaterThanOrEqual(
        islands[index - 1].right,
      );
    }
    expect(islands.length).toBeGreaterThan(0);
    expect(islands[islands.length - 1].right).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '绯樱酒红主题' }).click();
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('editor-crimson-1440.png') });
});

test('assistant replies keep readable contrast across accent themes', async ({ page }) => {
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  const reply = page.locator('[data-message-role="assistant"]').first();
  await expect(reply).toBeVisible();
  for (const appearance of ['light', 'dark']) {
    await page.evaluate((appearance) => {
      document.documentElement.classList.toggle('dark', appearance === 'dark');
    }, appearance);
    for (const seed of ['violet', 'crimson', 'teal', 'amber']) {
      await page.evaluate((seed) => {
        document.documentElement.dataset.seed = seed;
      }, seed);
      const contrast = await reply.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const components = color.match(/[\d.]+/g);
          if (!components || components.length < 3) throw new Error(`Unsupported color: ${color}`);
          const channels = components
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        );
      });
      expect(contrast, `Reply contrast for ${appearance}/${seed}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('narrow windows retain editor actions in the overflow menu', async ({ page }) => {
  await openFlowBoard(page, { width: 390, height: 844 }, 'draft');
  await page.getByRole('button', { name: '更多编辑操作' }).click();
  for (const name of [
    '撤销',
    '重做',
    '保存',
    '打包发布',
    '打开项目',
    '导入场景',
    '导出场景',
    '快照管理',
  ]) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更多编辑操作' }).click();
  await page.getByRole('menuitem', { name: '快照管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '历史版本' })).toBeVisible();
});

test('settings stay inside narrow and short windows', async ({ page }, testInfo) => {
  await openFlowBoard(page, { width: 390, height: 600 }, 'draft');
  await page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const originalInvoke = runtime.invoke.bind(runtime);
    runtime.invoke = async (command, args) => {
      const option = {
        value: 'test',
        label: 'Test provider',
        defaultModel: 'test-model',
        models: ['test-model'],
        defaultBaseUrl: '',
        baseUrlPlaceholder: '',
        needsBaseUrl: false,
        requiresApiKey: false,
      };
      if (command === 'list_ai_providers') {
        return { chat: [option], image: [option], tts: [option], video: [option] };
      }
      if (/^get_ai.*config$/.test(command)) {
        return { provider: 'test', model: 'test-model', api_key: '', base_url: '' };
      }
      return originalInvoke(command, args);
    };
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const appSettings = page.getByRole('heading', { name: '编辑器设置' }).locator('..').locator('..');
  const expectFits = async (panel: typeof appSettings) => {
    const bounds = await panel.boundingBox();
    if (!bounds) throw new Error('Settings panel is not visible');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
    expect(
      await panel.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  };
  await expectFits(appSettings);
  await expect(appSettings.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('app-settings-narrow.png') });
  await page.getByRole('button', { name: '打开 AI 设置' }).click();
  const aiSettings = page.getByRole('heading', { name: 'AI 设置' }).locator('..').locator('..');
  await expect(aiSettings.getByRole('button', { name: '测试连接' })).toBeVisible();
  await expectFits(aiSettings);
  await expect(aiSettings.getByRole('button', { name: '保存 AI 配置' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('ai-settings-narrow.png') });
});
