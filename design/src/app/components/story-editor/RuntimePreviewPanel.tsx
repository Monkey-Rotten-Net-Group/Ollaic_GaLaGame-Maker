import { ExternalLink, Loader2, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import type { useRuntimePreview } from '../../hooks/useRuntimePreview';
import { openInBrowser } from '../../lib/webgal-ipc';

export type PreviewLayout = 'hidden' | 'split' | 'large';

export function RuntimePreviewPanel({ preview, layout, sceneName, dirty, onLayoutChange, onSettings }: {
  preview: ReturnType<typeof useRuntimePreview>;
  layout: PreviewLayout;
  sceneName: string;
  dirty: boolean;
  onLayoutChange: (layout: PreviewLayout) => void;
  onSettings: () => void;
}) {
  return (
    <section aria-label="实时预览区域" className={`editor-preview-pane ${layout === 'hidden' ? 'hidden' : ''}`}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-container-lowest px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className={`size-1.5 shrink-0 rounded-full ${preview.ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          <strong className="shrink-0">实时预览</strong>
          <span className="truncate text-muted-foreground" title={sceneName}>{dirty ? '当前草稿' : sceneName}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="ollaic-icon-button" onClick={preview.ready ? preview.sync : preview.reconnect} aria-label={preview.ready ? '重新同步预览' : '重连预览'} title={preview.ready ? '从头预览当前场景' : '重连预览'}><RefreshCw className="size-4" /></button>
          {preview.url && <button type="button" className="ollaic-icon-button hidden sm:flex" onClick={() => { void openInBrowser(preview.url!); }} aria-label="在浏览器中预览" title="在浏览器中预览"><ExternalLink className="size-4" /></button>}
          <button type="button" className="ollaic-icon-button" onClick={() => onLayoutChange(layout === 'large' ? 'split' : 'large')} aria-label={layout === 'large' ? '返回分屏预览' : '放大预览'} title={layout === 'large' ? '返回分屏预览' : '放大预览'}>{layout === 'large' ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
          <button type="button" className="ollaic-icon-button" onClick={() => onLayoutChange('hidden')} aria-label="收起预览"><X className="size-4" /></button>
        </div>
      </header>
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
        {(!preview.url || preview.error) && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0f19] p-5 text-center text-sm text-slate-200">
          {preview.error ? <>
            <p role="alert">{preview.error}</p>
            <div className="flex gap-3">
              <button type="button" onClick={preview.reconnect} className="rounded border border-slate-600 px-3 py-1.5">重连预览</button>
              <button type="button" onClick={onSettings} className="rounded border border-slate-600 px-3 py-1.5">引擎设置</button>
            </div>
          </> : <><Loader2 className="size-5 animate-spin" /><p>正在连接 WebGAL 引擎</p></>}
        </div>}
      </div>
      <p className="shrink-0 border-t border-border bg-surface-container-lowest px-3 py-1.5 text-[10px] text-muted-foreground">{preview.ready ? '编辑后自动同步草稿 · 预览不会保存文件' : '等待引擎连接后自动同步'}</p>
    </section>
  );
}
