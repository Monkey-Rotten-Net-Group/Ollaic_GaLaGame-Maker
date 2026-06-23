import {
  loadProjectAssetMetadata,
  saveProjectAssetMetadata,
  type AssetMetadata,
  type SceneAssetCard,
} from './assets-ipc';
import type { WebGalNode } from './webgal-types';

export type { AssetMetadata } from './assets-ipc';

/** Stable scene-card id derived from a scene .txt filename. */
export function sceneCardId(sceneFile: string): string {
  return sceneFile.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Human-friendly default title from a scene filename ("start.txt" -> "start"). */
export function sceneTitleFromFile(sceneFile: string): string {
  return sceneFile.replace(/\.txt$/i, '') || sceneFile;
}

/** Default generated-background filename stem for a new scene card. */
export function defaultSceneTargetStem(index: number): string {
  return `${String(index).padStart(3, '0')}_scene_dusk`;
}

/** Default generated-image filename stem for a new CG card. */
export function defaultCgTargetStem(index: number): string {
  return `cg_${String(index).padStart(3, '0')}`;
}

/**
 * Ensure a background scene card exists for the given scene file. Returns the
 * (possibly unchanged) metadata. No-op if a card already exists or the card was
 * explicitly deleted by the user.
 */
export function ensureSceneCard(
  metadata: AssetMetadata,
  sceneFile: string,
  index: number,
): AssetMetadata {
  const id = sceneCardId(sceneFile);
  if (metadata.sceneCards?.[id]) return metadata;
  if ((metadata.deletedSceneCards ?? []).includes(id)) return metadata;
  const card: SceneAssetCard = {
    id,
    title: sceneTitleFromFile(sceneFile),
    sceneFile,
    imageAsset: null,
    targetStem: defaultSceneTargetStem(index),
    prompt: '',
    style: '',
    negativePrompt: '',
  };
  return {
    ...metadata,
    sceneCards: { ...(metadata.sceneCards ?? {}), [id]: card },
  };
}

export function extractSceneBackgroundAssets(nodes: WebGalNode[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'changeBg') continue;
    const asset = (node.asset || node.content || '').trim();
    if (!asset || asset === 'none' || seen.has(asset)) continue;
    seen.add(asset);
    result.push(asset);
  }
  return result;
}

/** Collect all distinct BGM filenames referenced by bgm nodes. */
export function extractSceneBgmAssets(nodes: WebGalNode[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'bgm') continue;
    const asset = (node.asset || node.content || '').trim();
    if (!asset || asset === 'none' || seen.has(asset)) continue;
    seen.add(asset);
    result.push(asset);
  }
  return result;
}

/** Stable scene-card id derived from a background image filename. */
export function backgroundCardId(backgroundFilename: string): string {
  return `bg:${backgroundFilename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/** Title from a background filename ("11.png" -> "11"). */
function backgroundCardTitle(backgroundFilename: string): string {
  return backgroundFilename.replace(/\.(png|jpe?g|webp|gif)$/i, '') || backgroundFilename;
}

/**
 * Sync scene cards from the background images a scene references. For each
 * distinct background filename in changeBg nodes, ensure a scene card keyed by
 * the filename exists (created lazily so an existing image still shows up, and a
 * non-existent filename becomes a "to-generate" card). User-deleted cards stay
 * deleted. Returns the (possibly unchanged) metadata.
 */
export function syncSceneCardsFromBackgrounds(
  metadata: AssetMetadata,
  sceneFile: string,
  backgroundFilenames: string[],
  availableBackgrounds: Set<string>,
): AssetMetadata {
  let changed = false;
  const sceneCards = { ...(metadata.sceneCards ?? {}) };
  const deleted = metadata.deletedSceneCards ?? [];

  for (const filename of backgroundFilenames) {
    const id = backgroundCardId(filename);
    if (deleted.includes(id)) continue;

    const exists = availableBackgrounds.has(filename);
    const targetStem = filename.replace(/\.(png|jpe?g|webp|gif)$/i, '');
    const imageAsset = exists ? filename : null;
    const existing = sceneCards[id];

    if (!existing) {
      sceneCards[id] = {
        id,
        title: backgroundCardTitle(filename),
        sceneFile,
        imageAsset,
        targetStem,
        prompt: '',
        style: '',
        negativePrompt: '',
      };
      changed = true;
    } else if (existing.imageAsset !== imageAsset) {
      // Keep user-edited fields (title/prompt/...), only refresh the link state.
      sceneCards[id] = { ...existing, imageAsset };
      changed = true;
    }
  }

  if (!changed) return metadata;
  return { ...metadata, sceneCards };
}

export function linkSceneCardImageAsset(
  metadata: AssetMetadata,
  sceneFile: string,
  index: number,
  imageAsset: string,
): AssetMetadata {
  const ensured = ensureSceneCard(metadata, sceneFile, index);
  const id = sceneCardId(sceneFile);
  const card = ensured.sceneCards?.[id];
  if (!card) return ensured;
  if (card.imageAsset === imageAsset) return ensured;
  return {
    ...ensured,
    sceneCards: {
      ...(ensured.sceneCards ?? {}),
      [id]: {
        ...card,
        imageAsset,
        targetStem: card.targetStem || imageAsset.replace(/\.[^.]+$/, ''),
      },
    },
  };
}

function renameAssetMetadataRecord<T>(
  entries: Record<string, T>,
  category: string,
  oldName: string,
  newName: string,
): Record<string, T> {
  const next = { ...entries };
  const oldScoped = assetMetadataKey(category, oldName);
  const newScoped = assetMetadataKey(category, newName);
  if (Object.prototype.hasOwnProperty.call(next, oldScoped)) {
    next[newScoped] = next[oldScoped];
    delete next[oldScoped];
  }
  if (Object.prototype.hasOwnProperty.call(next, oldName)) {
    next[newScoped] = next[oldName];
    delete next[oldName];
  }
  return next;
}

function renameReferenceEntries(
  entries: Record<string, string[]>,
  category: string,
  oldName: string,
  newName: string,
): Record<string, string[]> {
  const renamed = renameAssetMetadataRecord(entries, category, oldName, newName);
  const oldReferenceCategory = referenceCategoryForAsset(category, oldName);
  const newReferenceCategory = referenceCategoryForAsset(category, newName);
  if (!oldReferenceCategory || !newReferenceCategory) return renamed;
  const oldReferencePrefix = `${oldReferenceCategory}/`;
  const newReferencePrefix = `${newReferenceCategory}/`;
  const next = { ...renamed };
  for (const [key, value] of Object.entries(renamed)) {
    if (!key.startsWith(oldReferencePrefix)) continue;
    next[`${newReferencePrefix}${key.slice(oldReferencePrefix.length)}`] = value;
    delete next[key];
  }
  return next;
}

export function renameAssetMetadataFilename(
  metadata: AssetMetadata,
  category: string,
  oldName: string,
  newName: string,
): AssetMetadata {
  const oldStem = oldName.replace(/\.[^.]+$/, '');
  const newStem = newName.replace(/\.[^.]+$/, '');
  const sceneCards = { ...(metadata.sceneCards ?? {}) };
  if (category === 'background') {
    for (const [id, card] of Object.entries(sceneCards)) {
      const nextCard = { ...card };
      let changed = false;
      if (nextCard.imageAsset === oldName) {
        nextCard.imageAsset = newName;
        changed = true;
      }
      if (nextCard.targetStem === oldStem) {
        nextCard.targetStem = newStem;
        changed = true;
      }
      if (changed) sceneCards[id] = nextCard;
    }
  }

  return {
    ...metadata,
    aliases: renameAssetMetadataRecord(metadata.aliases, category, oldName, newName),
    descriptions: renameAssetMetadataRecord(metadata.descriptions, category, oldName, newName),
    tags: renameAssetMetadataRecord(metadata.tags, category, oldName, newName),
    references: renameReferenceEntries(metadata.references, category, oldName, newName),
    sceneCards,
  };
}

const legacyUnifiedKey = (projectId: string) => `asset-metadata-${projectId}`;
const legacyAliasKey = (projectId: string) => `asset-alias-${projectId}`;
const legacyTagsKey = (projectId: string) => `asset-tags-${projectId}`;
const legacyReferencesKey = (projectId: string) => `asset-references-${projectId}`;
const pendingSaves = new Map<string, Promise<void>>();

export function emptyAssetMetadata(): AssetMetadata {
  return { aliases: {}, descriptions: {}, tags: {}, references: {}, sceneCards: {}, cgCards: {}, voiceCards: {}, deletedSceneCards: [], deletedCgCards: [], deletedVoiceCards: [] };
}

export function assetMetadataKey(category: string, filename: string): string {
  return `${category}/${filename}`;
}

export function assetMetadataEntry<T>(
  entries: Record<string, T>,
  category: string,
  filename: string,
): T | undefined {
  return entries[assetMetadataKey(category, filename)] ?? entries[filename];
}

export function aliasesForCategory(metadata: AssetMetadata, category: string): Record<string, string> {
  const result: Record<string, string> = {};
  const prefix = `${category}/`;
  for (const [key, value] of Object.entries(metadata.aliases)) {
    if (!key.includes('/')) result[key] = value;
    if (key.startsWith(prefix)) result[key.slice(prefix.length)] = value;
  }
  return result;
}

function parseRecord<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as Record<string, T> : {};
  } catch {
    return {};
  }
}

function hasEntries(metadata: AssetMetadata): boolean {
  return Object.keys(metadata.aliases).length > 0
    || Object.keys(metadata.descriptions).length > 0
    || Object.keys(metadata.tags).length > 0
    || Object.keys(metadata.references).length > 0;
}

function loadLegacyMetadata(projectId: string): AssetMetadata {
  try {
    const unified = localStorage.getItem(legacyUnifiedKey(projectId));
    if (unified) {
      const parsed = JSON.parse(unified) as Partial<AssetMetadata>;
      return {
        aliases: parsed.aliases ?? {},
        descriptions: parsed.descriptions ?? {},
        tags: parsed.tags ?? {},
        references: parsed.references ?? {},
        sceneCards: parsed.sceneCards ?? {},
        cgCards: parsed.cgCards ?? {},
        voiceCards: parsed.voiceCards ?? {},
        deletedSceneCards: parsed.deletedSceneCards ?? [],
        deletedCgCards: parsed.deletedCgCards ?? [],
        deletedVoiceCards: parsed.deletedVoiceCards ?? [],
      };
    }
  } catch {
    // Fall through to the older split storage keys.
  }
  return {
    aliases: parseRecord<string>(legacyAliasKey(projectId)),
    descriptions: {},
    tags: parseRecord<string[]>(legacyTagsKey(projectId)),
    references: parseRecord<string[]>(legacyReferencesKey(projectId)),
    sceneCards: {},
    cgCards: {},
    voiceCards: {},
    deletedSceneCards: [],
    deletedCgCards: [],
    deletedVoiceCards: [],
  };
}

export async function loadAssetMetadata(
  projectPath: string,
  legacyProjectId?: string,
): Promise<AssetMetadata> {
  await flushAssetMetadataSaves(projectPath);
  const metadata = await loadProjectAssetMetadata(projectPath);
  if (hasEntries(metadata) || !legacyProjectId || typeof window === 'undefined') {
    return metadata;
  }
  const legacy = loadLegacyMetadata(legacyProjectId);
  if (hasEntries(legacy)) {
    await saveProjectAssetMetadata(projectPath, legacy);
    return legacy;
  }
  return metadata;
}

export async function saveAssetMetadata(
  projectPath: string,
  metadata: AssetMetadata,
): Promise<AssetMetadata> {
  const previous = pendingSaves.get(projectPath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => saveProjectAssetMetadata(projectPath, metadata));
  pendingSaves.set(projectPath, next);
  try {
    await next;
  } finally {
    if (pendingSaves.get(projectPath) === next) pendingSaves.delete(projectPath);
  }
  return metadata;
}

export async function flushAssetMetadataSaves(projectPath: string): Promise<void> {
  await pendingSaves.get(projectPath)?.catch(() => undefined);
}

function setEntry<T>(
  entries: Record<string, T>,
  category: string,
  filename: string,
  value: T | undefined,
): Record<string, T> {
  const next = { ...entries };
  delete next[filename];
  const key = assetMetadataKey(category, filename);
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

export function setAssetAlias(
  metadata: AssetMetadata,
  category: string,
  filename: string,
  alias: string,
): AssetMetadata {
  const value = alias.trim() || undefined;
  return { ...metadata, aliases: setEntry(metadata.aliases, category, filename, value) };
}

export function setAssetDescription(
  metadata: AssetMetadata,
  category: string,
  filename: string,
  description: string,
): AssetMetadata {
  const value = description.trim() || undefined;
  return { ...metadata, descriptions: setEntry(metadata.descriptions, category, filename, value) };
}

export function setAssetTags(
  metadata: AssetMetadata,
  category: string,
  filename: string,
  tags: string[],
): AssetMetadata {
  return {
    ...metadata,
    tags: setEntry(metadata.tags, category, filename, tags.length > 0 ? tags : undefined),
  };
}

export function setAssetReferences(
  metadata: AssetMetadata,
  category: string,
  filename: string,
  references: string[],
): AssetMetadata {
  return {
    ...metadata,
    references: setEntry(
      metadata.references,
      category,
      filename,
      references.length > 0 ? references : undefined,
    ),
  };
}

export function referenceCategoryForAsset(category: string, filename: string): string | null {
  if (category === 'background') return `reference/backgrounds/${filename}`;
  if (category === 'bgm' || category === 'sfx' || category === 'vocal') {
    return `reference/audio/${filename}`;
  }
  return null;
}

export function referenceFilePath(
  projectPath: string,
  category: string,
  assetFilename: string,
  referenceFilename: string,
): string | null {
  const referenceCategory = referenceCategoryForAsset(category, assetFilename);
  if (!referenceCategory) return null;
  return `${projectPath}/game/${referenceCategory}/${referenceFilename}`;
}
