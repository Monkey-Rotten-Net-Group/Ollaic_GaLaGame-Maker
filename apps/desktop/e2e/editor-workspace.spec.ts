import { expect, test } from '@playwright/test';
import { openFlowBoard } from './fixtures/editor';

test('one editing entry keeps both Agent drafts and workflow selection', async ({ page }) => {
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await expect(page).toHaveURL(/\/editor\/alpha\?agent=workflow$/);
  await expect(page.getByRole('navigation', { name: '核心视图' }).getByRole('button', { name: '编辑', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: '核心视图' }).getByText(/生产流|脚本流|场景/)).toHaveCount(0);
  await page.getByLabel('production brief').fill('我们这次只制作故事。');
  await page.getByLabel('执行世界观设定').uncheck();
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await page.getByLabel('AI 创作输入').fill('让开场对白更简洁');
  await page.getByRole('tab', { name: 'Workflow Agent', exact: true }).click();
  await expect(page.getByLabel('production brief')).toHaveValue('我们这次只制作故事。');
  await expect(page.getByLabel('执行世界观设定')).not.toBeChecked();
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await expect(page.getByLabel('AI 创作输入')).toHaveValue('让开场对白更简洁');
  await page.getByRole('button', { name: '场景图', exact: true }).click();
  await expect(page.getByText('场景关系图', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '编辑 Agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '场景图', exact: true }).click();
  await expect(page.getByRole('button', { name: /从这里开始我们的故事/ })).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`scene graph zoom and Escape preserve the editing workspace at ${viewport.width}px`, async ({ page }) => {
    await openFlowBoard(page, viewport, 'draft');
    await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
    await page.getByLabel('AI 创作输入').fill('保留这段编辑输入');
    if (viewport.width < 640) await page.getByRole('button', { name: '收起 Agent 面板' }).click();
    await page.getByRole('button', { name: '场景图', exact: true }).click();
    const graph = page.getByRole('region', { name: '场景图画布' });
    const branch = graph.getByRole('button', { name: /chapter2/ });
    const initialWidth = (await branch.boundingBox())!.width;
    for (let i = 0; i < 7; i++) await page.getByRole('button', { name: '放大视图' }).click();
    await expect(page.getByRole('button', { name: '重置缩放' })).toHaveText('200%');
    await expect.poll(async () => (await branch.boundingBox())!.width).toBeGreaterThan(initialWidth * 1.8);
    await branch.click();
    await expect(page.getByLabel('当前场景')).toHaveValue('chapter2.txt');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.getByRole('button', { name: '重置缩放' }).click();
    await expect(page.getByRole('button', { name: '重置缩放' })).toHaveText('100%');
    await page.keyboard.press('Escape');
    await expect(graph).toHaveCount(0);
    await expect(page.getByRole('button', { name: /从这里开始我们的故事/ })).toBeVisible();
    if (viewport.width < 640) await page.getByRole('button', { name: '打开 Agent 面板' }).click();
    await expect(page.getByLabel('AI 创作输入')).toHaveValue('保留这段编辑输入');
  });
}

test('live draft preview expands without reloading its iframe or losing the Agent', async ({ page }, testInfo) => {
  const messages: { data: { command: number; message: string } }[] = [];
  await page.route('**/__runtime-test*', (route) => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#202739;color:#fff;font:24px sans-serif;display:grid;place-items:center;height:100vh">WebGAL 运行画面</body>' }));
  await page.routeWebSocket('**/api/webgalsync', (socket) => {
    socket.onMessage((data) => messages.push(JSON.parse(String(data))));
    const heartbeat = setInterval(() => socket.send(JSON.stringify({ event: 'message', data: { command: 1 } })), 100);
    socket.onClose(() => clearInterval(heartbeat));
  });
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  const frame = page.getByTitle('WebGAL 实时预览');
  await expect(frame).toBeVisible();
  await expect.poll(() => messages.some((message) => message.data.command === 6)).toBe(true);
  await frame.evaluate((element) => element.setAttribute('data-persisted', 'yes'));
  await page.getByLabel('编辑器视图模式').selectOption('script');
  // Preview works without autosave and without writing the draft to disk.
  await page.getByRole('switch').click();
  await page.getByLabel('WebGAL 脚本编辑器').fill('林夏:预览这一句新的草稿。;');
  await expect.poll(() => messages.at(-1)?.data.message).toBe('林夏:预览这一句新的草稿。;');
  const saveCalls = await page.evaluate(() => (window as unknown as { __flowCalls: { command: string }[] }).__flowCalls.filter((call) => call.command === 'save_scene'));
  expect(saveCalls).toHaveLength(0);
  const splitHeight = (await frame.boundingBox())!.height;
  await page.getByRole('button', { name: '全屏大预览' }).click();
  expect((await frame.boundingBox())!.height).toBeGreaterThan(splitHeight * 1.6);
  await expect(page.getByLabel('AI 创作输入')).toBeVisible();
  await expect(frame).toHaveAttribute('data-persisted', 'yes');
  await page.screenshot({ path: testInfo.outputPath('editor-large-preview.png') });
  await page.getByRole('button', { name: '返回工作区预览' }).click();
  await expect(page.getByLabel('WebGAL 脚本编辑器')).toHaveValue('林夏:预览这一句新的草稿。;');
  await page.getByRole('button', { name: '脱离为悬浮画中画' }).click();
  const previewHeader = page.getByLabel('实时预览区域').locator('header');
  const floatingBounds = await page.getByLabel('实时预览区域').boundingBox();
  await previewHeader.getByText('实时预览', { exact: true }).dblclick();
  await expect(frame).toBeHidden();
  await page.getByRole('button', { name: '全屏大预览' }).click();
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('data-persisted', 'yes');
  await page.getByRole('button', { name: '返回工作区预览' }).click();
  await expect(frame).toBeHidden();
  await previewHeader.getByText('实时预览', { exact: true }).dblclick();
  await expect(frame).toBeVisible();
  expect(await page.getByLabel('实时预览区域').boundingBox()).toEqual(floatingBounds);
  await previewHeader.getByText('实时预览', { exact: true }).dblclick();
  await page.getByRole('button', { name: '吸附到底部底栏' }).click();
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('data-persisted', 'yes');
  await page.getByRole('button', { name: '收起预览' }).click();
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  await expect(frame).toHaveAttribute('data-persisted', 'yes');
});

test('bottom preview sash persists dragging and restores its default height on double click', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ollaic_webgal_preview_dock_height', '450'));
  await page.route('**/__runtime-test*', (route) => route.fulfill({ contentType: 'text/html', body: 'WebGAL' }));
  await page.routeWebSocket('**/api/webgalsync', (socket) => {
    socket.send(JSON.stringify({ data: { command: 1 } }));
  });
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  const preview = page.getByLabel('实时预览区域');
  const sash = page.locator('.editor-dock-resizer');
  await expect(preview).toHaveCSS('height', '450px');
  const bounds = (await sash.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 30, { steps: 5 });
  await page.mouse.up();
  await expect(preview).toHaveCSS('height', '480px');
  expect(await page.evaluate(() => localStorage.getItem('ollaic_webgal_preview_dock_height'))).toBe('480');
  await sash.dblclick();
  await expect(preview).toHaveCSS('height', '350px');
  expect(await page.evaluate(() => localStorage.getItem('ollaic_webgal_preview_dock_height'))).toBe('350');
  await sash.dblclick();
  await expect(preview).toHaveCSS('height', '350px');
});

test('bottom preview sash follows its rendered height after reaching the CSS limit', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ollaic_webgal_preview_dock_height', '700'));
  await page.route('**/__runtime-test*', (route) => route.fulfill({ contentType: 'text/html', body: 'WebGAL' }));
  await page.routeWebSocket('**/api/webgalsync', (socket) => socket.send(JSON.stringify({ data: { command: 1 } })));
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  const preview = page.getByLabel('实时预览区域');
  const sash = page.locator('.editor-dock-resizer');
  const initialHeight = (await preview.boundingBox())!.height;
  expect(initialHeight).toBeLessThan(700);
  const dragBy = async (dy: number) => {
    const bounds = (await sash.boundingBox())!;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 5 });
    await page.mouse.up();
  };
  const expectHeightPersisted = async () => {
    const actualHeight = (await preview.boundingBox())!.height;
    const storedHeight = await page.evaluate(() => Number(localStorage.getItem('ollaic_webgal_preview_dock_height')));
    expect(storedHeight).toBeCloseTo(actualHeight, 1);
  };
  await dragBy(30);
  expect((await preview.boundingBox())!.height).toBeCloseTo(initialHeight - 30, 1);
  await expectHeightPersisted();
  await dragBy(-100);
  expect((await preview.boundingBox())!.height).toBeCloseTo(initialHeight, 1);
  await expectHeightPersisted();
  await dragBy(30);
  expect((await preview.boundingBox())!.height).toBeCloseTo(initialHeight - 30, 1);
  await expectHeightPersisted();
});

test('bottom preview restores heights above 900px across reloads and smaller viewports', async ({ page }) => {
  await page.route('**/__runtime-test*', (route) => route.fulfill({ contentType: 'text/html', body: 'WebGAL' }));
  await page.routeWebSocket('**/api/webgalsync', (socket) => socket.send(JSON.stringify({ data: { command: 1 } })));
  await openFlowBoard(page, { width: 1440, height: 1440 }, 'draft');
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  const preview = page.getByLabel('实时预览区域');
  const bounds = (await page.locator('.editor-dock-resizer').boundingBox())!;
  const initialHeight = (await preview.boundingBox())!.height;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - (950 - initialHeight), { steps: 5 });
  await page.mouse.up();
  await expect(preview).toHaveCSS('height', '950px');
  expect(await page.evaluate(() => localStorage.getItem('ollaic_webgal_preview_dock_height'))).toBe('950');
  await page.reload();
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  await expect(preview).toHaveCSS('height', '950px');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  expect((await preview.boundingBox())!.height).toBeLessThan(950);
  expect(await page.evaluate(() => localStorage.getItem('ollaic_webgal_preview_dock_height'))).toBe('950');
  await page.setViewportSize({ width: 1440, height: 1440 });
  await expect(preview).toHaveCSS('height', '950px');
});

for (const mode of ['dock', 'float', 'resize'] as const) {
  for (const reason of ['blur', 'release'] as const) {
    test(`${mode} preview drag ends on ${reason} without leaving an overlay`, async ({ page, context }) => {
      await page.route('**/__runtime-test*', (route) => route.fulfill({ contentType: 'text/html', body: 'WebGAL' }));
      await page.routeWebSocket('**/api/webgalsync', (socket) => socket.send(JSON.stringify({ data: { command: 1 } })));
      await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
      await page.getByRole('button', { name: '实时预览', exact: true }).click();
      if (mode !== 'dock') await page.getByRole('button', { name: '脱离为悬浮画中画' }).click();
      const preview = page.getByLabel('实时预览区域');
      const handle = mode === 'dock' ? page.locator('.editor-dock-resizer')
        : mode === 'float' ? preview.locator('header strong') : page.getByTitle('按住等比缩放浮窗大小');
      const bounds = (await handle.boundingBox())!;
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 10, y - 10, { steps: 3 });
      const before = await preview.boundingBox();
      if (reason === 'blur') {
        const other = await context.newPage();
        await other.goto('about:blank');
        await other.bringToFront();
        await other.mouse.up();
        // Headless Chromium does not consistently send an OS focus event on tab switches.
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await page.bringToFront();
        await expect(page.locator('.fixed.cursor-grabbing, .fixed.cursor-row-resize')).toHaveCount(0);
        await other.close();
      }
      // CDP supplies buttons: 0 independently of Playwright's per-page mouse state.
      const input = await context.newCDPSession(page);
      await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 60, y: y - 60, buttons: 0 });
      expect(await preview.boundingBox()).toEqual(before);
      await expect(page.locator('.fixed.cursor-grabbing, .fixed.cursor-row-resize')).toHaveCount(0);
      const saved = await page.evaluate((mode) => localStorage.getItem(mode === 'dock'
        ? 'ollaic_webgal_preview_dock_height' : 'ollaic_webgal_preview_float'), mode);
      if (mode === 'dock') expect(Number(saved)).toBeCloseTo(before!.height, 1);
      else expect(JSON.parse(saved!)).toEqual({ x: before!.x, y: before!.y, width: before!.width, height: before!.height });
      await page.mouse.up();
    });
  }
}

test('narrow workspace can switch from Agent to a large preview without overflow', async ({ page }) => {
  await page.route('**/__runtime-test*', (route) => route.fulfill({ contentType: 'text/html', body: 'WebGAL' }));
  await page.routeWebSocket('**/api/webgalsync', (socket) => {
    const heartbeat = setInterval(() => socket.send(JSON.stringify({ data: { command: 1 } })), 100);
    socket.onClose(() => clearInterval(heartbeat));
  });
  await openFlowBoard(page, { width: 390, height: 844 }, 'draft');
  await page.getByRole('button', { name: '收起 Agent 面板' }).click();
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  await page.getByRole('button', { name: '全屏大预览' }).click();
  await expect(page.getByTitle('WebGAL 实时预览')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '打开 Agent 面板' }).click();
  await expect(page.getByLabel('production brief')).toBeVisible();
});

test('production ownership survives Agent switches and reloads scenes before editing resumes', async ({ page }) => {
  await openFlowBoard(page, { width: 1440, height: 900 });
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await expect(page.getByLabel('AI 创作输入')).toBeDisabled();
  await page.getByRole('tab', { name: 'Workflow Agent', exact: true }).click();
  await expect(page.getByTestId('flow-run-status')).toContainText('已暂停');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByTestId('flow-run-status')).toContainText('已停止');
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await expect(page.getByLabel('AI 创作输入')).toBeEnabled();
  await expect(page.getByRole('button', { name: /生产之后的场景/ })).toBeVisible();
});

test('restored unsaved drafts cannot autosave over production output', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => sessionStorage.setItem('scene-draft-alpha-start.txt', JSON.stringify([
    { id: 'unsaved', type: 'dialogue', character: '林夏', content: '保留我没有保存的草稿。', flags: [] },
  ])));
  await openFlowBoard(page, { width: 1440, height: 900 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('生产结果与未保存的编辑同时存在');
  await page.clock.fastForward(4000);
  expect(await page.evaluate(() => (window as unknown as { __flowCalls: { command: string }[] }).__flowCalls.filter((call) => call.command === 'save_scene'))).toHaveLength(0);
  await page.getByRole('button', { name: '读取生产结果（放弃当前草稿）', exact: true }).click();
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await expect(page.getByLabel('AI 创作输入')).toBeEnabled();
  await expect(page.getByRole('button', { name: /生产之后的场景/ })).toBeVisible();
});

test('preparing production also saves drafts cached in other scenes', async ({ page }) => {
  await openFlowBoard(page, { width: 1440, height: 900 }, 'draft');
  await page.getByRole('tab', { name: '编辑 Agent', exact: true }).click();
  await page.getByLabel('编辑器视图模式').selectOption('script');
  await page.getByLabel('WebGAL 脚本编辑器').fill('林夏:第一场景的未保存修改。;');
  await page.getByRole('button', { name: '应用更改', exact: true }).click();
  await page.getByLabel('当前场景').selectOption('chapter2.txt');
  await page.getByRole('tab', { name: 'Workflow Agent', exact: true }).click();
  await page.getByLabel('production brief').fill('保留之前的修改并准备后续生产');
  await page.getByRole('button', { name: '准备流程' }).click();
  await expect(page.getByTestId('flow-run-status')).toContainText('已暂停');
  const commands = await page.evaluate(() => (window as unknown as { __flowCalls: { command: string; args: { path?: string; nodes?: { content: string }[] } }[] }).__flowCalls);
  const start = commands.findIndex((call) => call.command === 'pipeline_start');
  const save = commands.findIndex((call) => call.command === 'save_scene' && call.args.path?.endsWith('/start.txt') && call.args.nodes?.[0]?.content.includes('第一场景的未保存修改'));
  expect(save).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(save);
});
