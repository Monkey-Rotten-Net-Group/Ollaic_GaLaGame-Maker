import { expect, test, type Page } from '@playwright/test';
import { openFlowBoard } from './fixtures/editor';

async function openCompactScene(page: Page) {
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.evaluate(() => {
    const runtime = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const originalInvoke = runtime.invoke.bind(runtime);
    runtime.invoke = async (command, args = {}) => {
      if (command === 'load_scene' && String(args.path).endsWith('/chapter2.txt')) {
        return [
          { id: 'opening', type: 'dialogue', character: '林夏', content: '故事开始。', flags: [] },
          { id: 'background', type: 'changeBg', asset: '', content: '', flags: [] },
          { id: 'next', type: 'dialogue', character: '林夏', content: '来到工作室。', flags: [] },
          { id: 'continuation', type: 'dialogue', content: '继续创作。', flags: [] },
        ];
      }
      return originalInvoke(command, args);
    };
  });
  await page.getByLabel('编辑器视图模式').selectOption('compact');
  await page.getByLabel('当前场景').selectOption('chapter2.txt');
  await expect(page.locator('[data-cmd-card]')).toHaveCount(3);
}

test('switching scenes clears collapsed sections and keeps a single section visible', async ({ page }) => {
  await openCompactScene(page);
  await page.locator('.section-block').first().locator('.group').first().click();
  await expect(page.locator('[data-node-id="opening"]')).toHaveCount(0);
  await page.getByLabel('当前场景').selectOption('start.txt');
  await expect(page.locator('[data-cmd-card]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /从这里开始我们的故事/ })).toBeVisible();
  await page.getByLabel('当前场景').selectOption('chapter2.txt');
  await expect(page.locator('[data-cmd-card]')).toHaveCount(3);
});

test('manual collapse and collapse-all preserve the selected command', async ({ page }) => {
  await openCompactScene(page);
  await page.getByRole('button', { name: /故事开始/ }).click();
  await page.locator('.section-block').first().locator('.group').first().click();
  await expect(page.locator('[data-node-id="opening"]')).toHaveCount(0);
  // The detail panel overlays the right end of this toolbar; use its keyboard controls.
  await page.getByRole('button', { name: '全部展开' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '全部折叠' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-cmd-card]')).toHaveCount(0);
  await page.getByRole('button', { name: '全部展开' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-cmd-card]')).toHaveCount(3);
});

test('compact commands support Tab, Enter, Space and independent keyboard actions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openCompactScene(page);
  const first = page.getByRole('button', { name: /故事开始/ });
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');

  const next = page.getByRole('button', { name: /来到工作室/ });
  await next.focus();
  await page.keyboard.press('Tab');
  const continuation = page.getByRole('button', { name: /继续创作/ });
  await expect(continuation).toBeFocused();
  await page.keyboard.press('Space');
  await expect(continuation).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');

  const menu = page.locator('[data-node-id="opening"]').getByRole('button', { name: '更多操作' });
  await menu.focus();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await expect(continuation).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});
