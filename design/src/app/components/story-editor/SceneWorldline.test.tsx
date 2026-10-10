import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FullScreenWorldline, SceneWorldlinePanel } from './SceneWorldline';
import { OllaicSideNav } from '../OllaicChrome';
import { MemoryRouter } from 'react-router';
import type { WebGalNode } from '../../lib/webgal-types';

const sampleNodes: WebGalNode[] = [
  {
    id: 'n1',
    type: 'dialogue',
    character: '希尔',
    content: '你好，欢迎来到这里。',
    flags: [],
    position: { x: 0, y: 0 },
    connections: [],
  },
];

describe('SceneWorldlinePanel', () => {
  it('renders action buttons and triggers callbacks', async () => {
    const user = userEvent.setup();
    const onEnlargePreview = vi.fn();
    const onNewScene = vi.fn();
    const onOpenSceneManager = vi.fn();
    const onSelectNode = vi.fn();
    const onOpenScene = vi.fn();

    render(
      <SceneWorldlinePanel
        scenes={['start.txt', 'branch_a.txt']}
        currentSceneName="start.txt"
        sceneHeaders={{}}
        sceneLinkMap={{}}
        nodes={sampleNodes}
        selectedNode={null}
        onSelectNode={onSelectNode}
        onOpenScene={onOpenScene}
        onNewScene={onNewScene}
        onOpenSceneManager={onOpenSceneManager}
        onEnlargePreview={onEnlargePreview}
      />,
    );

    expect(screen.getByText('场景关系图')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    const newBtn = screen.getByRole('button', { name: '新建场景' });
    const mgrBtn = screen.getByRole('button', { name: '场景管理' });
    const enlargeBtn = screen.getByRole('button', { name: '放大预览' });

    expect(newBtn).toBeInTheDocument();
    expect(mgrBtn).toBeInTheDocument();
    expect(enlargeBtn).toBeInTheDocument();

    await user.click(enlargeBtn);
    expect(onEnlargePreview).toHaveBeenCalledTimes(1);

    await user.click(newBtn);
    expect(onNewScene).toHaveBeenCalledTimes(1);

    await user.click(mgrBtn);
    expect(onOpenSceneManager).toHaveBeenCalledTimes(1);
  });

  it('supports right-click context menu on scene cards', async () => {
    const user = userEvent.setup();
    const onOpenScene = vi.fn();
    const onRenameScene = vi.fn();
    const onDeleteScene = vi.fn();

    render(
      <SceneWorldlinePanel
        scenes={['start.txt', 'branch_a.txt']}
        currentSceneName="start.txt"
        sceneHeaders={{}}
        sceneLinkMap={{}}
        nodes={sampleNodes}
        selectedNode={null}
        onSelectNode={vi.fn()}
        onOpenScene={onOpenScene}
        onRenameScene={onRenameScene}
        onDeleteScene={onDeleteScene}
      />,
    );

    const branchCard = screen.getByRole('button', { name: /branch_a/ });
    fireEvent.contextMenu(branchCard);

    expect(screen.getByText('切换到此场景')).toBeInTheDocument();
    expect(screen.getByText('重命名')).toBeInTheDocument();
    expect(screen.getByText('删除场景')).toBeInTheDocument();

    await user.click(screen.getByText('切换到此场景'));
    expect(onOpenScene).toHaveBeenCalledWith('branch_a.txt');
  });
});

describe('FullScreenWorldline', () => {
  it('renders enlarged preview header with controls and responds to Esc', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <FullScreenWorldline
        scenes={['start.txt']}
        currentSceneName="start.txt"
        sceneHeaders={{}}
        sceneLinkMap={{}}
        nodes={sampleNodes}
        selectedNode={null}
        onSelectNode={vi.fn()}
        onOpenScene={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('场景关系图')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回脚本流' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出放大预览' })).toBeInTheDocument();

    const zoomInBtn = screen.getByRole('button', { name: '放大视图' });
    const zoomOutBtn = screen.getByRole('button', { name: '缩小视图' });
    expect(screen.getByText('100%')).toBeInTheDocument();

    await user.click(zoomInBtn);
    expect(screen.getByText('115%')).toBeInTheDocument();

    await user.click(zoomOutBtn);
    expect(screen.getByText('100%')).toBeInTheDocument();

    // Escape key
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('OllaicSideNav navigation integration', () => {
  it('does not display standalone 场景 item in main navigation bar', () => {
    render(
      <MemoryRouter>
        <OllaicSideNav active="script" projectId="test-proj" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /首页/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /生产流/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /脚本流/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /资源库/ })).toBeInTheDocument();
    // Standalone "场景" should not be an item in the side navigation
    expect(screen.queryByRole('button', { name: /^场景$/ })).toBeNull();
  });
});
