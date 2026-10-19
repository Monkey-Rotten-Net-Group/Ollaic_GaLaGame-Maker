import type { ComponentProps } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { describe, expect, it, vi } from 'vitest';
import type { WebGalNode } from '../../lib/webgal-types';
import { ScriptCommandStream } from './ScriptCommandStream';

const nodes: WebGalNode[] = [
  { id: 'opening', type: 'dialogue', character: '林夏', content: '故事开始。', flags: [], position: { x: 0, y: 0 }, connections: [] },
  { id: 'background', type: 'changeBg', asset: 'studio.png', content: '', flags: [], position: { x: 0, y: 0 }, connections: [] },
  { id: 'next', type: 'dialogue', character: '林夏', content: '来到工作室。', flags: [], position: { x: 0, y: 0 }, connections: [] },
  { id: 'continuation', type: 'dialogue', content: '继续创作。', flags: [], position: { x: 0, y: 0 }, connections: [] },
];

function renderStream(overrides: Partial<ComponentProps<typeof ScriptCommandStream>> = {}) {
  const props: ComponentProps<typeof ScriptCommandStream> = {
    nodes,
    selectedNode: null,
    currentSceneName: 'start.txt',
    displayMode: 'compact',
    onSelectNode: vi.fn(),
    onInsertNode: vi.fn(),
    ...overrides,
  };
  const view = (next: typeof props) => (
    <DndProvider backend={HTML5Backend}><ScriptCommandStream {...next} /></DndProvider>
  );
  const result = render(view(props));
  return {
    ...result,
    props,
    update: (next: Partial<typeof props>) => {
      Object.assign(props, next);
      result.rerender(view(props));
    },
  };
}

function openingHeader() {
  return screen.getByText('序幕 · 开场').closest('.group')!;
}

describe('ScriptCommandStream compact view', () => {
  it('clears section collapse state when switching scenes', async () => {
    const user = userEvent.setup();
    const { update } = renderStream();
    await user.click(openingHeader());
    expect(screen.queryByRole('button', { name: /故事开始/ })).not.toBeInTheDocument();

    update({ currentSceneName: 'single.txt', nodes: [nodes[0]] });
    expect(screen.getByRole('button', { name: /故事开始/ })).toBeVisible();
    expect(screen.queryByText('全部展开')).not.toBeInTheDocument();

    update({ currentSceneName: 'another.txt', nodes });
    expect(screen.getByRole('button', { name: /故事开始/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /来到工作室/ })).toBeVisible();
  });

  it('keeps a lone section visible when editing removes the other sections', async () => {
    const user = userEvent.setup();
    const { update } = renderStream();
    await user.click(openingHeader());
    update({ nodes: [nodes[0]] });
    expect(screen.getByRole('button', { name: /故事开始/ })).toBeVisible();
  });

  it('preserves manual collapse and collapse-all after selecting a command', async () => {
    const user = userEvent.setup();
    const { update } = renderStream({ selectedNode: nodes[0] });
    await user.click(openingHeader());
    expect(screen.queryByRole('button', { name: /故事开始/ })).not.toBeInTheDocument();

    // Editing creates new node objects; it should not reveal the same selection.
    const editedNodes = nodes.map((node) => ({ ...node }));
    update({ nodes: editedNodes, selectedNode: editedNodes[0] });
    expect(screen.queryByRole('button', { name: /故事开始/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全部展开' }));
    await user.click(screen.getByRole('button', { name: '全部折叠' }));
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /来到工作室/ })).not.toBeInTheDocument();
  });

  it('reveals a new selection, including continuation lines and selection within the same section', async () => {
    const user = userEvent.setup();
    const { update } = renderStream({ selectedNode: nodes[0] });
    await user.click(screen.getByRole('button', { name: '全部折叠' }));
    update({ selectedNode: nodes[3] });
    expect(screen.getByRole('button', { name: /继续创作/, pressed: true })).toBeVisible();
    expect(screen.queryByRole('button', { name: /故事开始/ })).not.toBeInTheDocument();

    await user.click(screen.getByText(/小节 1 · studio/));
    expect(screen.queryByRole('button', { name: /继续创作/ })).not.toBeInTheDocument();
    update({ selectedNode: nodes[2] });
    expect(screen.getByRole('button', { name: /来到工作室/, pressed: true })).toBeVisible();
  });

  it('temporarily reveals search results without undoing manual collapse', async () => {
    const user = userEvent.setup();
    const { update } = renderStream({ selectedNode: nodes[0] });
    await user.click(openingHeader());
    update({ searchQuery: '故事' });
    expect(screen.getByRole('button', { name: /故事开始/ })).toBeVisible();
    update({ searchQuery: '' });
    expect(screen.queryByRole('button', { name: /故事开始/ })).not.toBeInTheDocument();
    update({ searchQuery: '工作室' });
    expect(screen.getByRole('button', { name: /来到工作室/ })).toBeVisible();
    update({ searchQuery: '' });
    expect(screen.queryByRole('button', { name: /故事开始/ })).not.toBeInTheDocument();
  });

  it.each(['{Enter}', ' '])('selects commands and continuation lines with %s', async (key) => {
    const user = userEvent.setup();
    const { props } = renderStream();
    const command = screen.getByRole('button', { name: /故事开始/ });
    for (let i = 0; document.activeElement !== command && i < 20; i++) await user.tab();
    expect(command).toHaveFocus();
    await user.keyboard(key);
    expect(props.onSelectNode).toHaveBeenCalledExactlyOnceWith(nodes[0]);

    const continuation = screen.getByRole('button', { name: /继续创作/ });
    continuation.focus();
    await user.keyboard(key);
    expect(props.onSelectNode).toHaveBeenLastCalledWith(nodes[3]);
    expect(props.onSelectNode).toHaveBeenCalledTimes(2);
  });

  it('keeps run and menu actions independent of command selection', async () => {
    const user = userEvent.setup();
    const onJumpToIndex = vi.fn();
    const onCopyNode = vi.fn();
    const { props } = renderStream({ onJumpToIndex, onCopyNode });
    const run = screen.getByRole('button', { name: '运行到此处第 1 行' });
    run.focus();
    await user.keyboard('{Enter}');
    expect(onJumpToIndex).toHaveBeenCalledExactlyOnceWith(0);
    expect(props.onSelectNode).not.toHaveBeenCalled();

    const row = screen.getByRole('button', { name: /故事开始/ }).closest('[data-cmd-card]')!;
    const menu = within(row as HTMLElement).getByRole('button', { name: '更多操作' });
    menu.focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('menuitem', { name: '复制' }));
    expect(onCopyNode).toHaveBeenCalledExactlyOnceWith(nodes[0].id);
    expect(props.onSelectNode).not.toHaveBeenCalled();

    fireEvent.click(within(row as HTMLElement).getByText('林夏', { selector: 'span' }));
    expect(props.onSelectNode).toHaveBeenCalledExactlyOnceWith(nodes[0]);
  });
});
