import { describe, expect, it } from 'vitest';
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
