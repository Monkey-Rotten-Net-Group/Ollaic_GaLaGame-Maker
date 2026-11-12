import { expect, test } from '@playwright/test';
import { installEditorFixture } from './fixtures/editor';

test('paused workflow card can collapse and open its board while editing stays locked', async ({ page }) => {
  await installEditorFixture(page, { width: 1440, height: 900 });
  await page.goto('/#/editor/alpha');
  const card = page.locator('[aria-label="工作流状态与规划卡"]');
  await expect(card).toContainText('工作流已暂停');
  await expect(card.getByRole('button', { name: '生成: 重逢', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '折叠规划卡' }).click({ timeout: 3000 });
  await expect(card.getByRole('button', { name: '展开规划卡' })).toBeVisible();
  await card.getByRole('button', { name: '展开规划卡' }).click();
  await expect(page.getByLabel('AI 创作输入')).toBeDisabled();
  await card.getByRole('button', { name: '看板', exact: true }).click();
  await expect(page).toHaveURL(/view=workflow/);
});

test('a failed resume reports its error without hiding the workflow controls', async ({ page }) => {
  await installEditorFixture(page, { width: 1440, height: 900 });
  await page.goto('/#/editor/alpha');
  const card = page.locator('[aria-label="工作流状态与规划卡"]');
  await expect(card).toContainText('工作流已暂停');
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = runtime.__TAURI_INTERNALS__.invoke;
    runtime.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'pipeline_resume') return Promise.reject(new Error('Unable to resume the workflow'));
      return invoke(command, args);
    };
  });
  await card.getByRole('button', { name: '继续工作流', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Unable to resume the workflow');
  await expect(card.getByRole('button', { name: '继续工作流', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
});

test('workflow card can resume, pause, and stop the current run', async ({ page }) => {
  await installEditorFixture(page, { width: 1440, height: 900 });
  await page.goto('/#/editor/alpha');
  const card = page.locator('[aria-label="工作流状态与规划卡"]');
  await expect(card).toContainText('工作流已暂停');
  await card.getByRole('button', { name: '继续工作流', exact: true }).click();
  await expect(card.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(card).toContainText('工作流已暂停');
  await card.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByLabel('AI 创作输入')).toBeEnabled();
});
