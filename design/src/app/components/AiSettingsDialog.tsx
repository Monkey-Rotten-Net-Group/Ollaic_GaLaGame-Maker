import { useEffect, useState } from 'react';
import { X, Save, PlugZap, CheckCircle2, AlertCircle } from 'lucide-react';
import {
  type AiConfig,
  type AiValidationResult,
  getAiConfig,
  setAiConfig,
  validateAiConfig,
} from '../lib/ai-ipc';

interface ProviderPreset {
  value: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  needsBaseUrl: boolean;
}

const PROVIDERS: ProviderPreset[] = [
  { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o-mini', defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-4-6', defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'gemini', label: 'Gemini', defaultModel: 'gemini-2.0-flash', defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat', defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'groq', label: 'Groq', defaultModel: 'llama-3.1-8b-instant', defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'xai', label: 'xAI', defaultModel: 'grok-3-mini', defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'ollama', label: 'Ollama (本地)', defaultModel: 'qwen2.5:7b', defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'custom', label: '自定义 (OpenAI 兼容)', defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.example.com/v1/', needsBaseUrl: true },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function AiSettingsDialog({ open, onClose, onSaved }: Props) {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<AiValidationResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setValidation(null);
    getAiConfig()
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  const update = (patch: Partial<AiConfig>) =>
    setConfig((c) => (c ? { ...c, ...patch } : c));

  const handleProviderChange = (value: string) => {
    const preset = PROVIDERS.find((p) => p.value === value);
    if (!preset || !config) {
      update({ provider: value });
      setValidation(null);
      return;
    }
    update({
      provider: value,
      model: config.model || preset.defaultModel,
      base_url: preset.needsBaseUrl ? (config.base_url || preset.defaultBaseUrl) : '',
    });
    setValidation(null);
  };

  const handleVerify = async () => {
    if (!config) return;
    setVerifying(true);
    setError(null);
    setValidation(null);
    try {
      const result = await validateAiConfig(config);
      setValidation(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await setAiConfig(config);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const provider = PROVIDERS.find((p) => p.value === config?.provider);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[620px] max-h-[85vh] flex flex-col bg-card border border-border rounded-lg shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-display-family">
            AI 设置
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!config ? (
            <div className="text-sm text-muted-foreground">加载中…</div>
          ) : (
            <>
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground leading-6">
                当前产品定位是本地创作工具。你可以直接填写自己的 `API Key / Base URL / Model`，
                `自定义 (OpenAI 兼容)` 是正式能力，可用于第三方聚合平台、自建中转或本地 vLLM。
              </div>

              <Field label="供应商">
                <select
                  value={config.provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  aria-label="选择 AI 供应商"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="模型"
                hint={provider ? `推荐: ${provider.defaultModel}` : undefined}
              >
                <input
                  type="text"
                  value={config.model}
                  onChange={(e) => update({ model: e.target.value })}
                  placeholder={provider?.defaultModel}
                  className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </Field>

              <Field
                label="API Key"
                hint={config.provider === 'ollama' ? '本地 Ollama 通常不需要 Key' : config.provider === 'custom' ? 'OpenAI 兼容接口可按服务端要求决定是否填写' : '存储在本地配置文件中'}
              >
                <input
                  type="password"
                  value={config.api_key}
                  onChange={(e) => update({ api_key: e.target.value })}
                  placeholder="sk-..."
                  className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </Field>

              <Field
                label="Base URL"
                hint={
                  config.provider === 'custom'
                    ? '必填，OpenAI 兼容端点（DeepSeek/Moonshot/通义/本地 vLLM 等）'
                    : '留空使用供应商默认地址'
                }
              >
                <input
                  type="text"
                  value={config.base_url}
                  onChange={(e) => update({ base_url: e.target.value })}
                  placeholder={provider?.needsBaseUrl ? provider.defaultBaseUrl : '(默认)'}
                  className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </Field>

              <div className="rounded-lg border border-border bg-secondary/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">连接验证</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      使用当前未保存或已修改的配置发起一次真实试连。
                    </div>
                  </div>
                  <button
                    onClick={handleVerify}
                    disabled={!config || verifying}
                    className="px-3 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors text-sm border border-border disabled:opacity-50 flex items-center gap-2"
                  >
                    <PlugZap className="w-3.5 h-3.5" />
                    {verifying ? '验证中…' : '测试连接'}
                  </button>
                </div>

                {validation && (
                  <div className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{validation.message}</span>
                    </div>
                    <div className="mt-1 text-xs text-emerald-100/80">
                      Endpoint: {validation.endpoint || '自动解析'}
                    </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5" />
                    <span>{error}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors text-sm"
            aria-label="取消"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={!config || saving || verifying}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center gap-2 text-sm disabled:opacity-50"
            aria-label="保存 AI 配置"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
          {label}
        </label>
        {action}
      </div>
      {children}
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
