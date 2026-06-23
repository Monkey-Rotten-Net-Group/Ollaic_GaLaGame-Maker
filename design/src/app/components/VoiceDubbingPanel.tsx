import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Music, Trash2, Wand2, Upload, Loader2,
  CheckSquare, Square, FolderOpen, ChevronDown, ChevronRight,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { VoiceAssetCard, AssetUsage } from '../lib/assets-ipc';
import {
  fillVoiceCard, deleteVoiceCard, importAsset,
} from '../lib/assets-ipc';
import { getScenePath, loadScene, saveScene } from '../lib/webgal-ipc';
import {
  generateBatchTts, listenBatchTtsProgress,
  getAiTtsConfig,
  type AiProviderConfig,
  type BatchTtsItem, type BatchTtsProgress,
} from '../lib/ai-ipc';
import { listCharacters } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';

interface Props {
  projectPath: string;
  voiceCards: VoiceAssetCard[];
  vocalAssetNames?: Set<string>;
  selectedVoiceCard: VoiceAssetCard | null;
  onSelectVoiceCard: (card: VoiceAssetCard | null) => void;
  onVoiceCardsChanged: () => void;
}

type FilterStatus = 'all' | 'pending' | 'done';
type GroupMode = 'scene' | 'character';

function legacySceneKeyFromId(id: string): string | null {
  const match = /^voice_(.+)_\d+$/.exec(id);
  return match?.[1] || null;
}

function sceneKeysForCard(card: VoiceAssetCard): string[] {
  const scenes = Array.from(new Set(
    (card.usages ?? [])
      .map((usage) => usage.sceneFile?.trim())
      .filter((scene): scene is string => Boolean(scene)),
  ));
  if (scenes.length > 0) return scenes;
  return [legacySceneKeyFromId(card.id) ?? '未关联场景'];
}

/**
 * Write the bound audio filename back into the matching dialogue lines of the
 * scene scripts as a `-voice` flag, so the command editor's "语音文件" field is
 * populated automatically after generation/import. Uses each usage's sceneFile
 * + lineNumber (node index + 1) to locate the line, with a text-equality guard
 * to avoid touching the wrong node. Failures are swallowed so they never block
 * the generation flow.
 */
async function writeVoiceFlagToScenes(
  projectPath: string,
  card: VoiceAssetCard,
  voiceFile: string,
): Promise<boolean> {
  const byScene = new Map<string, AssetUsage[]>();
  for (const usage of card.usages ?? []) {
    const scene = usage.sceneFile?.trim();
    if (!scene) continue;
    const list = byScene.get(scene) ?? [];
    list.push(usage);
    byScene.set(scene, list);
  }
  if (byScene.size === 0) return false;

  let wroteAny = false;
  for (const [sceneFile, usages] of byScene) {
    try {
      const scenePath = await getScenePath(projectPath, sceneFile);
      const nodes = await loadScene(scenePath);
      let changed = false;
      for (const usage of usages) {
        const idx = (usage.lineNumber ?? 0) - 1;
        const node = nodes[idx];
        if (!node || node.type !== 'dialogue') continue;
        if ((node.content ?? '').trim() !== (card.text ?? '').trim()) continue;
        if (node.voice === voiceFile) continue;
        nodes[idx] = { ...node, voice: voiceFile };
        changed = true;
      }
      if (changed) {
        await saveScene(scenePath, nodes);
        wroteAny = true;
      }
    } catch (e) {
      console.error(`写入语音标记失败 (${sceneFile}):`, e);
    }
  }
  return wroteAny;
}

function parseConfiguredModels(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

export function VoiceDubbingPanel({
  projectPath,
  voiceCards,
  vocalAssetNames,
  selectedVoiceCard,
  onSelectVoiceCard,
  onVoiceCardsChanged,
}: Props) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [groupMode, setGroupMode] = useState<GroupMode>('scene');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<Map<string, BatchTtsProgress>>(new Map());
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchConfig, setBatchConfig] = useState<AiProviderConfig | null>(null);
  const [batchModel, setBatchModel] = useState('');
  const [batchFormat, setBatchFormat] = useState('mp3');
  const [batchConfigError, setBatchConfigError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [importingId, setImportingId] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const isGenerated = useCallback(
    (card: VoiceAssetCard) => !!card.voiceAsset && (!vocalAssetNames || vocalAssetNames.has(card.voiceAsset)),
    [vocalAssetNames],
  );

  // Reload metadata on mount so voice cards are fresh (e.g. after scene save)
  useEffect(() => {
    onVoiceCardsChanged();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 加载角色，用于按角色名查音色（CosyVoice 等需要固定音色 ID）。
  useEffect(() => {
    let cancelled = false;
    listCharacters(projectPath)
      .then((list) => { if (!cancelled) setCharacters(list); })
      .catch(() => { if (!cancelled) setCharacters([]); });
    return () => { cancelled = true; };
  }, [projectPath]);

  // 角色名 → 音色 ID 映射。别名也一并映射，便于按别名命中。
  const voiceByCharacter = useMemo(() => {
    const map = new Map<string, string>();
    for (const ch of characters) {
      const timbre = ch.voiceTimbre?.trim();
      if (!timbre) continue;
      if (ch.name?.trim()) map.set(ch.name.trim(), timbre);
      for (const alias of ch.aliases ?? []) {
        if (alias?.trim()) map.set(alias.trim(), timbre);
      }
    }
    return map;
  }, [characters]);
  const timbreForCard = (card: VoiceAssetCard): string =>
    voiceByCharacter.get((card.character ?? '').trim()) ?? '';

  // Filter cards
  const filteredCards = useMemo(() => voiceCards.filter((card) => {
    if (filterStatus === 'pending') return !isGenerated(card);
    if (filterStatus === 'done') return isGenerated(card);
    return true;
  }), [voiceCards, filterStatus]);

  // Group cards, then sort groups by name.
  const sortedGroups = useMemo(() => {
    const groups = new Map<string, VoiceAssetCard[]>();
    for (const card of filteredCards) {
      const keys = groupMode === 'scene' ? sceneKeysForCard(card) : [card.character || '旁白'];
      for (const key of keys) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(card);
      }
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredCards, groupMode]);
  const sortedGroupKeys = sortedGroups.map(([key]) => key).join('\u0000');

  // Auto-expand all groups
  useEffect(() => {
    setExpandedGroups(new Set(sortedGroups.map(([k]) => k)));
  }, [groupMode, filterStatus, voiceCards.length, sortedGroupKeys]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleSelect = (cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const pendingCards = filteredCards.filter((c) => !isGenerated(c));
    if (pendingCards.every((c) => selectedIds.has(c.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingCards.map((c) => c.id)));
    }
  };

  const selectedPendingCards = voiceCards.filter((c) => selectedIds.has(c.id) && !isGenerated(c));
  const configuredModels = batchConfig ? parseConfiguredModels(batchConfig.model) : [];
  const effectiveBatchModel = batchModel || configuredModels[0] || batchConfig?.model.trim() || '';
  const completedBatchCount = Array.from(batchProgress.values()).filter((p) => p.status === 'done' || p.status === 'error').length;
  const doneBatchCount = Array.from(batchProgress.values()).filter((p) => p.status === 'done').length;
  const errorBatchCount = Array.from(batchProgress.values()).filter((p) => p.status === 'error').length;
  const batchPercent = batchTotal > 0 ? Math.min(100, Math.round((completedBatchCount / batchTotal) * 100)) : 0;

  const openBatchGenerateDialog = useCallback(async () => {
    const targets = voiceCards.filter((c) => selectedIds.has(c.id) && !isGenerated(c));
    if (targets.length === 0 || batchRunning) return;
    setBatchDialogOpen(true);
    setBatchConfigError(null);
    const ttsConfig = await getAiTtsConfig().catch(() => null);
    if (!ttsConfig || !ttsConfig.model.trim()) {
      setBatchConfig(null);
      setBatchModel('');
      setBatchConfigError('请先在 AI 设置中配置 TTS 供应商和模型。');
      return;
    }
    const models = parseConfiguredModels(ttsConfig.model);
    setBatchConfig(ttsConfig);
    setBatchModel((current) => current || models[0] || ttsConfig.model.trim());
  }, [batchRunning, isGenerated, selectedIds, voiceCards]);

  // Batch generate
  const handleBatchGenerate = useCallback(async () => {
    const targets = voiceCards.filter((c) => selectedIds.has(c.id) && !isGenerated(c));
    if (targets.length === 0) return;
    if (!effectiveBatchModel) {
      setBatchConfigError('请选择用于配音生成的模型。');
      return;
    }

    setBatchRunning(true);
    setBatchDialogOpen(false);
    setBatchTotal(targets.length);
    setBatchProgress(new Map());

    const items: BatchTtsItem[] = targets.map((card) => ({
      voiceCardId: card.id,
      text: card.text,
      // 传角色绑定的音色 ID（CosyVoice 等需要固定音色）；未设置则留空，由后端用默认音色。
      voicePrompt: timbreForCard(card),
    }));

    const unlisten = await listenBatchTtsProgress((progress) => {
      setBatchProgress((prev) => {
        const next = new Map(prev);
        next.set(progress.voiceCardId, progress);
        return next;
      });
    });

    try {
      const results = await generateBatchTts(projectPath, items, effectiveBatchModel, batchFormat);
      setBatchProgress((prev) => {
        const next = new Map(prev);
        for (const result of results) next.set(result.voiceCardId, result);
        return next;
      });
      // Write the generated audio back into each scene script's -voice flag.
      const cardById = new Map(targets.map((c) => [c.id, c]));
      for (const result of results) {
        if (result.status !== 'done' || !result.assetName) continue;
        const card = cardById.get(result.voiceCardId);
        if (card) await writeVoiceFlagToScenes(projectPath, card, result.assetName);
      }
      onVoiceCardsChanged();
    } catch (e) {
      console.error('Batch TTS failed:', e);
      alert(`批量生成失败: ${e}`);
    } finally {
      unlisten();
      setBatchRunning(false);
      setSelectedIds(new Set());
    }
  }, [batchFormat, effectiveBatchModel, projectPath, voiceCards, selectedIds, onVoiceCardsChanged, isGenerated]);

  // Single generate
  const handleSingleGenerate = useCallback(async (card: VoiceAssetCard) => {
    const ttsConfig = await getAiTtsConfig().catch(() => null);
    if (!ttsConfig || !ttsConfig.model) {
      alert('请先在 AI 设置中配置 TTS 供应商和模型。');
      return;
    }
    setGeneratingId(card.id);
    const items: BatchTtsItem[] = [{
      voiceCardId: card.id,
      text: card.text,
      voicePrompt: [card.character, card.emotion].filter(Boolean).join(' '),
    }];
    try {
      setBatchProgress(new Map());
      const unlisten = await listenBatchTtsProgress((p) => {
        setBatchProgress((prev) => { const n = new Map(prev); n.set(p.voiceCardId, p); return n; });
      });
      const results = await generateBatchTts(projectPath, items, ttsConfig.model, 'mp3');
      unlisten();
      const done = results.find((r) => r.voiceCardId === card.id && r.status === 'done');
      if (done?.assetName) await writeVoiceFlagToScenes(projectPath, card, done.assetName);
      onVoiceCardsChanged();
    } catch (e) {
      console.error('Single TTS failed:', e);
      alert(`生成失败: ${e}`);
    } finally {
      setGeneratingId(null);
      setBatchProgress(new Map());
    }
  }, [projectPath, onVoiceCardsChanged]);

  // Import file to fill voice card
  const handleImportFill = useCallback(async (card: VoiceAssetCard) => {
    setImportingId(card.id);
    try {
      const selected = await openDialog({
        title: '选择音频文件',
        filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'opus'] }],
        multiple: false,
      });
      if (!selected) { setImportingId(null); return; }

      // Import the file
      const assetInfo = await importAsset(selected as string, projectPath, 'vocal');
      // Fill the voice card
      await fillVoiceCard(projectPath, card.id, assetInfo.name);
      await writeVoiceFlagToScenes(projectPath, card, assetInfo.name);
      onVoiceCardsChanged();
    } catch (e) {
      console.error('Import fill failed:', e);
    } finally {
      setImportingId(null);
    }
  }, [projectPath, onVoiceCardsChanged]);

  // Delete voice card
  const handleDelete = useCallback(async (card: VoiceAssetCard) => {
    if (!window.confirm(`确定删除配音卡 "${card.character}: ${card.text.slice(0, 20)}..." 吗？`)) return;
    try {
      await deleteVoiceCard(projectPath, card.id);
      onVoiceCardsChanged();
      if (selectedVoiceCard?.id === card.id) onSelectVoiceCard(null);
    } catch (e) {
      console.error('Delete voice card failed:', e);
    }
  }, [projectPath, selectedVoiceCard, onSelectVoiceCard, onVoiceCardsChanged]);

  const pendingCount = voiceCards.filter((c) => !isGenerated(c)).length;
  const doneCount = voiceCards.filter((c) => isGenerated(c)).length;

  return (
    <div className="flex h-full flex-col bg-surface-container-lowest">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
          配音清单
        </span>
        <div className="flex items-center gap-1 rounded border border-border bg-surface-container-low p-0.5">
          {(['all', 'pending', 'done'] as FilterStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`rounded-sm px-2 py-1 text-[10px] font-semibold transition-colors ${
                filterStatus === s ? 'bg-secondary text-on-secondary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? `全部 (${voiceCards.length})` : s === 'pending' ? `待配音 (${pendingCount})` : `已配音 (${doneCount})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded border border-border bg-surface-container-low p-0.5">
          {(['scene', 'character'] as GroupMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setGroupMode(m)}
              className={`rounded-sm px-2 py-1 text-[10px] font-semibold transition-colors ${
                groupMode === m ? 'bg-secondary text-on-secondary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m === 'scene' ? '按场景' : '按角色'}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Batch actions */}
        {filterStatus !== 'done' && (
          <>
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {filteredCards.filter((c) => !isGenerated(c)).every((c) => selectedIds.has(c.id))
                ? <CheckSquare className="h-3.5 w-3.5" />
                : <Square className="h-3.5 w-3.5" />
              }
              全选待配音
            </button>
            <button
              onClick={openBatchGenerateDialog}
              disabled={batchRunning || selectedIds.size === 0}
              className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-semibold text-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {batchRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              生成选中 ({selectedIds.size})
            </button>
          </>
        )}
      </div>

      {/* Progress bar for batch */}
      {batchRunning && (
        <div className="shrink-0 border-b border-border bg-primary/5 px-4 py-2">
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="text-primary font-semibold">
              生成中... {doneBatchCount}/{batchTotal}
              {errorBatchCount > 0 && <span className="ml-2 text-error">失败 {errorBatchCount}</span>}
            </span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-secondary/30 overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${batchPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Card list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {voiceCards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <FolderOpen className="h-12 w-12 opacity-50" />
            <p className="text-sm">暂无配音条目</p>
            <p className="text-xs">在故事编织室保存场景后，对话行会自动生成配音槽位</p>
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <p className="text-sm">没有匹配的配音条目</p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {sortedGroups.map(([groupKey, cards]) => {
              const isExpanded = expandedGroups.has(groupKey);
              const groupPending = cards.filter((c) => !isGenerated(c)).length;
              const groupDone = cards.filter((c) => isGenerated(c)).length;
              return (
                <div key={groupKey}>
                  {/* Group header */}
                  <button
                    onClick={() => toggleGroup(groupKey)}
                    className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left hover:bg-surface-container-low transition-colors"
                  >
                    {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <span className="text-sm font-semibold">{groupKey}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {cards.length} 条
                      {groupPending > 0 && <span className="ml-1 text-tertiary">({groupPending} 待配音)</span>}
                      {groupDone > 0 && <span className="ml-1 text-primary">({groupDone} 已配音)</span>}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="ml-4 space-y-1">
                      {cards.map((card) => {
                        const isSelected = selectedVoiceCard?.id === card.id;
                        const isChecked = selectedIds.has(card.id);
                        const progress = batchProgress.get(card.id);
                        const isGenerating = generatingId === card.id || progress?.status === 'generating';
                        const hasAudio = isGenerated(card) || progress?.status === 'done';

                        return (
                          <div
                            key={card.id}
                            onClick={() => onSelectVoiceCard(card)}
                            className={`group flex items-center gap-3 rounded-sm px-3 py-2 cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-secondary/10 ring-1 ring-secondary/30'
                                : 'hover:bg-surface-container-low'
                            }`}
                          >
                            {/* Checkbox (only for pending) */}
                            {!isGenerated(card) && !isGenerating && (
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleSelect(card.id); }}
                                className="shrink-0"
                              >
                                {isChecked
                                  ? <CheckSquare className="h-4 w-4 text-primary" />
                                  : <Square className="h-4 w-4 text-muted-foreground" />
                                }
                              </button>
                            )}

                            {/* Status icon */}
                            {isGenerating ? (
                              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                            ) : hasAudio ? (
                              <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/20">
                                <Music className="h-3 w-3 text-primary" />
                              </div>
                            ) : (
                              <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-tertiary/50">
                                <div className="h-1.5 w-1.5 rounded-full bg-tertiary" />
                              </div>
                            )}

                            {/* Content */}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate">
                                  {card.character || '旁白'}
                                </span>
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                                  hasAudio ? 'bg-primary/10 text-primary' : 'bg-tertiary/10 text-tertiary'
                                }`}>
                                  {hasAudio ? '已配音' : '待配音'}
                                </span>
                                <span className="rounded bg-secondary/30 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                                  {card.emotion || '默认'}
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-muted-foreground truncate">
                                "{card.text}"
                              </p>
                              {progress?.message && progress.status !== 'done' && (
                                <p className="mt-0.5 text-[10px] text-primary/80">{progress.message}</p>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {!isGenerated(card) && !isGenerating && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleSingleGenerate(card); }}
                                  className="rounded p-1.5 hover:bg-primary/10 text-primary transition-colors"
                                  title="AI 生成"
                                >
                                  <Wand2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {!isGenerated(card) && !isGenerating && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleImportFill(card); }}
                                  disabled={importingId === card.id}
                                  className="rounded p-1.5 hover:bg-surface-container-high transition-colors"
                                  title="导入音频"
                                >
                                  {importingId === card.id
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Upload className="h-3.5 w-3.5" />
                                  }
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(card); }}
                                className="rounded p-1.5 hover:bg-error/10 text-muted-foreground hover:text-error transition-colors"
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {batchDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-[460px] max-w-full rounded-lg border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">AI 配音生成</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  将生成 {selectedPendingCards.length} 条待配音台词
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBatchDialogOpen(false)}
                className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              >
                关闭
              </button>
            </div>
            <div className="space-y-4 p-4">
              {batchConfigError ? (
                <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
                  {batchConfigError}
                </div>
              ) : (
                <>
                  <div>
                    <label className="mb-2 block text-xs uppercase tracking-wide text-muted-foreground">
                      生成模型
                    </label>
                    {configuredModels.length > 0 ? (
                      <select
                        value={effectiveBatchModel}
                        onChange={(event) => setBatchModel(event.target.value)}
                        className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      >
                        {configuredModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={batchModel}
                        onChange={(event) => setBatchModel(event.target.value)}
                        className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        placeholder="输入 TTS 模型"
                      />
                    )}
                  </div>
                  <div>
                    <label className="mb-2 block text-xs uppercase tracking-wide text-muted-foreground">
                      输出格式
                    </label>
                    <select
                      value={batchFormat}
                      onChange={(event) => setBatchFormat(event.target.value)}
                      className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="mp3">MP3</option>
                      <option value="wav">WAV</option>
                    </select>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      实际可用格式取决于当前 TTS 供应商；MP3 最稳定。
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                    生成时会逐条写入 game/vocal，并在列表中显示每条台词的生成状态。
                  </div>
                </>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border p-4">
              <button
                type="button"
                onClick={() => setBatchDialogOpen(false)}
                className="rounded-md bg-secondary px-4 py-2 text-sm hover:bg-secondary/70"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleBatchGenerate}
                disabled={Boolean(batchConfigError) || !effectiveBatchModel || selectedPendingCards.length === 0}
                className="inline-flex min-w-24 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wand2 className="h-4 w-4" />
                开始生成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
