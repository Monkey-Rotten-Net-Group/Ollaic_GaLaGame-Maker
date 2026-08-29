import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ai-ipc', () => ({
  aiChatTurn: vi.fn(),
  aiChatCancel: vi.fn(),
  appendAiAgentTrace: vi.fn(),
  getAiConfig: vi.fn(),
  getAiProviderCapability: vi.fn(),
}));

import { getAiProviderCapability } from '../lib/ai-ipc';
import { conversationModeForConfig } from './useAiAgent';

const customConfig = {
  provider: 'custom',
  model: 'model',
  api_key: '',
  base_url: 'https://example.test',
};

describe('provider capability routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [true, 'function_calling'],
    [false, 'legacy'],
  ] as const)('uses backend-declared chatTools=%s instead of provider name', async (chatTools, expected) => {
    vi.mocked(getAiProviderCapability).mockResolvedValue({ chatTools } as never);
    await expect(conversationModeForConfig(customConfig)).resolves.toBe(expected);
    expect(getAiProviderCapability).toHaveBeenCalledWith(customConfig);
  });
});
