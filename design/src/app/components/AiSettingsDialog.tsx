import { useEffect, useState } from 'react';
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

interface ProviderPreset {
  value: string;
  label: string;
  defaultModel: string;
  models?: string[];
  defaultBaseUrl: string;
  needsBaseUrl: boolean;
  keyHint?: string;
}

type AiSettingsTab = 'chat' | 'image' | 'tts' | 'music';

const CHAT_PROVIDERS: ProviderPreset[] = [
  { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.5', models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'anthropic', label: 'Anthropic', defaultModel: 'claude-opus-4-8', models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'gemini', label: 'Gemini', defaultModel: 'gemini-3.5-flash', models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound', 'qwen-2.5-32b', 'deepseek-r1-distill-llama-70b'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'xai', label: 'xAI', defaultModel: 'grok-4.3', models: ['grok-4.3', 'grok-4.20', 'grok-build-0.1'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'ollama', label: 'Ollama (本地)', defaultModel: 'qwen2.5:7b', models: ['qwen2.5:7b', 'qwen2.5:14b', 'qwen2.5:32b', 'llama3.3:70b', 'llama3.2:3b', 'deepseek-r1:7b', 'deepseek-r1:14b', 'gemma2:9b', 'mistral:7b', 'phi4:14b'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'custom', label: '自定义 (OpenAI 兼容)', defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.example.com/v1/', needsBaseUrl: true },
];

const IMAGE_PROVIDERS: ProviderPreset[] = [
  { value: 'openai', label: 'OpenAI Images', defaultModel: 'gpt-image-1', models: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'chatgpt-image-latest', 'dall-e-3', 'dall-e-2'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'gemini', label: 'Google Gemini / Imagen', defaultModel: 'gemini-3-pro-image-preview', models: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'nano-banana-pro-preview', 'imagen-4.0-ultra-generate-001', 'imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'aliyun', label: '阿里云 DashScope / 通义万相', defaultModel: 'wanx2.1-t2i-turbo', models: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx2.1-imageedit', 'wanx-v1', 'wan2.2-t2i-flash', 'wan2.2-t2i-plus', 'wan2.5-t2i-preview', 'wan2.6-t2i', 'wan2.7-image', 'wan2.7-image-pro', 'qwen-image', 'qwen-image-edit', 'qwen-image-plus', 'qwen-image-max', 'qwen-image-2.0-pro', 'z-image-turbo'], defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', needsBaseUrl: false },
  { value: 'volcengine', label: '火山引擎 / 即梦 / 豆包', defaultModel: 'doubao-seedream-4-5-251128', models: ['doubao-seedream-4-5-251128', 'doubao-seedream-5-0-lite', 'doubao-seedream-4-0-250828', 'doubao-seededit-3-0-i2i-250628', 'jimeng_high_aes_general_v21_L', 'jimeng_high_aes_general_v20_L', 'doubao-seedream-3-0-t2i-250415'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'zhipu', label: '智谱 CogView', defaultModel: 'cogview-3-flash', models: ['cogview-3-flash', 'cogview-3-plus', 'cogview-4'], defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', needsBaseUrl: false },
  { value: 'siliconflow', label: 'SiliconFlow', defaultModel: 'Kwai-Kolors/Kolors', models: ['Kwai-Kolors/Kolors', 'black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev', 'stabilityai/stable-diffusion-3-5-large', 'stabilityai/stable-diffusion-xl-base-1.0', 'Qwen/Qwen-Image', 'Qwen/Qwen-Image-Edit'], defaultBaseUrl: 'https://api.siliconflow.cn/v1', needsBaseUrl: false },
  { value: 'sd-webui', label: 'Stable Diffusion WebUI (本地)', defaultModel: 'local', models: ['local', 'sdxl', 'sd1.5', 'sd3.5-large', 'flux', 'kolors'], defaultBaseUrl: 'http://127.0.0.1:7860', needsBaseUrl: true, keyHint: '本地服务通常不需要 Key' },
  { value: 'custom', label: '自定义', defaultModel: 'image-model', models: ['image-model'], defaultBaseUrl: 'https://api.example.com/v1/images/generations', needsBaseUrl: true },
];

const TTS_PROVIDERS: ProviderPreset[] = [
  { value: 'openai', label: 'OpenAI TTS', defaultModel: 'gpt-4o-mini-tts', models: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15', 'tts-1', 'tts-1-1106', 'tts-1-hd', 'tts-1-hd-1106'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'elevenlabs', label: 'ElevenLabs', defaultModel: 'eleven_multilingual_v2', models: ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2_5', 'eleven_turbo_v2', 'eleven_multilingual_sts_v2', 'eleven_monolingual_v1'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'aliyun', label: '阿里云 DashScope / CosyVoice', defaultModel: 'cosyvoice-v2', models: ['cosyvoice-v2', 'cosyvoice-v1', 'cosyvoice-v3-flash', 'cosyvoice-v3-plus', 'qwen3-tts-flash', 'qwen-tts', 'qwen-tts-latest'], defaultBaseUrl: '', needsBaseUrl: false, keyHint: 'Base URL 留空即可' },
  { value: 'volcengine', label: '火山引擎 / 豆包语音', defaultModel: 'seed-tts', models: ['seed-tts', 'seed-tts-2.0', 'mega-tts', 'doubao-tts'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'custom', label: '自定义', defaultModel: 'tts-model', models: ['tts-model'], defaultBaseUrl: 'https://api.example.com/v1/audio/speech', needsBaseUrl: true },
];

const MUSIC_PROVIDERS: ProviderPreset[] = [
  { value: 'custom', label: '自定义 (OpenAI 兼容音乐端点)', defaultModel: 'music-1', models: ['music-1'], defaultBaseUrl: 'https://api.example.com/v1/audio/music', needsBaseUrl: true, keyHint: 'Base URL 指向返回音频字节的音乐生成端点' },
  { value: 'openai', label: 'OpenAI 兼容', defaultModel: 'music-1', models: ['music-1'], defaultBaseUrl: '', needsBaseUrl: false },
  { value: 'siliconflow', label: 'SiliconFlow', defaultModel: 'music-1', models: ['music-1'], defaultBaseUrl: 'https://api.siliconflow.cn/v1', needsBaseUrl: false },
];

function configFromPreset(preset: ProviderPreset): AiProviderConfig {
  return {
    provider: preset.value,
    model: preset.defaultModel,
    api_key: '',
    base_url: preset.needsBaseUrl ? preset.defaultBaseUrl : '',
  };
}

function normalizeImageConfig(config: AiProviderConfig): AiProviderConfig {
  if (IMAGE_PROVIDERS.some((provider) => provider.value === config.provider)) {
    return config;
  }
  return configFromPreset(IMAGE_PROVIDERS[0]);
}

function normalizeMusicConfig(config: AiProviderConfig): AiProviderConfig {
  if (MUSIC_PROVIDERS.some((provider) => provider.value === config.provider)) {
    return config;
  }
  return configFromPreset(MUSIC_PROVIDERS[0]);
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function AiSettingsDialog({ open, onClose, onSaved }: Props) {
  const [activeTab, setActiveTab] = useState<AiSettingsTab>('chat');
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [imageConfig, setImageConfig] = useState<AiProviderConfig | null>(null);
  const [ttsConfig, setTtsConfig] = useState<AiProviderConfig | null>(null);
  const [musicConfig, setMusicConfig] = useState<AiProviderConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<AiValidationResult | null>(null);
  const [logs, setLogs] = useState<AiLogEntry[]>([]);
  const [logPath, setLogPath] = useState('');

  useEffect(() => {
    if (!open) return;
    setActiveTab('chat');
    setError(null);
    setValidation(null);
    setLogs([]);
    setLogPath('');
    Promise.all([getAiConfig(), getAiImageConfig(), getAiTtsConfig(), getAiMusicConfig()])
      .then(([chat, image, tts, music]) => {
        setConfig(chat);
        setImageConfig(normalizeImageConfig(image));
        setTtsConfig(tts);
        setMusicConfig(normalizeMusicConfig(music));
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  const updateChat = (patch: Partial<AiConfig>) =>
    setConfig((c) => (c ? { ...c, ...patch } : c));

  const updateImage = (patch: Partial<AiProviderConfig>) =>
    setImageConfig((c) => (c ? { ...c, ...patch } : c));

  const updateTts = (patch: Partial<AiProviderConfig>) =>
    setTtsConfig((c) => (c ? { ...c, ...patch } : c));

  const updateMusic = (patch: Partial<AiProviderConfig>) =>
    setMusicConfig((c) => (c ? { ...c, ...patch } : c));

  const handleProviderChange = (
    value: string,
    current: AiConfig,
    providers: ProviderPreset[],
    update: (patch: Partial<AiConfig>) => void,
  ) => {
    const preset = providers.find((p) => p.value === value);
    if (!preset) {
      update({ provider: value });
      setValidation(null);
      return;
    }
    update({
      provider: value,
      model: preset.defaultModel,
      base_url: preset.needsBaseUrl ? (current.base_url || preset.defaultBaseUrl) : '',
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

  const loaded = config && imageConfig && ttsConfig && musicConfig;

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
                  <ConfigFields
                    config={config}
                    providers={CHAT_PROVIDERS}
                    multiModel={false}
                    onProviderChange={(value) => handleProviderChange(value, config, CHAT_PROVIDERS, updateChat)}
                    onUpdate={updateChat}
                    apiKeyHint={
                      config.provider === 'ollama'
                        ? '本地 Ollama 通常不需要 Key'
                        : config.provider === 'custom'
                          ? 'OpenAI 兼容接口可按服务端要求决定是否填写'
                          : '存储在本地配置文件中'
                    }
                    baseUrlHint={
                      config.provider === 'custom'
                        ? '必填，OpenAI 兼容端点（DeepSeek/Moonshot/通义/本地 vLLM 等）'
                        : '留空使用供应商默认地址'
                    }
                  />

                  <ConnectionPanel
                    verifying={verifying}
                    validation={validation}
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
                  providers={IMAGE_PROVIDERS}
                  onUpdate={updateImage}
                  onProviderChange={(value) => handleProviderChange(value, imageConfig, IMAGE_PROVIDERS, updateImage)}
                />
              )}

              {activeTab === 'tts' && (
                <ProviderConfigPanel
                  title="音频 / TTS 配置"
                  config={ttsConfig}
                  providers={TTS_PROVIDERS}
                  onUpdate={updateTts}
                  onProviderChange={(value) => handleProviderChange(value, ttsConfig, TTS_PROVIDERS, updateTts)}
                />
              )}

              {activeTab === 'music' && (
                <ProviderConfigPanel
                  title="背景音乐 (BGM) 生成配置"
                  config={musicConfig}
                  providers={MUSIC_PROVIDERS}
                  onUpdate={updateMusic}
                  onProviderChange={(value) => handleProviderChange(value, musicConfig, MUSIC_PROVIDERS, updateMusic)}
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
  providers,
  onUpdate,
  onProviderChange,
}: {
  title: string;
  config: AiProviderConfig;
  providers: ProviderPreset[];
  onUpdate: (patch: Partial<AiProviderConfig>) => void;
  onProviderChange: (value: string) => void;
}) {
  const preset = providers.find((p) => p.value === config.provider);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-secondary/20 p-3">
        <div>
          <div className="text-sm font-medium">{title}</div>
        </div>
      </div>

      <ConfigFields
        config={config}
        providers={providers}
        multiModel
        onProviderChange={onProviderChange}
        onUpdate={onUpdate}
        apiKeyHint={preset?.keyHint || '存储在本地配置文件中'}
        baseUrlHint={config.provider === 'custom' ? '按目标服务填写图片或音频接口端点' : '留空使用供应商默认地址'}
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
  providers,
  multiModel = false,
  onProviderChange,
  onUpdate,
  apiKeyHint,
  baseUrlHint,
}: {
  config: AiConfig;
  providers: ProviderPreset[];
  multiModel?: boolean;
  onProviderChange: (value: string) => void;
  onUpdate: (patch: Partial<AiConfig>) => void;
  apiKeyHint: string;
  baseUrlHint: string;
}) {
  const provider = providers.find((p) => p.value === config.provider);
  const modelOptions = provider?.models?.length ? provider.models : provider ? [provider.defaultModel] : [];
  return (
    <div className="space-y-4">
      <Field label="供应商">
        <select
          value={config.provider}
          onChange={(e) => onProviderChange(e.target.value)}
          className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          aria-label="选择 AI 供应商"
        >
          {providers.map((p) => (
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
          placeholder={provider?.needsBaseUrl ? provider.defaultBaseUrl : '(默认)'}
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
  onVerify,
}: {
  verifying: boolean;
  validation: AiValidationResult | null;
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
              ? 'bg-emerald-500/10 text-emerald-300'
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
