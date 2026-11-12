import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllaicTopBar } from './OllaicChrome';

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

function renderHeader(onBeforeNavigate?: (action: () => void) => void) {
  return render(
    <MemoryRouter initialEntries={['/editor/project']}>
      <OllaicTopBar projectId="project" activeSection="edit" onBeforeNavigate={onBeforeNavigate} />
      <CurrentPath />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('global topbar', () => {
  it('uses the brand button to return home', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: /Ollaic GalGame Studio，返回首页/ }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(/^\/$/);
  });

  it('renders quiet saved status when clean', () => {
    render(
      <MemoryRouter initialEntries={['/editor/project']}>
        <OllaicTopBar projectId="project" saveStatus="saved" />
      </MemoryRouter>,
    );
    expect(screen.getByText('已保存')).toBeInTheDocument();
  });

  it('provides a clickable save trigger when content is dirty', async () => {
    const user = userEvent.setup();
    const handleSave = vi.fn();
    render(
      <MemoryRouter initialEntries={['/editor/project']}>
        <OllaicTopBar projectId="project" isDirty onSave={handleSave} />
      </MemoryRouter>,
    );
    const saveTrigger = screen.getByRole('status');
    expect(saveTrigger).toHaveTextContent(/未保存/);
    await user.click(saveTrigger);
    expect(handleSave).toHaveBeenCalledTimes(1);
  });
});

it('keeps file commands, snapshots, source view and autosave reachable in the overflow', async () => {
  const user = userEvent.setup();
  const onImport = vi.fn();
  const onExport = vi.fn();
  const onSnapshots = vi.fn();
  const onScriptViewChange = vi.fn();
  const onAutoSaveChange = vi.fn();
  render(
    <MemoryRouter>
      <OllaicTopBar
        projectId="project"
        onImport={onImport}
        onExport={onExport}
        onSnapshots={onSnapshots}
        onScriptViewChange={onScriptViewChange}
        autoSave
        onAutoSaveChange={onAutoSaveChange}
      />
    </MemoryRouter>,
  );
  for (const [name, callback] of [
    ['导入场景', onImport],
    ['导出场景', onExport],
    ['快照管理', onSnapshots],
  ] as const) {
    await user.click(screen.getByRole('button', { name: '文件与编辑操作' }));
    await user.click(screen.getByRole('menuitem', { name }));
    expect(callback).toHaveBeenCalledTimes(1);
  }
  await user.click(screen.getByRole('button', { name: '文件与编辑操作' }));
  await user.click(screen.getByRole('menuitem', { name: '脚本源码' }));
  expect(onScriptViewChange).toHaveBeenCalledWith('script');
  await user.click(screen.getByRole('button', { name: '文件与编辑操作' }));
  await user.click(screen.getByRole('menuitemcheckbox', { name: '自动保存' }));
  expect(onAutoSaveChange).toHaveBeenCalledWith(false);
});
