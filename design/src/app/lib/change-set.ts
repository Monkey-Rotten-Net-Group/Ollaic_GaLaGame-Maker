/**
 * Change set — a batch of edits the agent staged across a multi-step loop,
 * presented to the user for a single approval. Generalizes the old single-scene
 * AiChangeRecord to cover scenes, characters, and project memory.
 *
 * Write tools never touch disk during the loop; they produce StagedWrite
 * payloads which this module turns into reviewable ChangeEdits (with diffs).
 * On accept the whole set is applied atomically (all-or-rollback).
 */

import type { AssetInfo } from './assets-ipc';
import type { Character } from './character-types';
import { applyEditorPatches } from './editor-executor';
import {
  extractPatchAssetRefs,
  splitPatchText,
  summarizePatches,
  validatePatchText,
  type EditorPatch,
} from './editor-patch';
import { figureFileTail, findCharacter, findSprite, resolveFigureByEmotion } from './figure-resolve';
import type { ProjectMemory } from './project-memory';
import { createLineDiff, type DiffLine, type MissingAssetIssue } from './story-agent';
import { parseScene, serializeScene, sceneDisplayName, type SceneHeader } from './webgal-ipc';
import type { WebGalNode } from './webgal-types';
import type { StagedWrite } from './ai-tools';

export interface SceneEdit {
  kind: 'scene';
  file: string;
  /** True when this is the scene currently open in the editor. */
  isCurrent: boolean;
  beforeContent: string;
  afterContent: string;
  beforeNodes: WebGalNode[];
  afterNodes: WebGalNode[];
  diff: DiffLine[];
  summary: string;
  warnings: string[];
}

export interface CharacterEdit {
  kind: 'character';
  id: string;
  name: string;
  before: Character;
  after: Character;
  changedFields: string[];
}

export interface MemoryEdit {
  kind: 'memory';
  before: ProjectMemory;
  after: ProjectMemory;
  changedFields: string[];
}

export interface CreateSceneEdit {
  kind: 'create_scene';
  file: string;          // filename with .txt suffix
  chapter?: string;
  outline?: string;
}

export type ChangeEdit = SceneEdit | CharacterEdit | MemoryEdit | CreateSceneEdit;

export interface PendingChangeSet {
  id: string;
  createdAt: string;
  sourceMessageId: string;
  status: 'pending' | 'accepted' | 'reverted' | 'failed';
  edits: ChangeEdit[];
}

/** Resources the staging functions read from (current editor state + lookups). */
export interface StagingContext {
  currentSceneName: string;
  currentScriptSource: string;
  currentNodes: WebGalNode[];
  assets: AssetInfo[];
  /** All characters (with sprites) — used to resolve立绘 emotion → file. */
  characters: Character[];
  /** Read another scene's raw content from disk (by scene file name). */
  readSceneContent: (file: string) => Promise<string>;
  /** List existing scene file names (for create-scene duplicate checks). */
  listSceneFiles: () => Promise<string[]>;
  /** Look up a character by id (from the in-memory list). */
  getCharacter: (id: string) => Character | undefined;
  /** Current project memory (or a blank one). */
  memory: ProjectMemory;
}

/** A staging failure with a user-facing message (and optional missing-asset detail). */
export class StageError extends Error {
  missingAssets?: MissingAssetIssue[];
  constructor(message: string, missingAssets?: MissingAssetIssue[]) {
    super(message);
    this.name = 'StageError';
    this.missingAssets = missingAssets;
  }
}

function validateSceneAssets(patches: EditorPatch[], assets: AssetInfo[]): MissingAssetIssue[] {
  // Index by both the full (possibly subdir-qualified) name and its basename, so
  // a reference matches whether it is qualified ("<角色ID>/x.png") or bare ("x.png").
  const available = new Set<string>();
  for (const a of assets) {
    available.add(`${a.category}/${a.name}`);
    available.add(`${a.category}/${figureFileTail(a.name)}`);
  }
  const issues: MissingAssetIssue[] = [];
  for (const patch of patches) {
    if (patch.type === 'delete') continue;
    for (const ref of extractPatchAssetRefs(patch.text)) {
      const qualified = `${ref.expectedCategory}/${ref.file}`;
      const bare = `${ref.expectedCategory}/${figureFileTail(ref.file)}`;
      if (!available.has(qualified) && !available.has(bare)) issues.push(ref);
    }
  }
  return issues;
}

const FIGURE_LINE = /^(\s*(?:changeFigure|miniAvatar):)([^\s;]*)(.*)$/;
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{2,5}$/;

function figureFlagValue(rest: string, key: string): string | undefined {
  const m = rest.match(new RegExp(`-${key}=([^\\s;]+)`));
  return m ? m[1] : undefined;
}

function withFigureFlag(rest: string, key: string, value: string): string {
  if (figureFlagValue(rest, key)) return rest;
  const semi = rest.match(/\s*;\s*$/);
  const suffix = semi ? semi[0] : '';
  const body = semi ? rest.slice(0, -suffix.length) : rest;
  return `${body} -${key}=${value}${suffix}`;
}

function looksLikeFileRef(asset: string): boolean {
  if (!asset || asset === 'none') return false;
  return asset.includes('/') || FILE_EXTENSION_RE.test(figureFileTail(asset));
}

function resolveFigureLineIntent(
  characters: Character[],
  asset: string,
  rest: string,
  assets: AssetInfo[],
): { file: string; rest: string } | null {
  const characterName = figureFlagValue(rest, 'figureCharacter');
  const emotionName = figureFlagValue(rest, 'figureEmotion');
  if (characterName && emotionName) {
    const resolved = resolveFigureByEmotion(characters, characterName, emotionName, assets);
    return resolved ? { file: resolved.file, rest } : null;
  }

  if (!characterName || !asset || looksLikeFileRef(asset)) return null;
  const character = findCharacter(characters, characterName);
  if (!character) return null;
  const sprite = findSprite(character, asset);
  if (!sprite) return null;
  const resolved = resolveFigureByEmotion(characters, character.name, sprite.emotion, assets);
  if (!resolved) return null;
  return {
    file: resolved.file,
    rest: withFigureFlag(rest, 'figureEmotion', sprite.emotion),
  };
}

/**
 * Rewrite changeFigure/miniAvatar lines so a `-figureCharacter`/`-figureEmotion`
 * intent resolves to the real sprite file. The model expresses "this character,
 * this emotion"; we fill in / correct the actual figure filename from the
 * character's sprite library. Also tolerates common raw-output mistakes such as
 * `changeFigure:生气 -figureCharacter=静香`, treating the asset token as emotion.
 * Lines whose character/emotion can't be resolved are left untouched
 * (missing-asset validation then surfaces them).
 */
export function resolveFigurePatchText(
  text: string,
  characters: Character[],
  assets: AssetInfo[],
): string {
  if (characters.length === 0) return text;
  let changed = false;
  const out = splitPatchText(text).map((line) => {
    const m = line.match(FIGURE_LINE);
    if (!m) return line;
    const [, head, asset, rest] = m;
    const resolved = resolveFigureLineIntent(characters, asset, rest, assets);
    if (!resolved || (resolved.file === asset && resolved.rest === rest)) return line;
    changed = true;
    return `${head}${resolved.file}${resolved.rest}`;
  });
  return changed ? out.join('\n') : text;
}

/** Apply figure resolution to a patch's text (insert/replace only). */
function resolveFigurePatches(patches: EditorPatch[], ctx: StagingContext): EditorPatch[] {
  return patches.map((p) =>
    p.type === 'insert' || p.type === 'replace'
      ? { ...p, text: resolveFigurePatchText(p.text, ctx.characters, ctx.assets) }
      : p,
  );
}

function figurePositionFlag(position?: 'left' | 'center' | 'right'): string {
  if (position === 'left') return ' -left';
  if (position === 'right') return ' -right';
  return '';
}

function figureInsertLine(staged: Extract<StagedWrite, { tool: 'insert_figure' }>, ctx: StagingContext): string {
  const resolved = resolveFigureByEmotion(ctx.characters, staged.character, staged.emotion, ctx.assets);
  if (!resolved) {
    const character = findCharacter(ctx.characters, staged.character);
    if (!character) throw new StageError(`找不到角色「${staged.character}」，无法插入立绘。`);
    const sprite = findSprite(character, staged.emotion);
    if (!sprite) throw new StageError(`角色「${character.name}」没有表情「${staged.emotion}」。`);
    throw new StageError(`角色「${character.name}」的表情「${sprite.emotion}」还没有可用立绘文件。`);
  }
  const id = staged.figureId ? ` -id=${staged.figureId}` : '';
  const next = staged.next === false ? '' : ' -next';
  return `changeFigure:${resolved.file} -figureCharacter=${resolved.character.name} -figureEmotion=${resolved.sprite.emotion}${figurePositionFlag(staged.position)}${id}${next};`;
}

export async function stageFigureInsert(
  existing: SceneEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'insert_figure' }>,
  ctx: StagingContext,
): Promise<SceneEdit> {
  const patch: EditorPatch = {
    type: 'insert',
    file: staged.file,
    afterLine: staged.afterLine,
    anchorText: staged.anchorText,
    text: figureInsertLine(staged, ctx),
  };
  return stageSceneEdit(existing, { tool: 'edit_scene', file: staged.file, patches: [patch] }, ctx);
}

/** Build (or merge into) a SceneEdit from staged scene patches. */
export async function stageSceneEdit(
  existing: SceneEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'edit_scene' }>,
  ctx: StagingContext,
): Promise<SceneEdit> {
  const isCurrent = staged.file === ctx.currentSceneName;
  // Base content: an in-progress edit chains onto its own afterContent so that
  // multiple edit_scene calls on the same file compose.
  const beforeContent = existing
    ? existing.afterContent
    : isCurrent
      ? ctx.currentScriptSource
      : await ctx.readSceneContent(staged.file);

  // Resolve立绘意图（角色+表情）为真实文件名，再做格式/缺素材校验与应用。
  const patches = resolveFigurePatches(staged.patches, ctx);

  const textErrors = patches.flatMap((p) =>
    p.type === 'insert' || p.type === 'replace' ? validatePatchText(p.text) : [],
  );
  if (textErrors.length > 0) {
    throw new StageError(`WebGAL txt 格式无效：\n${textErrors.join('\n')}`);
  }

  const missing = validateSceneAssets(patches, ctx.assets);
  if (missing.length > 0) {
    throw new StageError('引用了素材库中不存在的文件。', missing);
  }

  const applied = applyEditorPatches(beforeContent, patches);
  const afterNodes = await parseScene(applied.content);
  const afterContent = await serializeScene(afterNodes);

  const originalBefore = existing?.beforeContent ?? beforeContent;
  if (afterContent === originalBefore) {
    throw new StageError('patch 应用后脚本没有任何变化。');
  }

  const beforeNodes = existing?.beforeNodes ?? (isCurrent ? ctx.currentNodes : await parseScene(originalBefore));

  return {
    kind: 'scene',
    file: staged.file,
    isCurrent,
    beforeContent: originalBefore,
    afterContent,
    beforeNodes,
    afterNodes,
    diff: createLineDiff(originalBefore, afterContent),
    summary: summarizePatches(patches),
    warnings: existing?.warnings ?? [],
  };
}

function diffObjectFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed;
}

// Editable character fields, by value shape. `id` is intentionally excluded so
// a model can never repoint an edit at a different character; complex fields
// (sprites/relations) are edited through dedicated flows, not free-form partials.
const CHARACTER_STRING_FIELDS = [
  'name', 'description', 'personality', 'stance', 'dialogueStyle',
  'gender', 'age', 'defaultVoice', 'voiceTimbre', 'colorTheme', 'notes',
] as const;
const CHARACTER_STRING_ARRAY_FIELDS = ['aliases', 'keywords', 'referenceImages'] as const;
const MEMORY_STRING_FIELDS = ['worldSetting', 'writingStyle', 'userPreferences'] as const;

/** Keep only known fields with the expected type from a model-supplied partial. */
function sanitizePartial(
  partial: Record<string, unknown>,
  stringFields: readonly string[],
  stringArrayFields: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of stringFields) {
    if (typeof partial[key] === 'string') out[key] = partial[key];
  }
  for (const key of stringArrayFields) {
    const value = partial[key];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value;
  }
  return out;
}

/** Build (or merge into) a CharacterEdit from a staged partial update. */
export function stageCharacterEdit(
  existing: CharacterEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'edit_character' }>,
  ctx: StagingContext,
): CharacterEdit {
  const before = existing?.before ?? ctx.getCharacter(staged.id);
  if (!before) throw new StageError(`找不到角色 id：${staged.id}`);
  const baseAfter = existing?.after ?? before;
  const safePartial = sanitizePartial(staged.partial, CHARACTER_STRING_FIELDS, CHARACTER_STRING_ARRAY_FIELDS);
  const after = { ...baseAfter, ...safePartial } as Character;
  return {
    kind: 'character',
    id: staged.id,
    name: before.name,
    before,
    after,
    changedFields: diffObjectFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>),
  };
}

/** Build (or merge into) a MemoryEdit from a staged partial update. */
export function stageMemoryEdit(
  existing: MemoryEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'edit_memory' }>,
  ctx: StagingContext,
): MemoryEdit {
  const before = existing?.before ?? ctx.memory;
  const baseAfter = existing?.after ?? before;
  const safePartial = sanitizePartial(staged.partial, MEMORY_STRING_FIELDS);
  const after = { ...baseAfter, ...safePartial, updatedAt: new Date().toISOString() } as ProjectMemory;
  return {
    kind: 'memory',
    before,
    after,
    changedFields: diffObjectFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    ).filter((f) => f !== 'updatedAt'),
  };
}

/** Build a CreateSceneEdit, normalizing the filename and rejecting duplicates. */
export async function stageCreateSceneEdit(
  staged: Extract<StagedWrite, { tool: 'create_scene' }>,
  ctx: StagingContext,
): Promise<CreateSceneEdit> {
  const base = staged.name.trim().replace(/\\/g, '/').split('/').pop() ?? staged.name.trim();
  if (!base) throw new StageError('create_scene 的场景名为空。');
  const file = base.toLowerCase().endsWith('.txt') ? base : `${base}.txt`;
  const existing = await ctx.listSceneFiles();
  if (existing.some((f) => f.toLowerCase() === file.toLowerCase())) {
    throw new StageError(`场景「${file}」已存在，换个名字，或用 edit_scene 修改它。`);
  }
  return { kind: 'create_scene', file, chapter: staged.chapter, outline: staged.outline };
}

/** Human-readable one-line summary for an edit (approval list rows). */
export function describeEdit(edit: ChangeEdit, sceneHeaders?: Record<string, SceneHeader>): string {
  if (edit.kind === 'scene') return `场景「${sceneDisplayName(edit.file, sceneHeaders?.[edit.file])}」：${edit.summary}`;
  if (edit.kind === 'character') return `角色 ${edit.name}：修改 ${edit.changedFields.join('、') || '（无变化）'}`;
  if (edit.kind === 'create_scene') return `新建场景「${edit.chapter || edit.file}」`;
  return `项目记忆：修改 ${edit.changedFields.join('、') || '（无变化）'}`;
}

/** Whole-set summary for the assistant message bubble. */
export function summarizeChangeSet(set: PendingChangeSet, sceneHeaders?: Record<string, SceneHeader>): string {
  return set.edits.map((e) => describeEdit(e, sceneHeaders)).join(' · ');
}
