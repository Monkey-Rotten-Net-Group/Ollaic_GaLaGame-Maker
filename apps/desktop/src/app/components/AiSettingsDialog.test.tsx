import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AiSettingsDialog, ConfigFields } from './AiSettingsDialog';
import {
  listAiProviders,
  getAiConfig,
  setAiConfig,
  getAiImageConfig,
  setAiImageConfig,
  getAiTtsConfig,
  setAiTtsConfig,
  listAiLogs,
  getAiLogPath,
  listAiChatModels,
  listAiProviderProfiles,
} from '../lib/ai-ipc';

vi.mock('../lib/ai-ipc', () => ({
  listAiProviders: vi.fn(),
  getAiConfig: vi.fn(),
  setAiConfig: vi.fn(),
  getAiImageConfig: vi.fn(),
  setAiImageConfig: vi.fn(),
  getAiTtsConfig: vi.fn(),
  setAiTtsConfig: vi.fn(),
  validateAiConfig: vi.fn(),
  listAiChatModels: vi.fn(),
  listAiProviderProfiles: vi.fn().mockResolvedValue({ chat: {}, image: {}, tts: {} }),
  listAiLogs: vi.fn(),
  clearAiLogs: vi.fn(),
  getAiLogPath: vi.fn(),
}));

const mockCatalog = {
  chat: [
    {
      value: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini'],
      requiresApiKey: true,
      needsBaseUrl: false,
      defaultBaseUrl: '',
      baseUrlPlaceholder: '',
    },
  ],
  image: [
    {
      value: 'openai',
      label: 'OpenAI',
      defaultModel: 'dall-e-3',
      models: ['dall-e-3', 'dall-e-2'],
      requiresApiKey: true,
      needsBaseUrl: false,
    },
  ],
  tts: [
    {
      value: 'openai',
      label: 'OpenAI',
      defaultModel: 'tts-1',
      models: ['tts-1', 'tts-1-hd'],
      requiresApiKey: true,
      needsBaseUrl: false,
    },
  ],
};

const mockChatConfig = { provider: 'openai', model: 'gpt-4o', api_key: 'test-key', base_url: '' };
const mockImageConfig = {
  provider: 'openai',
  model: 'dall-e-3',
  api_key: 'test-key',
  base_url: '',
};
const mockTtsConfig = {
  provider: 'openai',
  model: 'tts-1,tts-1-hd',
  api_key: 'test-key',
  base_url: '',
};

describe('AiSettingsDialog', () => {
  it.each(['provider', 'base_url', 'api_key'] as const)(
    'invalidates cached models and late responses when %s changes',
    async (field) => {
      const user = userEvent.setup();
      const config = { ...mockChatConfig, base_url: 'https://a.invalid/v1' };
      let resolveOld!: (models: string[]) => void;
      const fetch = vi
        .fn<() => Promise<string[]>>()
        .mockResolvedValueOnce(['cached-model'])
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValueOnce(['current-model']);
      const props = {
        options: mockCatalog.chat,
        onUpdate: vi.fn(),
        onProviderChange: vi.fn(),
        onFetchModels: fetch,
      };
      const { rerender, unmount } = render(<ConfigFields {...props} config={config} />);
      await user.click(screen.getByRole('button', { name: '获取模型' }));
      expect(await screen.findByRole('button', { name: 'cached-model' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '获取模型' }));
      rerender(<ConfigFields {...props} config={{ ...config, [field]: 'changed' }} />);
      expect(screen.queryByRole('button', { name: 'cached-model' })).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '获取模型' }));
      expect(await screen.findByRole('button', { name: 'current-model' })).toBeInTheDocument();
      await act(async () => {
        resolveOld(['stale-model']);
      });
      expect(screen.queryByRole('button', { name: 'stale-model' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'current-model' })).toBeInTheDocument();
      rerender(<ConfigFields {...props} config={config} />);
      expect(screen.queryByRole('button', { name: 'cached-model' })).not.toBeInTheDocument();
      unmount();
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAiProviders).mockResolvedValue(mockCatalog as any);
    vi.mocked(getAiConfig).mockResolvedValue(mockChatConfig);
    vi.mocked(getAiImageConfig).mockResolvedValue(mockImageConfig);
    vi.mocked(getAiTtsConfig).mockResolvedValue(mockTtsConfig);
    vi.mocked(listAiLogs).mockResolvedValue([]);
    vi.mocked(getAiLogPath).mockResolvedValue('/tmp/ai.log');
    vi.mocked(listAiProviderProfiles).mockResolvedValue({ chat: {}, image: {}, tts: {} });
    vi.mocked(setAiConfig).mockResolvedValue();
    vi.mocked(setAiImageConfig).mockResolvedValue();
    vi.mocked(setAiTtsConfig).mockResolvedValue();
  });

  it('does not display a video tab', async () => {
    render(<AiSettingsDialog open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('AI 设置')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /视频/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /聊天/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /图片/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /音频/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /视频/ })).not.toBeInTheDocument();
  });

  it('clears credentials when a saved provider is no longer available', async () => {
    vi.mocked(getAiConfig).mockResolvedValue({
      provider: 'removed-provider',
      model: 'removed-model',
      api_key: 'removed-key',
      base_url: 'https://removed.invalid/v1',
    });

    render(<AiSettingsDialog open={true} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('AI 设置')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('sk-...')).toHaveValue('');
  });

  it('migrates TTS models into a pool and saves the selected model', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(<AiSettingsDialog open={true} onClose={onClose} onSaved={onSaved} />);

    await waitFor(() => {
      expect(screen.getByText('AI 设置')).toBeInTheDocument();
    });

    // Switch to TTS tab
    const ttsTab = screen.getByRole('button', { name: /音频/ });
    await user.click(ttsTab);

    const modelList = await screen.findByRole('group', { name: '模型列表' });
    expect(within(modelList).getByRole('button', { pressed: true })).toHaveTextContent('tts-1');
    await user.click(within(modelList).getByRole('button', { name: /^tts-1-hd$/ }));

    // Click Save
    const saveButton = screen.getByRole('button', { name: '保存 AI 配置' });
    await user.click(saveButton);

    await waitFor(() => {
      expect(setAiTtsConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          model: 'tts-1-hd',
          models: ['tts-1', 'tts-1-hd'],
        }),
      );
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('fetches chat models into the candidate list using the unsaved form values', async () => {
    const user = userEvent.setup();
    vi.mocked(listAiChatModels).mockResolvedValue(['gpt-live-a', 'gpt-4o']);
    render(<AiSettingsDialog open={true} onClose={vi.fn()} />);
    await screen.findByRole('group', { name: '模型列表' });

    await user.clear(screen.getByPlaceholderText('sk-...'));
    await user.type(screen.getByPlaceholderText('sk-...'), 'unsaved-key');
    await user.click(screen.getByRole('button', { name: '获取模型' }));

    expect(listAiChatModels).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', api_key: 'unsaved-key' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('已获取 2 个对话模型');
    const pool = screen.getByRole('group', { name: '模型列表' });
    // A fetched model is only a candidate until clicked; the pool is unchanged.
    expect(within(pool).queryByText('gpt-live-a')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'gpt-live-a' }));
    expect(
      within(pool).getByRole('button', { name: /gpt-live-a/, pressed: true }),
    ).toBeInTheDocument();
  });

  it("switches to each provider's own key instead of reusing the previous one", async () => {
    const user = userEvent.setup();
    vi.mocked(listAiProviders).mockResolvedValue({
      ...mockCatalog,
      chat: [
        ...mockCatalog.chat,
        {
          value: 'deepseek',
          label: 'DeepSeek',
          defaultModel: 'deepseek-flash',
          models: ['deepseek-flash'],
          requiresApiKey: true,
          needsBaseUrl: false,
        },
        {
          value: 'xai',
          label: 'xAI',
          defaultModel: 'grok-4.6',
          models: ['grok-4.6'],
          requiresApiKey: true,
          needsBaseUrl: false,
        },
      ],
    } as any);
    vi.mocked(listAiProviderProfiles).mockResolvedValue({
      chat: {
        xai: { model: 'grok-4.6', models: ['grok-4.6'], api_key: 'saved-xai-key', base_url: '' },
      },
      image: {},
      tts: {},
    });
    render(<AiSettingsDialog open={true} onClose={vi.fn()} />);
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await waitFor(() => expect(listAiProviderProfiles).toHaveBeenCalled());
    const providerSelect = screen.getByLabelText('选择 AI 供应商');

    await user.selectOptions(providerSelect, 'deepseek');
    expect(keyInput).toHaveValue('');
    await user.type(keyInput, 'typed-deepseek-key');

    await user.selectOptions(providerSelect, 'xai');
    expect(keyInput).toHaveValue('saved-xai-key');

    await user.selectOptions(providerSelect, 'openai');
    expect(keyInput).toHaveValue('test-key');

    await user.selectOptions(providerSelect, 'deepseek');
    expect(keyInput).toHaveValue('typed-deepseek-key');
  });

  it('shows fetch errors and only offers fetching on the chat tab', async () => {
    const user = userEvent.setup();
    vi.mocked(listAiChatModels).mockRejectedValue('HTTP 401 Unauthorized');
    render(<AiSettingsDialog open={true} onClose={vi.fn()} />);
    await screen.findByRole('group', { name: '模型列表' });

    await user.click(screen.getByRole('button', { name: '获取模型' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 401');

    await user.click(screen.getByRole('button', { name: /图片/ }));
    await screen.findByRole('group', { name: '模型列表' });
    expect(screen.queryByRole('button', { name: '获取模型' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /音频/ }));
    await screen.findByRole('group', { name: '模型列表' });
    expect(screen.queryByRole('button', { name: '获取模型' })).not.toBeInTheDocument();
  });
});
