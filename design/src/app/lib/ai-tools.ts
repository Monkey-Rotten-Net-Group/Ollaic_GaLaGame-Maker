/**
 * AI agent tool registry.
 *
 * Each tool is either:
 *  - 'read'  — executed automatically inside the agent loop; its result is fed
 *              back to the model. Read tools wrap existing IPC and self-truncate
 *              to avoid blowing up the context window.
 *  - 'write' — NOT executed here. The loop "stages" the call into a change set
 *              and the user approves the whole set at the end. The run() of a
 *              write tool just normalizes/echoes its arguments.
 *
 * The model sees tool schemas via ToolDef; the loop dispatches by name.
 */

import type { ToolDef } from './ai-ipc';
import { listAllAssets, listAssets, type AssetInfo } from './assets-ipc';
import { getCharacter, listCharacterNames, listCharacters } from './character-ipc';
import { readProjectMemory } from './project-memory';
import { getScenePath, listScenes, readFileText, parseSceneHeader } from './webgal-ipc';
import { isEditorPatch, type EditorPatch } from './editor-patch';
import { figureFileTail, findCharacter, resolveSpriteFile } from './figure-resolve';
import type { Character } from './character-types';

export type ToolKind = 'read' | 'write';

export interface AgentTool {
  name: string;
  description: string;
  kind: ToolKind;
  /** JSON Schema for the tool parameters. */
  schema: unknown;
  /** Execute (read) or normalize args (write). Returns a JSON-serializable value. */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  projectPath: string | null;
  currentSceneName: string;
}

const SCENE_READ_MAX_LINES = 200;
const ASSET_LIST_LIMIT = 200;

function sceneDir(projectPath: string): string {
  return `${projectPath}/game/scene`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asAfterLine(value: unknown): number | 'end' | undefined {
  if (value === 'end') return 'end';
  const n = asInt(value);
  return n && n > 0 ? n : undefined;
}

function asFigurePosition(value: unknown): 'left' | 'center' | 'right' | undefined {
  if (value === 'left' || value === 'center' || value === 'right') return value;
  return undefined;
}

function requireProject(ctx: ToolContext): string {
  if (!ctx.projectPath) throw new Error('当前没有打开的项目，无法读取项目数据。');
  return ctx.projectPath;
}

function numberScript(content: string, fromLine = 1, maxLines = SCENE_READ_MAX_LINES): {
  text: string;
  totalLines: number;
  truncated: boolean;
} {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(1, fromLine);
  const end = Math.min(lines.length, start + maxLines - 1);
  const slice = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`);
  return {
    text: slice.join('\n'),
    totalLines: lines.length,
    truncated: end < lines.length || start > 1,
  };
}

interface FigureMeta {
  character: string;
  emotion: string;
}

/** Map each figure asset (by basename) to its owning character + emotion. */
function buildFigureMeta(characters: Character[], assets: AssetInfo[]): Map<string, FigureMeta> {
  const figures = assets.filter((a) => a.category === 'figure');
  const byTail = new Map<string, FigureMeta>();
  for (const character of characters) {
    for (const sprite of character.sprites) {
      const file = resolveSpriteFile(character, sprite, figures);
      if (!file) continue;
      byTail.set(figureFileTail(file), { character: character.name, emotion: sprite.emotion || '默认' });
    }
  }
  return byTail;
}

function summarizeAssets(assets: AssetInfo[], query?: string, figureMeta?: Map<string, FigureMeta>): unknown {
  let list = assets;
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((a) => a.name.toLowerCase().includes(q));
  }
  const truncated = list.length > ASSET_LIST_LIMIT;
  return {
    total: list.length,
    truncated,
    assets: list.slice(0, ASSET_LIST_LIMIT).map((a) => {
      const meta = a.category === 'figure' ? figureMeta?.get(figureFileTail(a.name)) : undefined;
      return meta
        ? { name: a.name, category: a.category, character: meta.character, emotion: meta.emotion }
        : { name: a.name, category: a.category };
    }),
  };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const readTools: AgentTool[] = [
  {
    name: 'list_scenes',
    description: '列出项目中所有场景，给出文件名与对应的章节名/大纲。调用其它工具（read_scene/edit_scene）时用 file 文件名；章节名/大纲仅供你理解剧情结构。',
    kind: 'read',
    schema: { type: 'object', properties: {}, required: [] },
    run: async (_args, ctx) => {
      const projectPath = requireProject(ctx);
      const files = await listScenes(sceneDir(projectPath));
      // Pair each filename with its chapter/outline header for comprehension.
      const scenes = await Promise.all(files.map(async (file) => {
        try {
          const header = parseSceneHeader(await readFileText(await getScenePath(projectPath, file)));
          return { file, chapter: header.chapter ?? '', outline: header.outline ?? '' };
        } catch {
          return { file, chapter: '', outline: '' };
        }
      }));
      return { scenes };
    },
  },
  {
    name: 'read_scene',
    description:
      '读取某个场景文件的带行号脚本内容。可用 fromLine/maxLines 分页，避免一次返回过长。返回行号对应 WebGAL txt 行号。',
    kind: 'read',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '场景文件名，如 start.txt' },
        fromLine: { type: 'integer', description: '起始行号（默认 1）' },
        maxLines: { type: 'integer', description: `最多返回行数（默认 ${SCENE_READ_MAX_LINES}）` },
      },
      required: ['name'],
    },
    run: async (args, ctx) => {
      const projectPath = requireProject(ctx);
      const name = asString(args.name);
      if (!name) throw new Error('read_scene 需要场景文件名 name。');
      const path = await getScenePath(projectPath, name);
      const content = await readFileText(path);
      const numbered = numberScript(content, asInt(args.fromLine) ?? 1, asInt(args.maxLines) ?? SCENE_READ_MAX_LINES);
      return { name, ...numbered };
    },
  },
  {
    name: 'search_assets',
    description:
      '查询素材库可用文件。可按 category（background/figure/bgm/vocal/video）筛选，按 query 子串匹配文件名。引用素材时只能使用这里返回的文件名。figure（立绘）会附带其所属 character（角色）与 emotion（表情）——立绘表达的是“某角色的某表情”，插入 changeFigure 时优先用 get_character 的 sprites 选定表情。',
    kind: 'read',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '素材类别，省略则查全部' },
        query: { type: 'string', description: '文件名子串过滤' },
      },
      required: [],
    },
    run: async (args, ctx) => {
      const projectPath = requireProject(ctx);
      const category = asString(args.category);
      const assets = category ? await listAssets(projectPath, category) : await listAllAssets(projectPath);
      // For figures, annotate each file with its owning character + emotion so
      // the model picks expressions, not bare filenames.
      const wantsFigures = !category || category === 'figure' || category.startsWith('figure');
      const figureMeta = wantsFigures
        ? buildFigureMeta(await listCharacters(projectPath), assets)
        : undefined;
      return summarizeAssets(assets, asString(args.query), figureMeta);
    },
  },
  {
    name: 'list_characters',
    description: '列出项目中的角色（id 与名字）。',
    kind: 'read',
    schema: { type: 'object', properties: {}, required: [] },
    run: async (_args, ctx) => {
      const projectPath = requireProject(ctx);
      const characters = await listCharacterNames(projectPath);
      return { characters };
    },
  },
  {
    name: 'get_character',
    description: '获取单个角色的完整设定（性格、对话风格、关系等），含 sprites 立绘列表（每项 emotion 表情 → file 文件）。插入该角色立绘前用它确定可用表情。',
    kind: 'read',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '角色 id（也接受角色名或别名）' } },
      required: ['id'],
    },
    run: async (args, ctx) => {
      const projectPath = requireProject(ctx);
      const id = asString(args.id);
      if (!id) throw new Error('get_character 需要角色 id 或名字。');
      // Tolerate the model passing a name/alias instead of the canonical id.
      try {
        return await getCharacter(projectPath, id);
      } catch (err) {
        const match = findCharacter(await listCharacters(projectPath), id);
        if (match) return match;
        throw err;
      }
    },
  },
  {
    name: 'read_memory',
    description: '读取项目记忆（世界观、写作风格、用户偏好）。',
    kind: 'read',
    schema: { type: 'object', properties: {}, required: [] },
    run: async (_args, ctx) => {
      const projectPath = requireProject(ctx);
      const memory = await readProjectMemory(projectPath);
      return memory ?? { worldSetting: '', writingStyle: '', userPreferences: '' };
    },
  },
];

// ---------------------------------------------------------------------------
// Write tools — staged into the change set, not executed here.
// ---------------------------------------------------------------------------

/** Staged write payloads, discriminated by the originating tool name. */
export type StagedWrite =
  | { tool: 'edit_scene'; file: string; patches: EditorPatch[] }
  | {
      tool: 'insert_figure';
      file: string;
      afterLine: number | 'end';
      anchorText?: string;
      character: string;
      emotion: string;
      position?: 'left' | 'center' | 'right';
      next?: boolean;
      figureId?: string;
    }
  | { tool: 'edit_character'; id: string; partial: Record<string, unknown> }
  | { tool: 'edit_memory'; partial: Record<string, unknown> }
  | { tool: 'create_scene'; name: string; chapter?: string; outline?: string };

const writeTools: AgentTool[] = [
  {
    name: 'edit_scene',
    description:
      '对某个场景文件应用补丁。file 为场景文件名。每个 patch 必须含 type 字段：' +
      'insert 用 afterLine（正整数或字符串 "end"）+ text；' +
      'delete 用 startLine + endLine；' +
      'replace 用 startLine + endLine + text。' +
      '行号对应该场景 read_scene 返回的 txt 行号（从 1 开始的整数，不能省略、不能为 null）。' +
      '尽量提供 anchorText（原样复制目标行）以兜底行号漂移。text 为 WebGAL txt，多行用 \\n 分隔。修改先生成预览供用户确认。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标场景文件名' },
        patches: {
          type: 'array',
          description: '补丁数组，按出现顺序应用',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['insert', 'delete', 'replace'], description: '补丁类型' },
              afterLine: {
                description: 'insert 专用：在该 txt 行号之后插入；可为正整数，或字符串 "end" 表示文件末尾',
              },
              startLine: { type: 'integer', minimum: 1, description: 'delete/replace 专用：起始 txt 行号（含）' },
              endLine: { type: 'integer', minimum: 1, description: 'delete/replace 专用：结束 txt 行号（含）' },
              anchorText: { type: 'string', description: '目标行原文，用于行号漂移兜底' },
              text: { type: 'string', description: 'insert/replace 专用：写入的 WebGAL txt，多行用 \\n 分隔' },
            },
            required: ['type'],
          },
        },
      },
      required: ['file', 'patches'],
    },
    run: async (args) => {
      const file = asString(args.file);
      if (!file) throw new Error('edit_scene 需要 file。');
      if (!Array.isArray(args.patches) || args.patches.length === 0) {
        throw new Error('edit_scene 的 patches 必须是非空数组。');
      }
      // The model puts `file` at the top level (one edit_scene = one file), but
      // EditorPatch (and downstream applyEditorPatches) expects `file` on each
      // patch. Inject it before validating/staging.
      const patches = args.patches.map((p) =>
        p && typeof p === 'object' ? { ...(p as Record<string, unknown>), file } : p,
      );
      const invalid = patches.findIndex((p) => !isEditorPatch(p));
      if (invalid >= 0) {
        throw new Error(
          `patches[${invalid}] 字段不合法。每个 patch 必须含 type，且：` +
          'insert 需 afterLine(正整数或"end")与 text；delete 需 startLine 与 endLine(正整数)；' +
          'replace 需 startLine、endLine(正整数)与 text。行号必须是从 1 开始的整数，不能省略或为 null。',
        );
      }
      return { tool: 'edit_scene', file, patches: patches as EditorPatch[] } satisfies StagedWrite;
    },
  },
  {
    name: 'insert_figure',
    description:
      '插入角色立绘节点。优先使用这个工具，而不是手写 changeFigure 路径。' +
      '你只需要提供角色 character、表情 emotion、位置 position 和插入位置 afterLine；系统会从角色立绘库解析真实文件名并生成 WebGAL changeFigure 行。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标场景文件名' },
        afterLine: {
          description: '在该 txt 行号之后插入；可为正整数，或字符串 "end" 表示文件末尾',
        },
        anchorText: { type: 'string', description: 'afterLine 对应行原文，用于行号漂移兜底' },
        character: { type: 'string', description: '角色名、角色 id 或别名' },
        emotion: { type: 'string', description: '角色 sprites 中的表情名，如 默认、微笑、生气' },
        position: { type: 'string', enum: ['left', 'center', 'right'], description: '立绘位置，默认 center' },
        next: { type: 'boolean', description: '是否追加 -next，默认 true' },
        figureId: { type: 'string', description: '可选：WebGAL figure id（对应 -id=xxx）' },
      },
      required: ['file', 'afterLine', 'character', 'emotion'],
    },
    run: async (args) => {
      const file = asString(args.file);
      if (!file) throw new Error('insert_figure 需要 file。');
      const afterLine = asAfterLine(args.afterLine);
      if (!afterLine) throw new Error('insert_figure 需要 afterLine（正整数或 "end"）。');
      const character = asString(args.character);
      if (!character) throw new Error('insert_figure 需要 character。');
      const emotion = asString(args.emotion);
      if (!emotion) throw new Error('insert_figure 需要 emotion。');
      return {
        tool: 'insert_figure',
        file,
        afterLine,
        anchorText: asString(args.anchorText),
        character,
        emotion,
        position: asFigurePosition(args.position),
        next: asBool(args.next),
        figureId: asString(args.figureId),
      } satisfies StagedWrite;
    },
  },
  {
    name: 'edit_character',
    description:
      '修改某个角色的设定字段（如 personality、dialogueStyle、stance、description 等）。partial 只包含要改的字段。修改先进入预览，用户确认后才落盘。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '角色 id' },
        partial: { type: 'object', description: '要更新的字段集合' },
      },
      required: ['id', 'partial'],
    },
    run: async (args) => {
      const id = asString(args.id);
      if (!id) throw new Error('edit_character 需要角色 id。');
      const partial = (args.partial && typeof args.partial === 'object' ? args.partial : {}) as Record<string, unknown>;
      return { tool: 'edit_character', id, partial } satisfies StagedWrite;
    },
  },
  {
    name: 'edit_memory',
    description:
      '更新项目记忆字段（worldSetting/writingStyle/userPreferences）。partial 只包含要改的字段。修改先进入预览。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        partial: { type: 'object', description: '要更新的记忆字段' },
      },
      required: ['partial'],
    },
    run: async (args) => {
      const partial = (args.partial && typeof args.partial === 'object' ? args.partial : {}) as Record<string, unknown>;
      return { tool: 'edit_memory', partial } satisfies StagedWrite;
    },
  },
  {
    name: 'create_scene',
    description:
      '新建一个空场景文件，可选设置章节名(chapter)和大纲(outline)。建好后用 edit_scene 往里写内容（afterLine 用 "end" 追加）。新建先进入预览，用户确认后才落盘。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '场景文件名，可不含 .txt（会自动补全）' },
        chapter: { type: 'string', description: '可选：章节名' },
        outline: { type: 'string', description: '可选：本章大纲/简述' },
      },
      required: ['name'],
    },
    run: async (args) => {
      const name = asString(args.name);
      if (!name) throw new Error('create_scene 需要场景名 name。');
      return {
        tool: 'create_scene',
        name,
        chapter: asString(args.chapter),
        outline: asString(args.outline),
      } satisfies StagedWrite;
    },
  },
];

export const AGENT_TOOLS: AgentTool[] = [...readTools, ...writeTools];

const TOOL_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AgentTool | undefined {
  return TOOL_BY_NAME.get(name);
}

/** Tool definitions sent to the model. */
export function toolDefs(): ToolDef[] {
  return AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.schema }));
}
