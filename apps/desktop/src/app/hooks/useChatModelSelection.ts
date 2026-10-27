import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AI_CHAT_CONFIG_CHANGED_EVENT,
  getAiConfig,
  listAiProviders,
  setAiConfig,
  type AiConfig,
  type ProviderCatalog,
} from '../lib/ai-ipc';

export function useChatModelSelection() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const requestRef = useRef({ id: 0 });
  const switchingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (switchingRef.current) return;
    const request = ++requestRef.current.id;
    setLoading(true);
    setError(null);
    try {
      const [latest, providers] = await Promise.all([getAiConfig(), listAiProviders()]);
      if (activeRef.current && request === requestRef.current.id) {
        setConfig(latest);
        setCatalog(providers);
      }
    } catch {
      if (activeRef.current && request === requestRef.current.id) {
        setError('无法读取模型配置，请重试或打开 AI 设置。');
      }
    } finally {
      if (activeRef.current && request === requestRef.current.id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const requests = requestRef.current;
    activeRef.current = true;
    void refresh();
    const handleConfigChanged = () => {
      void refresh();
    };
    window.addEventListener(AI_CHAT_CONFIG_CHANGED_EVENT, handleConfigChanged);
    return () => {
      activeRef.current = false;
      requests.id++;
      window.removeEventListener(AI_CHAT_CONFIG_CHANGED_EVENT, handleConfigChanged);
    };
  }, [refresh]);

  const switchModel = async (model: string) => {
    if (!config || switchingRef.current) return;
    switchingRef.current = true;
    requestRef.current.id++;
    setSwitching(true);
    setLoading(false);
    setError(null);
    try {
      const latest = await getAiConfig();
      if (!activeRef.current) return;
      setConfig(latest);
      // A menu opened for another provider must not write its model into this configuration.
      if (latest.provider !== config.provider) {
        setError('供应商配置已更新，请重新选择模型。');
        return;
      }
      const updated = { ...latest, model };
      await setAiConfig(updated);
      if (activeRef.current) setConfig(updated);
    } catch {
      if (activeRef.current) setError('切换模型失败，请重试或打开 AI 设置。');
    } finally {
      switchingRef.current = false;
      if (activeRef.current) setSwitching(false);
    }
  };

  return { config, catalog, loading, switching, error, refresh, switchModel };
}
