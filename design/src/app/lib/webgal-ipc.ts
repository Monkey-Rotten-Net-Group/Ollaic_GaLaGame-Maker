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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportResult {
  success: boolean;
  warnings: string[];
}

/** Export a WebGAL project to the given output directory. */
export async function exportProject(projectPath: string, outputPath: string, asZip?: boolean): Promise<ExportResult> {
  return invoke<ExportResult>('export_project', { projectPath, outputPath, asZip: asZip ?? false });
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
