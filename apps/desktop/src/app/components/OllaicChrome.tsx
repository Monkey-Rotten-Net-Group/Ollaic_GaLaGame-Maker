import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type * as React from 'react';
import {
  BookOpen,
  Boxes,
  Camera,
  Cloud,
  CloudOff,
  FileDown,
  FileUp,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Settings,
  Sparkles,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { Switch } from './ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

type OllaicSection = 'edit' | 'assets';
type SeedColor = 'violet' | 'crimson' | 'teal' | 'amber';

const SEED_STORAGE_KEY = 'ollaic:ph-seed-color-v3';

export type OllaicSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface OllaicTopBarProps {
  projectId?: string;
  activeSection?: OllaicSection;
  onBeforeNavigate?: (action: () => void) => void;
  title?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onRun?: () => void;
  onPublish?: () => void;
  onSave?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  onOpenProject?: () => void;
  onSnapshots?: () => void;
  onToggleScript?: () => void;
  scriptMode?: boolean;
  onSearchChange?: (value: string) => void;
  searchValue?: string;
  searchPlaceholder?: string;
  saveStatus?: OllaicSaveStatus;
  autoSave?: boolean;
  onAutoSaveChange?: (enabled: boolean) => void;
  onSettings?: () => void;
}

interface OllaicPanelProps {
  title: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
}

export function OllaicTopBar({
  projectId,
  activeSection,
  onBeforeNavigate,
  title,
  onUndo,
  onRedo,
  onRun,
  onPublish,
  onSave,
  onImport,
  onExport,
  onOpenProject,
  onSnapshots,
  onToggleScript,
  scriptMode,
  onSearchChange,
  searchValue,
  searchPlaceholder,
  saveStatus = 'idle',
  autoSave,
  onAutoSaveChange,
  onSettings,
}: OllaicTopBarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigateTo = (path: string) => {
    if (location.pathname === path) return;
    const action = () => navigate(path);
    if (onBeforeNavigate) onBeforeNavigate(action);
    else action();
  };
  const [seedColor, setSeedColor] = useState<SeedColor>(() => {
    try {
      const saved = window.localStorage.getItem(SEED_STORAGE_KEY);
      if (saved === 'violet' || saved === 'crimson' || saved === 'teal' || saved === 'amber') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'violet';
  });

  useEffect(() => {
    document.documentElement.dataset.seed = seedColor;
    try {
      window.localStorage.setItem(SEED_STORAGE_KEY, seedColor);
    } catch {
      // ignore
    }
  }, [seedColor]);

  const topActions = [
    { label: '撤销', icon: RotateCcw, handler: onUndo },
    { label: '重做', icon: RotateCw, handler: onRedo },
    { label: '运行预览', icon: Play, handler: onRun },
    { label: '打包发布', icon: Upload, handler: onPublish },
    { label: '保存', icon: Save, handler: onSave, primary: true, dimWhenAutoSave: true },
  ].filter((action) => action.handler);

  const secondaryActions = [
    { label: '打开项目', icon: FolderOpen, handler: onOpenProject },
    { label: '导入场景', icon: FileUp, handler: onImport },
    { label: '导出场景', icon: FileDown, handler: onExport },
    { label: '快照管理', icon: Camera, handler: onSnapshots },
  ].filter((action) => action.handler);

  const SaveIndicatorIcon =
    saveStatus === 'saving' ? Loader2 : saveStatus === 'error' ? CloudOff : Cloud;
  const saveIndicatorTitle =
    saveStatus === 'saving'
      ? '保存中...'
      : saveStatus === 'saved'
        ? '已保存'
        : saveStatus === 'error'
          ? '保存失败'
          : '未保存';
  const saveIndicatorTone =
    saveStatus === 'error'
      ? 'text-destructive'
      : saveStatus === 'saved'
        ? 'text-tertiary'
        : 'text-muted-foreground';

  return (
    <header className="ollaic-topbar" aria-label={title ? `${title}工具栏` : '应用工具栏'}>
      <div className="ollaic-topbar-start">
        <button
          type="button"
          className="ollaic-topbar-island ollaic-topbar-brand"
          aria-label="Ollaic GalGame Studio，返回首页"
          title="返回首页"
          onClick={() => navigateTo('/')}
        >
          <span
            className="hidden h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground sm:flex"
            aria-hidden="true"
          >
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <span className="font-display-family text-[15px] font-extrabold leading-none text-foreground">
            Ollaic
          </span>
          <span
            className="hidden rounded-full px-2.5 py-0.5 text-[11px] font-bold sm:inline"
            style={{
              background: 'var(--badge-soft-bg, #f9d8e6)',
              color: 'var(--badge-soft-text, #5c1936)',
            }}
          >
            GalGame Studio
          </span>
        </button>
        {projectId && (
          <nav className="ollaic-topbar-island ollaic-view-switch" aria-label="核心视图">
            {(
              [
                { id: 'edit', label: '编辑', icon: BookOpen, path: `/editor/${projectId}` },
                { id: 'assets', label: '资源库', icon: Boxes, path: `/editor/${projectId}/assets` },
              ] as const
            ).map(({ id, label, icon: Icon, path }) => (
              <button
                key={id}
                type="button"
                className="ollaic-view-tab"
                aria-current={activeSection === id ? 'page' : undefined}
                onClick={() => navigateTo(path)}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>

      {/* Editor actions */}
      {(topActions.length > 0 || secondaryActions.length > 0) && (
        <nav
          className="ollaic-topbar-island hidden min-[1100px]:inline-flex"
          aria-label="编辑器快捷操作"
        >
          {topActions.map(({ label, icon: Icon, handler, primary, dimWhenAutoSave }) => (
            <button
              key={label}
              type="button"
              onClick={handler}
              className={
                primary
                  ? `ollaic-top-action bg-primary/12 text-primary hover:bg-primary/20 ${dimWhenAutoSave && autoSave ? 'opacity-60' : ''}`
                  : 'ollaic-top-action'
              }
              title={dimWhenAutoSave && autoSave ? '已开启自动保存，也可手动保存' : label}
              aria-label={label}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{label}</span>
            </button>
          ))}
          {secondaryActions.length > 0 && topActions.length > 0 && (
            <div className="mx-1 h-4 w-px bg-border" />
          )}
          {secondaryActions.map(({ label, icon: Icon, handler }) => (
            <button
              key={label}
              type="button"
              onClick={handler}
              className="ollaic-top-action text-muted-foreground hover:text-foreground"
              aria-label={label}
              title={label}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden min-[1800px]:inline">{label}</span>
            </button>
          ))}
        </nav>
      )}

      {/* 3. Right Search, Auto-Save, Seed Color Dots & Settings Floating Pill Island */}
      <div className="ollaic-topbar-island">
        {(topActions.length > 0 || secondaryActions.length > 0) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ollaic-icon-button min-[1100px]:hidden"
                aria-label="更多编辑操作"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {[...topActions, ...secondaryActions].map(({ label, icon: Icon, handler }) => (
                <DropdownMenuItem key={label} onSelect={handler}>
                  <Icon className="h-4 w-4" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onToggleScript && (
          <button
            type="button"
            onClick={onToggleScript}
            className={`ollaic-top-action text-xs ${scriptMode ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            aria-label={scriptMode ? '切换到指令流视图' : '切换到脚本编辑器'}
            title={scriptMode ? '指令流视图' : '脚本编辑器'}
          >
            {scriptMode ? '指令流' : '脚本'}
          </button>
        )}
        {onSearchChange && (
          <div className="ollaic-top-search hidden min-[1600px]:flex">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchValue ?? ''}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder ?? '搜索...'}
              className="ollaic-top-search-input"
              aria-label="搜索"
            />
          </div>
        )}
        {onAutoSaveChange && (
          <div className="flex items-center gap-1.5 pl-1">
            <label className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground cursor-pointer select-none">
              <Switch
                aria-label="自动保存"
                checked={autoSave}
                onCheckedChange={onAutoSaveChange}
                className="scale-75"
              />
              <span className="hidden sm:inline">自动保存</span>
            </label>
            {saveStatus !== 'idle' && (
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full ${saveIndicatorTone}`}
                title={saveIndicatorTitle}
                aria-label={saveIndicatorTitle}
              >
                <SaveIndicatorIcon
                  className={`h-3.5 w-3.5 ${saveStatus === 'saving' ? 'animate-spin' : ''}`}
                />
              </span>
            )}
          </div>
        )}

        {/* Subtle 4-Seed Accent Dots (Synced with ProjectHome) */}
        <div
          className="hidden sm:inline-flex items-center gap-1.5 px-1.5"
          role="group"
          aria-label="点缀主题色"
        >
          {(
            [
              { id: 'violet', color: '#65558f', label: '柔雾鸢尾' },
              { id: 'crimson', color: '#9e2a47', label: '绯樱酒红' },
              { id: 'teal', color: '#0f7685', label: '晴空青碧' },
              { id: 'amber', color: '#d97706', label: '暮光琥珀' },
            ] as const
          ).map((dot) => (
            <button
              key={dot.id}
              type="button"
              onClick={() => setSeedColor(dot.id)}
              title={dot.label}
              aria-label={`${dot.label}主题`}
              style={{
                width: 11,
                height: 11,
                borderRadius: 999,
                background: dot.color,
                border:
                  seedColor === dot.id ? '2px solid var(--foreground)' : '2px solid transparent',
                transform: seedColor === dot.id ? 'scale(1.2)' : 'scale(1)',
                padding: 0,
              }}
            />
          ))}
        </div>

        {onSettings && (
          <button
            type="button"
            onClick={onSettings}
            className="ollaic-icon-button"
            aria-label="设置"
          >
            <Settings className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
}

export function OllaicPanel({
  title,
  icon: Icon,
  action,
  children,
  className = '',
  headerClassName = '',
}: OllaicPanelProps) {
  return (
    <section className={`ollaic-panel ${className}`}>
      <header className={`ollaic-panel-header ${headerClassName}`}>
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-primary" />}
          <span className="truncate">{title}</span>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
