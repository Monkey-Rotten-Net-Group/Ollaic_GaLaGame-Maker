import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeInfo, getRuntimeUrl, setRuntimeProject } from '../lib/webgal-ipc';
import { useRuntimePreview } from './useRuntimePreview';

vi.mock('../lib/webgal-ipc', () => ({
  DebugCommand: { JUMP: 0, SYNCFC: 1, REFETCH_TEMPLATE_FILES: 4, TEMP_SCENE: 6 },
  getRuntimeInfo: vi.fn(), getRuntimeUrl: vi.fn(), setRuntimeProject: vi.fn(),
}));

class PreviewSocket {
  static OPEN = 1;
  static instances: PreviewSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: URL) { PreviewSocket.instances.push(this); }
  heartbeat() { this.onmessage?.({ data: JSON.stringify({ data: { command: 1 } }) }); }
}

describe('live runtime preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PreviewSocket.instances = [];
    vi.stubGlobal('WebSocket', PreviewSocket);
    vi.mocked(setRuntimeProject).mockResolvedValue();
    vi.mocked(getRuntimeInfo).mockResolvedValue({ installed: true, path: '/runtime', version: 'test' });
    vi.mocked(getRuntimeUrl).mockResolvedValue('http://127.0.0.1:9000/');
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('waits for the engine heartbeat, then previews the latest unsaved draft in memory', async () => {
    const { result, rerender } = renderHook(({ source }) => useRuntimePreview('/project', source, true), { initialProps: { source: '旧草稿;' } });
    await waitFor(() => expect(PreviewSocket.instances).toHaveLength(1));
    const socket = PreviewSocket.instances[0];
    act(() => socket.onopen?.());
    expect(result.current.url).toBe('http://127.0.0.1:9000/?ollaicPreview=1');
    act(() => socket.heartbeat());
    expect(result.current.ready).toBe(false);
    act(() => result.current.onFrameLoad());
    rerender({ source: '林夏:当前草稿;' });
    expect(socket.send).not.toHaveBeenCalled();
    vi.useFakeTimers();
    act(() => socket.heartbeat());
    act(() => vi.advanceTimersByTime(450));
    expect(JSON.parse(socket.send.mock.calls[0][0]).data.command).toBe(4);
    expect(JSON.parse(socket.send.mock.calls[1][0]).data).toMatchObject({ command: 6, message: '林夏:当前草稿;' });
    act(() => socket.heartbeat());
    act(() => vi.advanceTimersByTime(1000));
    expect(socket.send).toHaveBeenCalledTimes(2);
  });

  it('queues sentence jumps until the engine is ready instead of losing the first click', async () => {
    const { result } = renderHook(() => useRuntimePreview('/project', '场景;', true));
    await waitFor(() => expect(PreviewSocket.instances).toHaveLength(1));
    act(() => result.current.jump('chapter2.txt', 5));
    act(() => result.current.onFrameLoad());
    const socket = PreviewSocket.instances[0];
    vi.useFakeTimers();
    act(() => socket.heartbeat());
    act(() => vi.advanceTimersByTime(450));
    expect(JSON.parse(socket.send.mock.calls[1][0]).data).toMatchObject({ command: 0, sceneMsg: { scene: 'chapter2.txt', sentence: 5 } });
  });

  it('discards stale initialization when the project changes and closes the previous socket', async () => {
    let resolveOld!: () => void;
    vi.mocked(setRuntimeProject).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOld = resolve; }));
    const { rerender, unmount } = renderHook(({ project }) => useRuntimePreview(project, '场景;', true), { initialProps: { project: '/old' } });
    rerender({ project: '/new' });
    await waitFor(() => expect(PreviewSocket.instances).toHaveLength(1));
    await act(async () => resolveOld());
    expect(PreviewSocket.instances).toHaveLength(1);
    unmount();
    expect(PreviewSocket.instances[0].close).toHaveBeenCalledOnce();
  });

  it('wraps the preview script with simulated entry variables when provided', async () => {
    const { result } = renderHook(() =>
      useRuntimePreview('/project', '林夏:重要决断。;', true, {
        entryVariables: { linxia_trust: '3' },
      }),
    );
    await waitFor(() => expect(PreviewSocket.instances).toHaveLength(1));
    const socket = PreviewSocket.instances[0];
    act(() => socket.onopen?.());
    act(() => result.current.onFrameLoad());
    vi.useFakeTimers();
    act(() => socket.heartbeat());
    act(() => vi.advanceTimersByTime(450));
    const lastCall = JSON.parse(socket.send.mock.calls[socket.send.mock.calls.length - 1][0]);
    expect(lastCall.data.command).toBe(6);
    expect(lastCall.data.message).toContain('setVar:linxia_trust=3;');
    expect(lastCall.data.message).toContain('林夏:重要决断。;');
  });
});
