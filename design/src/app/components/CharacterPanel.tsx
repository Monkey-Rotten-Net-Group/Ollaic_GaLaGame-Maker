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
  Palette,
  Loader2,
  Search,
  Sparkles,
  Save,
  FileText,
  Upload,
  Check,
} from 'lucide-react';
import type { Character, CharacterSprite } from '../lib/character-types';
import {
  appendCharacterSprite,
  appendEmotionPreset,
  characterColor,
  createDraftCharacter,
  patchCharacter as patchCharacterList,
  referenceSpriteIndex,
  removeCharacterSprite,
  updateCharacterSprite,
  withReferenceSprite,
} from '../lib/character-editing';
import {
  createCharacter,
  deleteCharacter,
  listCharacters,
  updateCharacter,
} from '../lib/character-ipc';
import {
  deleteAsset,
  findAssetUsages,
  importAsset,
  saveGeneratedAsset,
  listAssets,
  type AssetInfo,
  type AssetUsage,
} from '../lib/assets-ipc';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  aiGenerateImage,
  removeBackground,
  getAiImageConfig,
  listenAiMediaGenerationProgress,
  type AiMediaGenerationProgress,
  type AiProviderConfig,
} from '../lib/ai-ipc';

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
  keepSelection?: boolean;
};

const inputClass = 'w-full px-2.5 py-1.5 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-xs';
const labelClass = 'block text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-mono-family';
const spriteSuggestions = [
  { pose: '日常站姿', emotion: '微笑', prompt: 'standing pose, gentle smile, relaxed hands' },
  { pose: '对话半身', emotion: '认真', prompt: 'upper body, serious expression, looking at viewer' },
  { pose: '惊讶反应', emotion: '惊讶', prompt: 'surprised expression, slightly opened mouth' },
  { pose: '剧情低落', emotion: '悲伤', prompt: 'sad expression, lowered eyes' },
];
const commonEmotions = ['默认', '微笑', '悲伤', '惊讶', '愤怒', '害羞', '思考', '严肃'];

// CosyVoice 常用音色（音色 ID 必须与所选模型版本匹配：v2 模型用带 _v2 后缀的音色）。
// 仅作下拉建议，用户也可手填其他音色 ID。
const voiceTimbrePresets: { value: string; label: string }[] = [
  { value: '', label: '未设置（用默认音色）' },
  { value: 'longxiaochun_v2', label: '龙小淳 v2 · 知性女声' },
  { value: 'longxiaoxia_v2', label: '龙小夏 v2 · 温柔女声' },
  { value: 'longwanjun', label: '龙婉君 · 标准女声' },
  { value: 'longanrou', label: '龙安柔 · 柔和女声' },
  { value: 'longyumi_v2', label: '龙裕米 v2 · 甜美女声' },
  { value: 'longxiaobai_v2', label: '龙小白 v2 · 清亮男声' },
  { value: 'longlaotie_v2', label: '龙老铁 v2 · 东北男声' },
  { value: 'longshu_v2', label: '龙书 v2 · 沉稳男声' },
  { value: 'longjielidou_v2', label: '龙杰力豆 v2 · 活泼童声' },
  { value: 'libai_v2', label: '李白 v2 · 古风男声' },
];

interface SpriteUsage extends AssetUsage {
  assetName: string;
}

type SpriteGenerationTarget =
  | { kind: 'reference' }
  | { kind: 'variant'; index: number };

type PendingSpriteGeneration = {
  emotion: string;
  target: SpriteGenerationTarget;
  batch?: boolean;
};

function parseConfiguredModels(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

function sanitizeFilenamePart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

// 与 generateSprite 的命名规则保持一致：文件名为
// `${characterPart}_${emotionPart}_${timestamp}.${ext}`。用前缀判断某情绪是否已生成。
function characterFilenamePart(character: Character): string {
  return sanitizeFilenamePart(character.name || character.id, 'character');
}

function spritePrefix(characterPart: string, emotion: string): string {
  return `${characterPart}_${sanitizeFilenamePart(emotion, 'sprite')}_`;
}

// 提示词完全以「本次生成提示词 + 参考图」为准，不再注入任何角色上下文字段
// （性别/年龄/外观设定/性格/剧情定位/说话风格/关键词都不进生图提示词，仅供文本生成参考）：
// - 本次提示词放在质量前缀之后第一位，扩散模型对靠前 token 更敏感。
// - 有参考图时外观一致性交给参考图，本次提示词决定姿势/表情/镜头等本次内容。
function buildSpritePrompt(
  character: Character,
  sprite: CharacterSprite,
  isReference: boolean,
  instruction: string,
): string {
  return [
    'visual novel character sprite, full body, plain white background, clean anime game asset, consistent character design',
    isReference ? 'main reference sprite, neutral readable pose, front-facing character design sheet quality' : '',
    instruction ? `本次生成提示词：${instruction}` : '',
    sprite.emotion ? `立绘形态/情绪：${sprite.emotion}` : '',
    'the background must be plain white or very light gray with no gradients shadows or patterns, avoid background scene, avoid text, avoid watermark, avoid extra characters',
  ].filter(Boolean).join('\n');
}

// 立绘按角色存放在 game/figure/<角色ID>/ 子目录；sprite.file 存子目录限定路径
// "<角色ID>/<文件名>"。以下两个工具在「限定路径」与「平铺文件名」之间转换。
function qualifyFigureFile(charId: string, name: string): string {
  if (!name) return '';
  return name.includes('/') ? name : `${charId}/${name}`;
}

function figureFileTail(file: string): string {
  if (!file) return '';
  const slash = file.lastIndexOf('/');
  return slash >= 0 ? file.slice(slash + 1) : file;
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
  // 待确认删除的角色 id（弹应用内确认框，避免依赖在 Tauri 里可能不弹的原生 confirm）。
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [showEmotionPicker, setShowEmotionPicker] = useState(false);
  const [customEmotion, setCustomEmotion] = useState('');
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [figureAssets, setFigureAssets] = useState<AssetInfo[]>([]);
  const [figureAssetsLoading, setFigureAssetsLoading] = useState(true);
  const [figureAssetImporting, setFigureAssetImporting] = useState(false);
  const [figureAssetDeleting, setFigureAssetDeleting] = useState<string | null>(null);
  // 主体图候选（存于 figure/<角色ID>/main/，与下方素材库隔离）。
  const [mainCandidates, setMainCandidates] = useState<AssetInfo[]>([]);
  const [mainCandidateDeleting, setMainCandidateDeleting] = useState<string | null>(null);
  // 本次生成主体图选用的参考图（图生图输入），单选；空表示纯文本生成。
  const [selectedReferenceImage, setSelectedReferenceImage] = useState<string | null>(null);
  const [spriteUsages, setSpriteUsages] = useState<SpriteUsage[]>([]);
  const [usageOpen, setUsageOpen] = useState(false);
  const [figureLibraryOpen, setFigureLibraryOpen] = useState(false);
  const [spriteGeneratingKey, setSpriteGeneratingKey] = useState<string | null>(null);
  const [pendingSpriteGeneration, setPendingSpriteGeneration] = useState<PendingSpriteGeneration | null>(null);
  // 当前展开提示词编辑框的变体索引；null 表示全部折叠为摘要行。
  const [expandedPromptIndex, setExpandedPromptIndex] = useState<number | null>(null);
  const savingRef = useRef(false);

  const emotionColor = (emotion: string): string => {
    const key = emotion.toLowerCase();
    if (key.includes('微笑') || key.includes('高兴') || key.includes('开心') || key.includes('笑') || key === 'happy' || key === 'smile') return 'var(--color-emotion-happy)';
    if (key.includes('悲伤') || key.includes('低落') || key.includes('哭') || key === 'sad' || key === 'cry') return 'var(--color-emotion-sad)';
    if (key.includes('愤怒') || key.includes('生气') || key === 'angry') return 'var(--color-emotion-angry)';
    if (key.includes('惊讶') || key === 'surprised') return 'var(--color-emotion-surprised)';
    if (key.includes('害羞') || key.includes('羞') || key === 'shy') return 'var(--color-emotion-shy)';
    if (key.includes('思考') || key.includes('认真') || key.includes('严肃') || key === 'serious') return 'var(--color-emotion-serious)';
    if (key.includes('默认') || key === 'default') return 'var(--color-emotion-default)';
    return 'var(--color-emotion-happy)';
  };

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
    if (!selectedId) {
      setFigureAssets([]);
      setFigureAssetsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setFigureAssetsLoading(true);
      try {
        // 每个角色的立绘存放在 game/figure/<角色ID>/ 子目录，按角色隔离。
        // 变体/备用图在顶层；主体候选在 main/ 子目录（不进素材库）。
        const [variants, candidates] = await Promise.all([
          listAssets(projectPath, `figure/${selectedId}`),
          listAssets(projectPath, `figure/${selectedId}/main`).catch(() => [] as AssetInfo[]),
        ]);
        if (!cancelled) {
          setFigureAssets(variants);
          setMainCandidates(candidates);
        }
      } catch {
        if (!cancelled) {
          setFigureAssets([]);
          setMainCandidates([]);
        }
      } finally {
        if (!cancelled) setFigureAssetsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath, selectedId, figureLibraryRefreshToken]);

  // 切换角色时重置本次选用的参考图。
  useEffect(() => {
    setSelectedReferenceImage(null);
  }, [selectedId]);

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

  const patchCharacter = useCallback((id: string, partial: Partial<Character>) => {
    setCharacters((prev) => patchCharacterList(prev, id, partial));
  }, []);

  const persistCharacter = useCallback(async (ch: Character, options: PersistOptions = {}) => {
    if (!ch.name.trim() || savingRef.current) return null;
    const { showSavedBadge = true, keepSelection = false } = options;
    savingRef.current = true;
    setSavingId(ch.id);
    setError(null);
    try {
      const saved = ch.id.startsWith('tmp_')
        ? await createCharacter(projectPath, ch)
        : await updateCharacter(projectPath, ch);
      setCharacters((prev) => prev.map((c) => (c.id === ch.id ? saved : c)));
      // 切换角色场景下不要把选中拉回当前角色，否则会和切换目标打架导致卡住。
      if (!keepSelection) setSelectedId(saved.id);
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

  const handleCreate = useCallback(async () => {
    // 立即落盘，避免切换 Tab 后 CharacterPanel 卸载导致未保存的草稿丢失。
    const draft = { ...createDraftCharacter(characters.length), name: '新角色' };
    setCharacters((prev) => [...prev, draft]);
    setSelectedId(draft.id);
    setMode('info');
    const saved = await persistCharacter(draft, { showSavedBadge: false });
    if (!saved) {
      // 落盘失败时回滚乐观插入的草稿，避免遗留无法保存的临时角色。
      setCharacters((prev) => prev.filter((c) => c.id !== draft.id));
    }
  }, [characters.length, persistCharacter]);

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

  // 点击删除：先弹应用内确认框，不直接删。
  const handleDelete = useCallback((id: string) => {
    setPendingDeleteId(id);
  }, []);

  // 确认后真正删除。
  const confirmDelete = useCallback(async (id: string) => {
    setPendingDeleteId(null);
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
    setCharacters((prev) => updateCharacterSprite(prev, charId, index, field, value));
  }, []);

  const addSprite = useCallback((charId: string, emotion = '', prompt = '') => {
    setCharacters((prev) => appendCharacterSprite(prev, charId, emotion, prompt));
  }, []);

  const addEmotionPreset = useCallback((charId: string, emotion: string, prompt = '') => {
    setCharacters((prev) => appendEmotionPreset(prev, charId, emotion, prompt));
  }, []);

  const setReferenceFile = useCallback(async (charId: string, filename: string) => {
    const current = characters.find((c) => c.id === charId);
    if (!current) return;
    const base = current.id.startsWith('tmp_')
      ? await ensurePersistedCharacter(charId, '设置主体素材')
      : current;
    if (!base) return;

    // 存子目录限定路径 <角色ID>/<文件名>，空值表示清除主体。
    const qualified = qualifyFigureFile(base.id, filename);
    await persistCharacter(withReferenceSprite(base, qualified), { showSavedBadge: false });
  }, [characters, ensurePersistedCharacter, persistCharacter]);

  const setReferencePrompt = useCallback((charId: string, prompt: string) => {
    setCharacters((prev) => prev.map((character) => {
      if (character.id !== charId) return character;
      const index = referenceSpriteIndex(character);
      if (index >= 0) {
        const sprites = character.sprites.map((sprite, spriteIndex) =>
          spriteIndex === index ? { ...sprite, emotion: '主体参考', prompt } : sprite,
        );
        return { ...character, sprites };
      }
      return {
        ...character,
        sprites: [{ emotion: '主体参考', file: '', prompt }, ...character.sprites],
      };
    }));
  }, []);

  const removeSprite = useCallback((charId: string, index: number) => {
    setCharacters((prev) => removeCharacterSprite(prev, charId, index));
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

  const containerClass = embedded
    ? 'h-full flex flex-col overflow-hidden'
    : 'flex-1 flex flex-col overflow-hidden';

  const referenceIndex = selected ? referenceSpriteIndex(selected) : -1;
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
            const usages = await findAssetUsages(projectPath, filename, 'figure');
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

  const refreshFigureAssets = useCallback(async () => {
    if (!selectedId) {
      setFigureAssets([]);
      return;
    }
    setFigureAssetsLoading(true);
    try {
      const list = await listAssets(projectPath, `figure/${selectedId}`);
      setFigureAssets(list);
    } catch (e) {
      setError(String(e));
      setFigureAssets([]);
    } finally {
      setFigureAssetsLoading(false);
    }
  }, [projectPath, selectedId]);

  // sprite.file 优先；否则按情绪前缀匹配素材库中最新文件。
  const findSpriteAssetSrc = useCallback((sprite: CharacterSprite): string | null => {
    if (!selected) return null;
    if (sprite.file) {
      const tail = figureFileTail(sprite.file);
      const match = figureAssets.find((asset) => figureFileTail(asset.name) === tail);
      if (match) return convertFileSrc(match.path);
      return convertFileSrc(`${projectPath}/game/figure/${sprite.file}`);
    }
    const prefix = spritePrefix(characterFilenamePart(selected), sprite.emotion);
    const matches = figureAssets
      .filter((asset) => figureFileTail(asset.name).startsWith(prefix))
      .sort((a, b) => figureFileTail(b.name).localeCompare(figureFileTail(a.name)));
    return matches[0] ? convertFileSrc(matches[0].path) : null;
  }, [figureAssets, projectPath, selected]);

  const hasGeneratedAsset = useCallback((emotion: string): boolean => {
    return findSpriteAssetSrc({ emotion, file: '' }) !== null;
  }, [findSpriteAssetSrc]);

  const refreshMainCandidates = useCallback(async () => {
    if (!selectedId) {
      setMainCandidates([]);
      return;
    }
    try {
      const list = await listAssets(projectPath, `figure/${selectedId}/main`);
      setMainCandidates(list);
    } catch {
      setMainCandidates([]);
    }
  }, [projectPath, selectedId]);

  // 从主体候选中选定当前主体（file 用 <角色ID>/main/<文件名> 限定路径）。
  const setMainFromCandidate = useCallback((asset: AssetInfo) => {
    if (!selectedId) return;
    void setReferenceFile(selectedId, `${selectedId}/main/${figureFileTail(asset.name)}`);
  }, [selectedId, setReferenceFile]);

  const removeMainCandidate = useCallback(async (asset: AssetInfo) => {
    if (!selectedId) return;
    const tail = figureFileTail(asset.name);
    setMainCandidateDeleting(asset.name);
    setError(null);
    try {
      await deleteAsset(projectPath, `figure/${selectedId}/main`, tail);
      // 若删除的是当前主体，清空主体引用。
      const current = characters.find((c) => c.id === selectedId);
      if (current && referenceSpriteIndex(current) >= 0
        && figureFileTail(current.sprites[referenceSpriteIndex(current)].file) === tail) {
        await setReferenceFile(selectedId, '');
      }
      await refreshMainCandidates();
    } catch (e) {
      setError(String(e));
    } finally {
      setMainCandidateDeleting(null);
    }
  }, [characters, projectPath, refreshMainCandidates, selectedId, setReferenceFile]);

  const generateSprite = useCallback(async (
    emotion: string,
    target: SpriteGenerationTarget,
    model: string,
    instruction: string,
    sourceCharacter?: Character,
  ) => {
    const current = sourceCharacter ?? selected;
    if (!current) return null;
    if (!projectPath) {
      setError('未打开项目，无法保存生成立绘。');
      return null;
    }

    const persisted = current.id.startsWith('tmp_')
      ? await ensurePersistedCharacter(current.id, '生成立绘')
      : current;
    if (!persisted) return null;

    const sprite =
      target.kind === 'reference'
        ? persisted.sprites[referenceSpriteIndex(persisted)] ?? { emotion: emotion || '主体参考', file: '', prompt: '' }
        : persisted.sprites[target.index];
    if (!sprite) {
      setError('没有找到要生成的立绘形态。');
      return null;
    }

    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction) {
      setError('请先填写本次立绘生成提示词，再生成。');
      return null;
    }

    const effectiveSprite = {
      ...sprite,
      emotion: emotion || sprite.emotion || (target.kind === 'reference' ? '主体参考' : '默认'),
    };
    const key = target.kind === 'reference' ? 'reference' : `variant:${target.index}`;
    setSpriteGeneratingKey(key);
    setError(null);
    try {
      // 主体图生成可带用户选定的参考图；表情变体自动以已确认的主体图作为参考，
      // 保证各变体与主体设计一致。不支持图生图的供应商（如火山引擎）会静默忽略。
      let referenceImagePath: string | undefined;
      if (target.kind === 'reference' && selectedReferenceImage) {
        referenceImagePath = `${projectPath}/game/reference/${persisted.id}/${selectedReferenceImage}`;
      } else if (target.kind === 'variant') {
        const refIdx = referenceSpriteIndex(persisted);
        const mainFile = refIdx >= 0 ? persisted.sprites[refIdx]?.file : undefined;
        if (mainFile) {
          referenceImagePath = `${projectPath}/game/figure/${mainFile}`;
        }
      }
      const media = await aiGenerateImage(
        buildSpritePrompt(persisted, effectiveSprite, target.kind === 'reference', trimmedInstruction),
        model,
        referenceImagePath,
      );
      // 抠背景：AI 出图多为白底/纯色底，用本地 ONNX 模型扣成透明 PNG 再入库。
      // 失败不阻断流程，回退使用原图；成功则把原图保留到 _raw/ 子目录（不污染素材库）。
      let finalMedia = media;
      let matted = false;
      try {
        finalMedia = await removeBackground(media.base64Data);
        matted = true;
      } catch (e) {
        console.warn('立绘抠背景失败，使用原图：', e);
      }
      const ts = Date.now();
      const extension = finalMedia.extension?.replace(/^\./, '') || 'png';
      const characterPart = sanitizeFilenamePart(persisted.name || persisted.id, 'character');
      const emotionPart = sanitizeFilenamePart(effectiveSprite.emotion || 'sprite', 'sprite');
      const filename = `${characterPart}_${emotionPart}_${ts}.${extension}`;
      // 主体候选存 main/ 子目录（与素材库隔离）；表情变体存子目录顶层。
      const figureCategory = target.kind === 'reference'
        ? `figure/${persisted.id}/main`
        : `figure/${persisted.id}`;
      const asset = await saveGeneratedAsset(projectPath, figureCategory, filename, finalMedia.base64Data);
      // 抠图成功时，把未抠的原图保留到 _raw/ 子目录（list 不递归，故不进素材库展示），
      // 便于需要时回溯或换用其他抠图方式。失败为尽力而为，不影响主流程。
      if (matted) {
        const rawExtension = media.extension?.replace(/^\./, '') || 'png';
        const rawFilename = `${characterPart}_${emotionPart}_${ts}_raw.${rawExtension}`;
        try {
          await saveGeneratedAsset(projectPath, `${figureCategory}/_raw`, rawFilename, media.base64Data);
        } catch (e) {
          console.warn('保存立绘原图失败：', e);
        }
      }
      // 仅主体（reference）需要把限定路径写回 sprite.file；变体图只进素材库不绑定。
      const qualifiedFile = `${persisted.id}/main/${asset.name}`;
      const nextCharacter = target.kind === 'reference'
        ? (() => {
            const next = withReferenceSprite(persisted, qualifiedFile);
            const index = referenceSpriteIndex(next);
            return {
              ...next,
              sprites: next.sprites.map((item, itemIndex) =>
                itemIndex === index ? { ...item, prompt: trimmedInstruction } : item,
              ),
            };
          })()
        : {
            ...persisted,
            sprites: persisted.sprites.map((item, index) =>
              // 变体生成的图片只进素材库（figure/<角色ID>/），卡片不绑定具体图片，
              // 脚本从素材库挑图。故 file 置空，仅保留情绪与提示词。
              index === target.index ? { ...item, emotion: effectiveSprite.emotion, file: '', prompt: trimmedInstruction } : item,
            ),
          };
      const saved = await persistCharacter(nextCharacter, { showSavedBadge: false });
      if (target.kind === 'reference') {
        await refreshMainCandidates();
      } else {
        await refreshFigureAssets();
      }
      setMode('sprite');
      return saved;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setSpriteGeneratingKey(null);
    }
  }, [ensurePersistedCharacter, persistCharacter, projectPath, refreshFigureAssets, refreshMainCandidates, selected, selectedReferenceImage]);

  const triggerBatchSpriteGeneration = useCallback(() => {
    if (!selected) {
      setError('请先选择一个角色，再批量生成。');
      return;
    }
    if (variantSprites.length === 0) {
      setMode('sprite');
      setError('请先添加表情变体，再批量生成。');
      return;
    }
    setMode('sprite');
    setError(null);
    setPendingSpriteGeneration({ emotion: '批量生成', target: { kind: 'variant', index: -1 }, batch: true });
  }, [selected, variantSprites]);

  const triggerSingleSpriteGeneration = useCallback((emotion: string, target: SpriteGenerationTarget = { kind: 'reference' }) => {
    if (!selected) return;
    setPendingSpriteGeneration({ emotion, target });
  }, [selected]);

  const handleConfirmSpriteGeneration = useCallback(async (model: string) => {
    if (!selected || !pendingSpriteGeneration) return;
    if (pendingSpriteGeneration.batch) {
      let current: Character | null = selected;
      let generatedCount = 0;
      for (const { sprite, index } of variantSprites) {
        if (hasGeneratedAsset(sprite.emotion)) continue;  // 已生成跳过
        if (!sprite.prompt?.trim()) continue;              // 无提示词跳过
        current = await generateSprite(
          sprite.emotion,
          { kind: 'variant', index },
          model,
          sprite.prompt,
          current ?? undefined,
        );
        if (!current) return;
        generatedCount += 1;
      }
      const skippedNoPrompt = variantSprites.filter(({ sprite }) =>
        !hasGeneratedAsset(sprite.emotion) && !sprite.prompt?.trim(),
      ).length;
      if (generatedCount === 0 && skippedNoPrompt === 0) {
        setError('所有变体均已生成，如需重做请用单个变体的「重新生成」按钮。');
      } else if (skippedNoPrompt > 0 && generatedCount === 0) {
        setError(`${skippedNoPrompt} 个变体缺少提示词已跳过，请填写后重试。`);
      } else if (skippedNoPrompt > 0) {
        setError(`已生成 ${generatedCount} 个，${skippedNoPrompt} 个缺少提示词已跳过。`);
      }
      setPendingSpriteGeneration(null);
      return;
    }
    const instruction = pendingSpriteGeneration.target.kind === 'reference'
      ? referenceSprite?.prompt ?? ''
      : selected.sprites[pendingSpriteGeneration.target.index]?.prompt ?? '';
    if (!instruction.trim()) {
      throw new Error(pendingSpriteGeneration.target.kind === 'reference'
        ? '请先填写主体区域的设定图提示词。'
        : '请先填写该表情变体的提示词。');
    }
    const saved = await generateSprite(
      pendingSpriteGeneration.emotion,
      pendingSpriteGeneration.target,
      model,
      instruction,
    );
    if (saved) setPendingSpriteGeneration(null);
  }, [generateSprite, hasGeneratedAsset, pendingSpriteGeneration, referenceSprite, selected, variantSprites]);

  const uploadFigureAsset = useCallback(async () => {
    if (!selectedId) {
      setError('请先选择或新建一个角色，再上传立绘素材。');
      return;
    }
    const path = await openDialog({
      title: '上传立绘素材',
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
    });
    if (!path) return;

    setFigureAssetImporting(true);
    setError(null);
    try {
      await importAsset(Array.isArray(path) ? path[0] : path, projectPath, `figure/${selectedId}`);
      await refreshFigureAssets();
    } catch (e) {
      setError(String(e));
    } finally {
      setFigureAssetImporting(false);
    }
  }, [projectPath, refreshFigureAssets, selectedId]);

  const removeFigureAsset = useCallback(async (asset: AssetInfo) => {
    if (!selectedId) return;
    setFigureAssetDeleting(asset.name);
    setError(null);
    try {
      // asset.name 为子目录内平铺文件名，类别携带角色子目录。
      await deleteAsset(projectPath, `figure/${selectedId}`, figureFileTail(asset.name));
      await refreshFigureAssets();
    } catch (e) {
      setError(String(e));
    } finally {
      setFigureAssetDeleting(null);
    }
  }, [projectPath, refreshFigureAssets, selectedId]);

  useEffect(() => {
    if (!generationRequestToken) return;
    triggerBatchSpriteGeneration();
  }, [generationRequestToken, triggerBatchSpriteGeneration]);

  return (
    <div className={`${containerClass} story-os-blueprint bg-surface-container-lowest`}>
      <div className="h-12 border-b border-border bg-surface-container-lowest px-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="story-os-chamfer-tr p-2 rounded bg-primary/15 border border-primary/30">
            <Users className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-widest text-primary font-bold">角色空间</h3>
            <div className="text-[10px] text-muted-foreground">Character node matrix</div>
          </div>
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
          <aside className={`${embedded ? 'w-72' : 'w-56'} border-r border-border bg-surface-bright/85 backdrop-blur flex flex-col`}>
            <div className="p-3 border-b border-border bg-surface-container-low">
              <button
                onClick={handleCreate}
                className="story-os-chamfer-tr mb-3 w-full px-3 py-2 rounded bg-primary text-primary-foreground hover:opacity-90 transition-colors text-sm flex items-center justify-center gap-2"
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
                const sprite = ch.sprites[referenceSpriteIndex(ch)]?.file || ch.sprites[0]?.file;
                const color = ch.colorTheme || characterColor(index);
                return (
                  <div
                    key={ch.id}
                    className={`rounded border transition-all ${
                      active ? 'border-secondary bg-secondary/10 story-os-hard-shadow' : 'border-border/60 bg-surface-container-lowest/80'
                    }`}
                  >
                    <button
                      onClick={() => {
                        // 切换到其他角色前，先静默保存当前角色，避免未保存改动丢失。
                        if (selected && selected.id !== ch.id && selected.name.trim() && !selected.id.startsWith('tmp_')) {
                          persistCharacter(selected, { showSavedBadge: false, keepSelection: true });
                        }
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

          <main className="relative flex-1 min-w-0 overflow-y-auto">
            {selected && (
              <div className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center overflow-hidden opacity-40">
                <div className="relative h-[78%] w-full max-w-2xl rounded-t-[220px] border border-dashed border-primary/30 bg-primary/5">
                  <svg className="mx-auto h-full max-h-[620px] fill-none stroke-primary/45" strokeWidth="0.5" viewBox="0 0 400 600" aria-hidden="true">
                    <path d="M200,50 C150,50 120,100 120,150 C120,200 150,250 200,250 C250,250 280,200 280,150 C280,100 250,50 200,50 Z" />
                    <path d="M120,250 C80,250 50,400 50,600 L350,600 C350,400 320,250 280,250" />
                    <line strokeDasharray="2,2" x1="50" x2="350" y1="300" y2="300" />
                    <line strokeDasharray="2,2" x1="50" x2="350" y1="450" y2="450" />
                    <line strokeDasharray="2,2" x1="200" x2="200" y1="50" y2="600" />
                  </svg>
                  <div className="absolute bottom-1/4 left-0 border-l-2 border-primary pl-2 text-primary">
                    <div className="text-[10px] uppercase opacity-70">Node ID</div>
                    <div className="text-xs font-semibold">{selected.id}</div>
                  </div>
                </div>
              </div>
            )}
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
              <div className="relative z-10 p-4 space-y-4 max-w-5xl">
                <section className="story-os-panel p-4">
                  <div className="mb-4 pb-3 border-b border-border">
                    <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">基本信息</h4>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      以下字段会构成 AI 角色上下文，影响立绘生成与剧本辅助；关键词同时用于人物搜索。
                    </p>
                  </div>

                  {/* 身份标识 */}
                  <div className="mb-5">
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground/60">身份标识</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className={labelClass}>姓名 *</label>
                        <input
                          value={selected.name}
                          onChange={(e) => patchCharacter(selected.id, { name: e.target.value })}
                          className={`${inputClass} ${!selected.name.trim() ? 'border-destructive/50' : ''}`}
                          placeholder="角色姓名（用于脚本对话标识）"
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
                          placeholder="昵称、称号，逗号分隔；用于人物搜索"
                        />
                      </div>
                      <div>
                        <label className={labelClass}>性别</label>
                        <input
                          value={selected.gender}
                          onChange={(e) => patchCharacter(selected.id, { gender: e.target.value })}
                          className={inputClass}
                          placeholder="男 / 女 / 其他"
                        />
                      </div>
                      <div>
                        <label className={labelClass}>年龄</label>
                        <input
                          value={selected.age}
                          onChange={(e) => patchCharacter(selected.id, { age: e.target.value })}
                          className={inputClass}
                          placeholder="具体年龄或年龄段"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className={labelClass}>配音音色</label>
                        <select
                          value={voiceTimbrePresets.some((p) => p.value === (selected.voiceTimbre || '')) ? (selected.voiceTimbre || '') : '__custom__'}
                          onChange={(e) => {
                            const v = e.target.value;
                            // 选「自定义」时清空走输入框；否则写入预设音色（含空＝未设置）。
                            patchCharacter(selected.id, { voiceTimbre: v === '__custom__' ? '' : v });
                          }}
                          className={inputClass}
                        >
                          {voiceTimbrePresets.map((p) => (
                            <option key={p.value || 'none'} value={p.value}>{p.label}</option>
                          ))}
                          <option value="__custom__">自定义音色 ID…</option>
                        </select>
                        {!voiceTimbrePresets.some((p) => p.value === (selected.voiceTimbre || '')) && (
                          <input
                            value={selected.voiceTimbre || ''}
                            onChange={(e) => patchCharacter(selected.id, { voiceTimbre: e.target.value })}
                            className={`${inputClass} mt-2`}
                            placeholder="手填音色 ID，如 longxiaochun_v2"
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 形象设定 */}
                  <div className="mb-5">
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground/60">形象设定 · 立绘生成输入</div>
                    <div className="space-y-3">
                      <div>
                        <label className={labelClass}>外观设定</label>
                        <textarea
                          value={selected.description}
                          onChange={(e) => patchCharacter(selected.id, { description: e.target.value })}
                          className={`${inputClass} h-24 resize-none`}
                          placeholder="只写可画出来的内容：发型、瞳色、服装、体型、配饰、标志物。不要写背景故事。"
                        />
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className={labelClass}>性格气质</label>
                          <input
                            value={selected.personality}
                            onChange={(e) => patchCharacter(selected.id, { personality: e.target.value })}
                            className={inputClass}
                            placeholder="例：冷静、克制、对陌生人保持距离"
                          />
                        </div>
                        <div>
                          <label className={labelClass}>剧情定位</label>
                          <input
                            value={selected.stance}
                            onChange={(e) => patchCharacter(selected.id, { stance: e.target.value })}
                            className={inputClass}
                            placeholder="例：转校生 / 学生会成员 / 反派协力者"
                          />
                        </div>
                      </div>
                      <div>
                        <label className={labelClass}>关键词</label>
                        <input
                          value={selected.keywords.join(', ')}
                          onChange={(e) => patchCharacter(selected.id, {
                            keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                          })}
                          className={inputClass}
                          placeholder="例：学生, 傲娇, 学生会；逗号分隔，兼作搜索标签"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 创作辅助 */}
                  <div>
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground/60">创作辅助</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="md:col-span-2">
                        <label className={labelClass}>说话风格</label>
                        <textarea
                          value={selected.dialogueStyle}
                          onChange={(e) => patchCharacter(selected.id, { dialogueStyle: e.target.value })}
                          className={`${inputClass} h-16 resize-none`}
                          placeholder="例：句子短，少用感叹号；紧张时回避称呼对方名字。供文本生成参考，不影响立绘外观。"
                        />
                      </div>
                      <div>
                        <label className={labelClass}>标识颜色</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={selected.colorTheme || characterColor(characters.indexOf(selected))}
                            onChange={(e) => patchCharacter(selected.id, { colorTheme: e.target.value })}
                            className="w-9 h-8 rounded border border-border bg-transparent"
                          />
                          <input
                            value={selected.colorTheme || ''}
                            onChange={(e) => patchCharacter(selected.id, { colorTheme: e.target.value })}
                            className={`${inputClass} font-mono-family`}
                            placeholder="var(--color-character-1)"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="story-os-panel p-4">
                  <label className={labelClass}>内部备注</label>
                  <p className="mb-2 text-[10px] text-muted-foreground">制作备注、待办、设定来源；不参与立绘或配音生成。</p>
                  <textarea
                    value={selected.notes}
                    onChange={(e) => patchCharacter(selected.id, { notes: e.target.value })}
                    className={`${inputClass} h-20 resize-none`}
                    placeholder="仅用于内部记录"
                  />
                </section>
              </div>
            ) : (
              <div className="relative z-10 p-4 space-y-4 max-w-6xl">
                {/* 区域1：主体立绘 — 角色设定图 / 三视图 */}
                <section className="story-os-panel p-4 border-2 border-primary/25 bg-primary/[0.04]">
                  <div className="mb-3 flex items-center gap-2">
                    <div className="story-os-chamfer-tr rounded bg-primary/15 border border-primary/30 p-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold tracking-wide text-primary">主体立绘 · 角色设定图</h4>
                    </div>
                  </div>

                  <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
                    <div className="aspect-[3/4] rounded-md border-2 border-primary/30 bg-secondary/30 overflow-hidden flex items-center justify-center">
                      {referenceSprite?.file ? (
                        <img
                          src={convertFileSrc(`${projectPath}/game/figure/${referenceSprite.file}`)}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-muted-foreground/50">
                          <ImageIcon className="w-12 h-12" />
                          <span className="text-xs">未设置主体图</span>
                        </div>
                      )}
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className={labelClass}>设定图提示词（三视图）</label>
                        <textarea
                          value={referenceSprite?.prompt || ''}
                          onChange={(e) => setReferencePrompt(selected.id, e.target.value)}
                          className={`${inputClass} h-28 resize-none font-mono-family`}
                          placeholder={'左区：角色正脸特写，面部占满左区，五官、发型、配饰清晰，无身体入镜、无遮挡变形；右区：标准角色设定三视图，横向依次排列侧视图、正视图、背视图，从头到脚完整无遮挡、高度统一；核心约束：特写与三视图为同一角色，五官、服装、配饰、体态完全一致；中性表情，眼神平静，自然站立，双手自然下垂，空手无手持物；浅灰色纯净背景，角色无阴影，无畸变，平视视角，超高清；严禁出现无关文字；\n银发齐刘海，红色瞳孔，白色水手服校服，左侧蝴蝶结发饰，纤细体型'}
                        />
                      </div>
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <label className={labelClass}>主体参考图（可选）</label>
                        </div>
                        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
                          {(selected.referenceImages ?? []).map((filename) => {
                            const isPicked = selectedReferenceImage === filename;
                            return (
                            <div
                              key={filename}
                              onClick={() => setSelectedReferenceImage((cur) => cur === filename ? null : filename)}
                              className={`group relative aspect-square rounded-md border overflow-hidden bg-secondary/20 cursor-pointer transition-all ${
                                isPicked ? 'border-primary ring-2 ring-primary' : 'border-border hover:border-primary/40'
                              }`}
                            >
                              <img
                                src={convertFileSrc(`${projectPath}/game/reference/${selected.id}/${filename}`)}
                                alt=""
                                className="w-full h-full object-cover"
                              />
                              {isPicked && (
                                <div className="absolute left-1 top-1 rounded bg-primary px-1 py-0.5 text-[9px] font-semibold text-primary-foreground">
                                  参考
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); removeReferenceImage(selected.id, filename); }}
                                className="absolute right-1 top-1 p-1 rounded bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
                                aria-label="移除参考图"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                            );
                          })}
                          {(selected.referenceImages?.length ?? 0) < 5 && (
                            <button
                              type="button"
                              onClick={() => uploadReferenceImage(selected.id)}
                              disabled={referenceUploading || !selected.name.trim()}
                              className="aspect-square rounded-md border border-dashed border-border bg-secondary/10 hover:bg-secondary/30 transition-colors flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground disabled:opacity-50"
                            >
                              {referenceUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                              上传
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => triggerSingleSpriteGeneration(referenceSprite?.emotion || '主体参考', { kind: 'reference' })}
                          disabled={spriteGeneratingKey !== null}
                          className="px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 text-xs flex items-center gap-2 disabled:opacity-50"
                        >
                          {spriteGeneratingKey === 'reference'
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Sparkles className="w-3.5 h-3.5" />}
                          {spriteGeneratingKey === 'reference'
                            ? '生成中'
                            : selectedReferenceImage ? '基于参考图生成（图生图）' : '生成主体设定图'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 主体候选 — 历次生成的主体图，点选其一为当前主体 */}
                  <div className="mt-4 border-t border-border/60 pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <label className={labelClass}>主体候选</label>
                      <span className="text-[10px] text-muted-foreground">{mainCandidates.length} 张 · 点选设为当前主体</span>
                    </div>
                    {mainCandidates.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground">
                        还没有主体候选。点击上方「生成主体设定图」后，生成的主体图会作为候选出现在这里。
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 md:grid-cols-5 xl:grid-cols-8 gap-2">
                        {mainCandidates.map((candidate) => {
                          const isCurrent = figureFileTail(referenceSprite?.file || '') === figureFileTail(candidate.name);
                          return (
                            <div
                              key={candidate.path}
                              onClick={() => setMainFromCandidate(candidate)}
                              className={`group relative aspect-[3/4] rounded-md border overflow-hidden bg-secondary/20 cursor-pointer transition-all ${
                                isCurrent ? 'border-primary ring-2 ring-primary' : 'border-border hover:border-primary/40'
                              }`}
                            >
                              <img src={convertFileSrc(candidate.path)} alt="" className="w-full h-full object-cover object-top" />
                              {isCurrent && (
                                <div className="absolute left-1 top-1 rounded bg-primary px-1 py-0.5 text-[9px] font-semibold text-primary-foreground">
                                  当前主体
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); removeMainCandidate(candidate); }}
                                disabled={mainCandidateDeleting === candidate.name}
                                className="absolute right-1 top-1 p-1 rounded bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                                aria-label="删除候选"
                              >
                                {mainCandidateDeleting === candidate.name
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Trash2 className="w-3 h-3" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>

                {/* 区域2：表情变体 — 醒目情绪标签 + 各自提示词 */}
                <section className="story-os-panel p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">表情变体</h4>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowEmotionPicker((value) => !value)}
                        className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" />
                        添加变体
                      </button>
                      <button
                        onClick={triggerBatchSpriteGeneration}
                        disabled={spriteGeneratingKey !== null || variantSprites.length === 0}
                        className="px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 text-xs flex items-center gap-1 disabled:opacity-50"
                      >
                        {spriteGeneratingKey !== null && spriteGeneratingKey !== 'reference'
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Sparkles className="w-3 h-3" />}
                        {spriteGeneratingKey !== null && spriteGeneratingKey !== 'reference' ? '生成中' : '批量生成'}
                      </button>
                    </div>
                  </div>

                  {showEmotionPicker && (
                    <div className="mb-3 rounded-md border border-border bg-secondary/20 p-3">
                      <div className="mb-2 text-xs text-muted-foreground">常用情绪</div>
                      <div className="flex flex-wrap gap-2">
                        {commonEmotions.map((emotion) => {
                          const color = emotionColor(emotion);
                          return (
                            <button
                              key={emotion}
                              type="button"
                              onClick={() => addEmotionPreset(selected.id, emotion)}
                              className="px-2 py-1 rounded text-xs border transition-colors"
                              style={{
                                color,
                                borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
                                backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
                              }}
                            >
                              {emotion}
                            </button>
                          );
                        })}
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
                      <div className="mt-3 border-t border-border pt-3">
                        <div className="mb-2 text-xs text-muted-foreground">建议姿态</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                          {spriteSuggestions.map((suggestion) => (
                            <button
                              key={`${suggestion.pose}-${suggestion.emotion}`}
                              onClick={() => addSprite(selected.id, `${suggestion.pose}-${suggestion.emotion}`, suggestion.prompt)}
                              className="rounded-md border border-border bg-background/40 p-2 text-left hover:border-primary/40 hover:bg-primary/10 transition-colors"
                            >
                              <div className="text-xs font-medium">{suggestion.pose}</div>
                              <div className="mt-0.5 text-[11px]" style={{ color: emotionColor(suggestion.emotion) }}>{suggestion.emotion}</div>
                              <div className="mt-1 text-[10px] text-muted-foreground font-mono-family line-clamp-2">{suggestion.prompt}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {variantSprites.length === 0 ? (
                    <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-3">还没有表情变体。点击「添加变体」选择情绪或建议姿态。</div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2">
                      {variantSprites.map(({ sprite, index }) => {
                        const color = emotionColor(sprite.emotion);
                        const generated = hasGeneratedAsset(sprite.emotion);
                        const generating = spriteGeneratingKey === `variant:${index}`;
                        const expanded = expandedPromptIndex === index;
                        return (
                          <div key={index} className="rounded-md border border-border bg-secondary/15 overflow-hidden hover:border-primary/30 transition-colors">
                            {/* 情绪标签 — 醒目展示 */}
                            <div
                              className="px-2 py-1 flex items-center gap-1"
                              style={{
                                backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)`,
                                borderBottom: `2px solid color-mix(in srgb, ${color} 25%, transparent)`,
                              }}
                            >
                              <input
                                value={sprite.emotion}
                                onChange={(e) => updateSprite(selected.id, index, 'emotion', e.target.value)}
                                className="min-w-0 flex-1 bg-transparent text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-primary/40 rounded px-1 py-0.5"
                                placeholder="情绪标签"
                                style={{ color }}
                              />
                              <button
                                onClick={() => removeSprite(selected.id, index)}
                                className="p-1 hover:bg-destructive/10 rounded transition-colors flex-shrink-0"
                                aria-label="删除变体"
                              >
                                <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                              </button>
                            </div>

                            {(() => {
                              const src = findSpriteAssetSrc(sprite);
                              return (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      className="w-full aspect-square flex items-center justify-center overflow-hidden border-b border-border relative cursor-pointer hover:opacity-80 transition-opacity"
                                      style={{
                                        background: src ? undefined : `linear-gradient(135deg, color-mix(in srgb, ${color} 18%, transparent), color-mix(in srgb, ${color} 4%, transparent))`,
                                      }}
                                    >
                                      {src ? (
                                        <img src={src} alt={sprite.emotion} className="w-full h-full object-cover object-top" />
                                      ) : (
                                        <ImageIcon className="w-6 h-6 opacity-60" style={{ color }} />
                                      )}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-64 p-2 max-h-72 overflow-y-auto">
                                    <div className="mb-1.5 flex items-center justify-between">
                                      <span className="text-xs text-muted-foreground">选择立绘图片</span>
                                      {sprite.file && (
                                        <button
                                          type="button"
                                          onClick={() => updateSprite(selected.id, index, 'file', '')}
                                          className="text-[10px] text-muted-foreground hover:text-foreground"
                                        >
                                          清除绑定
                                        </button>
                                      )}
                                    </div>
                                    {figureAssets.length === 0 ? (
                                      <div className="py-4 text-center text-[11px] text-muted-foreground">暂无素材图片</div>
                                    ) : (
                                      <div className="grid grid-cols-3 gap-1.5">
                                        {figureAssets.map((asset) => {
                                          const tail = figureFileTail(asset.name);
                                          const qualified = `${selected.id}/${tail}`;
                                          const isCurrent = sprite.file === qualified;
                                          return (
                                            <button
                                              type="button"
                                              key={asset.path}
                                              onClick={() => updateSprite(selected.id, index, 'file', qualified)}
                                              className={`aspect-square rounded border overflow-hidden transition-colors ${
                                                isCurrent ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50'
                                              }`}
                                            >
                                              <img src={convertFileSrc(asset.path)} alt={tail} className="w-full h-full object-cover object-top" />
                                            </button>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </PopoverContent>
                                </Popover>
                              );
                            })()}

                            <div className="p-1.5 space-y-1.5">
                              {/* 提示词折叠：默认一行摘要，点击展开编辑 */}
                              {expanded ? (
                                <textarea
                                  value={sprite.prompt || ''}
                                  onChange={(e) => updateSprite(selected.id, index, 'prompt', e.target.value)}
                                  onBlur={() => setExpandedPromptIndex(null)}
                                  autoFocus
                                  className="w-full h-14 resize-none text-[10px] font-mono-family bg-input-background border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
                                  placeholder="提示词（如：微笑表情，嘴角上扬，眼睛微眯…）"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setExpandedPromptIndex(index)}
                                  className="w-full text-left text-[10px] text-muted-foreground hover:text-foreground bg-input-background/60 border border-border rounded px-2 py-1 line-clamp-1 transition-colors"
                                  title={sprite.prompt || '点击添加提示词'}
                                >
                                  {sprite.prompt?.trim() || <span className="text-muted-foreground/60">点击添加提示词</span>}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => triggerSingleSpriteGeneration(sprite.emotion, { kind: 'variant', index })}
                                disabled={spriteGeneratingKey !== null}
                                className="w-full px-2 py-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs flex items-center justify-center gap-1 disabled:opacity-50"
                              >
                                {generating
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Sparkles className="w-3 h-3" />}
                                {generating ? '生成中' : generated ? '重新生成' : '生成'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* 区域3：立绘素材库 — 可折叠 */}
                <section className="story-os-panel p-4">
                  <button
                    type="button"
                    onClick={() => setFigureLibraryOpen((v) => !v)}
                    className="w-full flex items-center justify-between text-left"
                  >
                    <div>
                      <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-mono-family">立绘素材库</h4>
                      <p className="mt-0.5 text-[10px] text-muted-foreground/70">表情变体与上传的备用图；主体图在上方独立管理。</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {figureAssets.length} 个
                      <ChevronDown className={`w-4 h-4 transition-transform ${figureLibraryOpen ? 'rotate-180' : ''}`} />
                    </div>
                  </button>

                  {figureLibraryOpen && (
                    <div className="mt-3">
                      <div className="mb-3">
                        <button
                          type="button"
                          onClick={uploadFigureAsset}
                          disabled={figureAssetImporting}
                          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-colors text-xs flex items-center gap-2 disabled:opacity-50"
                        >
                          {figureAssetImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                          上传立绘素材
                        </button>
                      </div>

                      {figureAssetsLoading ? (
                        <div className="h-20 rounded-md border border-dashed border-border flex items-center justify-center text-muted-foreground">
                          <Loader2 className="w-4 h-4 animate-spin" />
                        </div>
                      ) : figureAssets.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                          还没有立绘素材，上传后的图片会出现在这里。
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2">
                          {figureAssets.map((asset) => (
                            <div key={asset.path} className="rounded-md border border-border bg-secondary/20 overflow-hidden">
                              <div className="aspect-[3/4] bg-background/40 overflow-hidden">
                                <img
                                  src={convertFileSrc(asset.path)}
                                  alt={asset.name}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                              <div className="p-1.5 space-y-1">
                                <div className="truncate text-[10px] font-medium" title={asset.name}>{asset.name}</div>
                                <button
                                  type="button"
                                  onClick={() => removeFigureAsset(asset)}
                                  disabled={figureAssetDeleting === asset.name}
                                  className="w-full px-1.5 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 text-[10px] disabled:opacity-50"
                                >
                                  {figureAssetDeleting === asset.name ? '删除中' : '删除'}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="story-os-panel p-4">
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
              <div className="sticky bottom-0 z-10 px-4 py-3 border-t border-border bg-card flex items-center justify-between">
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
      {pendingDeleteId && (() => {
        const target = characters.find((c) => c.id === pendingDeleteId);
        const name = target?.name?.trim() || '未命名角色';
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-[400px] max-w-full rounded-lg border border-border bg-card shadow-2xl">
              <div className="border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold text-destructive">删除角色</h3>
              </div>
              <div className="px-4 py-4 text-sm">
                确定删除角色「{name}」？
                <p className="mt-2 text-xs text-muted-foreground">此操作不可撤销，角色数据将永久丢失。</p>
              </div>
              <div className="flex justify-end gap-2 border-t border-border p-4">
                <button
                  type="button"
                  onClick={() => setPendingDeleteId(null)}
                  className="rounded-md bg-secondary px-4 py-2 text-sm hover:bg-secondary/70"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => confirmDelete(pendingDeleteId)}
                  className="rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      <SpriteAiGenerateDialog
        open={pendingSpriteGeneration !== null}
        generation={pendingSpriteGeneration}
        initialInstruction={
          pendingSpriteGeneration && selected
            ? pendingSpriteGeneration.batch
              ? ''
              : pendingSpriteGeneration.target.kind === 'reference'
                ? (referenceSprite?.prompt ?? '')
                : (selected.sprites[pendingSpriteGeneration.target.index]?.prompt ?? '')
            : ''
        }
        variantCount={variantSprites.length}
        onGenerate={handleConfirmSpriteGeneration}
        onClose={() => {
          if (!spriteGeneratingKey) setPendingSpriteGeneration(null);
        }}
      />
    </div>
  );
}

function SpriteAiGenerateDialog({
  open,
  generation,
  initialInstruction,
  variantCount,
  onGenerate,
  onClose,
}: {
  open: boolean;
  generation: PendingSpriteGeneration | null;
  initialInstruction: string;
  variantCount: number;
  onGenerate: (model: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<AiProviderConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<AiMediaGenerationProgress | null>(null);

  const configuredModels = config ? parseConfiguredModels(config.model) : [];
  const effectiveModel = selectedModel || configuredModels[0] || config?.model.trim() || '';
  const isBatch = generation?.batch === true;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setGenerationProgress(null);
    setLoadingConfig(true);
    getAiImageConfig()
      .then((nextConfig) => {
        setConfig(nextConfig);
        const models = parseConfiguredModels(nextConfig.model);
        setSelectedModel(models[0] ?? nextConfig.model.trim());
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingConfig(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listenAiMediaGenerationProgress((progress) => {
      if (!disposed) setGenerationProgress(progress);
    })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  if (!open || !generation) return null;

  const handleSubmit = async () => {
    if (!effectiveModel) {
      setError('请先在图片 AI 设置中选择至少一个模型。');
      return;
    }
    if (!isBatch && !initialInstruction.trim()) {
      setError(generation.target.kind === 'reference' ? '请先填写主体区域的设定图提示词。' : '请先填写该表情变体的提示词。');
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      await onGenerate(effectiveModel);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[640px] max-h-[86vh] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-display-family">
            {isBatch ? '批量生成角色立绘' : `生成立绘：${generation.emotion || '未命名形态'}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={generating}
            className="rounded-md px-2 py-1 text-sm hover:bg-secondary/60 disabled:opacity-50"
          >
            关闭
          </button>
        </div>

        <div className="max-h-[calc(86vh-120px)] overflow-y-auto p-4 space-y-4">
          <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
            {loadingConfig
              ? '正在读取图片 AI 配置...'
              : config
                ? `使用配置：${config.provider} / ${effectiveModel || '未填写模型'}`
                : '未读取到配置'}
          </div>

          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">生成模型</label>
            {configuredModels.length > 1 ? (
              <select
                value={effectiveModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {configuredModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            ) : (
              <input
                value={effectiveModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="先在图片 AI 设置中选择模型"
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            )}
          </div>

          {isBatch ? (
            <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
              将使用 {variantCount} 个表情变体各自填写的提示词批量生成；缺少提示词的变体会自动跳过。
            </div>
          ) : (
            <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
              {generation.target.kind === 'reference'
                ? '将使用主体区域的"设定图提示词（三视图）"生成。'
                : '将使用该表情变体卡片中填写的提示词生成。'}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {generating && (
            <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
              {generationProgress
                ? generationProgress.totalAttempts > 0
                  ? `${generationProgress.message} (${generationProgress.attempt}/${generationProgress.totalAttempts})`
                  : generationProgress.message
                : '正在提交生成请求...'}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <button
            type="button"
            onClick={onClose}
            disabled={generating}
            className="rounded-md bg-secondary px-4 py-2 text-sm hover:bg-secondary/70 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loadingConfig || generating}
            className="inline-flex min-w-24 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? '生成中' : '生成'}
          </button>
        </div>
      </div>
    </div>
  );
}
