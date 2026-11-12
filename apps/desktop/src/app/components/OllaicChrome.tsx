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

import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuCheckboxItem,
} from './ui/dropdown-menu';

export type OllaicActiveView = 'editor' | 'worldline' | 'workflow' | 'assets';
export type OllaicSaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type OllaicSection = 'edit' | 'assets';

const WORKSPACE_VIEWS = [
  { id: 'editor', label: '剧本编辑', icon: BookOpen },
  { id: 'worldline', label: '场景图', icon: GitBranch },
  { id: 'workflow', label: '工作流', icon: Workflow },
  { id: 'assets', label: '资源库', icon: Boxes },
] as const;

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

  // Workspace navigation
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
  scriptView?: 'compact' | 'stream' | 'script';
  onScriptViewChange?: (view: 'compact' | 'stream' | 'script') => void;
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
  onImport, onExport, onSnapshots, onToggleScript, scriptMode, onOpenProject, onScriptViewChange,
  autoSave, onAutoSaveChange,
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
      {/* Project context and file actions */}
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
        <div className="ollaic-project-context flex items-center gap-1.5 min-w-0">
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
          <div className="hidden lg:flex items-center gap-0.5">
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

      {/* Search, save status, and project actions */}
      <div className="ollaic-topbar-end flex items-center gap-2">
        {/* Global search */}
        {onSearchChange && (
          <div className="relative hidden items-center md:flex">
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground opacity-70" />
            <input
              type="text"
              value={searchValue ?? ''}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder ?? '搜索台词 / 指令...'}
              className="h-7 w-28 2xl:w-44 rounded-lg border border-border/80 bg-surface-container-low pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:bg-surface-container-lowest focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all outline-none"
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
            <span className="hidden lg:inline">打包发布</span>
          </button>
        )}

        {(onImport || onExport || onSnapshots || onToggleScript || onAutoSaveChange || onScriptViewChange) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="ollaic-icon-button px-2 text-xs" aria-label="文件与编辑操作">更多</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onUndo && <DropdownMenuItem className="lg:hidden" disabled={fileDisabled} onSelect={onUndo}>撤销</DropdownMenuItem>}
              {onRedo && <DropdownMenuItem className="lg:hidden" disabled={fileDisabled} onSelect={onRedo}>重做</DropdownMenuItem>}
              {onSave && <DropdownMenuItem onSelect={onSave}>保存</DropdownMenuItem>}
              {onOpenProject && <DropdownMenuItem onSelect={onOpenProject}>打开项目</DropdownMenuItem>}
              {onImport && <DropdownMenuItem disabled={fileDisabled} onSelect={onImport}>导入场景</DropdownMenuItem>}
              {onExport && <DropdownMenuItem onSelect={onExport}>导出场景</DropdownMenuItem>}
              {onSnapshots && <DropdownMenuItem disabled={fileDisabled} onSelect={onSnapshots}>快照管理</DropdownMenuItem>}
              {onScriptViewChange && <>
                <DropdownMenuItem disabled={fileDisabled} onSelect={() => onScriptViewChange('compact')}>剧本视图</DropdownMenuItem>
                <DropdownMenuItem disabled={fileDisabled} onSelect={() => onScriptViewChange('stream')}>指令卡片</DropdownMenuItem>
                <DropdownMenuItem disabled={fileDisabled} onSelect={() => onScriptViewChange('script')}>脚本源码</DropdownMenuItem>
              </>}
              {!onScriptViewChange && onToggleScript && <DropdownMenuItem disabled={fileDisabled} onSelect={onToggleScript}>{scriptMode ? '返回剧本视图' : '编辑源码'}</DropdownMenuItem>}
              {onAutoSaveChange && <DropdownMenuCheckboxItem checked={autoSave} onCheckedChange={onAutoSaveChange}>自动保存</DropdownMenuCheckboxItem>}
            </DropdownMenuContent>
          </DropdownMenu>
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
      {projectId && (
        <nav className="ollaic-workspace-navigation" aria-label="工作区视图切换">
          {WORKSPACE_VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onViewChange?.(id)}
              aria-label={label}
              aria-current={activeView === id ? 'page' : undefined}
              className="ollaic-view-tab"
            >
              <Icon className="size-3.5" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
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
