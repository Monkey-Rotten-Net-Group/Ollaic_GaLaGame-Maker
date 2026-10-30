import { useCallback, useRef } from 'react';
import {
  listAiProviderProfiles,
  type AiConfig,
  type ProviderOption,
  type ProviderProfile,
  type ProviderProfiles,
} from '../lib/ai-ipc';
import { normalizeModelConfig } from '../lib/ai-models';

export type ProfileKind = keyof ProviderProfiles;

const emptyProfiles = (): ProviderProfiles => ({ chat: {}, image: {}, tts: {} });
const profileKey = (provider: string) => provider.trim().toLowerCase();

/**
 * Remembers each provider's own Key, Base URL and model pool, so switching
 * provider in the settings restores that provider's values instead of
 * carrying the previous provider's Key over to a different service.
 *
 * Saved profiles come from the backend; values typed for another provider in
 * this dialog session are kept as drafts and win over the saved ones, so
 * switching away and back does not discard unsaved input.
 */
export function useProviderProfiles() {
  const saved = useRef<ProviderProfiles>(emptyProfiles());
  const drafts = useRef<ProviderProfiles>(emptyProfiles());

  const reload = useCallback(async () => {
    saved.current = emptyProfiles();
    drafts.current = emptyProfiles();
    try {
      const loaded = await listAiProviderProfiles();
      saved.current = {
        chat: loaded?.chat ?? {},
        image: loaded?.image ?? {},
        tts: loaded?.tts ?? {},
      };
    } catch {
      // Nothing remembered: switching falls back to a blank Key, which is
      // still safer than reusing the previous provider's.
    }
  }, []);

  const switchProvider = useCallback(
    (kind: ProfileKind, current: AiConfig, option: ProviderOption): Partial<AiConfig> => {
      drafts.current[kind][profileKey(current.provider)] = {
        model: current.model,
        models: current.models ?? [],
        api_key: current.api_key,
        base_url: current.base_url,
      };
      const key = profileKey(option.value);
      const remembered: ProviderProfile | undefined =
        drafts.current[kind][key] ?? saved.current[kind][key];
      if (remembered) {
        const { provider: _provider, ...restored } = normalizeModelConfig(
          {
            provider: option.value,
            model: remembered.model,
            models: remembered.models,
            api_key: remembered.api_key,
            base_url: remembered.base_url,
          },
          option.defaultModel,
        );
        return { provider: option.value, ...restored };
      }
      return {
        provider: option.value,
        model: option.defaultModel,
        models: [option.defaultModel],
        api_key: '',
        // A Base URL typed for the previous provider almost never applies to
        // the new one, so keep it only where the new provider has no built-in
        // endpoint and the user would otherwise have to retype it.
        base_url: option.needsBaseUrl ? current.base_url : '',
      };
    },
    [],
  );

  return { reload, switchProvider };
}
