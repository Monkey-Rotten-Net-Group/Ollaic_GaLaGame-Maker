import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  ChevronDown,
  ExternalLink,
  Plus,
  Trash2,
  Users,
  X,
  Image as ImageIcon,
  Music,
  Palette,
  Loader2,
  Search,
  Sparkles,
  Save,
  FileText,
  Upload,
} from 'lucide-react';
import type { Character, CharacterRelation, CharacterRef, CharacterSprite } from '../lib/character-types';
import {
  createCharacter,
  deleteCharacter,
  listCharacters,
  updateCharacter,
} from '../lib/character-ipc';
import { deleteAsset, findAssetUsages, importAsset, listAssets, type AssetInfo, type AssetUsage } from '../lib/assets-ipc';
import { AssetPickerButton } from './AssetPicker';

interface Props {
  projectPath: string;
  onClose?: () => void;
  embedded?: boolean;
  onCharacterCountChange?: (count: number) => void;
  generationRequestToken?: number;
  figureLibraryRefreshToken?: number;
}

type DetailMode = 'info' | 'sprite';
type PersistOptions = {
  showSavedBadge?: boolean;
};

const inputClass = 'w-full px-2.5 py-1.5 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-xs';
const labelClass = 'block text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-mono-family';
const colors = ['#D4A574', '#C9946A', '#7C9885', '#60A5FA', '#C084FC', '#FACC15', '#F472B6', '#34D399'];

const spriteSuggestions = [
  { pose: '日常站姿', emotion: '微笑', prompt: 'standing pose, gentle smile, relaxed hands' },
  { pose: '对话半身', emotion: '认真', prompt: 'upper body, serious expression, looking at viewer' },
  { pose: '惊讶反应', emotion: '惊讶', prompt: 'surprised expression, slightly opened mouth' },
  { pose: '剧情低落', emotion: '悲伤', prompt: 'sad expression, lowered eyes' },
];
const commonEmotions = ['默认', '微笑', '悲伤', '惊讶', '愤怒', '害羞', '思考', '严肃'];

interface SpriteUsage extends AssetUsage {
  assetName: string;
}

function pickColor(index: number): string {
  return colors[index % colors.length];
}

function emptyCharacter(index: number): Character {
  return {
    id: `tmp_${Date.now()}`,
    name: '',
    aliases: [],
    description: '',
    personality: '',
    consistencyPrompt: '',
    stance: '',
    keywords: [],
    dialogueStyle: '',
    gender: '',
    age: '',
    sprites: [],
    defaultVoice: undefined,
    voiceTimbre: undefined,
    referenceImages: [],
    relations: [],
    colorTheme: pickColor(index),
    notes: '',
  };
}

function getReferenceSpriteIndex(ch: Character): number {
  const explicit = ch.sprites.findIndex((sprite) => sprite.emotion === '主体参考');
  if (explicit >= 0) return explicit;
  const defaultIndex = ch.sprites.findIndex((sprite) => sprite.emotion === '默认' || sprite.emotion === 'default');
  if (defaultIndex >= 0) return defaultIndex;
  return ch.sprites.length > 0 ? 0 : -1;
}

export function CharacterPanel({
  projectPath,
  onClose,
  embedded = false,
  onCharacterCountChange,
  generationRequestToken = 0,
  figureLibraryRefreshToken = 0,
}: Props) {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<DetailMode>('info');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [recentlySavedId, setRecentlySavedId] = useState<string | null>(null);
  const [showEmotionPicker, setShowEmotionPicker] = useState(false);
  const [customEmotion, setCustomEmotion] = useState('');
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [figureAssets, setFigureAssets] = useState<AssetInfo[]>([]);
  const [figureAssetsLoading, setFigureAssetsLoading] = useState(true);
  const [figureAssetImporting, setFigureAssetImporting] = useState(false);
  const [figureAssetDeleting, setFigureAssetDeleting] = useState<string | null>(null);
  const [spriteUsages, setSpriteUsages] = useState<SpriteUsage[]>([]);
  const [usageOpen, setUsageOpen] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await listCharacters(projectPath);
        setCharacters(list);
        setSelectedId(list[0]?.id ?? null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setFigureAssetsLoading(true);
      try {
        const list = await listAssets(projectPath, 'figure');
        if (!cancelled) setFigureAssets(list);
      } catch {
        if (!cancelled) setFigureAssets([]);
      } finally {
        if (!cancelled) setFigureAssetsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath, figureLibraryRefreshToken]);

  const selected = useMemo(
    () => characters.find((c) => c.id === selectedId) ?? null,
    [characters, selectedId],
  );

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return characters;
    return characters.filter((c) =>
      [c.name, c.description, c.personality, c.stance, ...c.aliases, ...c.keywords]
        .some((part) => part?.toLowerCase().includes(text)),
    );
  }, [characters, query]);

  useEffect(() => {
    onCharacterCountChange?.(characters.length);
  }, [characters.length, onCharacterCountChange]);

  const otherCharacters = useCallback((excludeId: string): CharacterRef[] =>
    characters
      .filter((c) => c.id !== excludeId && c.name.trim())
      .map((c) => ({ id: c.id, name: c.name })),
  [characters]);

  const patchCharacter = useCallback((id: string, partial: Partial<Character>) => {
    setCharacters((prev) => prev.map((c) => (c.id === id ? { ...c, ...partial } : c)));
  }, []);

  const handleCreate = useCallback(() => {
    const ch = emptyCharacter(characters.length);
    setCharacters((prev) => [...prev, ch]);
    setSelectedId(ch.id);
    setMode('info');
  }, [characters.length]);

  const persistCharacter = useCallback(async (ch: Character, options: PersistOptions = {}) => {
    if (!ch.name.trim() || savingRef.current) return null;
    const { showSavedBadge = true } = options;
    savingRef.current = true;
    setSavingId(ch.id);
    setError(null);
    try {
      const saved = ch.id.startsWith('tmp_')
        ? await createCharacter(projectPath, ch)
        : await updateCharacter(projectPath, ch);
      setCharacters((prev) => prev.map((c) => (c.id === ch.id ? saved : c)));
      setSelectedId(saved.id);
      if (showSavedBadge) {
        setRecentlySavedId(saved.id);
        setTimeout(() => setRecentlySavedId(null), 1400);
      }
      return saved;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      savingRef.current = false;
      setSavingId(null);
    }
  }, [projectPath]);

  const handleSave = useCallback(async (ch: Character) => {
    await persistCharacter(ch);
  }, [persistCharacter]);

  const ensurePersistedCharacter = useCallback(async (charId: string, actionLabel: string) => {
    const current = characters.find((c) => c.id === charId);
    if (!current) return null;
    if (!current.id.startsWith('tmp_')) return current;
    if (!current.name.trim()) {
      setError(`请先填写人物姓名，再${actionLabel}`);
      return null;
    }
    return persistCharacter(current, { showSavedBadge: false });
  }, [characters, persistCharacter]);

  const handleDelete = useCallback(async (id: string) => {
    setError(null);
    try {
      if (!id.startsWith('tmp_')) {
        await deleteCharacter(projectPath, id);
      }
      setCharacters((prev) => {
        const next = prev.filter((c) => c.id !== id);
        if (selectedId === id) setSelectedId(next[0]?.id ?? null);
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath, selectedId]);

  const updateSprite = useCallback((charId: string, index: number, field: keyof CharacterSprite, value: string) => {
    setCharacters((prev) => prev.map((c) => {
      if (c.id !== charId) return c;
      const sprites = [...c.sprites];
      sprites[index] = { ...sprites[index], [field]: value };
      return { ...c, sprites };
    }));
  }, []);

  const addSprite = useCallback((charId: string, emotion = '') => {
    setCharacters((prev) => prev.map((c) =>
      c.id === charId ? { ...c, sprites: [...c.sprites, { emotion, file: '' }] } : c,
    ));
  }, []);

  const addEmotionPreset = useCallback((charId: string, emotion: string) => {
    if (!emotion.trim()) return;
    setCharacters((prev) => prev.map((c) => {
      if (c.id !== charId) return c;
      if (c.sprites.some((sprite) => sprite.emotion === emotion.trim())) return c;
      return { ...c, sprites: [...c.sprites, { emotion: emotion.trim(), file: '' }] };
    }));
  }, []);

  const setReferenceFile = useCallback(async (charId: string, filename: string) => {
    const current = characters.find((c) => c.id === charId);
    if (!current) return;
    const base = current.id.startsWith('tmp_')
      ? await ensurePersistedCharacter(charId, '设置主体素材')
      : current;
    if (!base) return;

    const sprites = [...base.sprites];
    const refIndex = getReferenceSpriteIndex(base);
    if (refIndex >= 0) {
      sprites[refIndex] = { ...sprites[refIndex], emotion: '主体参考', file: filename };
    } else {
      sprites.unshift({ emotion: '主体参考', file: filename });
    }

    await persistCharacter({ ...base, sprites }, { showSavedBadge: false });
  }, [characters, ensurePersistedCharacter, persistCharacter]);

  const removeSprite = useCallback((charId: string, index: number) => {
    setCharacters((prev) => prev.map((c) =>
      c.id === charId ? { ...c, sprites: c.sprites.filter((_, i) => i !== index) } : c,
    ));
  }, []);

  const uploadReferenceImage = useCallback(async (charId: string) => {
    const current = characters.find((c) => c.id === charId);
    if (!current || (current.referenceImages?.length ?? 0) >= 5) return;
    const path = await openDialog({
      title: '上传主体参考图',
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (!path) return;

    setReferenceUploading(true);
    setError(null);
    try {
      const persisted = await ensurePersistedCharacter(charId, '上传主体参考图');
      if (!persisted) return;
      const info = await importAsset(Array.isArray(path) ? path[0] : path, projectPath, `reference/${persisted.id}`);
      await persistCharacter({
        ...persisted,
        referenceImages: [...(persisted.referenceImages ?? []), info.name].slice(0, 5),
      }, { showSavedBadge: false });
    } catch (e) {
      setError(String(e));
    } finally {
      setReferenceUploading(false);
    }
  }, [characters, ensurePersistedCharacter, projectPath, persistCharacter]);

  const removeReferenceImage = useCallback(async (charId: string, filename: string) => {
    const persisted = await ensurePersistedCharacter(charId, '移除主体参考图');
    if (!persisted) return;
    try {
      await deleteAsset(projectPath, `reference/${persisted.id}`, filename);
    } catch {
      // The reference may already have been removed from disk; still remove the character mapping.
    }
    await persistCharacter({
      ...persisted,
      referenceImages: (persisted.referenceImages ?? []).filter((name) => name !== filename),
    }, { showSavedBadge: false });
  }, [ensurePersistedCharacter, persistCharacter, projectPath]);

  const updateRelation = useCallback((charId: string, index: number, field: keyof CharacterRelation, value: string) => {
    setCharacters((prev) => prev.map((c) => {
      if (c.id !== charId) return c;
      const relations = [...c.relations];
      relations[index] = { ...relations[index], [field]: value };
      return { ...c, relations };
    }));
  }, []);

  const addRelation = useCallback((charId: string) => {
    setCharacters((prev) => prev.map((c) =>
      c.id === charId
        ? { ...c, relations: [...c.relations, { targetId: '', relationType: '', description: '' }] }
        : c,
    ));
  }, []);

  const removeRelation = useCallback((charId: string, index: number) => {
    setCharacters((prev) => prev.map((c) =>
      c.id === charId ? { ...c, relations: c.relations.filter((_, i) => i !== index) } : c,
    ));
  }, []);

  const containerClass = embedded
    ? 'h-full flex flex-col overflow-hidden'
    : 'flex-1 flex flex-col overflow-hidden';

  const referenceIndex = selected ? getReferenceSpriteIndex(selected) : -1;
  const referenceSprite = selected && referenceIndex >= 0 ? selected.sprites[referenceIndex] : null;
  const variantSprites = selected
    ? selected.sprites
        .map((sprite, index) => ({ sprite, index }))
        .filter(({ index }) => index !== referenceIndex)
    : [];

  useEffect(() => {
    if (!selected || selected.sprites.length === 0) {
      setSpriteUsages([]);
      return;
    }
    const filenames = Array.from(new Set(selected.sprites.map((sprite) => sprite.file).filter(Boolean)));
    if (filenames.length === 0) {
      setSpriteUsages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await Promise.all(
          filenames.map(async (filename) => {
            const usages = await findAssetUsages(projectPath, filename);
            return usages.map((usage) => ({ ...usage, assetName: filename }));
          }),
        );
        if (!cancelled) setSpriteUsages(rows.flat());
      } catch {
        if (!cancelled) setSpriteUsages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath, selected]);

  const openUsage = useCallback((usage: AssetUsage) => {
    if (!projectId) return;
    navigate(`/editor/${projectId}?scene=${encodeURIComponent(usage.sceneFile)}&line=${usage.lineNumber}`);
  }, [navigate, projectId]);

  const triggerBatchSpriteGeneration = useCallback(() => {
    if (!selected) {
      setError('请先选择一个角色，再批量生成立绘结果与映射。');
      return;
    }
    setMode('sprite');
    setError(`“${selected.name || '当前角色'}”的立绘批量生成功能即将接入，这里会按“立绘结果与映射”里的形态统一生成。`);
  }, [selected]);

  const triggerSingleSpriteGeneration = useCallback((emotion: string) => {
    if (!selected) return;
    setError(`“${selected.name || '当前角色'} / ${emotion || '未命名形态'}”的单张立绘生成功能即将接入。`);
  }, [selected]);

  const refreshFigureAssets = useCallback(async () => {
    setFigureAssetsLoading(true);
    try {
      const list = await listAssets(projectPath, 'figure');
      setFigureAssets(list);
    } catch (e) {
      setError(String(e));
      setFigureAssets([]);
    } finally {
      setFigureAssetsLoading(false);
    }
  }, [projectPath]);

  const uploadFigureAsset = useCallback(async () => {
    const path = await openDialog({
      title: '上传立绘素材',
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
    });
    if (!path) return;

    setFigureAssetImporting(true);
    setError(null);
    try {
      await importAsset(Array.isArray(path) ? path[0] : path, projectPath, 'figure');
      await refreshFigureAssets();
    } catch (e) {
      setError(String(e));
    } finally {
      setFigureAssetImporting(false);
    }
  }, [projectPath, refreshFigureAssets]);

  const removeFigureAsset = useCallback(async (asset: AssetInfo) => {
    setFigureAssetDeleting(asset.name);
    setError(null);
    try {
      await deleteAsset(projectPath, 'figure', asset.name);
      await refreshFigureAssets();
    } catch (e) {
      setError(String(e));
    } finally {
      setFigureAssetDeleting(null);
    }
  }, [projectPath, refreshFigureAssets]);

  useEffect(() => {
    if (!generationRequestToken) return;
    triggerBatchSpriteGeneration();
  }, [generationRequestToken, triggerBatchSpriteGeneration]);

  return (
    <div className={containerClass}>
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-primary/20">
            <Users className="w-4 h-4 text-primary" />
          </div>
          <h3 className="text-sm uppercase tracking-widest text-muted-foreground font-mono-family">
            人物管理
          </h3>
        </div>
        <div className="flex items-center gap-1">
          {onClose && (
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-center gap-2">
          {error}
          <button onClick={() => setError(null)} className="ml-auto underline hover:no-underline">关闭</button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <aside className={`${embedded ? 'w-80' : 'w-52'} border-r border-border bg-card/20 flex flex-col`}>
            <div className="p-3 border-b border-border">
              <button
                onClick={handleCreate}
                className="mb-3 w-full px-3 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-colors text-sm flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                添加新角色
              </button>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full pl-8 pr-2 py-2 text-xs rounded-md bg-input-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="搜索人物"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {filtered.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground text-xs text-center">
                  <Users className="w-8 h-8 opacity-40" />
                  暂无人物
                </div>
              ) : filtered.map((ch, index) => {
                const active = ch.id === selectedId;
                const sprite = ch.sprites[getReferenceSpriteIndex(ch)]?.file || ch.sprites[0]?.file;
                const color = ch.colorTheme || pickColor(index);
                return (
                  <div
                    key={ch.id}
                    className={`rounded-md border transition-all ${
                      active ? 'border-primary/40 bg-primary/10' : 'border-border/60 bg-card/30'
                    }`}
                  >
                    <button
                      onClick={() => {
                        setSelectedId(ch.id);
                        if (!active) setMode('info');
                      }}
                      className="w-full p-2 text-left"
                    >
                      <div className="flex items-center gap-2">
                        {sprite ? (
                          <img
                            src={convertFileSrc(`${projectPath}/game/figure/${sprite}`)}
                            className="w-10 h-10 rounded object-cover bg-secondary/40 flex-shrink-0"
                            alt=""
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <div className="w-10 h-10 rounded bg-secondary/50 flex items-center justify-center flex-shrink-0">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="text-sm truncate">{ch.name || '未命名'}</div>
                          <div className="text-[10px] text-muted-foreground truncate">
                            {ch.stance || ch.personality || `${ch.sprites.length} 个立绘`}
                          </div>
                        </div>
                      </div>
                    </button>

                    {active && (
                      <div className="px-2 pb-2 grid grid-cols-2 gap-1">
                        <button
                          onClick={() => setMode('info')}
                          className={`px-2 py-1.5 rounded text-xs transition-colors flex items-center justify-center gap-1 ${
                            mode === 'info' ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 hover:bg-secondary'
                          }`}
                        >
                          <FileText className="w-3 h-3" />
                          基本信息
                        </button>
                        <button
                          onClick={() => setMode('sprite')}
                          className={`px-2 py-1.5 rounded text-xs transition-colors flex items-center justify-center gap-1 ${
                            mode === 'sprite' ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 hover:bg-secondary'
                          }`}
                        >
                          <Sparkles className="w-3 h-3" />
                          立绘创作
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          <main className="flex-1 min-w-0 overflow-y-auto">
            {!selected ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
                <Users className="w-12 h-12 opacity-40" />
                <button
                  onClick={handleCreate}
                  className="px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  新建人物
                </button>
              </div>
            ) : mode === 'info' ? (
              <div className="p-4 space-y-4 max-w-5xl">
                <section className="rounded-md border border-border bg-card/30 p-4">
                  <h4 className="mb-3 text-xs uppercase tracking-wide text-muted-foreground font-mono-family">基本信息</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>姓名 *</label>
                      <input
                        value={selected.name}
                        onChange={(e) => patchCharacter(selected.id, { name: e.target.value })}
                        className={`${inputClass} ${!selected.name.trim() ? 'border-destructive/50' : ''}`}
                        placeholder="角色姓名"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>别名</label>
                      <input
                        value={selected.aliases.join(', ')}
                        onChange={(e) => patchCharacter(selected.id, {
                          aliases: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        })}
                        className={inputClass}
                        placeholder="用逗号分隔"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>性别</label>
                      <input
                        value={selected.gender}
                        onChange={(e) => patchCharacter(selected.id, { gender: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>年龄</label>
                      <input
                        value={selected.age}
                        onChange={(e) => patchCharacter(selected.id, { age: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>性格</label>
                      <input
                        value={selected.personality}
                        onChange={(e) => patchCharacter(selected.id, { personality: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>立场</label>
                      <input
                        value={selected.stance}
                        onChange={(e) => patchCharacter(selected.id, { stance: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className={labelClass}>简介</label>
                      <textarea
                        value={selected.description}
                        onChange={(e) => patchCharacter(selected.id, { description: e.target.value })}
                        className={`${inputClass} h-20 resize-none`}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>关键词</label>
                      <input
                        value={selected.keywords.join(', ')}
                        onChange={(e) => patchCharacter(selected.id, {
                          keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        })}
                        className={inputClass}
                        placeholder="用逗号分隔"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>标识颜色</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={selected.colorTheme || pickColor(characters.indexOf(selected))}
                          onChange={(e) => patchCharacter(selected.id, { colorTheme: e.target.value })}
                          className="w-9 h-8 rounded border border-border bg-transparent"
                        />
                        <input
                          value={selected.colorTheme || ''}
                          onChange={(e) => patchCharacter(selected.id, { colorTheme: e.target.value })}
                          className={`${inputClass} font-mono-family`}
                          placeholder="#D4A574"
                        />
                      </div>
                    </div>
                    <div className="md:col-span-2">
                      <label className={labelClass}>对话风格</label>
                      <textarea
                        value={selected.dialogueStyle}
                        onChange={(e) => patchCharacter(selected.id, { dialogueStyle: e.target.value })}
                        className={`${inputClass} h-16 resize-none`}
                      />
                    </div>
                  </div>
                </section>

                <section className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-md border border-border bg-card/30 p-4">
                  <h4 className="md:col-span-2 text-xs uppercase tracking-wide text-muted-foreground font-mono-family">语音设置</h4>
                  <div>
                    <label className={labelClass}>默认语音</label>
                    <div className="flex items-center gap-2">
                      <Music className="w-3.5 h-3.5 text-muted-foreground" />
                      <input
                        value={selected.defaultVoice || ''}
                        onChange={(e) => patchCharacter(selected.id, { defaultVoice: e.target.value || undefined })}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>音色</label>
                    <input
                      value={selected.voiceTimbre || ''}
                      onChange={(e) => patchCharacter(selected.id, { voiceTimbre: e.target.value || undefined })}
                      className={inputClass}
                    />
                  </div>
                </section>

                <section className="space-y-2 rounded-md border border-border bg-card/30 p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">人物关系</h4>
                    <button
                      onClick={() => addRelation(selected.id)}
                      className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      添加
                    </button>
                  </div>
                  {selected.relations.map((rel, index) => (
                    <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-2 rounded-md bg-secondary/20 p-2">
                      <select
                        value={rel.targetId}
                        onChange={(e) => updateRelation(selected.id, index, 'targetId', e.target.value)}
                        className={inputClass}
                      >
                        <option value="">目标人物</option>
                        {otherCharacters(selected.id).map((target) => (
                          <option key={target.id} value={target.id}>{target.name}</option>
                        ))}
                      </select>
                      <input
                        value={rel.relationType}
                        onChange={(e) => updateRelation(selected.id, index, 'relationType', e.target.value)}
                        className={inputClass}
                        placeholder="关系"
                      />
                      <input
                        value={rel.description}
                        onChange={(e) => updateRelation(selected.id, index, 'description', e.target.value)}
                        className={inputClass}
                        placeholder="说明"
                      />
                      <button
                        onClick={() => removeRelation(selected.id, index)}
                        className="p-1.5 hover:bg-destructive/10 rounded transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                      </button>
                    </div>
                  ))}
                </section>

                <section className="rounded-md border border-border bg-card/30 p-4">
                  <label className={labelClass}>备注</label>
                  <textarea
                    value={selected.notes}
                    onChange={(e) => patchCharacter(selected.id, { notes: e.target.value })}
                    className={`${inputClass} h-20 resize-none`}
                  />
                </section>
              </div>
            ) : (
              <div className="p-4 space-y-4 max-w-6xl">
                <section className="rounded-md border border-border bg-card/30 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">主体立绘素材</h4>
                      <p className="mt-1 text-xs text-muted-foreground">从人物素材库选择主立绘；下面的主体参考图会单独绑定到当前人物，用于后续 AI 一致性控制。</p>
                    </div>
                    <AssetPickerButton
                      projectPath={projectPath}
                      category="figure"
                      currentValue={referenceSprite?.file || ''}
                      onSelect={(filename) => setReferenceFile(selected.id, filename === 'none' ? '' : filename)}
                    />
                  </div>

                  <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-4">
                    <div className="aspect-[3/4] rounded-md border border-border bg-secondary/30 overflow-hidden flex items-center justify-center">
                      {referenceSprite?.file ? (
                        <img
                          src={convertFileSrc(`${projectPath}/game/figure/${referenceSprite.file}`)}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="w-10 h-10 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className={labelClass}>一致性描述</label>
                        <textarea
                          value={selected.consistencyPrompt || ''}
                          onChange={(e) => patchCharacter(selected.id, { consistencyPrompt: e.target.value })}
                          className={`${inputClass} h-20 resize-none font-mono-family`}
                          placeholder="二次元风格，银发，红眼，校服，单人"
                        />
                      </div>
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <label className={labelClass}>主体参考图</label>
                          <span className="text-[10px] text-muted-foreground">最多 5 张</span>
                        </div>
                        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
                          {(selected.referenceImages ?? []).map((filename) => (
                            <div key={filename} className="group relative aspect-square rounded-md border border-border bg-secondary/20 overflow-hidden">
                              <img
                                src={convertFileSrc(`${projectPath}/game/config/references/${selected.id}/${filename}`)}
                                alt=""
                                className="w-full h-full object-cover"
                              />
                              <button
                                type="button"
                                onClick={() => removeReferenceImage(selected.id, filename)}
                                className="absolute right-1 top-1 p-1 rounded bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
                                aria-label="移除参考图"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                          {(selected.referenceImages?.length ?? 0) < 5 && (
                            <button
                              type="button"
                              onClick={() => uploadReferenceImage(selected.id)}
                              disabled={referenceUploading || !selected.name.trim()}
                              className="aspect-square rounded-md border border-dashed border-border bg-secondary/10 hover:bg-secondary/30 transition-colors flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground disabled:opacity-50"
                            >
                              {referenceUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                              上传主体参考图
                            </button>
                          )}
                        </div>
                        <p className="mt-2 text-[10px] text-muted-foreground">支持 PNG/JPG/WEBP。上传或删除后会自动保存到当前人物。</p>
                      </div>
                      <div className="rounded-md bg-secondary/20 p-3 text-xs text-muted-foreground">
                        生成提示词会组合为：一致性描述 + 主体素材参考 + 形态 + 表情。当前阶段保留 UI 框架，后续接入图片生成接口后自动保存到 game/figure/。
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-md border border-border bg-card/30 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">立绘素材库</h4>
                      <p className="mt-1 text-xs text-muted-foreground">这里集中管理人物可用的立绘素材。上传后的图片会出现在主体素材选择器和各个立绘映射里。</p>
                    </div>
                    <button
                      type="button"
                      onClick={uploadFigureAsset}
                      disabled={figureAssetImporting}
                      className="px-3 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-colors text-xs flex items-center gap-2 disabled:opacity-50"
                    >
                      {figureAssetImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                      上传立绘素材
                    </button>
                  </div>

                  {figureAssetsLoading ? (
                    <div className="h-28 rounded-md border border-dashed border-border flex items-center justify-center text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </div>
                  ) : figureAssets.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                      还没有立绘素材。可以从右上角或这里上传，上传后会立刻出现在选择器里。
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
                      {figureAssets.map((asset) => {
                        const isCurrentReference = referenceSprite?.file === asset.name;
                        return (
                          <div key={asset.path} className="rounded-md border border-border bg-secondary/20 overflow-hidden">
                            <div className="aspect-[3/4] bg-background/40 overflow-hidden">
                              <img
                                src={convertFileSrc(asset.path)}
                                alt={asset.name}
                                className="w-full h-full object-cover"
                              />
                            </div>
                            <div className="p-2 space-y-2">
                              <div className="truncate text-xs font-medium" title={asset.name}>{asset.name}</div>
                              <div className="text-[10px] text-muted-foreground">
                                {isCurrentReference ? '当前主体素材' : '可用于主体与立绘映射'}
                              </div>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => setReferenceFile(selected.id, asset.name)}
                                  className={`flex-1 px-2 py-1.5 rounded text-[10px] transition-colors ${
                                    isCurrentReference
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-primary/10 text-primary hover:bg-primary/20'
                                  }`}
                                >
                                  {isCurrentReference ? '当前主体' : '设为主体'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeFigureAsset(asset)}
                                  disabled={figureAssetDeleting === asset.name}
                                  className="px-2 py-1.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 text-[10px] disabled:opacity-50"
                                >
                                  {figureAssetDeleting === asset.name ? '删除中' : '删除'}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="rounded-md border border-border bg-card/30 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">剧本分析出的形态与表情</h4>
                      <p className="mt-1 text-xs text-muted-foreground">这里展示建议生成的立绘类型，后续会从剧本自动分析得到。</p>
                    </div>
                    <button
                      onClick={() => setShowEmotionPicker((value) => !value)}
                      className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      新增
                    </button>
                  </div>

                  {showEmotionPicker && (
                    <div className="mb-3 rounded-md border border-border bg-secondary/20 p-3">
                      <div className="mb-2 text-xs text-muted-foreground">常用情绪</div>
                      <div className="flex flex-wrap gap-2">
                        {commonEmotions.map((emotion) => (
                          <button
                            key={emotion}
                            type="button"
                            onClick={() => addEmotionPreset(selected.id, emotion)}
                            className="px-2 py-1 rounded bg-background/60 hover:bg-primary/10 hover:text-primary text-xs border border-border"
                          >
                            {emotion}
                          </button>
                        ))}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <input
                          value={customEmotion}
                          onChange={(e) => setCustomEmotion(e.target.value)}
                          className={inputClass}
                          placeholder="自定义情绪"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            addEmotionPreset(selected.id, customEmotion);
                            setCustomEmotion('');
                          }}
                          className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-xs"
                        >
                          添加
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                    {spriteSuggestions.map((suggestion) => (
                      <button
                        key={`${suggestion.pose}-${suggestion.emotion}`}
                        onClick={() => addSprite(selected.id, `${suggestion.pose}-${suggestion.emotion}`)}
                        className="rounded-md border border-border bg-secondary/20 p-3 text-left hover:border-primary/40 hover:bg-primary/10 transition-colors"
                      >
                        <div className="text-sm">{suggestion.pose}</div>
                        <div className="mt-1 text-xs text-primary">{suggestion.emotion}</div>
                        <div className="mt-2 text-[10px] text-muted-foreground font-mono-family">{suggestion.prompt}</div>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="space-y-2 rounded-md border border-border bg-card/30 p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">立绘结果与映射</h4>
                    <button
                      onClick={triggerBatchSpriteGeneration}
                      className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs flex items-center gap-1"
                    >
                      <Sparkles className="w-3 h-3" />
                      批量生成当前角色
                    </button>
                  </div>
                  {variantSprites.length === 0 && (
                    <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-3">暂无形态或表情立绘。</div>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
                    {variantSprites.map(({ sprite, index }) => (
                      <div key={index} className="rounded-md border border-border bg-secondary/20 overflow-hidden">
                        <div className="p-2 flex items-center gap-1">
                          <input
                            value={sprite.emotion}
                            onChange={(e) => updateSprite(selected.id, index, 'emotion', e.target.value)}
                            className="min-w-0 flex-1 bg-transparent text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary/40 rounded px-1 py-0.5"
                            placeholder="情绪标签"
                          />
                          <button
                            onClick={() => removeSprite(selected.id, index)}
                            className="p-1 hover:bg-destructive/10 rounded transition-colors"
                            aria-label="删除立绘"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                        <div className="aspect-[3/4] bg-background/40 flex items-center justify-center overflow-hidden">
                          {sprite.file ? (
                            <img
                              src={convertFileSrc(`${projectPath}/game/figure/${sprite.file}`)}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <ImageIcon className="w-8 h-8 text-muted-foreground/40" />
                          )}
                        </div>
                        <div className="p-2 space-y-2">
                          <div className="truncate text-[10px] text-muted-foreground font-mono-family">
                            {sprite.file || '未选择文件'}
                          </div>
                          <AssetPickerButton
                            projectPath={projectPath}
                            category="figure"
                            currentValue={sprite.file}
                            onSelect={(filename) => updateSprite(selected.id, index, 'file', filename === 'none' ? '' : filename)}
                          />
                          <button
                            type="button"
                            onClick={() => triggerSingleSpriteGeneration(sprite.emotion)}
                            className="w-full px-2 py-1.5 rounded bg-secondary/60 text-muted-foreground text-xs flex items-center justify-center gap-1 hover:bg-primary/10 hover:text-primary transition-colors"
                          >
                            <Sparkles className="w-3 h-3" />
                            生成此立绘
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-md border border-border bg-card/30 p-4">
                  <button
                    type="button"
                    onClick={() => setUsageOpen((value) => !value)}
                    className="w-full flex items-center justify-between text-left"
                  >
                    <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">剧本引用</h4>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {spriteUsages.length} 条
                      <ChevronDown className={`w-4 h-4 transition-transform ${usageOpen ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {usageOpen && (
                    <div className="mt-3 space-y-2">
                      {spriteUsages.length === 0 ? (
                        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-3">未在剧本中找到该角色立绘引用。</div>
                      ) : spriteUsages.map((usage, index) => (
                        <button
                          key={`${usage.assetName}-${usage.sceneFile}-${usage.lineNumber}-${index}`}
                          type="button"
                          onClick={() => openUsage(usage)}
                          className="w-full rounded-md bg-secondary/20 p-2 text-left hover:bg-primary/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-mono-family text-primary">{usage.assetName}</span>
                            <span className="text-muted-foreground">{usage.sceneFile} 第 {usage.lineNumber} 行</span>
                            <ExternalLink className="ml-auto w-3 h-3 text-muted-foreground" />
                          </div>
                          <div className="mt-1 truncate text-[10px] text-muted-foreground font-mono-family">{usage.lineContent}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {selected && (
              <div className="sticky bottom-0 px-4 py-3 border-t border-border bg-card/95 backdrop-blur flex items-center justify-between">
                <button
                  onClick={() => handleDelete(selected.id)}
                  disabled={savingId === selected.id}
                  className="px-3 py-2 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors text-xs flex items-center gap-2 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  删除
                </button>
                <button
                  onClick={() => handleSave(selected)}
                  disabled={savingId === selected.id || !selected.name.trim()}
                  className={`px-4 py-2 rounded-md transition-all text-xs font-medium flex items-center gap-2 disabled:opacity-50 ${
                    recentlySavedId === selected.id
                      ? 'bg-emerald-600 text-white'
                      : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {savingId === selected.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : recentlySavedId === selected.id ? (
                    <Palette className="w-3.5 h-3.5" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  {savingId === selected.id ? '保存中' : recentlySavedId === selected.id ? '已保存' : '保存'}
                </button>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
