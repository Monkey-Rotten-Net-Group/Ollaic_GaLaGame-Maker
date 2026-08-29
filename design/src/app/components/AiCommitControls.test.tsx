import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingChangeSet } from '../lib/change-set';
import { ChangeSetCard } from './AiPendingCard';
import { ConflictCard } from './AiStatusCard';
import { AiAssistantPanel } from './story-editor/AiAssistantPanel';

const changeSet: PendingChangeSet = {
  id: 'change-1',
  createdAt: '2026-08-29T00:00:00.000Z',
  sourceMessageId: 'message-1',
  status: 'pending',
  edits: [{ kind: 'create_scene', file: 'chapter_02.txt' }],
};

afterEach(cleanup);

describe('AI change commit controls', () => {
  it('disables all competing decisions while a normal acceptance is committing', () => {
    render(
      <ChangeSetCard
        changeSet={changeSet}
        committing
        onAccept={vi.fn()}
        onRevert={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '提交中...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled();
  });

  it('disables all conflict decisions while force apply is committing', () => {
    render(
      <ConflictCard
        committing
        onKeepManual={vi.fn()}
        onApplyAi={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '丢弃 AI 方案，保留手动修改' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '提交中...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新生成（基于你的最新内容）' })).toBeDisabled();
  });

  it('renders missing asset recovery in the assistant panel and wires its actions', () => {
    const useFallbackAssets = vi.fn();
    const openAssets = vi.fn();
    const retryWithExistingAssets = vi.fn();
    const noop = vi.fn();
    const noopAsync = vi.fn(async () => {});
    const aiAgent = {
      sessions: [],
      activeId: '',
      messages: [],
      busy: false,
      committing: false,
      status: 'missing_assets',
      stepLabel: '',
      pendingChangeSet: null,
      error: null,
      cooldown: 0,
      missingIssues: [{ command: 'changeBg', file: 'missing-room.png', expectedCategory: 'background' }],
      streamingIdRef: { current: null },
      input: '',
      memory: null,
      uploads: [],
      attachedIds: [],
      uploadBusy: false,
      uploadError: null,
      startNewSession: noop,
      selectSession: noop,
      removeSession: noop,
      renameSession: noop,
      acceptChange: noopAsync,
      revertChange: noop,
      forceApplyChange: noopAsync,
      regenerateAfterConflict: noop,
      retry: noop,
      stop: noop,
      saveMemory: noopAsync,
      addUploads: noopAsync,
      attachUpload: noop,
      detachUpload: noop,
      removeUpload: noopAsync,
      previewUpload: vi.fn(async () => null),
      clearUploadError: noop,
      useFallbackAssets,
      openAssets,
      retryWithExistingAssets,
    } as never;

    render(
      <AiAssistantPanel
        aiAgent={aiAgent}
        projectPath="/tmp/project"
        sceneHeaders={{}}
        onOpenSettings={noop}
        onSend={noop}
      />,
    );

    expect(screen.getByText('发现缺失素材')).toBeInTheDocument();
    expect(screen.getByText(/missing-room\.png/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暂用默认素材继续' }));
    fireEvent.click(screen.getByRole('button', { name: '去素材库补充' }));
    fireEvent.click(screen.getByRole('button', { name: '重新描述需求' }));
    expect(useFallbackAssets).toHaveBeenCalledTimes(1);
    expect(openAssets).toHaveBeenCalledTimes(1);
    expect(retryWithExistingAssets).toHaveBeenCalledTimes(1);
  });
});
