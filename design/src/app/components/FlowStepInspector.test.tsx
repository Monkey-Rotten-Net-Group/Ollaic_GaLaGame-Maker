import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FlowStepView } from '../lib/flow-state';
import { FlowStepInspector } from './FlowStepInspector';

const step: FlowStepView = {
  id: 'outline',
  kind: 'outline',
  agent: null,
  status: 'pending',
  dependsOn: ['plan'],
  attempt: 1,
  prompt: '生成故事大纲',
  output: '{"chapters":["第一章"]}',
  error: null,
  startedAt: 10,
  finishedAt: 30,
  history: [{
    attempt: 1,
    inputSnapshot: '{"brief":"校园恋爱"}',
    output: 'plain text fallback',
    startedAt: 10,
    finishedAt: 30,
    durationMs: 20,
    diff: 'synopsis updated',
    cost: 0.02,
    warnings: ['输出经过规范化'],
    downgrade: 'fallback-agent',
  }],
};

describe('FlowStepInspector', () => {
  it('renders nothing without a selected step', () => {
    const { container } = render(
      <FlowStepInspector selected={null} busy={false} detached={false} onClose={vi.fn()} onRetry={vi.fn()} onSkip={vi.fn()} onPromptRerun={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows step data, formatted output, history, and available actions', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    const onPromptRerun = vi.fn();
    render(
      <FlowStepInspector
        selected={step}
        busy={false}
        detached={false}
        onClose={vi.fn()}
        onRetry={onRetry}
        onSkip={onSkip}
        onPromptRerun={onPromptRerun}
        events={[{ event: { type: 'stepSucceeded', runId: 'run_1', stepId: 'outline', output: step.output }, receivedAt: 30 }]}
      />,
    );

    expect(screen.getByRole('complementary', { name: 'outline 步骤检查器' })).toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('outline 步骤 Prompt'));
    await user.type(screen.getByLabelText('outline 步骤 Prompt'), '改成三幕式大纲');
    await user.click(screen.getByRole('button', { name: '保存并重跑' }));
    expect(onPromptRerun).toHaveBeenCalledWith('outline', '改成三幕式大纲');
    await user.click(screen.getByRole('tab', { name: '输出' }));
    expect(screen.getByText(/"chapters": \[/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '记录' }));
    expect(screen.getByText('plain text fallback')).toBeInTheDocument();
    expect(screen.getByText('20 ms')).toBeInTheDocument();
    expect(screen.getByText('synopsis updated')).toBeInTheDocument();
    expect(screen.getByText('输出经过规范化')).toBeInTheDocument();
    expect(screen.getByText('fallback-agent')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '日志' }));
    expect(screen.getByText('执行完成')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '从此步重跑' }));
    await user.click(screen.getByRole('button', { name: '跳过' }));
    expect(onRetry).toHaveBeenCalledWith('outline');
    expect(onSkip).toHaveBeenCalledWith('outline');
  });

  it('hides retry while running and skip on a detached run', () => {
    const { rerender } = render(
      <FlowStepInspector selected={{ ...step, status: 'running' }} busy={false} detached={false} onClose={vi.fn()} onRetry={vi.fn()} onSkip={vi.fn()} onPromptRerun={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: '从此步重跑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '跳过' })).not.toBeInTheDocument();

    rerender(
      <FlowStepInspector selected={step} busy={false} detached onClose={vi.fn()} onRetry={vi.fn()} onSkip={vi.fn()} onPromptRerun={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '从此步重跑' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '跳过' })).not.toBeInTheDocument();
  });

  it('opens a completed business artifact in its editor', async () => {
    const user = userEvent.setup();
    const onOpenArtifact = vi.fn();
    const character = { ...step, id: 'character', kind: 'character', status: 'succeeded' as const };
    render(
      <FlowStepInspector
        selected={character}
        busy={false}
        detached={false}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
        onPromptRerun={vi.fn()}
        onOpenArtifact={onOpenArtifact}
      />,
    );
    await user.click(screen.getByRole('button', { name: '打开角色' }));
    expect(onOpenArtifact).toHaveBeenCalledWith(character);
  });

  it('shows asset queue task progress without replacing the step output', async () => {
    const user = userEvent.setup();
    let resolvePreview: (data: string) => void = () => {};
    const onPreviewAssetArtifact = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve; }));
    const onPromoteAssetArtifact = vi.fn(() => Promise.resolve());
    const onDeleteAssetArtifact = vi.fn(() => Promise.reject(new Error('artifact locked')));
    const assetStep = {
      ...step,
      id: 'media-production',
      kind: 'asset',
      agent: 'assetQueue',
      status: 'running' as const,
      output: '{"queued":2}',
    };
    render(
      <FlowStepInspector
        selected={assetStep}
        busy={false}
        detached={false}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
        onPromptRerun={vi.fn()}
        assetQueue={{
          runId: 'run_1',
          updatedAt: 30,
          tasks: [
            {
              id: 'bg-opening',
              kind: 'background',
              targetStem: 'bg_opening',
              prompt: '黄昏时的空教室',
              sceneRef: 'opening',
              status: 'succeeded',
              attempts: [{ attempt: 1, artifact: '.ollaic/artifacts/bg_opening.png' }],
              assetFile: 'bg_opening.png',
            },
            {
              id: 'voice-opening-1',
              kind: 'tts',
              targetStem: 'voice_opening_1',
              prompt: '平静但犹豫的语气',
              sceneRef: 'opening',
              characterRef: 'heroine',
              status: 'failed',
              attempts: [{ attempt: 1, error: 'provider timeout' }, { attempt: 2, error: 'provider timeout' }],
              error: 'provider timeout',
            },
          ],
        }}
        onPreviewAssetArtifact={onPreviewAssetArtifact}
        onPromoteAssetArtifact={onPromoteAssetArtifact}
        onDeleteAssetArtifact={onDeleteAssetArtifact}
      />,
    );

    await user.click(screen.getByRole('tab', { name: '输出' }));
    expect(screen.getByRole('list', { name: '资产任务列表' })).toBeInTheDocument();
    expect(screen.getByText('黄昏时的空教室')).toBeInTheDocument();
    expect(screen.getByText('重试 1')).toBeInTheDocument();
    expect(screen.getByText('正式素材 bg_opening.png')).toBeInTheDocument();
    expect(screen.getByText('provider timeout')).toBeInTheDocument();
    expect(screen.getByText(/"queued": 2/)).toBeInTheDocument();

    const preview = screen.getByRole('button', { name: '预览 bg_opening 候选 1' });
    const promote = screen.getByRole('button', { name: '提升 bg_opening 候选 1' });
    const remove = screen.getByRole('button', { name: '删除 bg_opening 候选 1' });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await user.click(preview);
    expect(promote).toBeDisabled();
    expect(remove).toBeDisabled();
    expect(onPreviewAssetArtifact).toHaveBeenCalledWith('bg-opening', 1);
    await act(async () => resolvePreview('data:image/png;base64,AAAA'));
    expect(await screen.findByRole('img', { name: 'bg_opening 候选 1' })).toHaveAttribute('src', 'data:image/png;base64,AAAA');

    await user.click(promote);
    expect(onPromoteAssetArtifact).toHaveBeenCalledWith('bg-opening', 1);
    await user.click(remove);
    expect(onDeleteAssetArtifact).toHaveBeenCalledWith('bg-opening', 1);
    expect(await screen.findByRole('alert')).toHaveTextContent('artifact locked');
  });

  it('binds imported audio to a manual audio task and separates pending reasons', async () => {
    const user = userEvent.setup();
    const onBindImportedAudio = vi.fn(() => Promise.reject(new Error('imported binding failed')));
    const assetStep = {
      ...step,
      id: 'media-production',
      kind: 'asset',
      agent: 'assetQueue',
      status: 'pending' as const,
    };
    render(
      <FlowStepInspector
        selected={assetStep}
        busy={false}
        detached={false}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
        onPromptRerun={vi.fn()}
        assetQueue={{
          runId: 'run_1',
          updatedAt: 30,
          tasks: [
            {
              id: 'bgm_theme',
              kind: 'bgm',
              targetStem: 'bgm_theme',
              prompt: '夜晚主题',
              sceneRef: 'start',
              status: 'pending',
              attempts: [],
              error: 'pending manual import: BGM/SFX 不支持 AI 生成',
            },
            {
              id: 'bg-opening',
              kind: 'background',
              targetStem: 'bg_opening',
              prompt: '黄昏',
              sceneRef: 'start',
              status: 'pending',
              attempts: [],
              error: 'pending configuration: image provider missing',
            },
          ],
        }}
        onBindImportedAudio={onBindImportedAudio}
        importedAudioByDir={{ bgm: ['bgm_theme.mp3'], vocal: [] }}
      />,
    );

    await user.click(screen.getByRole('tab', { name: '输出' }));
    expect(screen.getByText(/BGM\/音效不支持 AI 生成/)).toBeInTheDocument();
    expect(screen.getByText(/等待供应商配置/)).toBeInTheDocument();

    // SFX candidates live in the vocal directory, so bgm only offers bgm files.
    const bind = screen.getByRole('button', { name: '绑定 bgm_theme 已导入音频 bgm_theme.mp3' });
    await user.click(bind);
    expect(onBindImportedAudio).toHaveBeenCalledWith('bgm_theme', 'bgm_theme.mp3');
    expect(await screen.findByRole('alert')).toHaveTextContent('imported binding failed');
  });
});
