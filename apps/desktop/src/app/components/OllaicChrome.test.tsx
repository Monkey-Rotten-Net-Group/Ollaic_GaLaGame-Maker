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

describe('global workspace navigation', () => {
  it('offers two peer views and uses the brand to return home', async () => {
    const user = userEvent.setup();
    renderHeader();
    const navigation = within(screen.getByRole('navigation', { name: '核心视图' }));
    expect(navigation.getAllByRole('button')).toHaveLength(2);
    expect(navigation.getByRole('button', { name: '编辑' })).toHaveAttribute('aria-current', 'page');
    await user.click(navigation.getByRole('button', { name: '资源库' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/editor/project/assets');
    await user.click(screen.getByRole('button', { name: /Ollaic GalGame Studio，返回首页/ }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(/^\/$/);
  });

  it('waits for the existing navigation guard before leaving the editor', async () => {
    const user = userEvent.setup();
    const guard = vi.fn<(action: () => void) => void>();
    renderHeader(guard);
    await user.click(screen.getByRole('button', { name: '资源库' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(/^\/editor\/project$/);
    const action = guard.mock.calls[0]?.[0];
    if (!action) throw new Error('Navigation guard was not called');
    act(action);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/editor/project/assets');
  });

  it('does not navigate or prompt when the current view is clicked', async () => {
    const user = userEvent.setup();
    const guard = vi.fn();
    renderHeader(guard);
    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(guard).not.toHaveBeenCalled();
  });
});
