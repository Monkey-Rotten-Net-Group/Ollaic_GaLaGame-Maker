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
): Promise<AssetUsage[]> {
  return invoke<AssetUsage[]>('find_asset_usages', { projectPath, filename });
}
