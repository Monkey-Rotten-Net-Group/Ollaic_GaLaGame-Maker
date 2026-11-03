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
