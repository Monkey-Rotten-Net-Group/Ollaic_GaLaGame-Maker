/**
 * Frontend IPC layer — wraps Tauri invoke calls to the Rust backend.
 * All WebGAL parsing / serialization / file I/O / project management goes through here.
 */

import { invoke } from '@tauri-apps/api/core';
import type { WebGalNode } from './webgal-types';

// ---------------------------------------------------------------------------
// Scene parsing & serialization
// ---------------------------------------------------------------------------

/** Parse a WebGAL script string → structured nodes (backend). */
export async function parseScene(source: string): Promise<WebGalNode[]> {
  return invoke<WebGalNode[]>('parse_scene', { source });
}

/** Serialize structured nodes → WebGAL script string (backend). */
export async function serializeScene(nodes: WebGalNode[]): Promise<string> {
  return invoke<string>('serialize_scene', { nodes });
}

/** Read a .txt scene file from disk, parse it, return nodes. */
export async function loadScene(path: string): Promise<WebGalNode[]> {
  return invoke<WebGalNode[]>('load_scene', { path });
}

/** Serialize nodes and write to a .txt scene file on disk. */
export async function saveScene(path: string, nodes: WebGalNode[]): Promise<void> {
  return invoke<void>('save_scene', { path, nodes });
}

/** List all .txt scene files in a directory. */
export async function listScenes(dir: string): Promise<string[]> {
  return invoke<string[]>('list_scenes', { dir });
}

/** Read the raw text content of a file. */
export async function readFileText(path: string): Promise<string> {
  return invoke<string>('read_file_text', { path });
}

/** Write raw text content to a file. */
export async function writeFileText(path: string, content: string): Promise<void> {
  return invoke<void>('write_file_text', { path, content });
}

export interface SceneHeader {
  chapter?: string;
  outline?: string;
}

/**
 * Human-readable label for a scene: its chapter (and outline) when set,
 * falling back to the raw filename. Used everywhere a scene is shown to the
 * user or to the AI for comprehension — the filename stays the identifier for
 * WebGAL commands (changeScene, edit_scene, etc.).
 */
export function sceneDisplayName(file: string, header?: SceneHeader): string {
  if (header?.chapter) return header.outline ? `${header.chapter} — ${header.outline}` : header.chapter;
  return header?.outline ?? file;
}

/** Serialize a SceneHeader back into leading comment lines. */
export function serializeSceneHeader(header: SceneHeader): string {
  const lines: string[] = [];
  if (header.chapter?.trim()) lines.push(`; 章节: ${header.chapter.trim()}`);
  if (header.outline?.trim()) lines.push(`; 大纲: ${header.outline.trim()}`);
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Read a scene file, replace its leading comment header with the given metadata,
 * and write it back to disk.
 */
export async function updateSceneHeader(path: string, header: SceneHeader): Promise<void> {
  const text = await readFileText(path);
  const lines = text.split('\n');
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(';')) headerEnd = i + 1;
    else break;
  }
  const body = lines.slice(headerEnd).join('\n');
  await writeFileText(path, serializeSceneHeader(header) + body);
}

/**
 * Parse metadata from leading comment lines of a WebGAL scene file.
 * Reads until the first non-comment line. Recognised keys (case-insensitive):
 *   章节 / chapter  →  header.chapter
 *   大纲 / outline / 描述 / desc  →  header.outline
 *
 * Example:
 *   ; 章节: 第一章
 *   ; 大纲: 主角初次踏入小镇
 */
export function parseSceneHeader(text: string): SceneHeader {
  const header: SceneHeader = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(';')) break;
    const content = line.slice(1).trim();
    const colon = content.indexOf(':');
    if (colon === -1) continue;
    const key = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();
    if (!value) continue;
    if (key === '章节' || key === 'chapter') header.chapter = value;
    else if (key === '大纲' || key === 'outline' || key === '描述' || key === 'desc') header.outline = value;
  }
  return header;
}

// ---------------------------------------------------------------------------
// Project management
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  path: string;
  config: Record<string, string>;
  scenes: string[];
}

/** Initialize a new WebGAL project at baseDir/name/. */
export async function initProject(baseDir: string, name: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>('init_project', { baseDir, name });
}

/** Open an existing WebGAL project by its root directory path. */
export async function openProject(path: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>('open_project', { path });
}

/** Update config.txt for a project. */
export async function saveConfig(projectPath: string, config: Record<string, string>): Promise<void> {
  return invoke<void>('save_config', { projectPath, config });
}

/** Get the full disk path for a scene file within a project. */
export async function getScenePath(projectPath: string, sceneName: string): Promise<string> {
  return invoke<string>('get_scene_path', { projectPath, sceneName });
}

/** Create a new scene file in the project. */
export async function createScene(projectPath: string, sceneName: string): Promise<string> {
  return invoke<string>('create_scene', { projectPath, sceneName });
}

export async function deleteScene(path: string): Promise<void> {
  return invoke('delete_scene', { path });
}

export async function renameScene(path: string, newName: string): Promise<string> {
  return invoke<string>('rename_scene', { path, newName });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportResult {
  success: boolean;
  warnings: string[];
  outputPath: string;
  issues?: ExportValidationIssue[];
}

export interface ExportValidationIssue {
  level: 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
}

export interface ProjectMetadata {
  synopsis: string;
  description: string;
  coverPath: string;
  tags: string[];
  version: string;
  releaseNotes: string;
  lastExportDir: string;
}

export interface SnapshotInfo {
  id: string;
  label: string;
  createdAt: string;
  path: string;
  kind?: 'manual' | 'beforeRestore' | 'exportCandidate' | 'auto' | string;
  description?: string | null;
  includesEditorState?: boolean;
  metadataIncluded?: boolean | null;
  fileCount?: number | null;
}

/** Read editor/project metadata stored at the project root. */
export async function readProjectMetadata(projectPath: string): Promise<ProjectMetadata | null> {
  return invoke<ProjectMetadata | null>('read_project_metadata', { projectPath });
}

/** Persist editor/project metadata at the project root. */
export async function saveProjectMetadata(projectPath: string, metadata: ProjectMetadata): Promise<void> {
  return invoke<void>('save_project_metadata', { projectPath, metadata });
}

/** Export a WebGAL project to the given output directory. */
export async function exportProject(
  projectPath: string,
  outputPath: string,
  asZip?: boolean,
  metadata?: ProjectMetadata | null,
): Promise<ExportResult> {
  return invoke<ExportResult>('export_project', {
    projectPath,
    outputPath,
    asZip: asZip ?? false,
    metadata: metadata ?? null,
  });
}

/** Create a persistent whole-project snapshot. */
export async function createProjectSnapshot(
  projectPath: string,
  label?: string,
  kind?: SnapshotInfo['kind'],
  description?: string | null,
): Promise<SnapshotInfo> {
  return invoke<SnapshotInfo>('create_project_snapshot', {
    projectPath,
    label: label ?? null,
    kind: kind ?? null,
    description: description ?? null,
  });
}

/** List persistent project snapshots, newest first. */
export async function listProjectSnapshots(projectPath: string): Promise<SnapshotInfo[]> {
  return invoke<SnapshotInfo[]>('list_project_snapshots', { projectPath });
}

/** Rename a persistent project snapshot. */
export async function renameProjectSnapshot(projectPath: string, snapshotId: string, label: string): Promise<SnapshotInfo> {
  return invoke<SnapshotInfo>('rename_project_snapshot', { projectPath, snapshotId, label });
}

/** Delete a persistent project snapshot. */
export async function deleteProjectSnapshot(projectPath: string, snapshotId: string): Promise<void> {
  return invoke<void>('delete_project_snapshot', { projectPath, snapshotId });
}

/** Restore a persistent project snapshot. */
export async function restoreProjectSnapshot(projectPath: string, snapshotId: string): Promise<void> {
  return invoke<void>('restore_project_snapshot', { projectPath, snapshotId });
}

// ---------------------------------------------------------------------------
// Runtime preview server
// ---------------------------------------------------------------------------

/** Get the local URL the WebGAL runtime is served at, e.g. "http://127.0.0.1:54321/". */
export async function getRuntimeUrl(): Promise<string> {
  return invoke<string>('get_runtime_url');
}

/** Point the runtime server's /game/* route at the given project (or clear with null). */
export async function setRuntimeProject(projectPath: string | null): Promise<void> {
  return invoke<void>('set_runtime_project', { projectPath });
}

/** Update the WebGAL template directory used by the runtime preview server. */
export async function setRuntimeTemplateDir(templateDir: string): Promise<void> {
  return invoke<void>('set_runtime_template_dir', { templateDir });
}

/** Broadcast a debug-protocol message over the runtime WebSocket bus. */
export async function runtimeBroadcast(message: string): Promise<void> {
  return invoke<void>('runtime_broadcast', { message });
}

export interface RuntimeInfo {
  installed: boolean;
  path: string;
  version: string | null;
}

/** Inspect the currently-active WebGAL runtime install (path + version). */
export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return invoke<RuntimeInfo>('get_runtime_info');
}

/** Download a WebGAL release and install it into the user data directory. */
export async function installRuntime(version?: string): Promise<RuntimeInfo> {
  return invoke<RuntimeInfo>('install_runtime', { version: version ?? null });
}

/**
 * WebGAL debug-protocol command IDs.
 * Source: WebGAL/packages/webgal/src/types/debugProtocol.ts.
 * The runtime distinguishes commands by numeric enum value.
 */
export const DebugCommand = {
  JUMP: 0,
  SYNCFC: 1,
  SYNCFE: 2,
  EXE_COMMAND: 3,
  REFETCH_TEMPLATE_FILES: 4,
  SET_COMPONENT_VISIBILITY: 5,
  TEMP_SCENE: 6,
  FONT_OPTIMIZATION: 7,
  SET_EFFECT: 8,
  FAST_PREVIEW_TIMEOUT: 9,
  SET_TEXT_READ_MODE: 10,
} as const;

/** Open a URL in the user's default external browser. */
export async function openInBrowser(url: string): Promise<void> {
  return invoke<void>('open_in_browser', { url });
}

/** Fast-forward the runtime to a target sentence in a scene. */
export async function jumpToSentence(
  sceneName: string,
  sentence: number,
  opts: { fastSyncExperimental?: boolean } = {},
): Promise<void> {
  const envelope = {
    event: 'message',
    data: {
      command: DebugCommand.JUMP,
      sceneMsg: { scene: sceneName, sentence },
      message: opts.fastSyncExperimental ? 'exp' : 'Sync',
      stageSyncMsg: {},
    },
  };
  return runtimeBroadcast(JSON.stringify(envelope));
}
