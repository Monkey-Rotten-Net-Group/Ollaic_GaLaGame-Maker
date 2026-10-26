import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectHome, type Project } from './ProjectHome';
import { openProject, type ProjectInfo } from '../lib/webgal-ipc';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('../lib/webgal-ipc');

const projects: Project[] = ['A', 'B'].map((id) => ({
  id, name: `Project ${id}`, path: `/projects/${id}`, description: '',
  lastModified: '', isFavorite: false, sceneCount: 1,
}));

function savedProjects(): Project[] {
  return JSON.parse(localStorage.getItem('webgal-projects')!);
}

function record(id: string) {
  return within(screen.getByText(`Project ${id}`).closest('[role="button"]') as HTMLElement);
}

async function startOpening(entry: 'card' | 'folder') {
  let resolve!: (info: ProjectInfo) => void;
  vi.mocked(openProject).mockReturnValue(new Promise((done) => { resolve = done; }));
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<ProjectHome />} />
        <Route path="/editor/:id" element={<div>Editor</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    if (entry === 'folder') fireEvent.click(screen.getByRole('button', { name: /\u6253\u5f00\u5df2\u6709\u9879\u76ee/ }));
    else fireEvent.click(screen.getByText('Project A'));
  });
  return async () => {
    await act(async () => { resolve({ path: '/projects/A', config: {}, scenes: ['start.txt', 'next.txt'] }); });
  };
}

describe.each(['card', 'folder'] as const)('ProjectHome pending %s opens', (entry) => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('webgal-projects', JSON.stringify(projects));
    vi.mocked(openDialog).mockResolvedValue('/projects/A');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each(['A', 'B'])('preserves a favorite changed on project %s before navigation', async (id) => {
    const finishOpening = await startOpening(entry);
    fireEvent.click(record(id).getByRole('button', { name: '\u6536\u85cf\u9879\u76ee' }));
    await finishOpening();

    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(savedProjects().find((p) => p.id === id)?.isFavorite).toBe(true);
    expect(savedProjects().find((p) => p.id === 'A')?.sceneCount).toBe(2);
    expect(localStorage.getItem('project-path-A')).toBe('/projects/A');
  });

  it.each(['A', 'B'])('preserves moving project %s to trash while opening', async (id) => {
    const finishOpening = await startOpening(entry);
    fireEvent.click(record(id).getByRole('button', { name: '\u5220\u9664\u9879\u76ee' }));
    await finishOpening();

    expect(savedProjects().find((p) => p.id === id)?.deleted).toBe(true);
    expect(screen.queryByText('Editor') !== null).toBe(id !== 'A');
  });

  it('does not restore a permanently removed project after opening finishes', async () => {
    localStorage.setItem('webgal-projects', JSON.stringify([projects[0], { ...projects[1], deleted: true }]));
    const finishOpening = await startOpening(entry);
    fireEvent.click(screen.getByRole('button', { name: /\u56de\u6536\u7ad9/ }));
    fireEvent.click(record('B').getByRole('button', { name: '\u6c38\u4e45\u5220\u9664\u9879\u76ee' }));
    await finishOpening();

    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(savedProjects().map((p) => p.id)).toEqual(['A']);
    expect(localStorage.getItem('project-path-B')).toBeNull();
  });

  it('cancels opening a target permanently removed during the request', async () => {
    const finishOpening = await startOpening(entry);
    fireEvent.click(record('A').getByRole('button', { name: '\u5220\u9664\u9879\u76ee' }));
    fireEvent.click(screen.getByRole('button', { name: /\u56de\u6536\u7ad9/ }));
    fireEvent.click(record('A').getByRole('button', { name: '\u6c38\u4e45\u5220\u9664\u9879\u76ee' }));
    await finishOpening();

    expect(screen.queryByText('Editor')).not.toBeInTheDocument();
    expect(savedProjects().map((p) => p.id)).toEqual(['B']);
    expect(localStorage.getItem('project-path-A')).toBeNull();
  });

  if (entry === 'folder') it('restores a project that was already in trash when selected', async () => {
    localStorage.setItem('webgal-projects', JSON.stringify([{ ...projects[0], deleted: true }, projects[1]]));
    const finishOpening = await startOpening(entry);
    await finishOpening();

    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(savedProjects().find((p) => p.id === 'A')?.deleted).toBe(false);
  });
});
