import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
});

test('project home renders creation entry points', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: /^新建项目/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /打开已有项目/ })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索项目' })).toBeVisible();
});

test('an empty project library stays empty and remembers its theme after reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('暂无项目', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^打开项目 / })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('webgal-projects'))).toBeNull();
  await page.getByRole('button', { name: '切换到深色模式' }).click();
  await page.reload();
  await expect(page.locator('.ph-root')).toHaveClass(/dark/);
  await expect(page.getByText('暂无项目', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换到浅色模式' }).click();
  await page.reload();
  await expect(page.locator('.ph-root')).not.toHaveClass(/dark/);
});

test('new projects require a storage folder and retain it after cancelling the picker', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('webgal-projects', '[]');
    let selections = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'get_project_storage') return { managed: false };
          if (command === 'plugin:dialog|open') {
            selections++;
            return selections === 1 ? '/tmp/project-creation-qa' : null;
          }
          throw new Error(`Unexpected test command: ${command}`);
        },
      },
    });
  });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建项目' });
  await dialog.getByLabel('项目名称', { exact: true }).fill('新项目');
  await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '选择存储文件夹' }).click();
  await expect(dialog.getByLabel('存储文件夹', { exact: true })).toHaveValue(
    '/tmp/project-creation-qa',
  );
  await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '选择存储文件夹' }).click();
  await expect(dialog.getByLabel('存储文件夹', { exact: true })).toHaveValue(
    '/tmp/project-creation-qa',
  );
  await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('project-folder-selection.png'),
    animations: 'disabled',
  });
});

test('project metadata stays readable without decorative guidance', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'webgal-projects',
      JSON.stringify([
        {
          id: 'one',
          name: '测试项目',
          description: '项目简介',
          path: '/tmp/very-long-project-directory/测试项目',
          sceneCount: 1,
          lastModified: '2026/10/27 14:40',
          isFavorite: false,
        },
        {
          id: 'two',
          name: '第二个项目',
          description: '',
          path: '/tmp/second-project',
          sceneCount: 6,
          lastModified: '2026/10/27 13:00',
          isFavorite: false,
        },
        {
          id: 'three',
          name: '第三个项目',
          description: '',
          path: '/tmp/third-project',
          sceneCount: 2,
          lastModified: '2026/10/26 12:00',
          isFavorite: false,
        },
      ]),
    );
  });
  await page.goto('/');
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['列表视图', '网格视图']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await expect(page.getByRole('button', { name: mode, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const count = page.locator('.ph-card__scene-pill').first();
      const icon = count.locator('svg');
      expect((await icon.boundingBox())?.width).toBeLessThanOrEqual(12);
      expect((await icon.boundingBox())?.height).toBeLessThanOrEqual(12);
      expect((await count.boundingBox())?.height).toBeLessThanOrEqual(24);
      const wrapped = await count.evaluate((element) => {
        const lines = new Set<number>();
        for (const node of element.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) lines.add(rect.top);
        }
        return lines.size;
      });
      expect(wrapped).toBe(1);
    }
  }
  await expect(
    page.getByText(
      /CURRENT PROJECT|CURRENT STORY|SCENE PREVIEW|当前焦点作品|手风琴画廊|书脊列表|开启下一部/,
    ),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续创作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '网格视图', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '列表视图', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '更换封面', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更换封面 测试项目', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: '项目详情' })
      .getByText('/tmp/very-long-project-directory/测试项目'),
  ).toHaveCount(0);
  await page.locator('.ph-card').first().hover();
  await expect(page.getByRole('heading', { name: '测试项目', exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('home-cleanup-light.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '切换到深色模式' }).click();
  await expect(page.locator('.ph-card__scene-pill').first().locator('svg')).toHaveCSS(
    'width',
    '10px',
  );
  await page.screenshot({
    path: testInfo.outputPath('home-cleanup-dark.png'),
    animations: 'disabled',
  });
});
