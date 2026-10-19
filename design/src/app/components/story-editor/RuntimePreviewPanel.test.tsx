import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuntimePreviewPanel, type PreviewLayout } from './RuntimePreviewPanel';
import * as webgalIpc from '../../lib/webgal-ipc';

vi.mock('../../lib/webgal-ipc', () => ({
  openInBrowser: vi.fn(),
}));

describe('RuntimePreviewPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  });
  const createMockPreview = (ready = true, url: string | null = 'http://localhost:3001') => ({
    ready,
    url,
    error: null,
    revision: 1,
    sync: vi.fn(),
    jump: vi.fn(),
    reconnect: vi.fn(),
    onFrameLoad: vi.fn(),
  });

  it('renders bottom docked split layout with popout button and browser link', async () => {
    const preview = createMockPreview();
    const handleLayoutChange = vi.fn();
    const handleSettings = vi.fn();

    render(
      <RuntimePreviewPanel
        preview={preview}
        layout="split"
        sceneName="start.txt"
        dirty={false}
        onLayoutChange={handleLayoutChange}
        onSettings={handleSettings}
      />
    );

    // 验证标题与场景名
    expect(screen.getByText('实时预览')).toBeInTheDocument();
    expect(screen.getByTitle('start.txt')).toBeInTheDocument();

    // 验证脱离为浮窗按钮存在并可点击
    const popoutBtn = screen.getByRole('button', { name: '脱离为悬浮画中画' });
    expect(popoutBtn).toBeInTheDocument();
    await userEvent.click(popoutBtn);
    expect(handleLayoutChange).toHaveBeenCalledWith('float');

    // 验证单独在浏览器中打开按钮存在并调用 openInBrowser
    const browserBtn = screen.getByRole('button', { name: '在浏览器中预览' });
    expect(browserBtn).toBeInTheDocument();
    await userEvent.click(browserBtn);
    expect(webgalIpc.openInBrowser).toHaveBeenCalledWith('http://localhost:3001');
  });

  it('renders floating mode with dock-to-bottom button and handles docking', async () => {
    const preview = createMockPreview();
    const handleLayoutChange = vi.fn();

    render(
      <RuntimePreviewPanel
        preview={preview}
        layout="float"
        sceneName="chapter1.txt"
        dirty={true}
        onLayoutChange={handleLayoutChange}
        onSettings={vi.fn()}
      />
    );

    // dirty 状态应显示当前草稿
    expect(screen.getByText('当前草稿')).toBeInTheDocument();

    // 验证吸附到底栏按钮存在并可点击切回 split
    const dockBtn = screen.getByRole('button', { name: '吸附到底部底栏' });
    expect(dockBtn).toBeInTheDocument();
    await userEvent.click(dockBtn);
    expect(handleLayoutChange).toHaveBeenCalledWith('split');
  });

  it('supports toggling maximize to large preview and closing to hidden', async () => {
    const preview = createMockPreview();
    const handleLayoutChange = vi.fn();

    render(
      <RuntimePreviewPanel
        preview={preview}
        layout="split"
        sceneName="start.txt"
        dirty={false}
        onLayoutChange={handleLayoutChange}
        onSettings={vi.fn()}
      />
    );

    // 点击放大按钮触发 large
    const maxBtn = screen.getByRole('button', { name: '全屏大预览' });
    await userEvent.click(maxBtn);
    expect(handleLayoutChange).toHaveBeenCalledWith('large');

    // 点击关闭按钮触发 hidden
    const closeBtn = screen.getByRole('button', { name: '收起预览' });
    await userEvent.click(closeBtn);
    expect(handleLayoutChange).toHaveBeenCalledWith('hidden');
  });

  it('restores float mode when exiting large preview if float was the dockLayout', async () => {
    const preview = createMockPreview();
    const handleLayoutChange = vi.fn();

    render(
      <RuntimePreviewPanel
        preview={preview}
        layout="large"
        dockLayout="float"
        height={380}
        sceneName="start.txt"
        dirty={false}
        onLayoutChange={handleLayoutChange}
        onSettings={vi.fn()}
      />
    );

    const restoreBtn = screen.getByRole('button', { name: '返回工作区预览' });
    await userEvent.click(restoreBtn);
    expect(handleLayoutChange).toHaveBeenCalledWith('float');
  });

  it('renders size preset switcher in float mode and allows selecting presets', async () => {
    const preview = createMockPreview();

    render(
      <RuntimePreviewPanel
        preview={preview}
        layout="float"
        dockLayout="float"
        sceneName="start.txt"
        dirty={false}
        onLayoutChange={vi.fn()}
        onSettings={vi.fn()}
      />
    );

    // 应该渲染尺寸切换下拉触发器
    const switcher = screen.getByRole('button', { name: '切换画中画尺寸' });
    expect(switcher).toBeInTheDocument();
    expect(switcher).toHaveTextContent('640P');
    await userEvent.click(switcher);
    await userEvent.click(screen.getByRole('menuitem', { name: /854P/ }));
    expect(screen.getByLabelText('实时预览区域')).toHaveStyle({ width: '854px' });
    expect(switcher).toHaveTextContent('854P');
  });

  const renderPanel = (layout: PreviewLayout = 'float') => {
    const props = { preview: createMockPreview(), sceneName: 'start.txt', dirty: false,
      dockLayout: 'float' as const, onLayoutChange: vi.fn(), onSettings: vi.fn() };
    const result = render(<RuntimePreviewPanel {...props} layout={layout} />);
    return { ...result, changeLayout: (next: PreviewLayout) => result.rerender(<RuntimePreviewPanel {...props} layout={next} />) };
  };
  const doubleClickHeader = () => fireEvent.doubleClick(screen.getByText('实时预览').closest('header')!);
  const expectWithinViewport = () => {
    const panel = screen.getByLabelText('实时预览区域');
    const { left, top, width, height } = panel.style;
    expect(parseFloat(left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(top)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(left) + parseFloat(width)).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(top) + parseFloat(height)).toBeLessThanOrEqual(window.innerHeight);
  };

  it.each(['split', 'large'] as const)('shows the same iframe in %s after collapsing a float, then restores the capsule', (layout) => {
    const { changeLayout } = renderPanel();
    const frame = screen.getByTitle('WebGAL 实时预览');
    doubleClickHeader();
    expect(frame).not.toBeVisible();
    changeLayout(layout);
    expect(screen.getByTitle('WebGAL 实时预览')).toBe(frame);
    expect(frame).toBeVisible();
    changeLayout('float');
    expect(frame).not.toBeVisible();
    doubleClickHeader();
    expect(screen.getByTitle('WebGAL 实时预览')).toBe(frame);
    expect(frame).toBeVisible();
  });

  it('keeps the iframe and geometry through collapse, hide and fullscreen transitions', () => {
    const { changeLayout } = renderPanel();
    const frame = screen.getByTitle('WebGAL 实时预览');
    const original = screen.getByLabelText('实时预览区域').getAttribute('style');
    doubleClickHeader();
    doubleClickHeader();
    changeLayout('hidden');
    changeLayout('large');
    changeLayout('float');
    expect(screen.getByTitle('WebGAL 实时预览')).toBe(frame);
    expect(frame).toBeVisible();
    expect(screen.getByLabelText('实时预览区域').getAttribute('style')).toBe(original);
  });

  it('keeps the entire floating panel in bounds when dragged to either edge', () => {
    renderPanel();
    const header = screen.getByText('实时预览').closest('header')!;
    fireEvent.mouseDown(header, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 3000, clientY: 3000, buttons: 1 });
    fireEvent.mouseUp(window);
    expectWithinViewport();
    fireEvent.mouseDown(header, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: -3000, clientY: -3000, buttons: 1 });
    fireEvent.mouseUp(window);
    expectWithinViewport();
  });

  it('fits resize gestures and persists the bounded size', () => {
    renderPanel();
    fireEvent.mouseDown(screen.getByTitle('按住等比缩放浮窗大小'), { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 3000, buttons: 1 });
    fireEvent.mouseUp(window);
    expectWithinViewport();
    const stored = JSON.parse(localStorage.getItem('ollaic_webgal_preview_float')!);
    expect(screen.getByLabelText('实时预览区域')).toHaveStyle({ width: `${stored.width}px`, height: `${stored.height}px` });
    expect(Math.abs((stored.height - 68) / stored.width - 9 / 16)).toBeLessThan(0.002);
  });

  it.each([
    ['move', 'blur'], ['move', 'release'], ['resize', 'blur'], ['resize', 'release'],
  ])('ends floating %s on %s and persists its last geometry', (mode, reason) => {
    const { container } = renderPanel();
    const handle = mode === 'move'
      ? screen.getByText('实时预览').closest('header')!
      : screen.getByTitle('按住等比缩放浮窗大小');
    fireEvent.mouseDown(handle, { clientX: 200, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 230, clientY: 210, buttons: 1 });
    const panel = screen.getByLabelText('实时预览区域');
    const before = panel.getAttribute('style');
    expect(container.querySelector('.fixed.inset-0')).not.toBeNull();
    if (reason === 'blur') fireEvent(window, new Event('blur'));
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400, buttons: 0 });
    expect(panel.getAttribute('style')).toBe(before);
    expect(container.querySelector('.fixed.inset-0')).toBeNull();
    const saved = JSON.parse(localStorage.getItem('ollaic_webgal_preview_float')!);
    expect(panel).toHaveStyle({ left: `${saved.x}px`, top: `${saved.y}px`, width: `${saved.width}px`, height: `${saved.height}px` });
    // A later pressed movement cannot restart the completed interaction.
    fireEvent.mouseMove(window, { clientX: 450, clientY: 450, buttons: 1 });
    expect(panel.getAttribute('style')).toBe(before);
  });

  it('fits an oversized preset on a narrow viewport and refits when the viewport shrinks', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390 });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: '切换画中画尺寸' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /854P/ }));
    expectWithinViewport();
    Object.defineProperty(window, 'innerWidth', { value: 320 });
    Object.defineProperty(window, 'innerHeight', { value: 300 });
    fireEvent(window, new Event('resize'));
    expectWithinViewport();
  });

  it('fits persisted geometry when reopening on a smaller viewport', () => {
    localStorage.setItem('ollaic_webgal_preview_float', JSON.stringify({ x: 1800, y: 900, width: 854, height: 548 }));
    Object.defineProperty(window, 'innerWidth', { value: 390 });
    renderPanel();
    expectWithinViewport();
  });
});
