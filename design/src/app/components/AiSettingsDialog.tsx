import { useEffect, useRef, useState } from 'react';
import {
  X,
  Save,
  PlugZap,
  CheckCircle2,
  AlertCircle,
  List,
  Trash2,
  RefreshCw,
  MessageSquareText,
  Image,
  Volume2,
  Music,
} from 'lucide-react';
import {
  type AiLogEntry,
  type AiConfig,
  type AiProviderConfig,
  type AiValidationResult,
  type ProviderCatalog,
  type ProviderOption,
  listAiProviders,
  getAiConfig,
  setAiConfig,
  getAiImageConfig,
  setAiImageConfig,
  getAiTtsConfig,
  setAiTtsConfig,
  getAiMusicConfig,
  setAiMusicConfig,
  validateAiConfig,
  listAiLogs,
  clearAiLogs,
  getAiLogPath,
} from '../lib/ai-ipc';

type AiSettingsTab = 'chat' | 'image' | 'tts' | 'music';

// Base URL is deliberately left empty: the backend falls back to the
// provider's built-in endpoint, and a provider that has none shows the
// requirement as an input placeholder instead of pre-filling an example
// address the backend would later reject.
function configFromOption(option: ProviderOption): AiProviderConfig {
  return {
    provider: option.value,
    model: option.defaultModel,
    api_key: '',
    base_url: '',
  };
}

/**
 * Keep a saved config only while its provider is still offered for this tab.
 * A provider that the backend dropped falls back to the first option rather
 * than leaving the picker showing a value that is not in its list.
 */
function normalizeConfig(
  config: AiProviderConfig,
  options: ProviderOption[],
): AiProviderConfig {
  if (options.length === 0) return config;
  if (options.some((option) => option.value === config.provider)) {
    return config;
  }
  return configFromOption(options[0]);
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function AiSettingsDialog({ open, onClose, onSaved }: Props) {
  const [activeTab, setActiveTab] = useState<AiSettingsTab>('chat');
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [imageConfig, setImageConfig] = useState<AiProviderConfig | null>(null);
  const [ttsConfig, setTtsConfig] = useState<AiProviderConfig | null>(null);
  const [musicConfig, setMusicConfig] = useState<AiProviderConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<AiValidationResult | null>(null);
  /** True when the last successful verification also persisted the chat config. */
  const [verifiedSaved, setVerifiedSaved] = useState(false);
  const [logs, setLogs] = useState<AiLogEntry[]>([]);
  const [logPath, setLogPath] = useState('');
  const configRef = useRef<AiConfig | null>(null);

  useEffect(() => {
    if (!open) return;
    setActiveTab('chat');
    setError(null);
    setValidation(null);
    setVerifiedSaved(false);
    configRef.current = null;
    setLogs([]);
    setLogPath('');
    Promise.all([
      listAiProviders(),
      getAiConfig(),
      getAiImageConfig(),
      getAiTtsConfig(),
      getAiMusicConfig(),
    ])
      .then(([providers, chat, image, tts, music]) => {
        setCatalog(providers);
        setConfig(chat);
        configRef.current = chat;
        setImageConfig(normalizeConfig(image, providers.image));
        setTtsConfig(normalizeConfig(tts, providers.tts));
        setMusicConfig(normalizeConfig(music, providers.music));
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  // Any edit invalidates the previous verification result (and its auto-save).
  const updateChat = (patch: Partial<AiConfig>) => {
    setValidation(null);
    setVerifiedSaved(false);
    setConfig((current) => {
      const next = current ? { ...current, ...patch } : current;
      configRef.current = next;
      return next;
    });
  };

  const updateImage = (patch: Partial<AiProviderConfig>) =>
    setImageConfig((c) => (c ? { ...c, ...patch } : c));

  const updateTts = (patch: Partial<AiProviderConfig>) =>
    setTtsConfig((c) => (c ? { ...c, ...patch } : c));

  const updateMusic = (patch: Partial<AiProviderConfig>) =>
    setMusicConfig((c) => (c ? { ...c, ...patch } : c));

  const handleProviderChange = (
    value: string,
    current: AiConfig,
    options: ProviderOption[],
    update: (patch: Partial<AiConfig>) => void,
  ) => {
    const option = options.find((p) => p.value === value);
    if (!option) {
      update({ provider: value });
      setValidation(null);
      setVerifiedSaved(false);
      return;
    }
    update({
      provider: value,
      model: option.defaultModel,
      // A Base URL typed for the previous provider almost never applies to the
      // new one, so keep it only where the new provider has no built-in
      // endpoint and the user would otherwise have to retype it.
      base_url: option.needsBaseUrl ? current.base_url : '',
    });
    setValidation(null);
    setVerifiedSaved(false);
  };

  const handleVerify = async () => {
    if (!config) return;
    const testedConfig = { ...config };
    setVerifying(true);
    setError(null);
    setValidation(null);
    try {
      const result = await validateAiConfig(testedConfig);
      const currentConfig = configRef.current;
      const unchanged = currentConfig
        && currentConfig.provider === testedConfig.provider
        && currentConfig.model === testedConfig.model
        && currentConfig.api_key === testedConfig.api_key
        && currentConfig.base_url === testedConfig.base_url;
      if (!unchanged) return;
      setValidation(result);
      // A successful trial connection is an unambiguous "use this config".
      // Persist it right away: the dialog reloads from disk every time it
      // opens, so an unsaved draft would otherwise be silently discarded.
      if (result.ok) {
        await setAiConfig(testedConfig);
        setVerifiedSaved(true);
        onSaved?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setVerifying(false);
    }
  };

  const refreshLogs = async () => {
    setLogsLoading(true);
    setError(null);
    try {
      const [nextLogs, path] = await Promise.all([
        listAiLogs(80),
        getAiLogPath(),
      ]);
      setLogs(nextLogs);
      setLogPath(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setLogsLoading(false);
    }
  };

  const handleClearLogs = async () => {
    setLogsLoading(true);
    setError(null);
    try {
      await clearAiLogs();
      setLogs([]);
      setLogPath(await getAiLogPath());
    } catch (e) {
      setError(String(e));
    } finally {
      setLogsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config || !imageConfig || !ttsConfig || !musicConfig) return;
    setSaving(true);
    setError(null);
    try {
      await Promise.all([
        setAiConfig(config),
        setAiImageConfig(imageConfig),
        setAiTtsConfig(ttsConfig),
        setAiMusicConfig(musicConfig),
      ]);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const loaded = catalog && config && imageConfig && ttsConfig && musicConfig;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[720px] max-h-[85vh] flex flex-col bg-card border border-border rounded-lg shadow-2xl">
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

        <div className="border-b border-border px-4 pt-3">
          <div className="flex items-center gap-1">
            <TabButton active={activeTab === 'chat'} icon={<MessageSquareText className="h-4 w-4" />} label="聊天" onClick={() => setActiveTab('chat')} />
            <TabButton active={activeTab === 'image'} icon={<Image className="h-4 w-4" />} label="图片" onClick={() => setActiveTab('image')} />
            <TabButton active={activeTab === 'tts'} icon={<Volume2 className="h-4 w-4" />} label="音频" onClick={() => setActiveTab('tts')} />
            <TabButton active={activeTab === 'music'} icon={<Music className="h-4 w-4" />} label="音乐" onClick={() => setActiveTab('music')} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!loaded ? (
            <div className="text-sm text-muted-foreground">加载中…</div>
          ) : (
            <>
              {activeTab === 'chat' && (
                <>
                  <fieldset disabled={verifying} className="disabled:opacity-70">
                    <ConfigFields
                      config={config}
                      options={catalog.chat}
                      multiModel={false}
                      onProviderChange={(value) => handleProviderChange(value, config, catalog.chat, updateChat)}
                      onUpdate={updateChat}
                    />
                  </fieldset>

                  <ConnectionPanel
                    verifying={verifying}
                    validation={validation}
                    verifiedSaved={verifiedSaved}
                    onVerify={handleVerify}
                  />

                  <LogsPanel
                    logs={logs}
                    logPath={logPath}
                    logsLoading={logsLoading}
                    onRefresh={refreshLogs}
                    onClear={handleClearLogs}
                  />
                </>
              )}

              {activeTab === 'image' && (
                <ProviderConfigPanel
                  title="图片生成配置"
                  config={imageConfig}
                  options={catalog.image}
                  onUpdate={updateImage}
                  onProviderChange={(value) => handleProviderChange(value, imageConfig, catalog.image, updateImage)}
                />
              )}

              {activeTab === 'tts' && (
                <ProviderConfigPanel
                  title="音频 / TTS 配置"
                  config={ttsConfig}
                  options={catalog.tts}
                  onUpdate={updateTts}
                  onProviderChange={(value) => handleProviderChange(value, ttsConfig, catalog.tts, updateTts)}
                />
              )}

              {activeTab === 'music' && (
                <ProviderConfigPanel
                  title="背景音乐 (BGM) 生成配置"
                  config={musicConfig}
                  options={catalog.music}
                  onUpdate={updateMusic}
                  onProviderChange={(value) => handleProviderChange(value, musicConfig, catalog.music, updateMusic)}
                />
              )}

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
            disabled={!loaded || saving || verifying}
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

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ProviderConfigPanel({
  title,
  config,
  options,
  onUpdate,
  onProviderChange,
}: {
  title: string;
  config: AiProviderConfig;
  options: ProviderOption[];
  onUpdate: (patch: Partial<AiProviderConfig>) => void;
  onProviderChange: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-secondary/20 p-3">
        <div>
          <div className="text-sm font-medium">{title}</div>
        </div>
      </div>

      <ConfigFields
        config={config}
        options={options}
        multiModel
        onProviderChange={onProviderChange}
        onUpdate={onUpdate}
      />
    </div>
  );
}

const CUSTOM_MODEL_SENTINEL = '__custom__';

// Single-field model picker: a dropdown of preset models plus a "custom" option
// that turns the same slot into a free-text input for typing any model name.
function ModelSelectField({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (model: string) => void;
}) {
  // Custom mode is active when the user explicitly picks it, or when the saved
  // model isn't one of the presets (e.g. a previously typed custom value).
  const [custom, setCustom] = useState(() => options.length > 0 && !options.includes(value));

  if (options.length === 0 || custom) {
    return (
      <div className="space-y-2">
        {options.length > 0 && (
          <select
            value={CUSTOM_MODEL_SENTINEL}
            onChange={(e) => {
              if (e.target.value !== CUSTOM_MODEL_SENTINEL) {
                setCustom(false);
                onChange(e.target.value);
              }
            }}
            className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            aria-label="选择模型"
          >
            {options.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
            <option value={CUSTOM_MODEL_SENTINEL}>自定义…</option>
          </select>
        )}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus
          className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          aria-label="模型名称"
        />
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM_MODEL_SENTINEL) {
          setCustom(true);
        } else {
          onChange(e.target.value);
        }
      }}
      className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
      aria-label="选择模型"
    >
      {options.map((model) => (
        <option key={model} value={model}>{model}</option>
      ))}
      <option value={CUSTOM_MODEL_SENTINEL}>自定义…</option>
    </select>
  );
}

function ConfigFields({
  config,
  options,
  multiModel = false,
  onProviderChange,
  onUpdate,
}: {
  config: AiConfig;
  options: ProviderOption[];
  multiModel?: boolean;
  onProviderChange: (value: string) => void;
  onUpdate: (patch: Partial<AiConfig>) => void;
}) {
  const provider = options.find((p) => p.value === config.provider);
  const modelOptions = provider?.models?.length ? provider.models : provider ? [provider.defaultModel] : [];
  const apiKeyHint = provider && !provider.requiresApiKey
    ? '该供应商通常不需要 Key，可留空'
    : '存储在本地配置文件中';
  const baseUrlHint = provider?.needsBaseUrl
    ? '必填，该供应商没有内置地址'
    : '留空使用供应商默认地址';
  return (
    <div className="space-y-4">
      <Field label="供应商">
        <select
          value={config.provider}
          onChange={(e) => onProviderChange(e.target.value)}
          className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          aria-label="选择 AI 供应商"
        >
          {options.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="模型"
        hint={
          multiModel
            ? '从当前供应商的模型池选择，可批量填入，也可追加自定义模型名。'
            : provider ? `可下拉选择常用模型，也可直接输入自定义模型名。推荐: ${provider.defaultModel}` : '可直接输入模型名'
        }
      >
        {multiModel ? (
          <ModelTagPicker
            value={config.model}
            options={modelOptions}
            onChange={(model) => onUpdate({ model })}
          />
        ) : (
          <ModelSelectField
            key={provider?.value || 'custom'}
            value={config.model}
            options={modelOptions}
            placeholder={provider?.defaultModel || '输入模型名'}
            onChange={(model) => onUpdate({ model })}
          />
        )}
      </Field>

      <Field label="API Key" hint={apiKeyHint}>
        <input
          type="password"
          value={config.api_key}
          onChange={(e) => onUpdate({ api_key: e.target.value })}
          placeholder="sk-..."
          className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </Field>

      <Field label="Base URL" hint={baseUrlHint}>
        <input
          type="text"
          value={config.base_url}
          onChange={(e) => onUpdate({ base_url: e.target.value })}
          placeholder={provider?.baseUrlPlaceholder ?? '(默认)'}
          className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </Field>
    </div>
  );
}

function parseModelList(value: string) {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeModelList(models: string[]) {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean))).join(',');
}

function ModelTagPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const [customModel, setCustomModel] = useState('');
  const selected = parseModelList(value);
  const selectedSet = new Set(selected);

  const addModels = (models: string[]) => {
    onChange(serializeModelList([...selected, ...models]));
  };

  const removeModel = (model: string) => {
    onChange(serializeModelList(selected.filter((item) => item !== model)));
  };

  const addCustomModel = () => {
    const next = customModel.trim();
    if (!next) return;
    addModels([next]);
    setCustomModel('');
  };

  return (
    <div className="space-y-3">
      <div className="min-h-24 rounded-md border border-border bg-input-background p-2">
        {selected.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {selected.map((model) => (
              <button
                key={model}
                type="button"
                onClick={() => removeModel(model)}
                className="max-w-full rounded-md bg-secondary px-2 py-1 text-xs text-foreground hover:bg-secondary/70"
                title="点击移除"
              >
                <span className="break-all">{model}</span>
                <span className="ml-1 text-muted-foreground">x</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-1 py-1 text-sm text-muted-foreground">尚未选择模型</div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => addModels(options)}
          disabled={options.length === 0}
          className="rounded-md bg-primary/15 px-3 py-1.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          填入相关模型
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          disabled={selected.length === 0}
          className="rounded-md bg-secondary px-3 py-1.5 text-xs hover:bg-secondary/70 disabled:opacity-50"
        >
          清空
        </button>
      </div>

      {options.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-background/40 p-2">
          <div className="flex flex-wrap gap-2">
            {options.map((model) => {
              const active = selectedSet.has(model);
              return (
                <button
                  key={model}
                  type="button"
                  onClick={() => active ? removeModel(model) : addModels([model])}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-foreground hover:bg-secondary/70'
                  }`}
                >
                  {model}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">自定义模型名称</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustomModel();
              }
            }}
            placeholder="输入自定义模型名称"
            className="min-w-0 flex-1 px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            type="button"
            onClick={addCustomModel}
            className="rounded-md bg-secondary px-3 py-2 text-sm hover:bg-secondary/70"
          >
            填入
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionPanel({
  verifying,
  validation,
  verifiedSaved,
  onVerify,
}: {
  verifying: boolean;
  validation: AiValidationResult | null;
  verifiedSaved: boolean;
  onVerify: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">连接验证</div>
          <div className="text-xs text-muted-foreground mt-1">
            使用当前未保存或已修改的聊天配置发起一次真实试连。
          </div>
        </div>
        <button
          onClick={onVerify}
          disabled={verifying}
          className="px-3 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors text-sm border border-border disabled:opacity-50 flex items-center gap-2"
        >
          <PlugZap className="w-3.5 h-3.5" />
          {verifying ? '验证中…' : '测试连接'}
        </button>
      </div>

      {validation && (
        <div className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>{validation.message}</span>
          </div>
          <div className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-300/80">
            Endpoint: {validation.endpoint || '自动解析'}
          </div>
          {verifiedSaved && (
            <div className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-300/80">
              已自动保存这份聊天配置，可直接关闭对话框。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LogsPanel({
  logs,
  logPath,
  logsLoading,
  onRefresh,
  onClear,
}: {
  logs: AiLogEntry[];
  logPath: string;
  logsLoading: boolean;
  onRefresh: () => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <List className="h-4 w-4" />
            AI 调用日志
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {logPath || '读取最近的验证与对话调用记录。'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={logsLoading}
            className="rounded-md border border-border bg-secondary px-3 py-2 text-xs hover:bg-secondary/70 disabled:opacity-50 flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${logsLoading ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <button
            onClick={onClear}
            disabled={logsLoading}
            className="rounded-md border border-border bg-secondary px-3 py-2 text-xs hover:bg-secondary/70 disabled:opacity-50 flex items-center gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空
          </button>
        </div>
      </div>
      {logs.length > 0 ? (
        <div className="mt-3 max-h-56 overflow-y-auto rounded-md border border-border bg-background/40">
          {logs.map((entry, index) => (
            <AiLogRow key={`${entry.timestampMs}-${index}`} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          {logsLoading ? '正在读取日志…' : '暂无已加载日志。'}
        </div>
      )}
    </div>
  );
}

function AiLogRow({ entry }: { entry: AiLogEntry }) {
  const time = new Date(Number(entry.timestampMs)).toLocaleString();
  return (
    <div className="border-b border-border px-3 py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="min-w-0 truncate font-mono-family">
          {time} · {entry.action} · {entry.provider}/{entry.model}
        </div>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 ${
            entry.success
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          {entry.success ? '成功' : '失败'}
        </span>
      </div>
      {entry.endpoint && (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {entry.endpoint}
        </div>
      )}
      {entry.message && (
        <div className="mt-1 break-words text-xs text-muted-foreground">
          {entry.message}
        </div>
      )}
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
