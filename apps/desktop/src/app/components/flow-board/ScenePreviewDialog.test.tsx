import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { StoryPlan } from '../../lib/pipeline-types';
import { ScenePreviewDialog } from './ScenePreviewDialog';

const sync = vi.fn();
vi.mock('../../hooks/useRuntimePreview', () => ({
  useRuntimePreview: () => ({ sync, ready: true }),
}));

const plan: StoryPlan = {
  version: 1,
  prompt: 'test',
  synopsis: '',
  memory: { worldbook: '', glossary: {} },
  chapters: [],
  characters: [],
  scenes: [],
  sceneDrafts: [],
  assetPlan: [],
  pipelineRuns: [],
  scenePlans: [
    {
      id: 'opening',
      file: 'start.txt',
      chapterId: 'c1',
      title: 'Opening',
      summary: '',
      characterIds: [],
    },
  ],
  branches: { entryScene: 'opening', edges: [] },
  variables: [{ id: 'trust', kind: 'integer', initialValue: '0', description: '' }],
};

it('preserves preview variable edits on plan refresh and resets without syncing old values', async () => {
  const user = userEvent.setup();
  const props = {
    open: true,
    onClose: vi.fn(),
    projectPath: '/tmp/preview',
    scene: plan.scenePlans[0],
    plan,
    sceneScript: ':Hello;',
  };
  const { rerender } = render(<ScenePreviewDialog {...props} />);
  const input = screen.getByLabelText('变量 trust');
  await user.clear(input);
  await user.type(input, '5');
  rerender(<ScenePreviewDialog {...props} plan={{ ...plan }} />);
  expect(input).toHaveValue(5);
  await user.click(screen.getByRole('button', { name: '恢复默认' }));
  expect(input).toHaveValue(0);
  expect(sync).not.toHaveBeenCalled();
});
