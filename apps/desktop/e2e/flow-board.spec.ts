import { expect, test } from '@playwright/test';
import { openFlowBoard } from './fixtures/editor';

test('production checklist opens results, logs, dependency forms and editors', async ({ page }, testInfo) => {
  await openFlowBoard(page, { width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('production-desktop.png') });
  await expect(page.getByRole('region', { name: '故事概览' }).getByText('共同创作让两位主角重新理解彼此。')).toBeVisible();
  await expect(page.locator('.react-flow')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '生产事件账本' })).toHaveCount(0);
  await page.getByRole('button', { name: '运行日志' }).click();
  await expect(page.getByRole('region', { name: '生产事件账本' })).toBeVisible();
  await page.getByRole('button', { name: '运行日志' }).click();

  await page.getByRole('button', { name: '查看故事规划' }).click();
  await expect(page.getByRole('tab', { name: '输出' })).toHaveAttribute('data-state', 'active');
  await page.getByRole('button', { name: '关闭步骤检查器' }).click();
  await page.getByRole('button', { name: '查看对白创作' }).click();
  await page.getByText('调整前置步骤').click();
  await page.getByLabel('等待世界观设定').check();
  await page.getByRole('button', { name: '保存前置步骤' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __flowCalls: { command: string; args: Record<string, unknown> }[] }).__flowCalls.filter((call) => call.command === 'pipeline_update_dependencies'))).toEqual([
    { command: 'pipeline_update_dependencies', args: { runId: 'run_qa', projectPath: '/tmp/flow-qa', stepId: 'dialogist', dependsOn: ['character', 'memory'] } },
  ]);
  await page.getByRole('button', { name: '关闭步骤检查器' }).click();
  await page.getByRole('button', { name: '查看角色设计' }).click();
  await page.getByRole('button', { name: '打开角色' }).click();
  await expect(page).toHaveURL(/\/editor\/alpha\/assets\?tab=character$/);
});

test('narrow inspector traps focus, closes with Escape and restores focus', async ({ page }) => {
  await openFlowBoard(page, { width: 430, height: 900 });
  await page.getByRole('button', { name: '收起 Agent 面板' }).click();
  const trigger = page.getByRole('button', { name: '查看章节大纲' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '步骤检查器' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(430);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(430);
  await expect(page.getByRole('button', { name: '关闭步骤检查器' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const focusedInside = await dialog.evaluate((element) => element.contains(document.activeElement));
  expect(focusedInside).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('setup starts only after missing media is explicitly downgraded', async ({ page }) => {
  await openFlowBoard(page, { width: 1024, height: 900 }, 'draft');
  await page.getByLabel('production brief').fill('制作故事与角色设定');
  const start = page.getByRole('button', { name: '启动 Stage 1：立项与角色定锚' });
  await expect(start).toBeDisabled();
  await page.getByRole('switch', { name: '允许本地内容降级' }).check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByTestId('flow-run-status')).toHaveText('生产中');
  const calls = await page.evaluate(() => (window as unknown as { __flowCalls: { command: string; args: Record<string, unknown> }[] }).__flowCalls);
  expect(calls.find((call) => call.command === 'pipeline_run_setup')?.args).toEqual({ projectPath: '/tmp/flow-qa', prompt: '制作故事与角色设定', allowLocalFallback: true });
});

test('setup controls fit phone width and stay reachable with Agent closed', async ({ page }, testInfo) => {
  await openFlowBoard(page, { width: 390, height: 844 }, 'draft');
  await page.getByRole('button', { name: '收起 Agent 面板' }).click();
  await page.getByLabel('production brief').fill('窄屏故事');
  await page.getByRole('switch', { name: '允许本地内容降级' }).scrollIntoViewIfNeeded();
  await page.getByRole('switch', { name: '允许本地内容降级' }).check();
  const start = page.getByRole('button', { name: '启动 Stage 1：立项与角色定锚' });
  await expect(start).toBeEnabled();
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('production-phone.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
