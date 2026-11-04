import { describe, expect, it } from 'vitest';
import { getConfiguredModels, normalizeModelConfig, parseModelList } from './ai-models';

describe('AI model pools', () => {
  it('parses and deduplicates legacy comma-separated model lists', () => {
    expect(parseModelList('model-a, model-b，model-a\nmodel-c')).toEqual([
      'model-a',
      'model-b',
      'model-c',
    ]);
  });

  it('migrates a legacy model pool while selecting its first model', () => {
    expect(normalizeModelConfig({ model: 'model-a, model-b' })).toEqual({
      model: 'model-a',
      models: ['model-a', 'model-b'],
    });
  });

  it('preserves the active model alongside its saved model pool', () => {
    const config = normalizeModelConfig({ model: 'model-b', models: ['model-a', 'model-b'] });

    expect(config.model).toBe('model-b');
    expect(getConfiguredModels(config)).toEqual(['model-a', 'model-b']);
  });

  it('uses the provider model when an older config has no model value', () => {
    expect(normalizeModelConfig({ model: '' }, 'provider-default')).toEqual({
      model: 'provider-default',
      models: ['provider-default'],
    });
  });
});
