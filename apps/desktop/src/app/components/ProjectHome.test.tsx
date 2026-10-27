import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from '@tauri-apps/api/core';
import { ProjectHome, type Project } from './ProjectHome';
import {
  createManagedProject,
  getProjectStorage,
  initProject,
  openProject,
} from '../lib/webgal-ipc';
import { saveProjectMemory } from '../lib/project-memory';

vi.mock('../lib/webgal-ipc');
vi.mock('../lib/project-memory');
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false), invoke: vi.fn() }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', () => ({ useNavigate: () => navigate }));

const projects: Project[] = [
  {
    id: 'first',
    name: '雨后站台',
    description: '五年后的重逢',
    lastModified: '2026/10/26 12:00',
    path: '/stories/station',
    isFavorite: false,
    sceneCount: 3,
  },
  {
    id: 'second',
    name: '下一站夏天',
    description: '海边的约定',
    lastModified: '2026/10/25 09:00',
    path: '/stories/summer',
    isFavorite: true,
    sceneCount: 8,
  },
  {
    id: 'archived',
    name: '旧日来信',
    description: '',
    lastModified: '',
    path: '/stories/letter',
    isFavorite: false,
    sceneCount: 1,
    deleted: true,
  },
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('webgal-projects', JSON.stringify(projects));
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(saveProjectMemory).mockResolvedValue(undefined);
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(initProject).mockResolvedValue({
    path: '/chosen/新项目',
    config: {},
    scenes: ['start.txt'],
  });
  vi.mocked(openProject).mockImplementation(async (path) => ({ path, config: {}, scenes: [] }));
});
afterEach(cleanup);

describe('M3 project home', () => {
  it.each([null, '{invalid-json', '{}'])(
    'shows an empty library without sample projects for storage %s',
    (stored) => {
      if (stored === null) localStorage.removeItem('webgal-projects');
      else localStorage.setItem('webgal-projects', stored);
      render(<ProjectHome />);
      expect(screen.getByText('暂无项目')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^打开项目 / })).not.toBeInTheDocument();
      expect(localStorage.getItem('webgal-projects')).toBe(stored);
    },
  );

  it('restores and persists the home theme across remounts', async () => {
    const user = userEvent.setup();
    localStorage.setItem('ollaic-home-theme', 'dark');
    const initial = render(<ProjectHome />);
    expect(initial.container.querySelector('.ph-root')).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: '切换到浅色模式' }));
    expect(localStorage.getItem('ollaic-home-theme')).toBe('light');
    initial.unmount();
    const light = render(<ProjectHome />);
    expect(light.container.querySelector('.ph-root')).not.toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: '切换到深色模式' }));
    expect(localStorage.getItem('ollaic-home-theme')).toBe('dark');
    light.unmount();
    const dark = render(<ProjectHome />);
    expect(dark.container.querySelector('.ph-root')).toHaveClass('dark');
  });

  it('saves the project description as initial world memory', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('/chosen');
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '新项目');
    await user.type(screen.getByLabelText('项目简介'), '  雨后校园的故事  ');
    await user.click(screen.getByRole('button', { name: '选择存储文件夹' }));
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() =>
      expect(saveProjectMemory).toHaveBeenCalledWith('/chosen/新项目', {
        worldSetting: '雨后校园的故事',
        writingStyle: '',
        userPreferences: '',
        updatedAt: expect.any(String),
      }),
    );
    expect(navigate).toHaveBeenCalled();
  });

  it('keeps a created project reachable when saving initial memory fails', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('/chosen');
    vi.mocked(saveProjectMemory).mockRejectedValueOnce(new Error('Memory write failed'));
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '新项目');
    await user.type(screen.getByLabelText('项目简介'), '雨后校园');
    await user.click(screen.getByRole('button', { name: '选择存储文件夹' }));
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('Memory write failed');
    expect(screen.getByRole('button', { name: '打开项目 新项目' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
    expect(initProject).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('prefills the configured default directory', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      'webgal-app-settings',
      JSON.stringify({ defaultProjectDir: '/default/projects' }),
    );
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    expect(screen.getByLabelText('存储文件夹')).toHaveValue('/default/projects');
  });

  it('keeps mobile projects in managed storage', async () => {
    const user = userEvent.setup();
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(getProjectStorage).mockResolvedValue({ managed: true });
    vi.mocked(createManagedProject).mockResolvedValue({
      path: '/app/projects/new',
      config: {},
      scenes: ['start.txt'],
    });
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '新项目');
    await waitFor(() => expect(screen.getByLabelText('存储文件夹')).toHaveValue('应用项目库'));
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(createManagedProject).toHaveBeenCalledWith('新项目'));
    expect(initProject).not.toHaveBeenCalled();
    expect(localStorage.getItem('webgal-projects')).toContain('/app/projects/new');
  });

  it('prevents duplicate creation and keeps the modal open while initialization is pending', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('/chosen');
    vi.mocked(initProject).mockReturnValue(new Promise(() => {}));
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '新项目');
    await user.click(screen.getByRole('button', { name: '选择存储文件夹' }));
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    expect(screen.getByRole('button', { name: '创建中…' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeInTheDocument();
    expect(initProject).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('webgal-projects') ?? '[]')).toEqual(projects);
  });

  it('creates the project in the chosen folder before recording it or navigating', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('/chosen');
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }));
    await user.type(dialog.getByLabelText('项目名称'), '新项目');
    expect(dialog.getByRole('button', { name: '创建项目' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: '选择存储文件夹' }));
    expect(dialog.getByLabelText('存储文件夹')).toHaveValue('/chosen');
    await user.click(dialog.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(initProject).toHaveBeenCalledWith('/chosen', '新项目'));
    expect(saveProjectMemory).not.toHaveBeenCalled();
    expect(localStorage.getItem('webgal-projects')).toContain('/chosen/新项目');
    const saved = JSON.parse(localStorage.getItem('webgal-projects') ?? '[]') as Project[];
    expect(localStorage.getItem(`project-path-${saved[0].id}`)).toBe('/chosen/新项目');
    expect(navigate).toHaveBeenCalledWith(`/editor/${saved[0].id}?agent=workflow`);
  });

  it('keeps creation disabled after cancelling folder selection', async () => {
    const user = userEvent.setup();
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }));
    await user.type(dialog.getByLabelText('项目名称'), '新项目');
    await user.click(dialog.getByRole('button', { name: '选择存储文件夹' }));
    expect(dialog.getByRole('button', { name: '创建项目' })).toBeDisabled();
    expect(initProject).not.toHaveBeenCalled();
  });

  it('preserves the creation form and project list when disk initialization fails', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('/chosen');
    vi.mocked(initProject).mockRejectedValueOnce(new Error('Permission denied'));
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }));
    await user.type(dialog.getByLabelText('项目名称'), '新项目');
    await user.click(dialog.getByRole('button', { name: '选择存储文件夹' }));
    await user.click(dialog.getByRole('button', { name: '创建项目' }));
    await expect(dialog.findByRole('alert')).resolves.toHaveTextContent('Permission denied');
    expect(dialog.getByLabelText('项目名称')).toHaveValue('新项目');
    expect(dialog.getByLabelText('存储文件夹')).toHaveValue('/chosen');
    expect(JSON.parse(localStorage.getItem('webgal-projects') ?? '[]')).toEqual(projects);
    expect(navigate).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('opens a project directly and updates its recent position', async () => {
    const user = userEvent.setup();
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '打开项目 下一站夏天' }));
    expect(navigate).toHaveBeenCalledWith('/editor/second');
    expect(localStorage.getItem('project-path-second')).toBe('/stories/summer');
    expect(JSON.parse(localStorage.getItem('webgal-projects')!)[0].id).toBe('second');
  });

  it('searches by path and clears unmatched results', async () => {
    const user = userEvent.setup();
    render(<ProjectHome />);
    await user.type(screen.getByRole('searchbox', { name: '搜索项目' }), '/stories/summer');
    expect(screen.getByRole('button', { name: '打开项目 下一站夏天' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开项目 雨后站台' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), '-missing');
    expect(screen.getByText('没有找到匹配的项目')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '清除搜索' })[0]);
    expect(screen.getByRole('button', { name: '打开项目 雨后站台' })).toBeInTheDocument();
  });

  it('keeps card actions separate from project opening and persists favorites', async () => {
    const user = userEvent.setup();
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '收藏 雨后站台' }));
    await user.click(screen.getByRole('button', { name: '收藏（2）' }));
    expect(screen.getByRole('button', { name: '打开项目 雨后站台' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消收藏 雨后站台' }));
    expect(screen.queryByRole('button', { name: '打开项目 雨后站台' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开项目 下一站夏天' })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('restores a recycled project from its card without opening it', async () => {
    const user = userEvent.setup();
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '回收站（1）' }));
    expect(screen.getByRole('button', { name: '打开项目 旧日来信' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '还原项目 旧日来信' }));
    expect(screen.getByText('回收站是空的')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '项目（3）' }));
    expect(screen.getByRole('button', { name: '打开项目 旧日来信' })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('edits project details from its card and supports Escape to dismiss creation', async () => {
    const user = userEvent.setup();
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: '编辑项目 雨后站台' }));
    const dialog = within(screen.getByRole('dialog', { name: '编辑项目信息' }));
    await user.clear(dialog.getByLabelText('项目名称'));
    await user.type(dialog.getByLabelText('项目名称'), '雨后重逢');
    await user.click(dialog.getByRole('button', { name: '保存修改' }));
    expect(screen.getByRole('button', { name: '打开项目 雨后重逢' })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^新建项目/ }));
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建项目' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a recoverable error if the native folder picker is unavailable', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockRejectedValueOnce(new Error('native dialog unavailable'));
    render(<ProjectHome />);
    await user.click(screen.getByRole('button', { name: /^打开已有项目/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('无法打开项目');
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
