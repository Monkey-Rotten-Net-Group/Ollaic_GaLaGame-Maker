import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAiProviderProfiles, type AiConfig, type ProviderOption } from '../lib/ai-ipc';
import { useProviderProfiles } from './useProviderProfiles';

vi.mock('../lib/ai-ipc');

const option = (value: string, extra: Partial<ProviderOption> = {}): ProviderOption => ({
  value,
  label: value,
  defaultModel: `${value}-default`,
  models: [`${value}-default`],
  defaultBaseUrl: '',
  baseUrlPlaceholder: '',
  needsBaseUrl: false,
  requiresApiKey: true,
  ...extra,
});

const openai: AiConfig = {
  provider: 'openai',
  model: 'gpt-a',
  models: ['gpt-a', 'gpt-b'],
  api_key: 'openai-key',
  base_url: '',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listAiProviderProfiles).mockResolvedValue({
    chat: {
      anthropic: {
        model: 'claude-a',
        models: ['claude-a'],
        api_key: 'anthropic-key',
        base_url: 'https://proxy.test/v1',
      },
    },
    image: {},
    tts: {},
  });
});

async function loaded() {
  const { result } = renderHook(useProviderProfiles);
  await act(async () => {
    await result.current.reload();
  });
  return result;
}

describe('provider profiles', () => {
  it('never carries the previous key to a provider without a saved profile', async () => {
    const result = await loaded();
    const patch = result.current.switchProvider('chat', openai, option('deepseek'));
    expect(patch).toEqual({
      provider: 'deepseek',
      model: 'deepseek-default',
      models: ['deepseek-default'],
      api_key: '',
      base_url: '',
    });
  });

  it("restores a provider's saved key, base URL and model pool", async () => {
    const result = await loaded();
    const patch = result.current.switchProvider('chat', openai, option('anthropic'));
    expect(patch).toMatchObject({
      provider: 'anthropic',
      model: 'claude-a',
      models: ['claude-a'],
      api_key: 'anthropic-key',
      base_url: 'https://proxy.test/v1',
    });
  });

  it('keeps unsaved input when switching away and back', async () => {
    const result = await loaded();
    const away = result.current.switchProvider('chat', openai, option('deepseek'));
    const deepseek = { ...openai, ...away, api_key: 'typed-deepseek-key' };
    const back = result.current.switchProvider('chat', deepseek, option('openai'));
    expect(back).toMatchObject({ api_key: 'openai-key', models: ['gpt-a', 'gpt-b'] });
    const again = result.current.switchProvider('chat', { ...deepseek, ...back }, option('deepseek'));
    expect(again).toMatchObject({ api_key: 'typed-deepseek-key' });
  });

  it('keeps modalities apart and tolerates a failed load', async () => {
    vi.mocked(listAiProviderProfiles).mockRejectedValue(new Error('read failed'));
    const result = await loaded();
    const patch = result.current.switchProvider('image', openai, option('anthropic'));
    expect(patch.api_key).toBe('');
  });

  it('keeps the base URL only for a provider that has no built-in endpoint', async () => {
    const result = await loaded();
    const custom = { ...openai, base_url: 'https://gateway.test/v1' };
    const patch = result.current.switchProvider('chat', custom, option('custom', { needsBaseUrl: true }));
    expect(patch).toMatchObject({ api_key: '', base_url: 'https://gateway.test/v1' });
  });
});
