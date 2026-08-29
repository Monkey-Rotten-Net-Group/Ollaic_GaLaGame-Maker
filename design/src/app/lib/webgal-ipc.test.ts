import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteScene,
  listScenes,
  loadScene,
  readFileText,
  renameScene,
  saveScene,
  writeFileText,
} from './webgal-ipc';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe('project-scoped Scene IPC', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('sends project identity and Scene identifiers instead of raw paths', async () => {
    const projectPath = '/projects/story';
    await loadScene(projectPath, 'start.txt');
    await saveScene(projectPath, 'start.txt', []);
    await listScenes(projectPath);
    await readFileText(projectPath, 'start.txt');
    await writeFileText(projectPath, 'start.txt', 'Alice:Hello;');
    await deleteScene(projectPath, 'old.txt');
    await renameScene(projectPath, 'old.txt', 'new.txt');

    expect(invokeMock.mock.calls).toEqual([
      ['load_scene', { projectPath, sceneName: 'start.txt' }],
      ['save_scene', { projectPath, sceneName: 'start.txt', nodes: [] }],
      ['list_scenes', { projectPath }],
      ['read_file_text', { projectPath, sceneName: 'start.txt' }],
      ['write_file_text', { projectPath, sceneName: 'start.txt', content: 'Alice:Hello;' }],
      ['delete_scene', { projectPath, sceneName: 'old.txt' }],
      ['rename_scene', { projectPath, sceneName: 'old.txt', newName: 'new.txt' }],
    ]);
  });
});
