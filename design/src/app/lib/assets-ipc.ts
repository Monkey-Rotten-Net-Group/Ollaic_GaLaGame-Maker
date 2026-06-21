import { invoke } from '@tauri-apps/api/core';

export interface AssetInfo {
  name: string;
  path: string;
  category: string;
  size: number;
  extension: string;
}

export interface AssetUsage {
  sceneFile: string;
  lineNumber: number;
  lineContent: string;
  command: string;
}

export interface SceneAssetCard {
  id: string;
  title: string;
  sceneFile?: string | null;
  imageAsset?: string | null;
  targetStem: string;
  prompt: string;
  style: string;
  negativePrompt: string;
}

export interface VoiceAssetCard {
  id: string;
  character: string;
  text: string;
  emotion: string;
  voiceAsset?: string | null;
  targetStem: string;
  prompt: string;
  usages?: AssetUsage[];
}

export interface AssetMetadata {
  aliases: Record<string, string>;
  descriptions: Record<string, string>;
  tags: Record<string, string[]>;
  references: Record<string, string[]>;
  sceneCards: Record<string, SceneAssetCard>;
  cgCards: Record<string, SceneAssetCard>;
  voiceCards: Record<string, VoiceAssetCard>;
  deletedSceneCards: string[];
  deletedCgCards: string[];
  deletedVoiceCards: string[];
}

/** List media files in a project's asset subdirectory. */
export async function listAssets(projectPath: string, category: string): Promise<AssetInfo[]> {
  return invoke<AssetInfo[]>('list_assets', { projectPath, category });
}

/** List all media files across all asset subdirectories. */
export async function listAllAssets(projectPath: string): Promise<AssetInfo[]> {
  return invoke<AssetInfo[]>('list_all_assets', { projectPath });
}

/** Copy an external file into a project's asset directory. */
export async function importAsset(
  sourcePath: string,
  projectPath: string,
  category: string,
): Promise<AssetInfo> {
  return invoke<AssetInfo>('import_asset', { sourcePath, projectPath, category });
}

/** Save generated media bytes to a project's asset directory with a fixed filename. */
export async function saveGeneratedAsset(
  projectPath: string,
  category: string,
  filename: string,
  base64Data: string,
): Promise<AssetInfo> {
  return invoke<AssetInfo>('save_generated_asset', { projectPath, category, filename, base64Data });
}

/** Delete an asset file from the project. */
export async function deleteAsset(
  projectPath: string,
  category: string,
  filename: string,
): Promise<void> {
  return invoke<void>('delete_asset', { projectPath, category, filename });
}

/** Rename an asset file. */
export async function renameAsset(
  projectPath: string,
  category: string,
  oldName: string,
  newName: string,
): Promise<AssetInfo> {
  return invoke<AssetInfo>('rename_asset', { projectPath, category, oldName, newName });
}

/** Find scene-script lines that reference an asset filename. */
export async function findAssetUsages(
  projectPath: string,
  filename: string,
  category?: string,
): Promise<AssetUsage[]> {
  return invoke<AssetUsage[]>('find_asset_usages', { projectPath, filename, category: category ?? null });
}

/** Load editor-owned metadata stored with the project. */
export async function loadProjectAssetMetadata(projectPath: string): Promise<AssetMetadata> {
  return invoke<AssetMetadata>('load_asset_metadata', { projectPath });
}

/** Persist editor-owned metadata with the project. */
export async function saveProjectAssetMetadata(
  projectPath: string,
  metadata: AssetMetadata,
): Promise<void> {
  return invoke<void>('save_asset_metadata', { projectPath, metadata });
}

/** Scan a scene file and create VoiceAssetCard entries for dialogue lines. */
export async function syncSceneVoiceCards(
  projectPath: string,
  sceneFile: string,
): Promise<VoiceAssetCard[]> {
  return invoke<VoiceAssetCard[]>('sync_scene_voice_cards', { projectPath, sceneFile });
}

/** Link an imported audio file to a voice card slot. */
export async function fillVoiceCard(
  projectPath: string,
  voiceCardId: string,
  assetFilename: string,
): Promise<VoiceAssetCard> {
  return invoke<VoiceAssetCard>('fill_voice_card', { projectPath, voiceCardId, assetFilename });
}

/** Mark a voice card as deleted (won't be re-created on future syncs). */
export async function deleteVoiceCard(
  projectPath: string,
  voiceCardId: string,
): Promise<void> {
  return invoke<void>('delete_voice_card', { projectPath, voiceCardId });
}
