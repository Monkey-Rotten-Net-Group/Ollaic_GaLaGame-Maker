import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { OllaicTopBar } from '../OllaicChrome';
import type { WebGalNode } from '../../lib/webgal-types';
import { FullScreenWorldline } from './SceneWorldline';

const sampleNodes: WebGalNode[] = [{
  id: 'n1', type: 'dialogue', character: '希尔', content: '你好，欢迎来到这里。', flags: [],
  position: { x: 0, y: 0 }, connections: [],
}];

function renderWorldline(overrides: Partial<ComponentProps<typeof FullScreenWorldline>> = {}) {
  const props = {
    scenes: ['start.txt', 'branch_a.txt'],
    currentSceneName: 'start.txt',
    sceneHeaders: {},
    sceneLinkMap: {},
    nodes: sampleNodes,
    selectedNode: null,
    onSelectNode: vi.fn(),
    onOpenScene: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<FullScreenWorldline {...props} />);
  return props;
}

describe('FullScreenWorldline', () => {
  it('zooms between 50% and 200% and resets to 100%', async () => {
    const user = userEvent.setup();
    renderWorldline();
    const zoomIn = screen.getByRole('button', { name: '放大视图' });
    const zoomOut = screen.getByRole('button', { name: '缩小视图' });
    const reset = screen.getByRole('button', { name: '重置缩放' });

    expect(reset).toHaveTextContent('100%');
    await user.click(zoomIn);
    expect(reset).toHaveTextContent('115%');
    await user.click(zoomOut);
    expect(reset).toHaveTextContent('100%');
    for (let i = 0; i < 10; i++) await user.click(zoomIn);
    expect(reset).toHaveTextContent('200%');
    expect(zoomIn).toBeDisabled();
    await user.click(reset);
    expect(reset).toHaveTextContent('100%');
    expect(zoomIn).toBeEnabled();
    for (let i = 0; i < 10; i++) await user.click(zoomOut);
    expect(reset).toHaveTextContent('50%');
    expect(zoomOut).toBeDisabled();
    await user.click(reset);
    expect(zoomOut).toBeEnabled();
  });

  it('returns to the editor using its button or Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWorldline();
    expect(screen.getByText('场景关系图')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回编辑器' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('dismisses the context menu before leaving the graph', () => {
    const { onClose } = renderWorldline();
    fireEvent.contextMenu(screen.getByRole('button', { name: /branch_a/ }));
    expect(screen.getByRole('button', { name: '切换到此场景' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: '切换到此场景' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves Escape handling to an open dialog or input composition', () => {
    const { onClose } = renderWorldline();
    render(<div role="dialog" aria-label="场景管理"><input aria-label="场景名称" /></div>);
    fireEvent.keyDown(screen.getByLabelText('场景名称'), { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    const handledEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handledEscape.preventDefault();
    window.dispatchEvent(handledEscape);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens scenes with mouse or keyboard and selects commands in the index', async () => {
    const user = userEvent.setup();
    const { onOpenScene, onSelectNode } = renderWorldline();
    const branch = screen.getByRole('button', { name: /branch_a/ });
    await user.click(branch);
    fireEvent.keyDown(branch, { key: 'Enter' });
    fireEvent.keyDown(branch, { key: ' ' });
    expect(onOpenScene).toHaveBeenCalledTimes(3);
    expect(onOpenScene).toHaveBeenLastCalledWith('branch_a.txt');
    await user.click(screen.getByRole('button', { name: /你好，欢迎来到这里/ }));
    expect(onSelectNode).toHaveBeenCalledWith(sampleNodes[0]);
  });

  it('keeps rename and delete actions in the scene context menu', async () => {
    const user = userEvent.setup();
    const onRenameScene = vi.fn();
    const onDeleteScene = vi.fn();
    renderWorldline({ onRenameScene, onDeleteScene });
    const branch = screen.getByRole('button', { name: /branch_a/ });
    fireEvent.contextMenu(branch);
    await user.click(screen.getByRole('button', { name: '重命名' }));
    expect(onRenameScene).toHaveBeenCalledWith('branch_a.txt');
    fireEvent.contextMenu(branch);
    await user.click(screen.getByRole('button', { name: '删除场景' }));
    expect(onDeleteScene).toHaveBeenCalledWith('branch_a.txt');
  });
});

describe('OllaicTopBar navigation integration', () => {
  it('unifies production, scripts and scenes under editing', () => {
    render(<MemoryRouter><OllaicTopBar activeSection="edit" projectId="test-proj" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: '编辑' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: /生产流|脚本流|^场景$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /资源库/ })).toBeInTheDocument();
  });
});
