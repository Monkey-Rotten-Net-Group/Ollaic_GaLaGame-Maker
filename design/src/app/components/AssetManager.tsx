import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  ArrowLeft,
  Upload,
  Search,
  Image,
  Music,
  Users,
  FolderOpen,
  Grid3x3,
  List,
  Play,
  Pause,
  Trash2,
  Edit3,
  Download,
  Plus,
  Sparkles,
  Tag,
  Filter,
  Loader2,
  AlertTriangle,
  Copy,
} from 'lucide-react';
import {
  listAssets,
  listAllAssets,
  importAsset,
  deleteAsset,
  findAssetUsages,
  renameAsset,
  type AssetInfo,
  type AssetUsage,
} from '../lib/assets-ipc';
import { getAliasMap, setAlias as persistAssetAlias, removeAlias as removeAssetAlias } from '../lib/asset-alias';
import { listCharacters } from '../lib/character-ipc';
import { CharacterPanel } from './CharacterPanel';

type TabId = 'scene' | 'music' | 'character';
type MusicCategory = 'bgm' | 'sfx' | 'vocal';

const musicTabs: { id: MusicCategory; label: string }[] = [
  { id: 'bgm', label: 'BGM 背景音乐' },
  { id: 'sfx', label: 'SFX 音效' },
  { id: 'vocal', label: '语音 Vocal' },
];

const musicCategoryLabels: Record<MusicCategory, string> = {
  bgm: 'BGM',
  sfx: '音效',
  vocal: '语音',
};

const sceneTagGroups = [
  { title: '时段', tags: ['白天', '黄昏', '夜晚', '雨天'] },
  { title: '场景类型', tags: ['室内', '室外', '幻想', '战斗'] },
];

function tabToCategories(tab: TabId): string[] {
  switch (tab) {
    case 'scene': return ['background'];
    case 'music': return ['bgm', 'sfx', 'vocal'];
    case 'character': return ['figure'];
  }
}

function isImageExt(ext: string): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(normalized);
}

function isAudioExt(ext: string): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return ['mp3', 'ogg', 'wav', 'flac', 'aac'].includes(normalized);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCategory(category: string): string {
  const labels: Record<string, string> = {
    background: '背景',
    figure: '立绘',
    bgm: '背景音乐',
    sfx: '音效',
    vocal: '语音',
  };
  return labels[category] || category;
}

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '--:--';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function getSafeAudioDuration(audio: HTMLAudioElement): number {
  return Number.isFinite(audio.duration) ? audio.duration : 0;
}

function getImportConfig(tab: TabId, musicCategory: MusicCategory) {
  if (tab === 'scene') {
    return {
      title: '上传背景素材',
      buttonLabel: '上传背景',
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
    };
  }
  if (tab === 'music') {
    return {
      title: `上传${musicCategoryLabels[musicCategory]}`,
      buttonLabel: `上传${musicCategoryLabels[musicCategory]}`,
      filters: [{ name: '音频文件', extensions: ['mp3', 'ogg', 'wav', 'flac', 'aac'] }],
    };
  }
  return {
    title: '上传立绘素材',
    buttonLabel: '上传立绘素材',
    filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
  };
}

function getAudioDurationLabel(
  assetPath: string,
  audioDurations: Record<string, number>,
  audioMetadataErrors: Record<string, boolean>,
): string {
  if (audioMetadataErrors[assetPath]) return '无法读取时长';
  return formatDuration(audioDurations[assetPath]);
}

const tabConfig: { id: TabId; label: string; icon: typeof Image }[] = [
  { id: 'scene', label: '场景', icon: Image },
  { id: 'music', label: '音乐', icon: Music },
  { id: 'character', label: '人物立绘', icon: Users },
];

export function AssetManager() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState<TabId>(
    searchParams.get('tab') === 'character' ? 'character' : 'scene',
  );
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<AssetInfo | null>(null);
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const [musicCategory, setMusicCategory] = useState<MusicCategory>('bgm');
  const [characterCount, setCharacterCount] = useState(0);
  const [characterGenerationRequestToken, setCharacterGenerationRequestToken] = useState(0);
  const [figureLibraryRefreshToken, setFigureLibraryRefreshToken] = useState(0);
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({});
  const [audioMetadataErrors, setAudioMetadataErrors] = useState<Record<string, boolean>>({});
  const [audioProgress, setAudioProgress] = useState<Record<string, number>>({});
  const [assetUsages, setAssetUsages] = useState<AssetUsage[]>([]);
  const [tagsByAsset, setTagsByAsset] = useState<Record<string, string[]>>({});
  const [referencesByAsset, setReferencesByAsset] = useState<Record<string, string[]>>({});
  const [aliasesByAsset, setAliasesByAsset] = useState<Record<string, string>>({});
  const [referenceUploading, setReferenceUploading] = useState(false);

  // Real data state
  const [projectPath, setProjectPath] = useState<string>('');
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [allAssets, setAllAssets] = useState<AssetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Load project path
  useEffect(() => {
    const path = localStorage.getItem(`project-path-${projectId}`);
    if (path) {
      setProjectPath(path);
    } else {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (searchParams.get('tab') === 'character') {
      setActiveTab('character');
    }
  }, [searchParams]);

  // Load assets on mount and tab change
  const loadAssetsForTab = useCallback(async (tab: TabId, path: string, musicSubtab: MusicCategory) => {
    setLoading(true);
    setError(null);
    try {
      const cats = tab === 'music' ? [musicSubtab] : tabToCategories(tab);
      const results = await Promise.all(cats.map(c => listAssets(path, c)));
      const all = results.flat();
      setAssets(all);
    } catch (e) {
      setError(String(e));
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load all assets for counts and "all folders" view
  const loadAllAssets = useCallback(async (path: string) => {
    try {
      const all = await listAllAssets(path);
      setAllAssets(all);
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    if (!projectPath) return;
    loadAssetsForTab(activeTab, projectPath, musicCategory);
    loadAllAssets(projectPath);
  }, [projectPath, activeTab, musicCategory, loadAssetsForTab, loadAllAssets]);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    listCharacters(projectPath)
      .then((list) => {
        if (!cancelled) setCharacterCount(list.length);
      })
      .catch(() => {
        if (!cancelled) setCharacterCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, figureLibraryRefreshToken]);

  useEffect(() => {
    if (!projectId) return;
    try {
      setTagsByAsset(JSON.parse(localStorage.getItem(`asset-tags-${projectId}`) || '{}'));
      setReferencesByAsset(JSON.parse(localStorage.getItem(`asset-references-${projectId}`) || '{}'));
      setAliasesByAsset(getAliasMap(projectId));
    } catch {
      setTagsByAsset({});
      setReferencesByAsset({});
      setAliasesByAsset({});
    }
  }, [projectId]);

  const filteredAssets = assets.filter((a) => {
    const q = searchQuery.toLowerCase();
    return a.name.toLowerCase().includes(q) || (aliasesByAsset[a.name] || '').toLowerCase().includes(q);
  });

  // Tab counts from all assets
  const tabCounts = {
    scene: allAssets.filter(a => a.category === 'background').length,
    music: allAssets.filter(a => a.category === 'bgm' || a.category === 'sfx' || a.category === 'vocal').length,
    character: characterCount,
  };

  const importConfig = getImportConfig(activeTab, musicCategory);
  const aiActionLabel = activeTab === 'scene'
    ? 'AI 生成背景'
    : activeTab === 'music'
      ? `AI 生成${musicCategoryLabels[musicCategory]}`
      : '批量生成当前角色立绘';

  // --- Actions ---
  const handleImport = useCallback(async () => {
    if (!projectPath || !importConfig) return;
    const path = await openDialog({
      title: importConfig.title,
      filters: importConfig.filters,
    });
    if (!path) return;

    setImporting(true);
    setError(null);
    try {
      const cats = activeTab === 'music' ? [musicCategory] : tabToCategories(activeTab);
      const info = await importAsset(Array.isArray(path) ? path[0] : path, projectPath, cats[0]);
      setAssets(prev => [info, ...prev]);
      if (activeTab === 'character') {
        setFigureLibraryRefreshToken((value) => value + 1);
      }
      // Refresh all assets for updated counts
      loadAllAssets(projectPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }, [projectPath, activeTab, importConfig, musicCategory, loadAllAssets]);

  const handleDelete = useCallback(async () => {
    if (!selectedAsset || !projectPath) return;
    if (!confirm(`确定删除 "${selectedAsset.name}"？（不可恢复）`)) return;

    try {
      await deleteAsset(projectPath, selectedAsset.category, selectedAsset.name);
      setAssets(prev => prev.filter(a => a.path !== selectedAsset.path));
      setAllAssets(prev => prev.filter(a => a.path !== selectedAsset.path));
      setSelectedAsset(null);
    } catch (e) {
      setError(String(e));
    }
  }, [selectedAsset, projectPath]);

  const handleRename = useCallback(async () => {
    if (!selectedAsset || !projectPath) return;
    const ext = selectedAsset.extension;
    const stem = selectedAsset.name.slice(0, -(ext.length + 1));
    const newName = prompt('输入新名称:', stem);
    if (!newName || newName === stem) return;

    const fullNewName = `${newName}.${ext}`;
    try {
      const info = await renameAsset(projectPath, selectedAsset.category, selectedAsset.name, fullNewName);
      setAssets(prev => prev.map(a => a.path === selectedAsset.path ? info : a));
      setAllAssets(prev => prev.map(a => a.path === selectedAsset.path ? info : a));
      setSelectedAsset(info);
    } catch (e) {
      setError(String(e));
    }
  }, [selectedAsset, projectPath]);

  const handleDownload = useCallback(async (asset?: AssetInfo) => {
    const a = asset || selectedAsset;
    if (!a) return;
    const dest = await saveDialog({
      title: '导出素材到',
      defaultPath: a.name,
    });
    if (!dest) return;

    try {
      // For MVP: copy file contents via read/write
      const fileData = await fetch(convertFileSrc(a.path));
      const blob = await fileData.blob();
      // Create an object URL and trigger download via a temporary anchor
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`导出失败: ${e}. 文件路径: ${a.path}`);
    }
  }, [selectedAsset]);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handlePlayToggle = useCallback(async (assetPath: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingAudio === assetPath) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
      setPlayingAudio(null);
      return;
    }

    setError(null);
    setAudioProgress((prev) => ({ ...prev, [assetPath]: 0 }));
    audio.pause();
    audio.src = convertFileSrc(assetPath);
    audio.load();

    try {
      await audio.play();
      setPlayingAudio(assetPath);
    } catch (e) {
      setPlayingAudio(null);
      setError(`无法播放音频：${String(e)}`);
    }
  }, [playingAudio]);

  const persistTags = useCallback((next: Record<string, string[]>) => {
    setTagsByAsset(next);
    if (projectId) localStorage.setItem(`asset-tags-${projectId}`, JSON.stringify(next));
  }, [projectId]);

  const toggleTag = useCallback((assetName: string, tag: string) => {
    const current = tagsByAsset[assetName] ?? [];
    const nextTags = current.includes(tag)
      ? current.filter((item) => item !== tag)
      : [...current, tag];
    persistTags({ ...tagsByAsset, [assetName]: nextTags });
  }, [persistTags, tagsByAsset]);

  const persistReferences = useCallback((next: Record<string, string[]>) => {
    setReferencesByAsset(next);
    if (projectId) localStorage.setItem(`asset-references-${projectId}`, JSON.stringify(next));
  }, [projectId]);

  const handleReferenceUpload = useCallback(async () => {
    if (!selectedAsset || !projectPath) return;
    const isAudioReference = activeTab === 'music';
    const referenceCategory = isAudioReference
      ? `reference/audio/${selectedAsset.name}`
      : `reference/backgrounds/${selectedAsset.name}`;
    const path = await openDialog({
      title: isAudioReference ? '上传参考音频' : '上传参考图',
      filters: [{
        name: isAudioReference ? '音频文件' : '图片文件',
        extensions: isAudioReference ? ['mp3', 'ogg', 'wav', 'flac', 'aac'] : ['png', 'jpg', 'jpeg', 'webp'],
      }],
    });
    if (!path) return;

    setReferenceUploading(true);
    setError(null);
    try {
      const info = await importAsset(Array.isArray(path) ? path[0] : path, projectPath, referenceCategory);
      persistReferences({
        ...referencesByAsset,
        [selectedAsset.name]: [...(referencesByAsset[selectedAsset.name] ?? []), info.name],
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setReferenceUploading(false);
    }
  }, [activeTab, persistReferences, projectPath, referencesByAsset, selectedAsset]);

  const handleReferenceRemove = useCallback(async (filename: string) => {
    if (!selectedAsset || !projectPath) return;
    const referenceCategory = activeTab === 'music'
      ? `reference/audio/${selectedAsset.name}`
      : `reference/backgrounds/${selectedAsset.name}`;
    try {
      await deleteAsset(projectPath, referenceCategory, filename);
    } catch {
      // Keep the local reference list clean even if the backing file was already gone.
    }
    persistReferences({
      ...referencesByAsset,
      [selectedAsset.name]: (referencesByAsset[selectedAsset.name] ?? []).filter((name) => name !== filename),
    });
  }, [activeTab, persistReferences, projectPath, referencesByAsset, selectedAsset]);

  // Keep the shared audio element in sync when playback is cleared externally.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!playingAudio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
    }
  }, [playingAudio]);

  useEffect(() => {
    if (!selectedAsset || !projectPath) {
      setAssetUsages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const usages = await findAssetUsages(projectPath, selectedAsset.name);
        if (!cancelled) setAssetUsages(usages);
      } catch {
        if (!cancelled) setAssetUsages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath, selectedAsset]);

  const openUsage = useCallback((usage: AssetUsage) => {
    navigate(`/editor/${projectId}?scene=${encodeURIComponent(usage.sceneFile)}&line=${usage.lineNumber}`);
  }, [navigate, projectId]);

  // Thumbnail URL
  const getThumbnail = (asset: AssetInfo): string | null => {
    if (isImageExt(asset.extension)) {
      return convertFileSrc(asset.path);
    }
    return null;
  };

  const handleAliasChange = (filename: string, alias: string) => {
    if (!projectId) return;
    if (alias.trim()) {
      persistAssetAlias(projectId, filename, alias);
      setAliasesByAsset(prev => ({ ...prev, [filename]: alias.trim() }));
    } else {
      removeAssetAlias(projectId, filename);
      setAliasesByAsset(prev => {
        const next = { ...prev };
        delete next[filename];
        return next;
      });
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(`/editor/${projectId}`)}
              className="p-2 rounded-md hover:bg-secondary/50 transition-colors"
              aria-label="返回编辑器"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="h-6 w-px bg-border" />
            <h1 className="text-3xl tracking-tight font-display-family">
              素材库
            </h1>
            {projectPath && (
              <span className="text-xs text-muted-foreground truncate max-w-xs font-mono-family">
                {projectPath}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                if (activeTab === 'character') {
                  setCharacterGenerationRequestToken((value) => value + 1);
                  return;
                }
                alert(`${aiActionLabel} 即将推出`);
              }}
              className="px-4 py-2 rounded-md bg-primary/10 text-primary flex items-center gap-2 hover:bg-primary/20 transition-all border border-primary/30"
            >
              <Sparkles className="w-4 h-4" />
              <span>{aiActionLabel}</span>
            </button>
            {importConfig && (
              <button
                onClick={handleImport}
                disabled={!projectPath || importing}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground flex items-center gap-2 hover:opacity-90 transition-all hover:shadow-[0_0_20px_rgba(212,165,116,0.4)] disabled:opacity-50"
              >
                {importing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                <span>{importing ? '导入中…' : importConfig.buttonLabel}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {!projectPath ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <AlertTriangle className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p>未找到项目路径，请从编辑器重新进入素材库</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left Sidebar */}
          <aside className="w-64 border-r border-border bg-card/30 flex flex-col">
            <div className="p-4 border-b border-border">
              <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3 font-mono-family">
                素材类型
              </h2>
              <div className="space-y-1">
                {tabConfig.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => { setActiveTab(id); setSelectedAsset(null); }}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-md transition-all ${
                      activeTab === id
                        ? 'bg-primary/20 text-primary border border-primary/30'
                        : 'hover:bg-secondary/50 text-foreground'
                    }`}
                    aria-label={`筛选${label}`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {tabCounts[id]}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4">
              <h3 className="text-sm uppercase tracking-wide text-muted-foreground mb-3 font-mono-family">
                快捷操作
              </h3>
              <div className="space-y-1">
                <button
                  onClick={() => alert('文件夹浏览即将推出')}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 transition-colors"
                  aria-label="浏览所有文件夹"
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>所有文件夹</span>
                </button>
                <button
                  onClick={() => alert('标签管理即将推出')}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 transition-colors"
                  aria-label="管理素材标签"
                >
                  <Tag className="w-4 h-4" />
                  <span>标签管理</span>
                </button>
                <button
                  onClick={() => alert('筛选器即将推出')}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 transition-colors"
                  aria-label="使用筛选器筛选素材"
                >
                  <Filter className="w-4 h-4" />
                  <span>筛选器</span>
                </button>
              </div>
            </div>
          </aside>

          {/* Main Content */}
          <main className="flex-1 flex flex-col overflow-hidden">
            {activeTab === 'character' ? (
              <CharacterPanel
                projectPath={projectPath}
                embedded
                onCharacterCountChange={setCharacterCount}
                generationRequestToken={characterGenerationRequestToken}
                figureLibraryRefreshToken={figureLibraryRefreshToken}
              />
            ) : (
              <>
            {/* Toolbar */}
            <div className="px-6 py-4 border-b border-border bg-card/20 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4 flex-1">
                {activeTab === 'music' && (
                  <div className="flex items-center gap-1 bg-secondary/50 rounded-md p-1 flex-shrink-0">
                    {musicTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => { setMusicCategory(tab.id); setSelectedAsset(null); }}
                        className={`px-3 py-1.5 rounded text-xs transition-colors ${
                          musicCategory === tab.id ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="搜索素材名称..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-secondary/50 rounded-md p-1">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-2 rounded transition-colors ${
                      viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                    }`}
                    aria-label="切换为网格视图"
                  >
                    <Grid3x3 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-2 rounded transition-colors ${
                      viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                    }`}
                    aria-label="切换为列表视图"
                  >
                    <List className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <div className="mx-6 mt-2 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                {error}
                <button onClick={() => setError(null)} className="ml-auto text-xs underline hover:no-underline">关闭</button>
              </div>
            )}

            {/* Assets Display */}
            <div className="flex-1 overflow-auto p-6">
              {loading ? (
                <div className="h-full flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : filteredAssets.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                  <FolderOpen className="w-16 h-16 mb-4 opacity-50" />
                  <p className="text-lg mb-2">暂无素材</p>
                  <p className="text-sm">点击右上角“{importConfig?.buttonLabel ?? 'AI 生成'}”开始添加</p>
                </div>
              ) : viewMode === 'grid' ? (
                <div className={`grid gap-4 ${
                  activeTab === 'scene'
                    ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
                    : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
                }`}>
                  {filteredAssets.map((asset) => {
                    const thumbnail = getThumbnail(asset);
                    const isSelected = selectedAsset?.path === asset.path;
                    const progress = audioProgress[asset.path] ?? 0;
                    const hasAudioDuration = audioDurations[asset.path] !== undefined;
                    const hasAudioMetadataError = audioMetadataErrors[asset.path] === true;
                    return (
                      <div
                        key={asset.path}
                        onClick={() => setSelectedAsset(asset)}
                        className={`group relative rounded-lg overflow-hidden cursor-pointer transition-all hover:scale-[1.02] ${
                          isSelected
                            ? 'ring-2 ring-primary shadow-[0_0_20px_rgba(212,165,116,0.3)]'
                            : 'hover:ring-1 hover:ring-border'
                        }`}
                      >
                        <div className={`${activeTab === 'scene' ? 'aspect-video' : 'aspect-square'} bg-secondary/30 relative overflow-hidden`}>
                          {thumbnail ? (
                            <img
                              src={thumbnail}
                              alt={asset.name}
                              className="w-full h-full object-cover"
                              onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                            />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-4">
                              {isAudioExt(asset.extension) ? (
                                <>
                                  <Music className="w-10 h-10 text-muted-foreground" />
                                  <div className="w-2/3 h-8 rounded overflow-hidden bg-[repeating-linear-gradient(90deg,hsl(var(--primary)/0.25)_0_3px,transparent_3px_7px)]" />
                                </>
                              ) : (
                                <Image className="w-12 h-12 text-muted-foreground/30" />
                              )}
                            </div>
                          )}
                          {isAudioExt(asset.extension) && progress > 0 && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-background/50">
                              <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(progress * 100, 100)}%` }} />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="absolute bottom-0 left-0 right-0 p-3 flex gap-2">
                              {isAudioExt(asset.extension) && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handlePlayToggle(asset.path); }}
                                  className="p-2 rounded-full bg-primary/90 hover:bg-primary transition-colors"
                                  aria-label="切换音频播放"
                                >
                                  {playingAudio === asset.path ? (
                                    <Pause className="w-3 h-3 text-primary-foreground" />
                                  ) : (
                                    <Play className="w-3 h-3 text-primary-foreground" />
                                  )}
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDownload(asset); }}
                                className="p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm transition-colors"
                                aria-label="导出素材"
                              >
                                <Download className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                        <div className="p-3 bg-card border-t border-border">
                          <h3 className="text-sm font-medium truncate mb-1">{aliasesByAsset[asset.name] || asset.name}</h3>
                          {aliasesByAsset[asset.name] && (
                            <div className="mb-1 truncate text-[11px] text-muted-foreground font-mono-family">{asset.name}</div>
                          )}
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{asset.extension.toUpperCase()}</span>
                            {isAudioExt(asset.extension) && (
                              <span>{getAudioDurationLabel(asset.path, audioDurations, audioMetadataErrors)}</span>
                            )}
                            <span>{formatSize(asset.size)}</span>
                          </div>
                          {isAudioExt(asset.extension) && !hasAudioDuration && !hasAudioMetadataError && (
                            <audio
                              preload="metadata"
                              src={convertFileSrc(asset.path)}
                              onLoadedMetadata={(event) => {
                                const duration = getSafeAudioDuration(event.currentTarget);
                                setAudioDurations((prev) => ({ ...prev, [asset.path]: duration }));
                                setAudioMetadataErrors((prev) => {
                                  if (!prev[asset.path]) return prev;
                                  const next = { ...prev };
                                  delete next[asset.path];
                                  return next;
                                });
                              }}
                              onError={() => {
                                setAudioMetadataErrors((prev) => ({ ...prev, [asset.path]: true }));
                              }}
                              className="hidden"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredAssets.map((asset) => {
                    const thumbnail = getThumbnail(asset);
                    const isSelected = selectedAsset?.path === asset.path;
                    const progress = audioProgress[asset.path] ?? 0;
                    const hasAudioDuration = audioDurations[asset.path] !== undefined;
                    const hasAudioMetadataError = audioMetadataErrors[asset.path] === true;
                    return (
                      <div
                        key={asset.path}
                        onClick={() => setSelectedAsset(asset)}
                        className={`flex items-center gap-4 p-4 rounded-lg cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-primary/10 ring-1 ring-primary'
                            : 'bg-card/50 hover:bg-card'
                        }`}
                      >
                        <div className="w-16 h-16 rounded overflow-hidden bg-secondary/30 flex-shrink-0">
                          {thumbnail ? (
                            <img src={thumbnail} alt={asset.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              {isAudioExt(asset.extension) ? (
                                <Music className="w-6 h-6 text-muted-foreground" />
                              ) : (
                                <Image className="w-6 h-6 text-muted-foreground/30" />
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium truncate">{aliasesByAsset[asset.name] || asset.name}</h3>
                          <p className="text-sm text-muted-foreground">
                            {aliasesByAsset[asset.name] ? `${asset.name} · ` : ''}{formatCategory(asset.category)} · {asset.extension.toUpperCase()} · {isAudioExt(asset.extension) ? `${getAudioDurationLabel(asset.path, audioDurations, audioMetadataErrors)} · ` : ''}{formatSize(asset.size)}
                          </p>
                          {isAudioExt(asset.extension) && progress > 0 && (
                            <div className="mt-2 h-1 rounded bg-secondary overflow-hidden">
                              <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(progress * 100, 100)}%` }} />
                            </div>
                          )}
                          {isAudioExt(asset.extension) && !hasAudioDuration && !hasAudioMetadataError && (
                            <audio
                              preload="metadata"
                              src={convertFileSrc(asset.path)}
                              onLoadedMetadata={(event) => {
                                const duration = getSafeAudioDuration(event.currentTarget);
                                setAudioDurations((prev) => ({ ...prev, [asset.path]: duration }));
                                setAudioMetadataErrors((prev) => {
                                  if (!prev[asset.path]) return prev;
                                  const next = { ...prev };
                                  delete next[asset.path];
                                  return next;
                                });
                              }}
                              onError={() => {
                                setAudioMetadataErrors((prev) => ({ ...prev, [asset.path]: true }));
                              }}
                              className="hidden"
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{asset.extension.toUpperCase()}</span>
                          {isAudioExt(asset.extension) && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handlePlayToggle(asset.path); }}
                              className="p-2 rounded-full hover:bg-secondary transition-colors"
                              aria-label="切换音频播放"
                            >
                              {playingAudio === asset.path ? (
                                <Pause className="w-4 h-4" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
              </>
            )}
          </main>

          {/* Right Sidebar - Details */}
          {activeTab !== 'character' && (
          <aside className="w-80 border-l border-border bg-card/30 overflow-auto">
            {selectedAsset ? (
              <div className="p-6">
                <div className="mb-6">
                  <div className="aspect-video rounded-lg overflow-hidden bg-secondary/30 mb-4">
                    {getThumbnail(selectedAsset) ? (
                      <img
                        src={getThumbnail(selectedAsset)!}
                        alt={selectedAsset.name}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        {isAudioExt(selectedAsset.extension) ? (
                          <Music className="w-16 h-16 text-muted-foreground" />
                        ) : (
                          <Image className="w-16 h-16 text-muted-foreground/30" />
                        )}
                      </div>
                    )}
                  </div>
                  <h2 className="text-xl mb-2 font-display-family">
                    {selectedAsset.name}
                  </h2>
                  <p className="text-xs text-muted-foreground truncate font-mono-family">
                    {selectedAsset.path}
                  </p>
                </div>

                <div className="space-y-4 mb-6">
                  {(activeTab === 'scene' || activeTab === 'music') && (
                    <div>
                      <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                        显示名称
                      </label>
                      <input
                        type="text"
                        value={aliasesByAsset[selectedAsset.name] || ''}
                        onChange={(e) => handleAliasChange(selectedAsset.name, e.target.value)}
                        className="w-full px-3 py-2 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                        placeholder={activeTab === 'scene' ? '例：教室 · 白天' : '例：悲伤主旋律'}
                        aria-label="素材显示名称"
                      />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        设置后，剧本编辑器的素材选择弹窗会优先显示这个名称。
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                      文件信息
                    </label>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">类型</span>
                        <span>{formatCategory(selectedAsset.category)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">格式</span>
                        <span>{selectedAsset.extension.toUpperCase()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">大小</span>
                        <span>{formatSize(selectedAsset.size)}</span>
                      </div>
                    </div>
                  </div>

                  {activeTab === 'scene' && (
                    <div>
                      <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                        场景标签
                      </label>
                      <div className="space-y-3">
                        {sceneTagGroups.map((group) => (
                          <div key={group.title}>
                            <div className="mb-1 text-[10px] text-muted-foreground">{group.title}</div>
                            <div className="flex flex-wrap gap-2">
                              {group.tags.map((tagName) => {
                                const active = (tagsByAsset[selectedAsset.name] ?? []).includes(tagName);
                                return (
                                  <button
                                    key={tagName}
                                    type="button"
                                    onClick={() => toggleTag(selectedAsset.name, tagName)}
                                    className={`px-2 py-1 rounded-full text-xs border transition-colors ${
                                      active
                                        ? 'bg-primary/20 text-primary border-primary/30'
                                        : 'bg-secondary/40 border-border hover:bg-secondary'
                                    }`}
                                  >
                                    {tagName}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs uppercase tracking-wide text-muted-foreground">
                        {activeTab === 'music' ? '参考音频' : '参考图'}
                      </label>
                      <button
                        type="button"
                        onClick={handleReferenceUpload}
                        disabled={referenceUploading}
                        className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs flex items-center gap-1 disabled:opacity-50"
                      >
                        {referenceUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                        上传
                      </button>
                    </div>
                    <div className="space-y-2">
                      {(referencesByAsset[selectedAsset.name] ?? []).length === 0 ? (
                        <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border p-3">暂无参考资料。</div>
                      ) : (referencesByAsset[selectedAsset.name] ?? []).map((filename) => (
                        <div key={filename} className="flex items-center gap-2 rounded-md bg-secondary/20 p-2">
                          {activeTab === 'music' ? (
                            <audio controls src={convertFileSrc(`${projectPath}/game/config/references/audio/${selectedAsset.name}/${filename}`)} className="min-w-0 flex-1 h-8" />
                          ) : (
                            <img src={convertFileSrc(`${projectPath}/game/config/references/backgrounds/${selectedAsset.name}/${filename}`)} alt="" className="w-10 h-10 rounded object-cover bg-secondary" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-xs font-mono-family">{filename}</span>
                          <button
                            type="button"
                            onClick={() => handleReferenceRemove(filename)}
                            className="p-1 rounded hover:bg-destructive/10"
                            aria-label="删除参考资料"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                      剧本引用
                    </label>
                    <div className="space-y-2">
                      {assetUsages.length === 0 ? (
                        <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border p-3">未在剧本中找到引用。</div>
                      ) : assetUsages.map((usage, index) => (
                        <button
                          key={`${usage.sceneFile}-${usage.lineNumber}-${index}`}
                          type="button"
                          onClick={() => openUsage(usage)}
                          className="w-full rounded-md bg-secondary/20 p-2 text-left hover:bg-primary/10 transition-colors"
                        >
                          <div className="text-xs text-primary">{usage.sceneFile} 第 {usage.lineNumber} 行</div>
                          <div className="mt-1 truncate text-[10px] text-muted-foreground font-mono-family">{usage.lineContent}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    onClick={handleRename}
                    className="w-full px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center justify-center gap-2"
                    aria-label="重命名素材"
                  >
                    <Edit3 className="w-4 h-4" />
                    重命名
                  </button>
                  <button
                    onClick={() => handleDownload()}
                    className="w-full px-4 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-colors flex items-center justify-center gap-2"
                    aria-label="复制素材文件路径"
                  >
                    <Copy className="w-4 h-4" />
                    复制路径
                  </button>
                  <button
                    onClick={handleDelete}
                    className="w-full px-4 py-2 rounded-md bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors flex items-center justify-center gap-2"
                    aria-label="删除素材"
                  >
                    <Trash2 className="w-4 h-4" />
                    删除素材
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <Image className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-sm">选择一个素材查看详情</p>
              </div>
            )}
          </aside>
          )}
        </div>
      )}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingAudio(null)}
        onError={() => {
          const current = playingAudio;
          if (current) {
            setAudioMetadataErrors((prev) => ({ ...prev, [current]: true }));
            setError('当前音频无法解码或播放，请尝试转换为常规 MP3/WAV/Ogg 后重新导入。');
          }
          setPlayingAudio(null);
        }}
        onLoadedMetadata={(event) => {
          if (!playingAudio) return;
          const duration = getSafeAudioDuration(event.currentTarget);
          setAudioDurations((prev) => ({ ...prev, [playingAudio]: duration }));
        }}
        onTimeUpdate={(event) => {
          if (!playingAudio) return;
          const { currentTime } = event.currentTarget;
          const duration = getSafeAudioDuration(event.currentTarget);
          setAudioProgress((prev) => ({ ...prev, [playingAudio]: duration ? currentTime / duration : 0 }));
        }}
        className="hidden"
        aria-label="音频播放器"
      />
    </div>
  );
}
