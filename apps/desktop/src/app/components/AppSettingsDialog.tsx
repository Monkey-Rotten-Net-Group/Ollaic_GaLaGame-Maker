import { useEffect, useState } from 'react';
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
  Bot,
  Sliders,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getRuntimeInfo, installRuntime, type RuntimeInfo } from '../lib/webgal-ipc';

export type SeedColor = 'violet' | 'crimson' | 'teal' | 'amber';

export interface AppSettings {
  defaultProjectDir: string;
  runtimeTemplateDir: string;
  language: 'zh-CN' | 'en';
  theme: 'dark' | 'light';
  seedColor: SeedColor;
}

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

const STORAGE_KEY = 'webgal-app-settings';
const SEED_STORAGE_KEY = 'ollaic:ph-seed-color-v3';
const HOME_THEME_STORAGE_KEY = 'ollaic-home-theme';

const DEFAULTS: AppSettings = {
  defaultProjectDir: '',
  runtimeTemplateDir: '',
  language: 'zh-CN',
  theme: 'dark',
  seedColor: 'violet',
};

export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const savedSeed = localStorage.getItem(SEED_STORAGE_KEY) as SeedColor | null;
    const homeTheme = localStorage.getItem(HOME_THEME_STORAGE_KEY) as 'dark' | 'light' | null;
    return {
      ...DEFAULTS,
      ...parsed,
      seedColor:
        savedSeed === 'violet' || savedSeed === 'crimson' || savedSeed === 'teal' || savedSeed === 'amber'
          ? savedSeed
          : parsed.seedColor || 'violet',
      theme:
        homeTheme === 'dark' || homeTheme === 'light'
          ? homeTheme
          : parsed.theme || (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  localStorage.setItem(SEED_STORAGE_KEY, settings.seedColor);
  localStorage.setItem(HOME_THEME_STORAGE_KEY, settings.theme);
  document.documentElement.dataset.seed = settings.seedColor;
  document.documentElement.classList.toggle('dark', settings.theme === 'dark');
}

interface Props {
  open: boolean;
  onClose: () => void;
  mode?: 'home' | 'editor';
  onOpenAiSettings?: () => void;
  onApplyRuntimeTemplateDir?: (dir: string) => Promise<void> | void;
}

export function AppSettingsDialog({
  open,
  onClose,
  mode = 'editor',
  onOpenAiSettings,
  onApplyRuntimeTemplateDir,
}: Props) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const loaded = loadAppSettings();
    setSettings(loaded);
    setError(null);
    setRuntimeError(null);
    getRuntimeInfo()
      .then(setRuntime)
      .catch((e) => setRuntimeError(String(e)));
  }, [open]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch }));

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
      saveAppSettings(settings);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'home' ? '应用设置' : '编辑器设置';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[540px] max-w-[calc(100vw-2rem)] max-h-[85dvh] flex flex-col bg-card border border-border rounded-lg shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-display-family">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-5">
          {/* 1. 外观与主题 */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
              <Palette className="w-3.5 h-3.5" />
              <span>外观与主题</span>
            </div>

            {/* 显示模式（明暗） */}
            <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-secondary/15">
              <div>
                <div className="text-sm font-medium">界面显示模式</div>
                <div className="text-xs text-muted-foreground mt-0.5">选择偏好的明暗界面风格</div>
              </div>
              <div className="flex items-center gap-1 bg-input-background border border-border rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => {
                    update({ theme: 'light' });
                    document.documentElement.classList.remove('dark');
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    settings.theme === 'light'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  aria-label="浅色模式"
                >
                  <Sun className="w-3.5 h-3.5" />
                  <span>浅色</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    update({ theme: 'dark' });
                    document.documentElement.classList.add('dark');
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    settings.theme === 'dark'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  aria-label="深色模式"
                >
                  <Moon className="w-3.5 h-3.5" />
                  <span>深色</span>
                </button>
              </div>
            </div>

            {/* 点缀主题色 */}
            <div>
              <div className="text-xs text-muted-foreground mb-2">点缀主题色</div>
              <div
                className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                role="group"
                aria-label="点缀主题色"
              >
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
                      className={`flex flex-col items-start gap-1 p-2.5 rounded-lg border text-left transition-all ${
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
                      <span className="text-xs font-semibold text-foreground mt-1">{dot.name}</span>
                      <span className="text-[10px] text-muted-foreground line-clamp-1">{dot.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 2. 存储与目录 */}
          <div className="space-y-3 pt-2 border-t border-border">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{mode === 'home' ? '项目存储' : '工程目录'}</span>
            </div>

            {/* 默认项目目录 */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1.5 font-mono-family">
                默认项目目录
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
              <p className="mt-1 text-xs text-muted-foreground">创建新项目时默认放置在此目录下</p>
            </div>

            {/* 编辑器专属：预览模板目录 */}
            {mode === 'editor' && (
              <div>
                <label className="block text-xs text-muted-foreground mb-1.5 font-mono-family">
                  预览模板目录
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
                  默认使用自动检测的运行时模板。高级用户可选择本地修改过的 `WebGAL_Template` 目录覆盖。
                </p>
              </div>
            )}
          </div>

          {/* 3. AI 服务设置入口 */}
          {onOpenAiSettings && (
            <div className="pt-2 border-t border-border">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-primary/5">
                <div className="flex items-start gap-2.5">
                  <Bot className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                  <div>
                    <div className="text-sm font-medium">AI 接口与大模型配置</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {mode === 'home'
                        ? '配置全局剧本对话、立绘生图及配音模型（DeepSeek、OpenAI、Claude 等），所有项目通用'
                        : '管理剧本 Agent、立绘生图 Agent 及语音合成的模型与 API Key'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onOpenAiSettings}
                  className="shrink-0 px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 text-xs font-semibold transition-all"
                  aria-label="打开 AI 设置"
                >
                  打开 AI 设置 →
                </button>
              </div>
            </div>
          )}

          {/* 4. WebGAL 运行时管理 */}
          <div className="pt-2 border-t border-border space-y-2">
            <label className="block text-xs uppercase tracking-widest text-muted-foreground font-mono-family">
              WebGAL 运行时引擎
            </label>

            <div className="flex items-start gap-2 p-3 rounded-lg border border-border bg-secondary/10">
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

            <p className="text-xs text-muted-foreground">
              从 OpenWebGAL Release 下载最新版，安装到应用数据目录（优先于内置版本）
            </p>

            {runtimeError && (
              <div className="px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                {runtimeError}
              </div>
            )}
          </div>

          {error && (
            <div className="px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
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
  );
}
