import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ExternalLink, Loader2, Maximize2, Minimize2, PanelBottom, PictureInPicture2, RefreshCw, X } from 'lucide-react';
import type { useRuntimePreview } from '../../hooks/useRuntimePreview';
import { openInBrowser } from '../../lib/webgal-ipc';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export type PreviewLayout = 'hidden' | 'split' | 'float' | 'large';

const STORAGE_KEY = 'ollaic_webgal_preview_float';
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 428;

// Reserve space for the application toolbar and a small viewport margin.
function fitGeometry(geometry: FloatGeometry, minimized = false): FloatGeometry {
  const left = Math.min(10, window.innerWidth / 4);
  const top = Math.min(48, window.innerHeight / 4);
  const maxWidth = Math.max(1, window.innerWidth - left - 10);
  const maxHeight = Math.max(1, window.innerHeight - top - 10);
  const ratio = Math.max(1, geometry.height - 68) / geometry.width;
  const width = Math.min(geometry.width, maxWidth, Math.max(1, (maxHeight - 68) / ratio));
  const height = Math.min(maxHeight, Math.round(width * ratio) + 68);
  return {
    x: Math.max(left, Math.min(window.innerWidth - width - 10, geometry.x)),
    y: Math.max(top, Math.min(window.innerHeight - (minimized ? 44 : height) - 10, geometry.y)),
    width,
    height,
  };
}

interface PresetSize {
  id: '480p' | '640p' | '854p';
  label: string;
  width: number;
  height: number;
  description: string;
}

const PRESET_SIZES: PresetSize[] = [
  { id: '480p', label: '480P', width: 480, height: Math.round(480 * 9 / 16) + 68, description: '480 × 270 · 紧凑小窗，最少遮挡' },
  { id: '640p', label: '640P', width: 640, height: Math.round(640 * 9 / 16) + 68, description: '640 × 360 · 标准推荐，视线平衡' },
  { id: '854p', label: '854P', width: 854, height: Math.round(854 * 9 / 16) + 68, description: '854 × 480 · 大屏精修，细节立现' },
];

interface FloatGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function loadInitialGeometry(): FloatGeometry {
  if (typeof window === 'undefined') {
    return { x: 100, y: 120, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if ([parsed.x, parsed.y, parsed.width, parsed.height].every(Number.isFinite)
        && parsed.width > 0 && parsed.height > 68) {
        return fitGeometry(parsed);
      }
    }
  } catch {
    // ignore parse error and use default
  }
  const defaultY = Math.max(60, window.innerHeight - DEFAULT_HEIGHT - 40);
  const defaultX = Math.max(90, 100);
  return fitGeometry({ x: defaultX, y: defaultY, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
}

export function RuntimePreviewPanel({ preview, layout, dockLayout = 'split', height, sceneName, dirty, onLayoutChange, onSettings }: {
  preview: ReturnType<typeof useRuntimePreview>;
  layout: PreviewLayout;
  dockLayout?: 'split' | 'float';
  height?: number;
  sceneName: string;
  dirty: boolean;
  onLayoutChange: (layout: PreviewLayout) => void;
  onSettings: () => void;
}) {
  const [geometry, setGeometry] = useState<FloatGeometry>(loadInitialGeometry);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hasDragMoved, setHasDragMoved] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const collapsed = layout === 'float' && isMinimized;

  useEffect(() => {
    if (layout !== 'float') return;
    const fitToViewport = () => setGeometry((previous) => {
      const next = fitGeometry(previous, collapsed);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Storage is optional. */ }
      return next;
    });
    fitToViewport();
    window.addEventListener('resize', fitToViewport);
    return () => window.removeEventListener('resize', fitToViewport);
  }, [layout, collapsed]);

  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Sync geometry changes to localStorage
  const saveGeometry = (next: FloatGeometry) => {
    setGeometry(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage error
    }
  };

  // Header drag handlers for floating mode
  const handleHeaderMouseDown = (event: React.MouseEvent) => {
    if (layout !== 'float' || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    setIsDragging(true);
    setHasDragMoved(false);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      initialX: geometry.x,
      initialY: geometry.y,
    };
    event.preventDefault();
  };

  // Resize handle for floating mode
  const handleResizeMouseDown = (event: React.MouseEvent) => {
    if (layout !== 'float' || isMinimized || event.button !== 0) return;
    setIsResizing(true);
    resizeRef.current = {
      startX: event.clientX,
      startWidth: geometry.width,
    };
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    if (!isDragging && !isResizing) return;
    let latestGeometry = geometry;
    const finishInteraction = () => {
      if (!dragRef.current && !resizeRef.current) return;
      dragRef.current = null;
      resizeRef.current = null;
      setIsDragging(false);
      setHasDragMoved(false);
      setIsResizing(false);
      saveGeometry(latestGeometry);
    };

    const handleMouseMove = (event: MouseEvent) => {
      if ((event.buttons & 1) === 0) {
        finishInteraction();
        return;
      }
      if (isDragging && dragRef.current) {
        const dx = event.clientX - dragRef.current.startX;
        const dy = event.clientY - dragRef.current.startY;
        if (!hasDragMoved && Math.hypot(dx, dy) < 3) return;
        setHasDragMoved(true);
        const nextX = dragRef.current.initialX + dx;
        const nextY = dragRef.current.initialY + dy;
        latestGeometry = fitGeometry({ ...latestGeometry, x: nextX, y: nextY }, collapsed);
        setGeometry(latestGeometry);
      } else if (isResizing && resizeRef.current) {
        const dx = event.clientX - resizeRef.current.startX;
        const newWidth = Math.max(360, resizeRef.current.startWidth + dx);
        const newHeight = Math.round(newWidth * (9 / 16)) + 68;
        latestGeometry = fitGeometry({ ...latestGeometry, width: newWidth, height: newHeight });
        setGeometry(latestGeometry);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', finishInteraction);
    window.addEventListener('blur', finishInteraction);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', finishInteraction);
      window.removeEventListener('blur', finishInteraction);
    };
  }, [isDragging, isResizing, geometry, collapsed, hasDragMoved]);

  const currentPreset = PRESET_SIZES.find((p) => Math.abs(p.width - geometry.width) <= 12);
  const currentLabel = currentPreset ? currentPreset.label : '自定义';

  const applyPreset = (preset: PresetSize) => {
    const nextGeometry = fitGeometry({
      x: geometry.x,
      y: geometry.y,
      width: preset.width,
      height: preset.height,
    }, collapsed);
    saveGeometry(nextGeometry);
  };

  const panelStyle: React.CSSProperties = layout === 'float' ? {
    left: `${geometry.x}px`,
    top: `${geometry.y}px`,
    width: `${geometry.width}px`,
    height: isMinimized ? '44px' : `${geometry.height}px`,
  } : layout === 'split' && height ? {
    height: `${height}px`,
    flex: `0 0 ${height}px`,
  } : {};

  return (
    <>
      {/* Invisible overlay while dragging/resizing so iframe doesn't swallow mouse events */}
      {((isDragging && hasDragMoved) || isResizing) && (
        <div className="fixed inset-0 z-[100] cursor-grabbing select-none" />
      )}

      <section
        aria-label="实时预览区域"
        className={`editor-preview-pane ${layout === 'hidden' ? 'hidden' : ''} ${layout === 'float' ? 'editor-preview-floating' : ''}`}
        style={panelStyle}
      >
        <header
          className={`flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-container-lowest px-3 ${layout === 'float' ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onMouseDown={handleHeaderMouseDown}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest('button')) return;
            if (layout === 'float') setIsMinimized((v) => !v);
          }}
          title={layout === 'float' ? '按住可拖动浮窗位置，双击可折叠/展开' : undefined}
        >
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className={`size-1.5 shrink-0 rounded-full ${preview.ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <strong className="shrink-0">实时预览</strong>
            <span className="truncate text-muted-foreground" title={sceneName}>{dirty ? '当前草稿' : sceneName}</span>
            {layout === 'float' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border bg-surface-container-low px-1.5 text-[10px] font-semibold text-primary transition-colors hover:bg-surface-container-high focus:outline-none"
                    title="切换画中画尺寸"
                    aria-label="切换画中画尺寸"
                  >
                    <span>{currentLabel}</span>
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52 bg-surface-container-lowest text-xs shadow-xl">
                  <DropdownMenuLabel className="text-[10px] text-muted-foreground font-normal">画中画视窗尺寸</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {PRESET_SIZES.map((preset) => {
                    const isActive = currentPreset?.id === preset.id;
                    return (
                      <DropdownMenuItem
                        key={preset.id}
                        onClick={() => applyPreset(preset)}
                        className={`flex flex-col items-start gap-0.5 py-1.5 cursor-pointer ${isActive ? 'bg-primary/10 text-primary font-semibold' : ''}`}
                      >
                        <div className="flex w-full items-center justify-between">
                          <span>{preset.label}</span>
                          {isActive && <Check className="size-3 text-primary" />}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-normal">{preset.description}</span>
                      </DropdownMenuItem>
                    );
                  })}
                  {!currentPreset && (
                    <>
                      <DropdownMenuSeparator />
                      <div className="px-2 py-1 text-[10px] text-muted-foreground">
                        自定义: {Math.round(geometry.width)} × {Math.round(geometry.height - 68)}
                      </div>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="ollaic-icon-button"
              onClick={preview.ready ? preview.sync : preview.reconnect}
              aria-label={preview.ready ? '重新同步预览' : '重连预览'}
              title={preview.ready ? '从头预览当前场景' : '重连预览'}
            >
              <RefreshCw className="size-4" />
            </button>

            {/* 保留在浏览器中单独打开 */}
            {preview.url && (
              <button
                type="button"
                className="ollaic-icon-button hidden sm:flex"
                onClick={() => { void openInBrowser(preview.url!); }}
                aria-label="在浏览器中预览"
                title="在独立的浏览器窗口中打开预览"
              >
                <ExternalLink className="size-4" />
              </button>
            )}

            {/* 切换停靠 / 浮窗模式 */}
            {layout === 'float' ? (
              <button
                type="button"
                className="ollaic-icon-button"
                onClick={() => onLayoutChange('split')}
                aria-label="吸附到底部底栏"
                title="吸附到编辑器左下方"
              >
                <PanelBottom className="size-4" />
              </button>
            ) : layout === 'split' ? (
              <button
                type="button"
                className="ollaic-icon-button"
                onClick={() => onLayoutChange('float')}
                aria-label="脱离为悬浮画中画"
                title="脱离为自由悬浮画中画"
              >
                <PictureInPicture2 className="size-4" />
              </button>
            ) : null}

            {/* 全屏放大 / 还原 */}
            <button
              type="button"
              className="ollaic-icon-button"
              onClick={() => onLayoutChange(layout === 'large' ? dockLayout : 'large')}
              aria-label={layout === 'large' ? '返回工作区预览' : '全屏大预览'}
              title={layout === 'large' ? '返回工作区预览' : '全屏大预览'}
            >
              {layout === 'large' ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>

            {/* 收起 / 关闭 */}
            <button
              type="button"
              className="ollaic-icon-button"
              onClick={() => onLayoutChange('hidden')}
              aria-label="收起预览"
              title="收起预览"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        {/* Keep the engine mounted while collapsed to preserve playback state. */}
          <div hidden={collapsed} className={collapsed ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
            <div
              className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0b0f19] p-2"
              style={{ containerType: 'size' }}
            >
              {preview.url && (
                <div
                  className="relative flex items-center justify-center overflow-hidden rounded bg-black shadow-2xl ring-1 ring-white/10"
                  style={{
                    width: 'min(100cqw, calc(100cqh * 16 / 9))',
                    height: 'min(100cqh, calc(100cqw * 9 / 16))',
                    aspectRatio: '16 / 9',
                  }}
                >
                  <iframe
                    key={`${preview.url}:${preview.revision}`}
                    title="WebGAL 实时预览"
                    src={preview.url}
                    onLoad={preview.onFrameLoad}
                    allow="autoplay; fullscreen"
                    allowFullScreen
                    className="h-full w-full border-0"
                  />
                </div>
              )}
              {(!preview.url || preview.error) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0f19] p-5 text-center text-sm text-slate-200">
                  {preview.error ? (
                    <>
                      <p role="alert">{preview.error}</p>
                      <div className="flex gap-3">
                        <button type="button" onClick={preview.reconnect} className="rounded border border-slate-600 px-3 py-1.5">重连预览</button>
                        <button type="button" onClick={onSettings} className="rounded border border-slate-600 px-3 py-1.5">引擎设置</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Loader2 className="size-5 animate-spin" />
                      <p>正在连接 WebGAL 引擎</p>
                    </>
                  )}
                </div>
              )}
            </div>

            <p className="shrink-0 border-t border-border bg-surface-container-lowest px-3 py-1.5 text-[10px] text-muted-foreground">
              {preview.ready ? '编辑后自动同步草稿 · 预览不会保存文件' : '等待引擎连接后自动同步'}
            </p>

            {/* 浮窗右下角 16:9 等比拉伸手柄 */}
            {layout === 'float' && (
              <div
                className="editor-preview-resize-handle"
                onMouseDown={handleResizeMouseDown}
                title="按住等比缩放浮窗大小"
              />
            )}
          </div>
      </section>
    </>
  );
}
