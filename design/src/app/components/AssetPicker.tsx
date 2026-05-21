import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Image, Search, Loader2, Music, Volume2 } from 'lucide-react';
import { listAssets, type AssetInfo } from '../lib/assets-ipc';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';

interface Props {
  projectPath: string;
  category: string; // "background" | "figure" | "bgm" | "sfx" | "video"
  currentValue: string;
  onSelect: (filename: string) => void;
  aliases?: Record<string, string>;
}

function isImageExt(ext: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].some(e => ext.toLowerCase().endsWith(e));
}

function isAudioExt(ext: string): boolean {
  return ['.mp3', '.ogg', '.wav', '.flac', '.aac'].some(e => ext.toLowerCase().endsWith(e));
}

function titleForCategory(category: string): string {
  const labels: Record<string, string> = {
    background: '选择背景',
    figure: '选择立绘',
    bgm: '选择背景音乐',
    sfx: '选择音效',
    vocal: '选择语音',
    video: '选择视频',
  };
  return labels[category] || '选择素材';
}

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '--:--';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

export function AssetPickerButton({ projectPath, category, currentValue, onSelect, aliases = {} }: Props) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [durations, setDurations] = useState<Record<string, number>>({});
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAssets(projectPath, category);
      setAssets(result);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, category]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((asset) => {
      const alias = aliases[asset.name] || '';
      return asset.name.toLowerCase().includes(q) || alias.toLowerCase().includes(q);
    });
  }, [aliases, assets, search]);

  const selectAndClose = (filename: string) => {
    previewAudioRef.current?.pause();
    onSelect(filename);
    setOpen(false);
  };

  const playPreview = (asset: AssetInfo) => {
    if (!isAudioExt(asset.extension)) return;
    previewAudioRef.current?.pause();
    const audio = new Audio(convertFileSrc(asset.path));
    audio.volume = 0.45;
    previewAudioRef.current = audio;
    void audio.play().catch(() => undefined);
  };

  const stopPreview = () => {
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
  };

  const imageLike = ['background', 'figure'].includes(category);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-2 py-1.5 text-xs rounded bg-secondary hover:bg-secondary/70 transition-colors border border-border flex items-center gap-1"
        title="浏览素材库"
        aria-label="浏览素材库"
      >
        <Image className="w-3 h-3" />
        浏览
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
            <DialogTitle className="text-base font-display-family">{titleForCategory(category)}</DialogTitle>
            <DialogDescription className="text-xs">
              选择后仍会写入原始文件名，显示名称只用于编辑器。
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 py-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索显示名称或文件名..."
                className="w-full pl-10 pr-3 py-2 text-sm bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
                aria-label="搜索素材"
              />
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-5">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {search ? '无匹配素材' : '暂无素材，请先上传'}
              </div>
            ) : (
              <div className={imageLike ? 'grid grid-cols-2 sm:grid-cols-3 gap-3' : 'space-y-2'}>
                <button
                  onClick={() => selectAndClose('none')}
                  className={`rounded-md border border-dashed border-border px-3 py-3 text-sm text-left hover:bg-secondary/50 transition-colors ${
                    currentValue === 'none' ? 'bg-primary/10 text-primary border-primary/30' : ''
                  } ${imageLike ? 'min-h-28' : 'w-full'}`}
                >
                  （无 / 清除）
                </button>

                {filtered.map(asset => {
                  const thumb = isImageExt(asset.extension) ? convertFileSrc(asset.path) : null;
                  const alias = aliases[asset.name];
                  const label = alias || asset.name;
                  const isSelected = currentValue === asset.name;
                  const isAudio = isAudioExt(asset.extension);
                  return (
                    <button
                      key={asset.path}
                      type="button"
                      onClick={() => selectAndClose(asset.name)}
                      onMouseEnter={() => playPreview(asset)}
                      onMouseLeave={stopPreview}
                      className={`group text-left rounded-md border overflow-hidden hover:bg-secondary/50 transition-all ${
                        isSelected ? 'bg-primary/10 text-primary border-primary/40' : 'border-border bg-card/60'
                      } ${imageLike ? '' : 'w-full flex items-center gap-3 p-3'}`}
                    >
                      {imageLike ? (
                        <>
                          <div className="aspect-video bg-secondary/30 flex items-center justify-center overflow-hidden">
                            {thumb ? (
                              <img src={thumb} alt="" className="w-full h-full object-cover transition-transform group-hover:scale-[1.03]" />
                            ) : (
                              <Image className="w-8 h-8 text-muted-foreground/40" />
                            )}
                          </div>
                          <div className="p-3 min-w-0">
                            <div className="truncate text-sm font-medium">{label}</div>
                            {alias && <div className="mt-1 truncate text-[11px] text-muted-foreground font-mono-family">{asset.name}</div>}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="w-11 h-11 rounded-md bg-secondary/40 flex-shrink-0 flex items-center justify-center">
                            {isAudio ? <Music className="w-5 h-5 text-muted-foreground" /> : <Image className="w-5 h-5 text-muted-foreground/40" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{label}</div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground font-mono-family">
                              {asset.name}{isAudio ? ` · ${formatDuration(durations[asset.path])}` : ''}
                            </div>
                          </div>
                          {isAudio && <Volume2 className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />}
                          {isAudio && durations[asset.path] === undefined && (
                            <audio
                              preload="metadata"
                              src={convertFileSrc(asset.path)}
                              onLoadedMetadata={(event) => {
                                const duration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0;
                                setDurations(prev => ({ ...prev, [asset.path]: duration }));
                              }}
                              className="hidden"
                            />
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
