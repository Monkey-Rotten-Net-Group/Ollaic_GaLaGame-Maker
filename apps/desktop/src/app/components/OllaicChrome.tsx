import { useLocation, useNavigate } from 'react-router';
import type * as React from 'react';
import {
  BookOpen,
  Boxes,
  ChevronDown,
  Cloud,
  CloudOff,
  FileText,
  FolderOpen,
  GitBranch,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Sparkles,
  Upload,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { sceneDisplayName, type SceneHeader } from '../lib/webgal-ipc';

export type OllaicActiveView = 'editor' | 'worldline' | 'workflow' | 'assets';
export type OllaicSaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type OllaicSection = 'edit' | 'assets';

export interface OllaicTopBarProps {
  projectId?: string;
  projectName?: string;
  title?: string;

  // File & Scene Context (Left)
  currentFile?: string;
  scenes?: string[];
  sceneHeaders?: Record<string, SceneHeader>;
  onSelectFile?: (file: string) => void;
  onOpenSceneManager?: () => void;
  fileDisabled?: boolean;

  // Undo / Redo
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;

  // Center: Segmented View Navigation
  activeView?: OllaicActiveView;
  onViewChange?: (view: OllaicActiveView) => void;

  // Search
  searchValue?: string;
  onSearchChange?: (val: string) => void;
  searchPlaceholder?: string;

  // Save & Status
  saveStatus?: OllaicSaveStatus;
  isDirty?: boolean;
  onSave?: () => void;

  // Actions (Right)
  onRun?: () => void;
  previewActive?: boolean;
  onPublish?: () => void;
  onSettings?: () => void;

  // Side Panel Toggle
  agentOpen?: boolean;
  agentBusy?: boolean;
  onToggleAgent?: () => void;

  // Navigation guard
  onBeforeNavigate?: (action: () => void) => void;

  // Backward compatibility props
  activeSection?: OllaicSection;
  autoSave?: boolean;
  onAutoSaveChange?: (enabled: boolean) => void;
  onImport?: () => void;
  onExport?: () => void;
  onOpenProject?: () => void;
  onSnapshots?: () => void;
  onToggleScript?: () => void;
  scriptMode?: boolean;
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
  projectName,
  onBeforeNavigate,
  title,
  currentFile,
  scenes,
  sceneHeaders,
  onSelectFile,
  onOpenSceneManager,
  fileDisabled = false,
  onUndo,
  onRedo,
  activeView = 'editor',
  onViewChange,
  onRun,
  previewActive = false,
  onPublish,
  onSave,
  onSearchChange,
  searchValue,
  searchPlaceholder,
  saveStatus = 'idle',
  isDirty = false,
  onSettings,
  agentOpen,
  agentBusy,
  onToggleAgent,
}: OllaicTopBarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigateTo = (path: string) => {
    if (location.pathname === path) return;
    const action = () => navigate(path);
    if (onBeforeNavigate) onBeforeNavigate(action);
    else action();
  };

  return (
    <header className="ollaic-topbar" aria-label={title ? `${title}工具栏` : '应用工具栏'}>
      {/* Zone 1: Left - Brand, File Context & History */}
      <div className="ollaic-topbar-start flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-full px-2 py-1 text-foreground transition-all hover:bg-surface-container"
          onClick={() => navigateTo('/')}
          aria-label="Ollaic GalGame Studio，返回首页"
          title="返回首页"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-2xs">
            <Sparkles className="size-3.5" />
          </span>
          <span className="font-display-family text-sm font-extrabold text-foreground">
            Ollaic
          </span>
        </button>

        <div className="hidden sm:block h-3.5 w-px bg-border/80" />

        {/* Project (Parent) + File/Section (Child) Breadcrumb Hierarchy */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="text-xs font-semibold text-foreground/80 truncate max-w-[110px] sm:max-w-[150px]"
            title={`当前工程: ${projectName || projectId || 'WebGAL 工程'}`}
          >
            {projectName || projectId || 'WebGAL 工程'}
          </span>
          <span className="text-muted-foreground/50 text-xs select-none">/</span>

          {currentFile ? (
            <div className="flex items-center gap-1">
              <div className="relative flex items-center">
                <FileText className="pointer-events-none absolute left-2 size-3 text-muted-foreground opacity-70" />
                <select
                  aria-label="当前场景文件"
                  value={currentFile}
                  disabled={fileDisabled}
                  onChange={(e) => onSelectFile?.(e.target.value)}
                  className="h-7 max-w-32 sm:max-w-40 rounded-lg border border-border/80 bg-surface-container-low pl-6 pr-5 text-xs font-semibold text-foreground hover:bg-surface-container transition-colors cursor-pointer appearance-none truncate"
                >
                  {(scenes && scenes.length > 0 ? scenes : [currentFile]).map((scene) => (
                    <option key={scene} value={scene}>
                      {sceneHeaders?.[scene]?.chapter || sceneHeaders?.[scene]?.outline
                        ? `${sceneDisplayName(scene, sceneHeaders[scene])} · ${scene}`
                        : scene}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1 size-3 text-muted-foreground opacity-70" />
              </div>

              {onOpenSceneManager && (
                <button
                  type="button"
                  onClick={onOpenSceneManager}
                  disabled={fileDisabled}
                  className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
                  aria-label="场景管理"
                  title="打开场景文件管理器"
                >
                  <FolderOpen className="size-3.5" />
                </button>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground font-semibold">
              {title || '素材库'}
            </span>
          )}
        </div>

        {/* Undo / Redo */}
        {(onUndo || onRedo) && (
          <div className="hidden md:flex items-center gap-0.5">
            <button
              type="button"
              onClick={onUndo}
              disabled={!onUndo || fileDisabled}
              className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-30"
              title="撤销 (⌘Z)"
              aria-label="撤销"
            >
              <RotateCcw className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!onRedo || fileDisabled}
              className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-30"
              title="重做 (⇧⌘Z)"
              aria-label="重做"
            >
              <RotateCw className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Zone 2: Center - Unified Segmented View Control */}
      <div className="ollaic-topbar-center flex items-center justify-center">
        {projectId && (
          <nav
            className="flex items-center rounded-lg border border-border/70 bg-surface-container-low p-0.5 text-xs font-medium shadow-2xs"
            aria-label="工作区视图切换"
          >
            <button
              type="button"
              onClick={() => onViewChange?.('editor')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-all ${
                activeView === 'editor'
                  ? 'bg-surface-container-lowest text-primary font-bold shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <BookOpen className="size-3.5" />
              <span className="hidden sm:inline">剧本编辑</span>
            </button>
            <button
              type="button"
              onClick={() => onViewChange?.('worldline')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-all ${
                activeView === 'worldline'
                  ? 'bg-surface-container-lowest text-primary font-bold shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <GitBranch className="size-3.5" />
              <span className="hidden sm:inline">场景图</span>
            </button>
            <button
              type="button"
              onClick={() => onViewChange?.('workflow')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-all ${
                activeView === 'workflow'
                  ? 'bg-surface-container-lowest text-primary font-bold shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Workflow className="size-3.5" />
              <span className="hidden sm:inline">工作流</span>
            </button>
            <button
              type="button"
              onClick={() => onViewChange?.('assets')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-all ${
                activeView === 'assets'
                  ? 'bg-surface-container-lowest text-primary font-bold shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Boxes className="size-3.5" />
              <span className="hidden sm:inline">资源库</span>
            </button>
          </nav>
        )}
      </div>

      {/* Zone 3: Right - Global Actions & Panel Controls */}
      <div className="ollaic-topbar-end flex items-center gap-2">
        {/* Compact Global Search Capsule (Always visible) */}
        {onSearchChange && (
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground opacity-70" />
            <input
              type="text"
              value={searchValue ?? ''}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder ?? '搜索台词 / 指令...'}
              className="h-7 w-28 sm:w-36 md:w-44 rounded-lg border border-border/80 bg-surface-container-low pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:w-48 focus:bg-surface-container-lowest focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all outline-none"
              aria-label="全局搜索"
            />
            <kbd className="pointer-events-none absolute right-1.5 text-[9px] font-mono text-muted-foreground opacity-60">⌘K</kbd>
          </div>
        )}

        {/* AutoSave & Dirty Status Indicator */}
        <div className="flex items-center px-1">
          {saveStatus === 'saving' ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground select-none" role="status">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span className="hidden sm:inline">保存中…</span>
            </span>
          ) : saveStatus === 'error' ? (
            <button
              type="button"
              onClick={onSave}
              className="flex items-center gap-1 text-xs font-semibold text-destructive hover:underline cursor-pointer"
              title="保存失败，点击立即重试"
              role="status"
            >
              <CloudOff className="size-3.5" />
              <span className="hidden sm:inline">保存失败</span>
            </button>
          ) : isDirty ? (
            <button
              type="button"
              onClick={onSave}
              className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400 hover:text-amber-500 transition-colors cursor-pointer"
              title="存在未保存修改，点击即时保存 (⌘S)"
              role="status"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              <span>未保存</span>
              <kbd className="hidden sm:inline font-mono text-[9px] opacity-75">⌘S</kbd>
            </button>
          ) : (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground/70 select-none"
              title="所有更改已自动保存至本地"
              role="status"
            >
              <span className="size-1.5 rounded-full bg-emerald-500/80" />
              <span className="hidden sm:inline">已保存</span>
            </span>
          )}
        </div>

        {/* Secondary Action: ▷ 实时预览 */}
        {onRun && (
          <button
            type="button"
            onClick={onRun}
            className={`flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-all ${
              previewActive
                ? 'bg-primary/15 text-primary border-primary/30 font-semibold'
                : 'border-border/80 bg-surface-container-low text-foreground hover:bg-surface-container'
            }`}
            title="实时运行 WebGAL 预览 (F5)"
            aria-label="实时预览"
            aria-pressed={previewActive}
          >
            <Play className="size-3" />
            <span className="hidden sm:inline">实时预览</span>
          </button>
        )}

        {/* Primary CTA: [↑ 打包发布] */}
        {onPublish && (
          <button
            type="button"
            onClick={onPublish}
            className="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-2xs transition-all hover:bg-primary/90 active:scale-95"
            aria-label="打包发布"
            title="打包发布 WebGAL 独立运行包"
          >
            <Upload className="size-3.5" />
            <span>打包发布</span>
          </button>
        )}

        {/* Settings */}
        {onSettings && (
          <button
            type="button"
            onClick={onSettings}
            className="ollaic-icon-button h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label="设置"
            title="应用偏好设置"
          >
            <Settings className="size-4" />
          </button>
        )}

        {/* Side Panel Toggle */}
        {onToggleAgent && (
          <button
            type="button"
            onClick={onToggleAgent}
            className={`ollaic-icon-button relative h-7 w-7 ${
              agentOpen ? 'bg-primary/12 text-primary font-semibold' : 'text-muted-foreground hover:text-foreground'
            }`}
            aria-label={agentOpen ? '收起 Agent 面板' : '展开 Agent 面板'}
            aria-expanded={agentOpen}
            title={agentOpen ? '收起 Agent 面板' : '展开 Agent 面板'}
          >
            {agentOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            {agentBusy && (
              <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
            )}
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
