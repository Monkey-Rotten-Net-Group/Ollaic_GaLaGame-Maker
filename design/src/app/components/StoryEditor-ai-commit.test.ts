import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorCommitCoordinator } from './story-editor/editor-commit-coordinator';

describe('StoryEditor AI commit coordination', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks autosave for an affected scene only while its commit is in flight', () => {
    vi.useFakeTimers();
    const coordinator = createEditorCommitCoordinator();
    const save = vi.fn();
    let currentScene = 'start.txt';
    setInterval(() => {
      if (coordinator.canSave(currentScene)) save(currentScene);
    }, 100);

    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenLastCalledWith('start.txt');

    coordinator.beginCommit(['start.txt']);
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledTimes(1);

    coordinator.settleCommit();
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(2);

    coordinator.beginCommit(['chapter-2.txt']);
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(3);

    currentScene = 'chapter-2.txt';
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('keeps non-current cached user drafts reachable across commit settlement', () => {
    const coordinator = createEditorCommitCoordinator();
    const draft = [{ id: 'draft-node' }];
    coordinator.cacheDraft('chapter-2.txt', draft);

    coordinator.beginCommit(['chapter-2.txt']);
    coordinator.settleCommit();

    expect(coordinator.getDraft('chapter-2.txt')).toBe(draft);
  });

  it('waits for an already-running save while blocking later saves', async () => {
    const coordinator = createEditorCommitCoordinator();
    const finishSave = coordinator.startSave('start.txt');
    expect(finishSave).not.toBeNull();
    let commitReady = false;

    const begin = coordinator.beginCommit(['start.txt']).then(() => {
      commitReady = true;
    });
    await Promise.resolve();

    expect(commitReady).toBe(false);
    expect(coordinator.startSave('start.txt')).toBeNull();

    finishSave?.();
    await begin;
    expect(commitReady).toBe(true);
  });
});
