import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CHAT_CONFIG_CHANGED_EVENT,
  getAiConfig,
  listAiProviders,
  setAiConfig,
  type AiConfig,
} from '../lib/ai-ipc';
import { useChatModelSelection } from './useChatModelSelection';

vi.mock('../lib/ai-ipc');

const original: AiConfig = {
  provider: 'test',
  model: 'model-a',
  api_key: 'old-test-key',
  base_url: '',
};

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAiConfig).mockResolvedValue(original);
  vi.mocked(listAiProviders).mockResolvedValue({ chat: [], image: [], tts: [], video: [] });
  vi.mocked(setAiConfig).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('chat model selection', () => {
  it('ignores an older refresh and stops observing configuration saves after unmount', async () => {
    const older = deferred<AiConfig>();
    vi.mocked(getAiConfig).mockReturnValueOnce(older.promise);
    const { result, unmount } = renderHook(useChatModelSelection);
    const latest = { ...original, model: 'model-b', api_key: 'new-test-key' };
    vi.mocked(getAiConfig).mockResolvedValue(latest);
    await act(async () => {
      window.dispatchEvent(new Event(AI_CHAT_CONFIG_CHANGED_EVENT));
    });
    await waitFor(() => expect(result.current.config).toEqual(latest));
    await act(async () => {
      older.resolve(original);
    });
    expect(result.current.config).toEqual(latest);
    unmount();
    vi.mocked(getAiConfig).mockClear();
    window.dispatchEvent(new Event(AI_CHAT_CONFIG_CHANGED_EVENT));
    expect(getAiConfig).not.toHaveBeenCalled();
  });

  it('waits for persistence, preserves current credentials and blocks overlapping selections', async () => {
    const saved = deferred<void>();
    vi.mocked(setAiConfig).mockReturnValue(saved.promise);
    const { result } = renderHook(useChatModelSelection);
    await waitFor(() => expect(result.current.config).toEqual(original));
    const latest = { ...original, api_key: 'new-test-key', base_url: 'https://test.invalid/v1' };
    vi.mocked(getAiConfig).mockResolvedValue(latest);
    let switching: Promise<void> | undefined;
    act(() => {
      switching = result.current.switchModel('model-b');
    });
    await waitFor(() => expect(setAiConfig).toHaveBeenCalledWith({ ...latest, model: 'model-b' }));
    expect(result.current.config?.model).toBe('model-a');
    await act(async () => {
      await result.current.switchModel('model-c');
    });
    expect(setAiConfig).toHaveBeenCalledTimes(1);
    await act(async () => {
      saved.resolve();
      await switching;
    });
    expect(result.current.config?.model).toBe('model-b');
    expect(result.current.switching).toBe(false);
  });

  it('does not apply a stale menu selection to a different provider', async () => {
    const { result } = renderHook(useChatModelSelection);
    await waitFor(() => expect(result.current.config).toEqual(original));
    const latest = { ...original, provider: 'other', model: 'other-a' };
    vi.mocked(getAiConfig).mockResolvedValue(latest);
    await act(async () => {
      await result.current.switchModel('model-b');
    });
    expect(setAiConfig).not.toHaveBeenCalled();
    expect(result.current.config).toEqual(latest);
    expect(result.current.error).toContain('供应商配置已更新');
  });

  it('keeps a failed selection recoverable and allows retrying it', async () => {
    const { result } = renderHook(useChatModelSelection);
    await waitFor(() => expect(result.current.config).toEqual(original));
    vi.mocked(setAiConfig).mockRejectedValueOnce(new Error('Test write failed'));
    await act(async () => {
      await result.current.switchModel('model-b');
    });
    expect(result.current.config).toEqual(original);
    expect(result.current.error).toContain('切换模型失败');
    expect(result.current.switching).toBe(false);
    await act(async () => {
      await result.current.switchModel('model-b');
    });
    expect(result.current.config?.model).toBe('model-b');
    expect(result.current.error).toBeNull();
  });
});
