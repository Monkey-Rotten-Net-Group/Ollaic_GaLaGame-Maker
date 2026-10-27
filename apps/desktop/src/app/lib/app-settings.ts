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
const HOME_THEME_STORAGE_KEY = 'ollaic-home-theme';

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
    const homeTheme = localStorage.getItem(HOME_THEME_STORAGE_KEY) as 'dark' | 'light' | null;
    return {
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
        homeTheme === 'dark' || homeTheme === 'light'
          ? homeTheme
          : parsed.theme ||
            (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  localStorage.setItem(SEED_STORAGE_KEY, settings.seedColor);
  localStorage.setItem(HOME_THEME_STORAGE_KEY, settings.theme);
  applyAppAppearance(settings);
}

export function applyAppAppearance(settings: Pick<AppSettings, 'theme' | 'seedColor'>) {
  document.documentElement.dataset.seed = settings.seedColor;
  document.documentElement.classList.toggle('dark', settings.theme === 'dark');
}
