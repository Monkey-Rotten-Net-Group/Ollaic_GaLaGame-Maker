import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getTool } from './ai-tools';
import { isSessionDigest } from '../hooks/useChatSession';

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

describe('list_scenes and read_scene tools', () => {
  it('orders scenes from start.txt along outgoing transitions and infers titles when headers are absent', async () => {
    const scripts: Record<string, string> = {
      '/tmp/project/game/scene/afterbell.txt':
        '; Ollaic Agent scene: 陌生名字\nintro:陌生名字;\n:结局;\nend;',
      '/tmp/project/game/scene/archive.txt':
        'intro:誓约留下的缺口;\nchoose:查遗址:traces.txt|见议事会:council.txt;',
      '/tmp/project/game/scene/council.txt': ':议事会;\nchangeScene:afterbell.txt;',
      '/tmp/project/game/scene/start.txt': 'intro:山路尽头的钟声;\nchangeScene:archive.txt;',
      '/tmp/project/game/scene/traces.txt': 'intro:旧事故的回声;\nchangeScene:council.txt;',
    };
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === 'list_scenes') {
        return ['afterbell.txt', 'archive.txt', 'council.txt', 'start.txt', 'traces.txt'];
      }
      if (cmd === 'get_scene_path') {
        return `/tmp/project/game/scene/${args.sceneName}`;
      }
      if (cmd === 'read_file_text') {
        return scripts[args.path] ?? '';
      }
      return undefined;
    });

    const result = (await getTool('list_scenes')!.run(
      {},
      { projectPath: '/tmp/project', currentSceneName: 'start.txt' },
    )) as {
      currentScene: string;
      scenes: Array<{
        file: string;
        chapter: string;
        totalLines: number;
        nextScenes: string[];
        current?: boolean;
      }>;
    };

    expect(result.currentScene).toBe('start.txt');
    expect(result.scenes.map((scene) => scene.file)).toEqual([
      'start.txt',
      'archive.txt',
      'traces.txt',
      'council.txt',
      'afterbell.txt',
    ]);
    expect(result.scenes[0]).toMatchObject({
      file: 'start.txt',
      chapter: '山路尽头的钟声',
      nextScenes: ['archive.txt'],
      current: true,
    });
    expect(result.scenes[1]).toMatchObject({
      file: 'archive.txt',
      chapter: '誓约留下的缺口',
      nextScenes: ['traces.txt', 'council.txt'],
    });
    expect(result.scenes[4]).toMatchObject({
      file: 'afterbell.txt',
      chapter: '陌生名字',
      nextScenes: [],
    });
  });

  it('short-circuits redundant full reads of the active scene already injected in system context', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === 'get_scene_path') return `/tmp/project/game/scene/${args.sceneName}`;
      if (cmd === 'read_file_text') return 'intro:山路尽头的钟声;\n:第二行;';
      return undefined;
    });

    const currentRead = (await getTool('read_scene')!.run(
      { name: 'start.txt', maxLines: 400 },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt' },
    )) as Record<string, unknown>;
    expect(currentRead).toMatchObject({
      name: 'start.txt',
      alreadyInSystemContext: true,
      totalLines: 2,
      truncated: false,
    });
    expect(currentRead.text).toBeUndefined();

    const otherRead = (await getTool('read_scene')!.run(
      { name: 'archive.txt', maxLines: 400 },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt' },
    )) as Record<string, unknown>;
    expect(otherRead).toMatchObject({
      name: 'archive.txt',
      totalLines: 2,
      truncated: false,
      text: '1: intro:山路尽头的钟声;\n2: :第二行;',
    });
  });

  it('returns staged scene contents instead of short-circuiting or reading stale disk files', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === 'list_scenes') return ['start.txt'];
      if (cmd === 'get_scene_path') return `/tmp/project/game/scene/${args.sceneName}`;
      if (cmd === 'read_file_text') {
        if (args.path.endsWith('start.txt')) return 'intro:旧内容;';
        throw new Error('File not found');
      }
      return undefined;
    });

    const stagedSceneContents = new Map<string, string>([
      ['start.txt', 'intro:新章节;\n:已暂存的第二行;\nchangeScene:branch.txt;'],
      ['branch.txt', 'intro:新分支;\n:分支正文;\nend;'],
    ]);

    const readEditedCurrent = (await getTool('read_scene')!.run(
      { name: 'start.txt', maxLines: 100 },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', stagedSceneContents },
    )) as Record<string, unknown>;
    expect(readEditedCurrent.alreadyInSystemContext).toBeUndefined();
    expect(readEditedCurrent.text).toBe(
      '1: intro:新章节;\n2: :已暂存的第二行;\n3: changeScene:branch.txt;',
    );

    const readNewBranch = (await getTool('read_scene')!.run(
      { name: 'branch.txt', maxLines: 100 },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', stagedSceneContents },
    )) as Record<string, unknown>;
    expect(readNewBranch.text).toBe('1: intro:新分支;\n2: :分支正文;\n3: end;');

    const listed = (await getTool('list_scenes')!.run(
      {},
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', stagedSceneContents },
    )) as { scenes: Array<{ file: string; chapter: string; nextScenes: string[] }> };
    expect(listed.scenes.map((scene) => scene.file)).toEqual(['start.txt', 'branch.txt']);
    expect(listed.scenes[1]).toMatchObject({
      file: 'branch.txt',
      chapter: '新分支',
      nextScenes: [],
    });
  });
});

describe('isSessionDigest', () => {
  it('accepts valid string-array digests and rejects malformed array elements', () => {
    const valid = {
      version: 1,
      goal: '扩写雾钟镇开篇',
      decisions: ['保留沙耶视角'],
      completed: ['edit_scene: 完成'],
      openQuestions: [],
      nextStep: '继续写集市调查',
      sourceMessageIds: ['m1', 'm2'],
      updatedAt: '2026-10-31T09:00:00.000Z',
    };
    expect(isSessionDigest(valid)).toBe(true);
    expect(isSessionDigest({ ...valid, decisions: [{ text: 'bad' }] })).toBe(false);
    expect(isSessionDigest(null)).toBe(false);
  });
});
