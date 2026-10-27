import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettingsDialog } from './AppSettingsDialog';
import {
  getAiConfig,
  getAiImageConfig,
  getAiTtsConfig,
  getAiVideoConfig,
  listAiProviders,
  setAiConfig,
  setAiImageConfig,
  setAiTtsConfig,
  setAiVideoConfig,
  type AiConfig,
} from '../lib/ai-ipc';
import { getRuntimeInfo } from '../lib/webgal-ipc';

vi.mock('../lib/ai-ipc');
vi.mock('../lib/webgal-ipc');

const config: AiConfig = { provider: 'test', model: 'model-a', api_key: 'test-key', base_url: '' };
const option = {
  value: 'test',
  label: 'Test provider',
  defaultModel: 'model-a',
  models: ['model-a', 'model-b'],
  defaultBaseUrl: '',
  baseUrlPlaceholder: '',
  needsBaseUrl: false,
  requiresApiKey: true,
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(getRuntimeInfo).mockResolvedValue({
    installed: true,
    path: '/tmp/runtime',
    version: 'test',
  });
  vi.mocked(listAiProviders).mockResolvedValue({
    chat: [option],
    image: [option],
    tts: [option],
    video: [option],
  });
  for (const read of [getAiConfig, getAiImageConfig, getAiTtsConfig, getAiVideoConfig]) {
    vi.mocked(read).mockResolvedValue(config);
  }
  for (const write of [setAiConfig, setAiImageConfig, setAiTtsConfig, setAiVideoConfig]) {
    vi.mocked(write).mockResolvedValue(undefined);
  }
});
afterEach(cleanup);

describe('application settings configuration ownership', () => {
  it('ignores configuration reads from a previous opening', async () => {
    let resolveOlder: (value: AiConfig) => void = () => {};
    vi.mocked(getAiConfig).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlder = resolve;
      }),
    );
    const onClose = vi.fn();
    const view = render(<AppSettingsDialog open onClose={onClose} initialTab="ai" />);
    view.rerender(<AppSettingsDialog open={false} onClose={onClose} initialTab="ai" />);
    vi.mocked(getAiConfig).mockResolvedValue({ ...config, model: 'model-b' });
    view.rerender(<AppSettingsDialog open onClose={onClose} initialTab="ai" />);
    await waitFor(() => expect(screen.getByLabelText('选择模型')).toHaveValue('model-b'));
    await act(async () => {
      resolveOlder(config);
    });
    expect(screen.getByLabelText('选择模型')).toHaveValue('model-b');
  });

  it('saves only the AI category edited in this dialog', async () => {
    const user = userEvent.setup();
    render(<AppSettingsDialog open onClose={vi.fn()} initialTab="ai" />);
    await waitFor(() => expect(screen.getByPlaceholderText('sk-...')).toHaveValue('test-key'));
    await user.clear(screen.getByPlaceholderText('sk-...'));
    await user.type(screen.getByPlaceholderText('sk-...'), 'new-test-key');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(setAiConfig).toHaveBeenCalledWith({ ...config, api_key: 'new-test-key' });
    expect(setAiImageConfig).not.toHaveBeenCalled();
    expect(setAiTtsConfig).not.toHaveBeenCalled();
    expect(setAiVideoConfig).not.toHaveBeenCalled();
  });

  it('retains edited values after a failed save and notifies the parent only after success', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(setAiConfig).mockRejectedValueOnce(new Error('Test save failed'));
    render(<AppSettingsDialog open onClose={onClose} onSaved={onSaved} initialTab="ai" />);
    await waitFor(() => expect(screen.getByPlaceholderText('sk-...')).toHaveValue('test-key'));
    await user.clear(screen.getByPlaceholderText('sk-...'));
    await user.type(screen.getByPlaceholderText('sk-...'), 'new-test-key');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('Error: Test save failed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('sk-...')).toHaveValue('new-test-key');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
