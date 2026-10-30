export interface ModelConfig {
  model: string;
  models?: string[];
}

export function parseModelList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function getConfiguredModels(config: ModelConfig): string[] {
  return Array.from(
    new Set([
      ...(config.models ?? []).map((item) => item.trim()).filter(Boolean),
      ...parseModelList(config.model),
    ]),
  );
}

export function normalizeModelConfig<T extends ModelConfig>(
  config: T,
  defaultModel = '',
): T & { models: string[] } {
  const modelParts = parseModelList(config.model);
  const model = modelParts[0] || defaultModel;
  const models = getConfiguredModels(config);

  if (model && !models.includes(model)) models.unshift(model);

  return { ...config, model, models };
}
