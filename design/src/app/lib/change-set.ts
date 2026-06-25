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
import { characterColor } from './character-editing';
import { figureFileTail, findCharacter, findSprite, resolveFigureByEmotion } from './figure-resolve';
import { emptyProjectMemory, type ProjectMemory } from './project-memory';
import { createLineDiff, type DiffLine, type MissingAssetIssue } from './story-agent';
import { parseScene, serializeScene, sceneDisplayName, type SceneHeader } from './webgal-ipc';
import type { WebGalNode } from './webgal-types';
import type { StagedWrite } from './ai-tools';

type DialogueLineInput = Record<string, unknown>;

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

export interface CreateCharacterEdit {
  kind: 'create_character';
  draft: Character;
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
  initialContent?: string;
  initialNodes?: WebGalNode[];
}

export type ChangeEdit = SceneEdit | CharacterEdit | CreateCharacterEdit | MemoryEdit | CreateSceneEdit;

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

function normalizeSceneFilename(value: string): string {
  const base = value.trim().replace(/\\/g, '/').split('/').pop() ?? value.trim();
  return base.toLowerCase().endsWith('.txt') ? base : `${base}.txt`;
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function boolField(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function linePositionFlag(input: Record<string, unknown>): string {
  const position = stringField(input, 'position');
  if (position === 'left') return ' -left';
  if (position === 'right') return ' -right';
  return '';
}

function nextFlag(input: Record<string, unknown>, fallback = true): string {
  return boolField(input, 'next', fallback) ? ' -next' : '';
}

function escapeChoicePart(value: string): string {
  return value.replace(/[|:;\n\r]/g, ' ').trim();
}

function sceneBlockLine(input: DialogueLineInput, ctx: StagingContext): string {
  const type = stringField(input, 'type');
  const text = stringField(input, 'text');
  const asset = stringField(input, 'asset');
  switch (type) {
    case 'narrator':
      if (!text) throw new StageError('insert_dialogue_block 的 narrator 行缺少 text。');
      return `:${text};`;
    case 'dialogue': {
      const character = stringField(input, 'character');
      if (!character || !text) throw new StageError('insert_dialogue_block 的 dialogue 行需要 character 和 text。');
      return `${character}:${text};`;
    }
    case 'intro':
      if (!text) throw new StageError('insert_dialogue_block 的 intro 行缺少 text。');
      return `intro:${text.replace(/\n/g, '|')};`;
    case 'background':
      if (!asset) throw new StageError('insert_dialogue_block 的 background 行缺少 asset。');
      return `changeBg:${asset}${nextFlag(input)};`;
    case 'figure': {
      const character = stringField(input, 'character');
      const emotion = stringField(input, 'emotion');
      if (asset) {
        const flags = [
          character ? ` -figureCharacter=${character}` : '',
          emotion ? ` -figureEmotion=${emotion}` : '',
          linePositionFlag(input),
          nextFlag(input),
        ].join('');
        return `changeFigure:${asset}${flags};`;
      }
      if (!character || !emotion) throw new StageError('insert_dialogue_block 的 figure 行需要 asset，或 character + emotion。');
      return figureInsertLine({
        tool: 'insert_figure',
        file: '',
        afterLine: 'end',
        character,
        emotion,
        position: stringField(input, 'position') as 'left' | 'center' | 'right' | undefined,
        next: boolField(input, 'next', true),
      }, ctx);
    }
    case 'bgm':
      if (!asset) throw new StageError('insert_dialogue_block 的 bgm 行缺少 asset。');
      return `bgm:${asset};`;
    case 'effect':
      if (!asset) throw new StageError('insert_dialogue_block 的 effect 行缺少 asset。');
      return `playEffect:${asset};`;
    case 'video':
      if (!asset) throw new StageError('insert_dialogue_block 的 video 行缺少 asset。');
      return `playVideo:${asset};`;
    case 'jump': {
      const target = stringField(input, 'target');
      if (!target) throw new StageError('insert_dialogue_block 的 jump 行缺少 target。');
      return `changeScene:${normalizeSceneFilename(target)};`;
    }
    case 'call': {
      const target = stringField(input, 'target');
      if (!target) throw new StageError('insert_dialogue_block 的 call 行缺少 target。');
      return `callScene:${normalizeSceneFilename(target)};`;
    }
    case 'label': {
      const label = stringField(input, 'label') || text;
      if (!label) throw new StageError('insert_dialogue_block 的 label 行缺少 label。');
      return `label:${label};`;
    }
    case 'end':
      return 'end;';
    case 'comment':
      if (!text) throw new StageError('insert_dialogue_block 的 comment 行缺少 text。');
      return `;${text}`;
    default:
      throw new StageError(`insert_dialogue_block 不支持的行类型：${type || '空'}`);
  }
}

function sceneBlockText(lines: DialogueLineInput[], ctx: StagingContext): string {
  return lines.map((line) => sceneBlockLine(line, ctx)).join('\n');
}

function headerPatches(
  file: string,
  content: string,
  chapter?: string,
  outline?: string,
): EditorPatch[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  let hasChapter = false;
  let hasOutline = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('; 章节:') || trimmed.startsWith(';章节:')) {
      hasChapter = true;
      return chapter === undefined ? line : `; 章节: ${chapter}`;
    }
    if (trimmed.startsWith('; 大纲:') || trimmed.startsWith(';大纲:')) {
      hasOutline = true;
      return outline === undefined ? line : `; 大纲: ${outline}`;
    }
    return line;
  });
  const prefix = [
    chapter !== undefined && !hasChapter ? `; 章节: ${chapter}` : undefined,
    outline !== undefined && !hasOutline ? `; 大纲: ${outline}` : undefined,
  ].filter((line): line is string => Boolean(line));
  const nextText = [...prefix, ...next].join('\n');
  if (nextText === normalized) return [];
  return [{
    type: 'replace',
    file,
    startLine: 1,
    endLine: Math.max(1, lines.length),
    anchorText: lines[0] ?? '',
    text: nextText,
  }];
}

export async function stageSceneHeaderEdit(
  existing: SceneEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'set_scene_header' }>,
  ctx: StagingContext,
): Promise<SceneEdit> {
  const isCurrent = staged.file === ctx.currentSceneName;
  const content = existing?.afterContent ?? (isCurrent ? ctx.currentScriptSource : await ctx.readSceneContent(staged.file));
  const patches = headerPatches(staged.file, content, staged.chapter, staged.outline);
  if (patches.length === 0) throw new StageError('章节/大纲没有变化。');
  return stageSceneEdit(existing, { tool: 'edit_scene', file: staged.file, patches }, ctx);
}

export async function stageDialogueBlockInsert(
  existing: SceneEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'insert_dialogue_block' }>,
  ctx: StagingContext,
): Promise<SceneEdit> {
  const patch: EditorPatch = {
    type: 'insert',
    file: staged.file,
    afterLine: staged.afterLine,
    anchorText: staged.anchorText,
    text: sceneBlockText(staged.lines, ctx),
  };
  return stageSceneEdit(existing, { tool: 'edit_scene', file: staged.file, patches: [patch] }, ctx);
}

function choiceTarget(choice: Record<string, unknown>): string {
  const target = stringField(choice, 'targetScene') || stringField(choice, 'target') || stringField(choice, 'file');
  if (!target) throw new StageError('create_branch 的 choice 缺少 targetScene。');
  return normalizeSceneFilename(target);
}

export async function stageBranchEdit(
  existing: SceneEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'create_branch' }>,
  ctx: StagingContext,
): Promise<{ sourceEdit: SceneEdit; createSceneEdits: CreateSceneEdit[] }> {
  const createSceneEdits: CreateSceneEdit[] = [];
  const existingFiles = await ctx.listSceneFiles();
  const choices = staged.choices.map((choice) => {
    const text = stringField(choice, 'text');
    if (!text) throw new StageError('create_branch 的 choice 缺少 text。');
    const target = choiceTarget(choice);
    if (existingFiles.some((file) => file.toLowerCase() === target.toLowerCase())) {
      throw new StageError(`分支目标场景「${target}」已存在，create_branch 只负责创建新目标场景。`);
    }
    if (createSceneEdits.some((edit) => edit.file.toLowerCase() === target.toLowerCase())) {
      throw new StageError(`create_branch 中重复的目标场景：${target}`);
    }
    const contentLines = Array.isArray(choice.contentLines)
      ? choice.contentLines.filter((line): line is DialogueLineInput => typeof line === 'object' && line !== null && !Array.isArray(line))
      : [];
    createSceneEdits.push({
      kind: 'create_scene',
      file: target,
      chapter: stringField(choice, 'chapter') || undefined,
      outline: stringField(choice, 'outline') || undefined,
      initialContent: contentLines.length > 0 ? sceneBlockText(contentLines, ctx) : undefined,
    });
    return `${escapeChoicePart(text)}:${target}`;
  });
  const patch: EditorPatch = {
    type: 'insert',
    file: staged.file,
    afterLine: staged.afterLine,
    anchorText: staged.anchorText,
    text: `choose:${choices.join('|')};`,
  };
  const sourceEdit = await stageSceneEdit(existing, { tool: 'edit_scene', file: staged.file, patches: [patch] }, ctx);
  const withNodes = await Promise.all(createSceneEdits.map(async (edit) => ({
    ...edit,
    initialNodes: edit.initialContent ? await parseScene(edit.initialContent) : undefined,
  })));
  return { sourceEdit, createSceneEdits: withNodes };
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
const CREATE_CHARACTER_STRING_FIELDS = [
  'name', 'description', 'personality', 'stance', 'dialogueStyle',
  'gender', 'age', 'voiceTimbre', 'colorTheme', 'notes',
] as const;
const CREATE_CHARACTER_STRING_ARRAY_FIELDS = ['aliases', 'keywords'] as const;
const MEMORY_STRING_FIELDS = ['worldSetting', 'writingStyle', 'userPreferences'] as const;
const CHARACTER_SPRITE_FIELDS = ['emotion', 'prompt'] as const;

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

function sanitizeSprites(value: unknown): Character['sprites'] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sprites: Character['sprites'] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const input = item as Record<string, unknown>;
    const emotion = typeof input.emotion === 'string' ? input.emotion.trim() : '';
    if (!emotion || seen.has(emotion)) continue;
    seen.add(emotion);
    const sprite: Character['sprites'][number] = { emotion, file: '' };
    for (const key of CHARACTER_SPRITE_FIELDS) {
      if (key === 'emotion') continue;
      const field = input[key];
      if (typeof field === 'string' && field.trim()) sprite[key] = field.trim();
    }
    sprites.push(sprite);
  }
  return sprites;
}

function makeDraftCharacter(draft: Record<string, unknown>, index: number): Character {
  const safe = sanitizePartial(draft, CREATE_CHARACTER_STRING_FIELDS, CREATE_CHARACTER_STRING_ARRAY_FIELDS);
  const name = typeof safe.name === 'string' ? safe.name.trim() : '';
  if (!name) throw new StageError('create_character 需要角色名称。');
  const character: Character = {
    id: `tmp_ai_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name,
    aliases: [],
    description: '',
    personality: '',
    stance: '',
    keywords: [],
    dialogueStyle: '',
    gender: '',
    age: '',
    sprites: sanitizeSprites(draft.sprites),
    defaultVoice: undefined,
    voiceTimbre: undefined,
    referenceImages: [],
    relations: [],
    colorTheme: characterColor(index),
    notes: '',
    ...safe,
  };
  if (!character.colorTheme) character.colorTheme = characterColor(index);
  if (!character.sprites.some((sprite) => sprite.emotion === '默认' || sprite.emotion === 'default')) {
    character.sprites = [{ emotion: '默认', file: '' }, ...character.sprites];
  }
  return character;
}

/** Build a CreateCharacterEdit from a staged character draft. */
export function stageCreateCharacterEdit(
  staged: Extract<StagedWrite, { tool: 'create_character' }>,
  ctx: StagingContext,
): CreateCharacterEdit {
  const draft = makeDraftCharacter(staged.draft, ctx.characters.length);
  const duplicate = ctx.characters.some((character) =>
    character.name.trim().toLowerCase() === draft.name.trim().toLowerCase()
    || character.id === draft.id,
  );
  if (duplicate) throw new StageError(`角色「${draft.name}」已存在，使用 edit_character 修改它。`);
  const baseline = {
    ...makeDraftCharacter({ name: draft.name }, ctx.characters.length),
    id: draft.id,
    colorTheme: draft.colorTheme,
  };
  return {
    kind: 'create_character',
    draft,
    changedFields: diffObjectFields(
      baseline as unknown as Record<string, unknown>,
      draft as unknown as Record<string, unknown>,
    ),
  };
}

export function stageCharacterSpritesPlan(
  existing: CharacterEdit | undefined,
  staged: Extract<StagedWrite, { tool: 'plan_character_sprites' }>,
  ctx: StagingContext,
): CharacterEdit {
  const character = findCharacter(ctx.characters, staged.character);
  if (!character) throw new StageError(`找不到角色：${staged.character}`);
  const before = existing?.before ?? character;
  const baseAfter = existing?.after ?? before;
  const sprites = [...baseAfter.sprites];
  for (const input of staged.sprites) {
    const emotion = stringField(input, 'emotion');
    const prompt = stringField(input, 'prompt');
    if (!emotion) continue;
    const index = sprites.findIndex((sprite) => sprite.emotion.trim().toLowerCase() === emotion.toLowerCase());
    if (index >= 0) {
      sprites[index] = {
        ...sprites[index],
        prompt: prompt || sprites[index].prompt,
      };
    } else {
      sprites.push({ emotion, file: '', prompt: prompt || undefined });
    }
  }
  const after = { ...baseAfter, sprites } as Character;
  return {
    kind: 'character',
    id: before.id,
    name: before.name,
    before,
    after,
    changedFields: diffObjectFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>),
  };
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
  const before = existing?.before ?? ctx.memory ?? emptyProjectMemory();
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
  const file = normalizeSceneFilename(staged.name);
  if (!file || file === '.txt') throw new StageError('create_scene 的场景名为空。');
  const existing = await ctx.listSceneFiles();
  if (existing.some((f) => f.toLowerCase() === file.toLowerCase())) {
    throw new StageError(`场景「${file}」已存在，换个名字，或用 edit_scene 修改它。`);
  }
  return { kind: 'create_scene', file, chapter: staged.chapter, outline: staged.outline };
}

/** Human-readable one-line summary for an edit (approval list rows). */
export function describeEdit(edit: ChangeEdit, sceneHeaders?: Record<string, SceneHeader>): string {
  if (edit.kind === 'scene') return `场景「${sceneDisplayName(edit.file, sceneHeaders?.[edit.file])}」：${edit.summary}`;
  if (edit.kind === 'create_character') return `新建角色 ${edit.draft.name}`;
  if (edit.kind === 'character') return `角色 ${edit.name}：修改 ${edit.changedFields.join('、') || '（无变化）'}`;
  if (edit.kind === 'create_scene') return `新建场景「${edit.chapter || edit.file}」`;
  return `项目记忆：修改 ${edit.changedFields.join('、') || '（无变化）'}`;
}

/** Whole-set summary for the assistant message bubble. */
export function summarizeChangeSet(set: PendingChangeSet, sceneHeaders?: Record<string, SceneHeader>): string {
  return set.edits.map((e) => describeEdit(e, sceneHeaders)).join(' · ');
}
