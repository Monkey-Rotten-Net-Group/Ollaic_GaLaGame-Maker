export type SeedColor = 'violet' | 'crimson' | 'teal' | 'amber';

export interface AppSettings {
  defaultProjectDir: string;
  runtimeTemplateDir: string;
  language: 'zh-CN' | 'en';
  theme: 'dark' | 'light';
  seedColor: SeedColor;
}

const STORAGE_KEY = 'webgal-app-settings';
const SEED_STORAGE_KEY = 'ollaic:ph-seed-color-v3';
// Legacy home-only theme toggle. App settings are now the single theme source,
// migrate its last choice before removing the key.
const LEGACY_HOME_THEME_STORAGE_KEY = 'ollaic-home-theme';

export const DEFAULT_APP_SETTINGS: AppSettings = {
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
    const legacyTheme = localStorage.getItem(LEGACY_HOME_THEME_STORAGE_KEY);
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      ...parsed,
      seedColor:
        savedSeed === 'violet' ||
        savedSeed === 'crimson' ||
        savedSeed === 'teal' ||
        savedSeed === 'amber'
          ? savedSeed
          : parsed.seedColor || 'violet',
      theme:
        parsed.theme === 'dark' || parsed.theme === 'light'
          ? parsed.theme
          : document.documentElement.classList.contains('dark')
            ? 'dark'
            : 'light',
    };
    if (legacyTheme === 'dark' || legacyTheme === 'light') {
      settings.theme = legacyTheme;
      saveAppSettings(settings);
    }
    localStorage.removeItem(LEGACY_HOME_THEME_STORAGE_KEY);
    return settings;
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  localStorage.setItem(SEED_STORAGE_KEY, settings.seedColor);
  applyAppAppearance(settings);
}

/** Persists only the theme, keeping every other saved app setting. */
export function saveAppTheme(theme: AppSettings['theme']): AppSettings {
  const next = { ...loadAppSettings(), theme };
  saveAppSettings(next);
  return next;
}

export function applyAppAppearance(settings: Pick<AppSettings, 'theme' | 'seedColor'>) {
  document.documentElement.dataset.seed = settings.seedColor;
  document.documentElement.classList.toggle('dark', settings.theme === 'dark');
}
