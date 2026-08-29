import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsDialog } from './AiSettingsDialog';

vi.mock('../lib/ai-ipc', () => ({
  getAiConfig: vi.fn(),
  setAiConfig: vi.fn(async () => {}),
  getAiImageConfig: vi.fn(),
  setAiImageConfig: vi.fn(async () => {}),
  getAiTtsConfig: vi.fn(),
  setAiTtsConfig: vi.fn(async () => {}),
  getAiMusicConfig: vi.fn(),
  setAiMusicConfig: vi.fn(async () => {}),
  validateAiConfig: vi.fn(),
  listAiLogs: vi.fn(async () => []),
  clearAiLogs: vi.fn(async () => {}),
  getAiLogPath: vi.fn(async () => ''),
}));

import {
  getAiConfig,
  getAiImageConfig,
  getAiMusicConfig,
  getAiTtsConfig,
  setAiConfig,
  setAiImageConfig,
} from '../lib/ai-ipc';

const capabilities = {
  chat_tools: true,
  json_mode: true,
  streaming_cancellation: true,
  media_url_output: true,
  chat_deadline_ms: 120_000,
  flow_step_deadline_ms: 180_000,
  media_fetch_deadline_ms: 30_000,
};

const customConfig = {
  provider: 'custom',
  model: 'custom-model',
  api_key: '',
  base_url: 'https://example.test/v1',
  capabilities,
};

describe('AI settings capability deadlines', () => {
  beforeEach(() => {
    vi.mocked(getAiConfig).mockResolvedValue({ ...customConfig });
    vi.mocked(getAiImageConfig).mockResolvedValue({ ...customConfig });
    vi.mocked(getAiTtsConfig).mockResolvedValue({ ...customConfig });
    vi.mocked(getAiMusicConfig).mockResolvedValue({ ...customConfig });
    vi.mocked(setAiConfig).mockClear();
    vi.mocked(setAiImageConfig).mockClear();
  });

  it('saves chat and media deadline inputs as milliseconds', async () => {
    render(<AiSettingsDialog open onClose={() => {}} />);

    const chatDeadline = await screen.findByLabelText('聊天请求时限（秒）');
    fireEvent.change(chatDeadline, { target: { value: '45' } });

    fireEvent.click(screen.getByRole('button', { name: '图片' }));
    const mediaFlowDeadline = await screen.findByLabelText('Agent Flow 步骤时限（秒）');
    fireEvent.change(mediaFlowDeadline, { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }));

    await waitFor(() => expect(setAiConfig).toHaveBeenCalled());
    expect(vi.mocked(setAiConfig).mock.calls[0][0].capabilities?.chat_deadline_ms).toBe(45_000);
    expect(vi.mocked(setAiImageConfig).mock.calls[0][0].capabilities?.flow_step_deadline_ms).toBe(900_000);
  });
});
