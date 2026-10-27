import { useEffect, useRef, useState } from 'react';
import {
  X,
  Save,
  FolderOpen,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sun,
  Moon,
  Palette,
  Check,
  Sliders,
  MessageSquareText,
  Image,
  Volume2,
  Film,
  Bot,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getRuntimeInfo, installRuntime, type RuntimeInfo } from '../lib/webgal-ipc';
import {
  type AiConfig,
  type AiProviderConfig,
  type AiValidationResult,
  type ProviderCatalog,
  type ProviderOption,
  type AiLogEntry,
  listAiProviders,
  getAiConfig,
  setAiConfig,
  getAiImageConfig,
  setAiImageConfig,
  getAiTtsConfig,
  setAiTtsConfig,
  getAiVideoConfig,
  setAiVideoConfig,
  validateAiConfig,
  listAiLogs,
  clearAiLogs,
  getAiLogPath,
} from '../lib/ai-ipc';
import {
  ConfigFields,
  ConnectionPanel,
  LogsPanel,
  normalizeConfig,
  ProviderConfigPanel,
} from './AiSettingsDialog';

import {
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
  type SeedColor,
} from '../lib/app-settings';

export { loadAppSettings, saveAppSettings } from '../lib/app-settings';
export type { AppSettings, SeedColor } from '../lib/app-settings';

export type SettingsTab = 'appearance' | 'general' | 'ai';
export type AiSubTab = 'chat' | 'image' | 'tts' | 'video';

export const SEED_COLORS: {
  id: SeedColor;
  label: string;
  name: string;
  color: string;
  desc: string;
}[] = [
  { id: 'violet', label: '柔雾鸢尾主题', name: '柔雾鸢尾', color: '#65558f', desc: '雅致淡紫' },
  { id: 'crimson', label: '绯樱酒红主题', name: '绯樱酒红', color: '#9e2a47', desc: '甜美绯红' },
  { id: 'teal', label: '晴空青碧主题', name: '晴空青碧', color: '#0f7685', desc: '未来青绿' },
  { id: 'amber', label: '暮光琥珀主题', name: '暮光琥珀', color: '#b45309', desc: '温暖琥珀' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: AppSettings) => void;
  mode?: 'home' | 'editor';
  initialTab?: string;
  onOpenAiSettings?: () => void;
  onApplyRuntimeTemplateDir?: (dir: string) => Promise<void> | void;
}

export function AppSettingsDialog({
  open,
  onClose,
  onSaved,
  mode = 'editor',
  initialTab,
  onOpenAiSettings,
  onApplyRuntimeTemplateDir,
}: Props) {
  const resolveInitialTab = (tab?: string): SettingsTab => {
    if (!tab) return 'appearance';
    if (tab === 'ai' || tab.startsWith('ai')) return 'ai';
    if (tab === 'general') return 'general';
    return 'appearance';
  };

  const resolveInitialAiSubTab = (tab?: string): AiSubTab => {
    if (tab === 'ai-image' || tab === 'image') return 'image';
    if (tab === 'ai-tts' || tab === 'tts') return 'tts';
    if (tab === 'ai-video' || tab === 'video') return 'video';
    return 'chat';
  };

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => resolveInitialTab(initialTab));
  const [aiSubTab, setAiSubTab] = useState<AiSubTab>(() => resolveInitialAiSubTab(initialTab));
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Runtime state
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  // AI states
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [chatConfig, setChatConfig] = useState<AiConfig | null>(null);
  const [imageConfig, setImageConfig] = useState<AiProviderConfig | null>(null);
  const [ttsConfig, setTtsConfig] = useState<AiProviderConfig | null>(null);
  const [videoConfig, setVideoConfig] = useState<AiProviderConfig | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [validation, setValidation] = useState<AiValidationResult | null>(null);
  const [verifiedSaved, setVerifiedSaved] = useState(false);
  const [logs, setLogs] = useState<AiLogEntry[]>([]);
  const [logPath, setLogPath] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const configRef = useRef<AiConfig | null>(null);
  const editedAiConfigs = useRef(new Set<AiSubTab>());

  useEffect(() => {
    if (!open) return;
    let active = true;
    setActiveTab(resolveInitialTab(initialTab));
    setAiSubTab(resolveInitialAiSubTab(initialTab));
    setSettings(loadAppSettings());
    setError(null);
    setRuntimeError(null);
    setValidation(null);
    setVerifiedSaved(false);
    configRef.current = null;
    editedAiConfigs.current.clear();
    setCatalog(null);
    setChatConfig(null);
    setImageConfig(null);
    setTtsConfig(null);
    setVideoConfig(null);
    setLogs([]);
    setLogPath('');

    getRuntimeInfo()
      .then((info) => {
        if (active) setRuntime(info);
      })
      .catch((e) => {
        if (active) setRuntimeError(String(e));
      });

    Promise.all([
      listAiProviders(),
      getAiConfig(),
      getAiImageConfig(),
      getAiTtsConfig(),
      getAiVideoConfig(),
    ])
      .then(([providers, chat, image, tts, video]) => {
        if (!active) return;
        setCatalog(providers);
        setChatConfig(chat);
        configRef.current = chat;
        setImageConfig(normalizeConfig(image, providers.image));
        setTtsConfig(normalizeConfig(tts, providers.tts, true));
        setVideoConfig(normalizeConfig(video, providers.video));
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [open, initialTab]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch }));

  const updateChat = (patch: Partial<AiConfig>) => {
    editedAiConfigs.current.add('chat');
    setValidation(null);
    setVerifiedSaved(false);
    setChatConfig((current) => {
      const next = current ? { ...current, ...patch } : current;
      configRef.current = next;
      return next;
    });
  };

  const updateImage = (patch: Partial<AiProviderConfig>) => {
    editedAiConfigs.current.add('image');
    setImageConfig((c) => (c ? { ...c, ...patch } : c));
  };

  const updateTts = (patch: Partial<AiProviderConfig>) => {
    editedAiConfigs.current.add('tts');
    setTtsConfig((c) => (c ? { ...c, ...patch } : c));
  };

  const updateVideo = (patch: Partial<AiProviderConfig>) => {
    editedAiConfigs.current.add('video');
    setVideoConfig((c) => (c ? { ...c, ...patch } : c));
  };

  const handleProviderChange = (
    value: string,
    current: AiConfig,
    options: ProviderOption[],
    updateFn: (patch: Partial<AiConfig>) => void,
  ) => {
    const option = options.find((p) => p.value === value);
    if (!option) {
      updateFn({ provider: value });
      setValidation(null);
      setVerifiedSaved(false);
      return;
    }
    updateFn({
      provider: value,
      model: option.defaultModel,
      base_url: option.needsBaseUrl ? current.base_url : '',
    });
    setValidation(null);
    setVerifiedSaved(false);
  };

  const handleVerify = async () => {
    if (!chatConfig) return;
    const testedConfig = { ...chatConfig };
    setVerifying(true);
    setError(null);
    setValidation(null);
    try {
      const result = await validateAiConfig(testedConfig);
      const currentConfig = configRef.current;
      const unchanged =
        currentConfig &&
        currentConfig.provider === testedConfig.provider &&
        currentConfig.model === testedConfig.model &&
        currentConfig.api_key === testedConfig.api_key &&
        currentConfig.base_url === testedConfig.base_url;
      if (!unchanged) return;
      setValidation(result);
      if (result.ok) {
        await setAiConfig(testedConfig);
        editedAiConfigs.current.delete('chat');
        setVerifiedSaved(true);
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
      const [nextLogs, path] = await Promise.all([listAiLogs(80), getAiLogPath()]);
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

  const handleInstallRuntime = async () => {
    setRuntimeBusy(true);
    setRuntimeError(null);
    try {
      const info = await installRuntime();
      setRuntime(info);
    } catch (e) {
      setRuntimeError(String(e));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const handlePickDir = async () => {
    const dir = await openDialog({
      title: '选择默认项目目录',
      directory: true,
    });
    if (dir) update({ defaultProjectDir: dir });
  };

  const handlePickTemplateDir = async () => {
    const dir = await openDialog({
      title: '选择 WebGAL 预览模板目录',
      directory: true,
    });
    if (dir) update({ runtimeTemplateDir: dir });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (settings.runtimeTemplateDir.trim() && onApplyRuntimeTemplateDir) {
        await onApplyRuntimeTemplateDir(settings.runtimeTemplateDir.trim());
      }
      // Unchanged snapshots may be older than settings saved in the nested dialog.
      const writes: Promise<void>[] = [];
      if (editedAiConfigs.current.has('chat') && chatConfig) writes.push(setAiConfig(chatConfig));
      if (editedAiConfigs.current.has('image') && imageConfig) {
        writes.push(setAiImageConfig(imageConfig));
      }
      if (editedAiConfigs.current.has('tts') && ttsConfig) {
        writes.push(
          setAiTtsConfig({
            ...ttsConfig,
            model: ttsConfig.model.split(/[\n,，]/)[0]?.trim() || ttsConfig.model.trim(),
          }),
        );
      }
      if (editedAiConfigs.current.has('video') && videoConfig) {
        writes.push(setAiVideoConfig(videoConfig));
      }
      await Promise.all(writes);
      saveAppSettings(settings);
      onSaved?.(settings);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'home' ? '应用设置' : '编辑器设置';

  const tabs: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
    { id: 'appearance', label: '外观主题', icon: Palette },
    { id: 'general', label: mode === 'home' ? '常规设置' : '常规工程', icon: Sliders },
    { id: 'ai', label: 'AI 模型服务', icon: Bot },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[740px] max-w-[calc(100vw-2rem)] max-h-[88dvh] flex flex-col bg-card border border-border rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-primary" />
            <h2 className="text-base font-display-family font-bold">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-secondary/50 transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Top Bar Tabs (3 大分类顶栏) */}
        <div className="border-b border-border bg-surface-container-low px-5 pt-2">
          <nav className="flex items-center gap-2" aria-label="设置分类">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold tracking-wide transition-all ${
                    isActive
                      ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-md'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-surface-container-high rounded-t-md'
                  }`}
                  aria-selected={isActive}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Content Area */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-5">
          {/* 1. 外观主题 */}
          {activeTab === 'appearance' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-1">界面显示模式</h3>
                <p className="text-xs text-muted-foreground mb-2">选择偏好的明亮或暗色风格</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      update({ theme: 'light' });
                      document.documentElement.classList.remove('dark');
                    }}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-xs font-medium transition-all ${
                      settings.theme === 'light'
                        ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/20 font-bold'
                        : 'border-border bg-card text-muted-foreground hover:bg-secondary/50'
                    }`}
                    aria-label="浅色模式"
                  >
                    <Sun className="w-4 h-4" />
                    <span>浅色模式</span>
                    {settings.theme === 'light' && <Check className="w-3.5 h-3.5 ml-1" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      update({ theme: 'dark' });
                      document.documentElement.classList.add('dark');
                    }}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-xs font-medium transition-all ${
                      settings.theme === 'dark'
                        ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/20 font-bold'
                        : 'border-border bg-card text-muted-foreground hover:bg-secondary/50'
                    }`}
                    aria-label="深色模式"
                  >
                    <Moon className="w-4 h-4" />
                    <span>深色模式</span>
                    {settings.theme === 'dark' && <Check className="w-3.5 h-3.5 ml-1" />}
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-border">
                <h3 className="text-sm font-semibold mb-1">点缀主题色</h3>
                <p className="text-xs text-muted-foreground mb-3">为整个工作区赋予灵动统一的个性化主色调</p>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" role="group" aria-label="点缀主题色">
                  {SEED_COLORS.map((dot) => {
                    const isSelected = settings.seedColor === dot.id;
                    return (
                      <button
                        key={dot.id}
                        type="button"
                        onClick={() => {
                          update({ seedColor: dot.id });
                          document.documentElement.dataset.seed = dot.id;
                        }}
                        className={`flex flex-col items-start gap-1.5 p-3 rounded-lg border text-left transition-all ${
                          isSelected
                            ? 'border-primary bg-primary/10 shadow-sm ring-2 ring-primary/30'
                            : 'border-border bg-card hover:bg-secondary/40'
                        }`}
                        aria-label={dot.label}
                        title={dot.name}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span
                            className="w-4 h-4 rounded-full shadow-inner"
                            style={{ backgroundColor: dot.color }}
                          />
                          {isSelected && <Check className="w-3.5 h-3.5 text-primary" />}
                        </div>
                        <span className="text-xs font-semibold text-foreground mt-0.5">{dot.name}</span>
                        <span className="text-[10px] text-muted-foreground line-clamp-1">{dot.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 2. 常规设置 / 工程目录 */}
          {activeTab === 'general' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs uppercase tracking-widest text-muted-foreground mb-1.5 font-mono-family">
                  默认项目存储目录
                </label>
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1 px-3 py-2 bg-input-background border border-border rounded-md text-sm truncate font-mono-family">
                    {settings.defaultProjectDir || '（未设置）'}
                  </div>
                  <button
                    onClick={handlePickDir}
                    className="shrink-0 px-3 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors border border-border"
                    aria-label="选择目录"
                    title="选择目录"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">创建新作品项目时默认保存在此文件夹下</p>
              </div>

              {mode === 'editor' && (
                <div>
                  <label className="block text-xs uppercase tracking-widest text-muted-foreground mb-1.5 font-mono-family">
                    预览模板目录 (WebGAL_Template)
                  </label>
                  <div className="flex gap-2">
                    <div
                      className="min-w-0 flex-1 px-3 py-2 bg-input-background border border-border rounded-md text-sm truncate font-mono-family"
                      title={settings.runtimeTemplateDir || runtime?.path || ''}
                    >
                      {settings.runtimeTemplateDir ||
                        (runtime?.path ? `${runtime.path}（自动检测）` : '（未设置）')}
                    </div>
                    <button
                      onClick={handlePickTemplateDir}
                      className="shrink-0 px-3 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors border border-border"
                      aria-label="选择预览模板目录"
                      title="选择预览模板目录"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    默认使用运行时自动检测的路径。高级用户可选择本地修改过的 `WebGAL_Template` 目录覆盖。
                  </p>
                </div>
              )}

              {/* 快捷跳转 AI 设置 */}
              <div className="pt-2 border-t border-border">
                <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-primary/5">
                  <div className="flex items-center gap-2 text-xs">
                    <Bot className="w-4 h-4 text-primary" />
                    <span>需要配置大模型或 API Key？</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('ai');
                      setAiSubTab('chat');
                      onOpenAiSettings?.();
                    }}
                    className="text-xs text-primary font-semibold hover:underline"
                    aria-label="打开 AI 设置"
                  >
                    配置 AI 服务与模型 →
                  </button>
                </div>
              </div>

              {/* WebGAL 运行时引擎 */}
              <div className="pt-2 border-t border-border space-y-2">
                <label className="block text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
                  WebGAL 运行时引擎
                </label>

                <div className="flex items-start gap-2 p-3 rounded-lg border border-border bg-secondary/15">
                  {runtime?.installed ? (
                    <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-500 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 mt-0.5 text-yellow-500 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 text-sm">
                    <div className="font-mono-family font-medium">
                      {runtime?.installed ? `已安装 v${runtime.version ?? '(未知)'}` : '未安装'}
                    </div>
                    <div
                      className="text-xs text-muted-foreground font-mono-family truncate mt-0.5"
                      title={runtime?.path ?? ''}
                    >
                      {runtime?.path ?? '—'}
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleInstallRuntime}
                  disabled={runtimeBusy}
                  className="w-full shrink-0 px-3 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {runtimeBusy ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>下载安装中…</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      <span>{runtime?.installed ? '重新下载运行时' : '下载并安装运行时'}</span>
                    </>
                  )}
                </button>

                {runtimeError && (
                  <div className="px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                    {runtimeError}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. AI 模型服务（内部二级模态分段胶囊控制） */}
          {activeTab === 'ai' && (
            <div className="space-y-4">
              {/* 二级模态分段胶囊 (Segmented Pills) */}
              <div
                className="flex items-center gap-1.5 p-1 rounded-lg border border-border bg-surface-container-low max-w-fit"
                role="tablist"
                aria-label="AI 模态分类"
              >
                <button
                  type="button"
                  onClick={() => setAiSubTab('chat')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    aiSubTab === 'chat'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <MessageSquareText className="w-3.5 h-3.5" />
                  <span>剧本对话</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAiSubTab('image')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    aiSubTab === 'image'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Image className="w-3.5 h-3.5" />
                  <span>画面插画</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAiSubTab('tts')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    aiSubTab === 'tts'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>角色配音</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAiSubTab('video')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    aiSubTab === 'video'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Film className="w-3.5 h-3.5" />
                  <span>视频生成</span>
                </button>
              </div>

              {/* Subtab Panels */}
              {aiSubTab === 'chat' && (
                <div className="space-y-4 pt-1">
                  <div className="rounded-lg border border-border bg-secondary/20 p-3">
                    <div className="text-sm font-semibold">AI 剧本与对话模型配置</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      用于故事创作、剧情编写、场景拆解及对白润色的主对话大模型。
                    </div>
                  </div>

                  {catalog && chatConfig ? (
                    <>
                      <fieldset disabled={verifying} className="disabled:opacity-70">
                        <ConfigFields
                          config={chatConfig}
                          options={catalog.chat}
                          multiModel={false}
                          onProviderChange={(value) =>
                            handleProviderChange(value, chatConfig, catalog.chat, updateChat)
                          }
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
                  ) : (
                    <div className="text-xs text-muted-foreground py-4 text-center">正在读取 AI 配置…</div>
                  )}
                </div>
              )}

              {aiSubTab === 'image' && (
                <div className="space-y-4 pt-1">
                  {catalog && imageConfig ? (
                    <ProviderConfigPanel
                      title="图片与立绘生成配置"
                      config={imageConfig}
                      options={catalog.image}
                      onUpdate={updateImage}
                      onProviderChange={(value) =>
                        handleProviderChange(value, imageConfig, catalog.image, updateImage)
                      }
                    />
                  ) : (
                    <div className="text-xs text-muted-foreground py-4 text-center">正在读取 AI 配置…</div>
                  )}
                </div>
              )}

              {aiSubTab === 'tts' && (
                <div className="space-y-4 pt-1">
                  {catalog && ttsConfig ? (
                    <ProviderConfigPanel
                      title="音频与语音合成 (TTS) 配置"
                      config={ttsConfig}
                      options={catalog.tts}
                      multiModel={false}
                      onUpdate={updateTts}
                      onProviderChange={(value) =>
                        handleProviderChange(value, ttsConfig, catalog.tts, updateTts)
                      }
                    />
                  ) : (
                    <div className="text-xs text-muted-foreground py-4 text-center">正在读取 AI 配置…</div>
                  )}
                </div>
              )}

              {aiSubTab === 'video' && (
                <div className="space-y-4 pt-1">
                  {catalog && videoConfig ? (
                    <ProviderConfigPanel
                      title="动态视频生成配置"
                      config={videoConfig}
                      options={catalog.video}
                      onUpdate={updateVideo}
                      onProviderChange={(value) =>
                        handleProviderChange(value, videoConfig, catalog.video, updateVideo)
                      }
                    />
                  ) : (
                    <div className="text-xs text-muted-foreground py-4 text-center">正在读取 AI 配置…</div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-border bg-surface-container-lowest">
          <div className="text-xs text-muted-foreground">
            {verifiedSaved && <span className="text-green-600 font-medium">✓ 聊天配置测试已通过</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors text-sm"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center gap-2 text-sm disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
