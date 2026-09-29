import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AiSettingsDialog } from './AiSettingsDialog';
import {
  listAiProviders,
  getAiConfig,
  setAiConfig,
  getAiImageConfig,
  setAiImageConfig,
  getAiTtsConfig,
  setAiTtsConfig,
  getAiVideoConfig,
  setAiVideoConfig,
  listAiLogs,
  getAiLogPath,
} from '../lib/ai-ipc';

vi.mock('../lib/ai-ipc', () => ({
  listAiProviders: vi.fn(),
  getAiConfig: vi.fn(),
  setAiConfig: vi.fn(),
  getAiImageConfig: vi.fn(),
  setAiImageConfig: vi.fn(),
  getAiTtsConfig: vi.fn(),
  setAiTtsConfig: vi.fn(),
  getAiVideoConfig: vi.fn(),
  setAiVideoConfig: vi.fn(),
  validateAiConfig: vi.fn(),
  listAiLogs: vi.fn(),
  clearAiLogs: vi.fn(),
  getAiLogPath: vi.fn(),
}));

const mockCatalog = {
  chat: [
    { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'], requiresApiKey: true, needsBaseUrl: false },
  ],
  image: [
    { value: 'openai', label: 'OpenAI', defaultModel: 'dall-e-3', models: ['dall-e-3', 'dall-e-2'], requiresApiKey: true, needsBaseUrl: false },
  ],
  tts: [
    { value: 'openai', label: 'OpenAI', defaultModel: 'tts-1', models: ['tts-1', 'tts-1-hd'], requiresApiKey: true, needsBaseUrl: false },
  ],
  video: [
    { value: 'minimax', label: 'MiniMax', defaultModel: 'video-01', models: ['video-01'], requiresApiKey: true, needsBaseUrl: false },
  ],
};

const mockChatConfig = { provider: 'openai', model: 'gpt-4o', api_key: 'test-key', base_url: '' };
const mockImageConfig = { provider: 'openai', model: 'dall-e-3', api_key: 'test-key', base_url: '' };
const mockTtsConfig = { provider: 'openai', model: 'tts-1,tts-1-hd', api_key: 'test-key', base_url: '' };
const mockVideoConfig = { provider: 'minimax', model: 'video-01', api_key: 'test-key', base_url: '' };

describe('AiSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAiProviders).mockResolvedValue(mockCatalog as any);
    vi.mocked(getAiConfig).mockResolvedValue(mockChatConfig);
    vi.mocked(getAiImageConfig).mockResolvedValue(mockImageConfig);
    vi.mocked(getAiTtsConfig).mockResolvedValue(mockTtsConfig);
    vi.mocked(getAiVideoConfig).mockResolvedValue(mockVideoConfig);
    vi.mocked(listAiLogs).mockResolvedValue([]);
    vi.mocked(getAiLogPath).mockResolvedValue('/tmp/ai.log');
    vi.mocked(setAiConfig).mockResolvedValue();
    vi.mocked(setAiImageConfig).mockResolvedValue();
    vi.mocked(setAiTtsConfig).mockResolvedValue();
    vi.mocked(setAiVideoConfig).mockResolvedValue();
  });

  it('does not display a music tab', async () => {
    render(<AiSettingsDialog open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('AI 设置')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /音乐/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /聊天/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /图片/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /音频/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /视频/ })).toBeInTheDocument();
  });

  it('restricts TTS to single model and normalizes comma-separated list on save', async () => {
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

    // Should NOT have "填入相关模型" button in TTS tab (since it's singleModel)
    expect(screen.queryByRole('button', { name: '填入相关模型' })).not.toBeInTheDocument();

    // The model select dropdown should be rendered and normalized to "tts-1"
    const modelSelect = screen.getByLabelText('选择模型');
    expect(modelSelect).toHaveValue('tts-1');

    // Click Save
    const saveButton = screen.getByRole('button', { name: '保存 AI 配置' });
    await user.click(saveButton);

    await waitFor(() => {
      expect(setAiTtsConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          model: 'tts-1',
        }),
      );
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });
});
