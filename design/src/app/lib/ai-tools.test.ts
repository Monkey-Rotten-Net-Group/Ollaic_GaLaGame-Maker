import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getTool } from './ai-tools';

describe('plan_assets tool', () => {
  it('stages missing background/CG asset cards instead of script commands', async () => {
    const tool = getTool('plan_assets');
    expect(tool).toBeTruthy();

    const staged = await tool!.run({
      assets: [
        {
          category: 'background',
          title: '灰色房间信件',
          sceneFile: 'start.txt',
          targetStem: 'gray_room_letter',
          prompt: '灰色房间, 桌上一封信, 阴天冷光',
        },
      ],
    }, { projectPath: '/tmp/project', currentSceneName: 'start.txt' });

    expect(staged).toEqual({
      tool: 'plan_assets',
      assets: [
        {
          category: 'background',
          title: '灰色房间信件',
          sceneFile: 'start.txt',
          targetStem: 'gray_room_letter',
          prompt: '灰色房间, 桌上一封信, 阴天冷光',
        },
      ],
    });
  });

  it('rejects empty asset plans', async () => {
    const tool = getTool('plan_assets');
    await expect(tool!.run({ assets: [] }, { projectPath: '/tmp/project', currentSceneName: 'start.txt' }))
      .rejects
      .toThrow('plan_assets 需要非空 assets');
  });
});

describe('autonomous memory tools', () => {
  it('persists adds, updates and deletes directly instead of staging them', async () => {
    const ctx = { projectPath: '/tmp/project', currentSceneName: 'start.txt' };
    const stored = { worldSetting: '', writingStyle: '', userPreferences: '', updatedAt: '42', entries: [] };
    vi.mocked(invoke).mockResolvedValue(stored);
    expect(getTool('add_memory')?.kind).toBe('memory');
    expect(await getTool('add_memory')!.run({ category: 'plot', content: '主角转学' }, ctx)).toBe(stored);
    expect(invoke).toHaveBeenLastCalledWith('add_project_memory_entry', { projectPath: '/tmp/project', category: 'plot', content: '主角转学', source: 'agent' });
    await getTool('update_memory')!.run({ id: 'm1', expectedUpdatedAt: '41', content: '主角已经毕业' }, ctx);
    expect(invoke).toHaveBeenLastCalledWith('update_project_memory_entry', { projectPath: '/tmp/project', id: 'm1', patch: { content: '主角已经毕业' }, source: 'agent', expectedUpdatedAt: '41' });
    await getTool('delete_memory')!.run({ id: 'm1', expectedUpdatedAt: '42' }, ctx);
    expect(invoke).toHaveBeenLastCalledWith('delete_project_memory_entry', { projectPath: '/tmp/project', id: 'm1', expectedUpdatedAt: '42' });
    expect(getTool('edit_memory')).toBeUndefined();
  });

  it('validates categories and requires a revision before update or deletion', async () => {
    const ctx = { projectPath: '/tmp/project', currentSceneName: 'start.txt' };
    await expect(getTool('add_memory')!.run({ category: '__proto__', content: '内容' }, ctx)).rejects.toThrow('记忆分类无效');
    await expect(getTool('update_memory')!.run({ id: 'm1', content: '内容' }, ctx)).rejects.toThrow('expectedUpdatedAt');
    await expect(getTool('delete_memory')!.run({ id: 'm1' }, ctx)).rejects.toThrow('expectedUpdatedAt');
  });
});
