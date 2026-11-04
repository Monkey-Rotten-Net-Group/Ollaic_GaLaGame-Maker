import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettingsDialog } from './AppSettingsDialog';
import {
  getAiConfig,
  getAiImageConfig,
  getAiTtsConfig,
  listAiProviders,
  setAiConfig,
  setAiImageConfig,
  setAiTtsConfig,
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
  });
  for (const read of [getAiConfig, getAiImageConfig, getAiTtsConfig]) {
    vi.mocked(read).mockResolvedValue(config);
  }
  for (const write of [setAiConfig, setAiImageConfig, setAiTtsConfig]) {
    vi.mocked(write).mockResolvedValue(undefined);
  }
});
afterEach(cleanup);

describe('application settings configuration ownership', () => {
  it('does not show the obsolete AI shortcut inside general project settings', async () => {
    render(<AppSettingsDialog open onClose={vi.fn()} initialTab="general" />);

    await waitFor(() => expect(screen.getByText('WebGAL 运行时引擎')).toBeInTheDocument());
    expect(screen.queryByText('需要配置大模型或 API Key？')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /配置 AI 服务与模型/ }),
    ).not.toBeInTheDocument();
  });

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
    const modelList = await screen.findByRole('group', { name: '模型列表' });
    await waitFor(() => {
      expect(within(modelList).getByRole('button', { pressed: true })).toHaveTextContent('model-b');
    });
    await act(async () => {
      resolveOlder(config);
    });
    expect(within(modelList).getByRole('button', { pressed: true })).toHaveTextContent('model-b');
  });

  it('saves only the AI category edited in this dialog', async () => {
    const user = userEvent.setup();
    render(<AppSettingsDialog open onClose={vi.fn()} initialTab="ai" />);
    await waitFor(() => expect(screen.getByPlaceholderText('sk-...')).toHaveValue('test-key'));
    await user.clear(screen.getByPlaceholderText('sk-...'));
    await user.type(screen.getByPlaceholderText('sk-...'), 'new-test-key');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(setAiConfig).toHaveBeenCalledWith({
      ...config,
      models: ['model-a'],
      api_key: 'new-test-key',
    });
    expect(setAiImageConfig).not.toHaveBeenCalled();
    expect(setAiTtsConfig).not.toHaveBeenCalled();
  });

  it('adds a model to the pool and switches the active model', async () => {
    const user = userEvent.setup();
    render(<AppSettingsDialog open onClose={vi.fn()} initialTab="ai" />);

    await waitFor(() => expect(screen.getByPlaceholderText('sk-...')).toHaveValue('test-key'));
    await user.type(screen.getByLabelText('输入模型名称'), 'model-c');
    await user.click(screen.getByRole('button', { name: /^添加$/ }));

    const modelList = screen.getByRole('group', { name: '模型列表' });
    expect(within(modelList).getByRole('button', { pressed: true })).toHaveTextContent('model-c');
    expect(
      within(modelList).getByRole('button', { name: /^model-a$/, pressed: false }),
    ).toBeInTheDocument();

    await user.click(within(modelList).getByRole('button', { name: /^model-a$/, pressed: false }));
    expect(within(modelList).getByRole('button', { pressed: true })).toHaveTextContent('model-a');
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
