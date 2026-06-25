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

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item));
    return out.length > 0 ? out : undefined;
  }
  const single = asString(value);
  if (!single) return undefined;
  const out = single
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item),
  );
  return out.length > 0 ? out : undefined;
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

interface FigureSpriteSummary {
  emotion: string;
  file: string;
  resolvedFile: string;
  scriptFile: string;
  available: boolean;
  prompt?: string;
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
    list = list.filter((a) => {
      const meta = a.category === 'figure' ? figureMeta?.get(figureFileTail(a.name)) : undefined;
      return [
        a.name,
        a.category,
        meta?.character ?? '',
        meta?.emotion ?? '',
      ].some((value) => value.toLowerCase().includes(q));
    });
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

function summarizeCharacterForAi(character: Character, figureAssets: AssetInfo[]): Character & { sprites: FigureSpriteSummary[] } {
  return {
    ...character,
    sprites: character.sprites.map((sprite) => {
      const resolvedFile = resolveSpriteFile(character, sprite, figureAssets);
      return {
        emotion: sprite.emotion,
        file: sprite.file,
        resolvedFile,
        scriptFile: resolvedFile || sprite.file,
        available: Boolean(resolvedFile || sprite.file),
        prompt: sprite.prompt,
      };
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
    description: '获取单个角色的完整设定（性格、对话风格、关系等），含 sprites 立绘列表。每个 sprite 都会给出 emotion、原始 file、resolvedFile/scriptFile（可写入脚本的真实文件）与 available；即使原始 file 为空，也可能通过角色素材库解析出可用 resolvedFile。',
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
      const figureAssets = await listAssets(projectPath, 'figure');
      // Tolerate the model passing a name/alias instead of the canonical id.
      try {
        return summarizeCharacterForAi(await getCharacter(projectPath, id), figureAssets);
      } catch (err) {
        const match = findCharacter(await listCharacters(projectPath), id);
        if (match) return summarizeCharacterForAi(match, figureAssets);
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
  | { tool: 'set_scene_header'; file: string; chapter?: string; outline?: string }
  | { tool: 'insert_dialogue_block'; file: string; afterLine: number | 'end'; anchorText?: string; lines: Record<string, unknown>[] }
  | { tool: 'create_branch'; file: string; afterLine: number | 'end'; anchorText?: string; choices: Record<string, unknown>[] }
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
  | { tool: 'create_character'; draft: Record<string, unknown> }
  | { tool: 'plan_character_sprites'; character: string; sprites: Record<string, unknown>[] }
  | { tool: 'plan_assets'; assets: Record<string, unknown>[] }
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
      '尽量提供 anchorText（原样复制目标行）以兜底行号漂移。text 为 WebGAL txt，多行用 \\n 分隔。' +
      '背景素材可用真实文件名；缺少背景时先调用 plan_assets，再引用同一 targetStem 的 .png 文件名。修改先生成预览供用户确认。',
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
    name: 'set_scene_header',
    description:
      '设置某个场景的章节名和/或大纲。用于组织故事结构，不要再手写注释行改章节/大纲。修改先进入预览。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标场景文件名' },
        chapter: { type: 'string', description: '章节名；省略表示不改' },
        outline: { type: 'string', description: '场景大纲/简述；省略表示不改' },
      },
      required: ['file'],
    },
    run: async (args) => {
      const file = asString(args.file);
      if (!file) throw new Error('set_scene_header 需要 file。');
      const chapter = asString(args.chapter);
      const outline = asString(args.outline);
      if (!chapter && !outline) throw new Error('set_scene_header 至少需要 chapter 或 outline。');
      return { tool: 'set_scene_header', file, chapter, outline } satisfies StagedWrite;
    },
  },
  {
    name: 'insert_dialogue_block',
    description:
      '向场景插入一段结构化剧情块。用于连续写入旁白、对白、背景、BGM、音效、跳转、结束等常见 WebGAL 内容，系统会生成合法 txt。真实素材先用 search_assets 查询；缺少背景时先调用 plan_assets，再在 background.asset 填同一 targetStem 的 .png 文件名。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标场景文件名' },
        afterLine: { description: '在该 txt 行号之后插入；可为正整数，或字符串 "end" 表示文件末尾' },
        anchorText: { type: 'string', description: 'afterLine 对应行原文，用于行号漂移兜底' },
        lines: {
          type: 'array',
          description: '剧情行数组',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['narrator', 'dialogue', 'intro', 'background', 'figure', 'bgm', 'effect', 'video', 'jump', 'call', 'label', 'end', 'comment'] },
              text: { type: 'string', description: '旁白/对白/intro/注释文本' },
              character: { type: 'string', description: 'dialogue/figure 专用角色名' },
              emotion: { type: 'string', description: 'figure 专用表情名' },
              position: { type: 'string', enum: ['left', 'center', 'right'] },
              asset: { type: 'string', description: 'background/bgm/effect/video/figure 专用素材文件名；background 可用真实文件名，或同一轮 plan_assets 返回的 scriptAsset；figure 可省略，由角色+表情解析' },
              target: { type: 'string', description: 'jump/call 目标场景文件名' },
              label: { type: 'string', description: 'label 名称' },
              next: { type: 'boolean', description: '素材命令是否加 -next，默认 true' },
            },
            required: ['type'],
          },
        },
      },
      required: ['file', 'afterLine', 'lines'],
    },
    run: async (args) => {
      const file = asString(args.file);
      if (!file) throw new Error('insert_dialogue_block 需要 file。');
      const afterLine = asAfterLine(args.afterLine);
      if (!afterLine) throw new Error('insert_dialogue_block 需要 afterLine（正整数或 "end"）。');
      const lines = asRecordArray(args.lines);
      if (!lines) throw new Error('insert_dialogue_block 需要非空 lines。');
      return { tool: 'insert_dialogue_block', file, afterLine, anchorText: asString(args.anchorText), lines } satisfies StagedWrite;
    },
  },
  {
    name: 'create_branch',
    description:
      '在当前/指定场景插入选项分支，并暂存创建每个目标场景。只用于目标场景尚不存在的分支。若目标场景已存在，用 edit_scene 插入 choose，再用 insert_dialogue_block 填写已有场景。choices 中每项包含 text、targetScene、可选 chapter/outline/contentLines。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '插入 choose 的源场景文件名' },
        afterLine: { description: '在该 txt 行号之后插入 choose；可为正整数，或字符串 "end" 表示文件末尾' },
        anchorText: { type: 'string', description: 'afterLine 对应行原文，用于行号漂移兜底' },
        choices: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '选项显示文本' },
              targetScene: { type: 'string', description: '目标场景文件名，可不含 .txt' },
              chapter: { type: 'string', description: '目标场景章节名' },
              outline: { type: 'string', description: '目标场景大纲' },
              contentLines: { type: 'array', description: '可选：目标场景初始剧情行，格式同 insert_dialogue_block.lines', items: { type: 'object' } },
            },
            required: ['text', 'targetScene'],
          },
        },
      },
      required: ['file', 'afterLine', 'choices'],
    },
    run: async (args) => {
      const file = asString(args.file);
      if (!file) throw new Error('create_branch 需要 file。');
      const afterLine = asAfterLine(args.afterLine);
      if (!afterLine) throw new Error('create_branch 需要 afterLine（正整数或 "end"）。');
      const choices = asRecordArray(args.choices);
      if (!choices || choices.length < 2) throw new Error('create_branch 至少需要两个 choices。');
      return { tool: 'create_branch', file, afterLine, anchorText: asString(args.anchorText), choices } satisfies StagedWrite;
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
    name: 'create_character',
    description:
      '新建一个角色设定卡。用于用户要求“创建/新增角色”时。只填写基础设定与可选表情槽（sprites 只写 emotion/prompt，不绑定素材文件）；创建先进入预览，用户确认后才落盘。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色主名称，会用于脚本对白' },
        aliases: { type: 'array', items: { type: 'string' }, description: '别名/昵称' },
        description: { type: 'string', description: '外观、身份或背景简述' },
        personality: { type: 'string', description: '性格特征' },
        stance: { type: 'string', description: '立场/阵营/道德倾向' },
        keywords: { type: 'array', items: { type: 'string' }, description: '标签关键词' },
        dialogueStyle: { type: 'string', description: '说话方式/口癖/语气指南' },
        gender: { type: 'string', description: '性别或性别表达' },
        age: { type: 'string', description: '年龄或年龄段' },
        voiceTimbre: { type: 'string', description: '可选 TTS 音色 id' },
        colorTheme: { type: 'string', description: '可选 CSS 颜色' },
        notes: { type: 'string', description: '补充备注' },
        sprites: {
          type: 'array',
          description: '可选表情槽，先不绑定 file；后续由素材生成/绑定流程补齐',
          items: {
            type: 'object',
            properties: {
              emotion: { type: 'string', description: '表情名，如 默认、微笑、生气' },
              prompt: { type: 'string', description: '该表情的生成提示词' },
            },
            required: ['emotion'],
          },
        },
      },
      required: ['name'],
    },
    run: async (args) => {
      const name = asString(args.name);
      if (!name) throw new Error('create_character 需要 name。');
      const draft: Record<string, unknown> = { name };
      for (const key of [
        'description',
        'personality',
        'stance',
        'dialogueStyle',
        'gender',
        'age',
        'voiceTimbre',
        'colorTheme',
        'notes',
      ]) {
        const value = asString(args[key]);
        if (value) draft[key] = value;
      }
      const aliases = asStringArray(args.aliases);
      if (aliases) draft.aliases = aliases;
      const keywords = asStringArray(args.keywords);
      if (keywords) draft.keywords = keywords;
      if (Array.isArray(args.sprites)) draft.sprites = args.sprites;
      return { tool: 'create_character', draft } satisfies StagedWrite;
    },
  },
  {
    name: 'plan_character_sprites',
    description:
      '给已有角色规划/追加表情槽与生图提示词，不调用生图模型、不绑定素材文件。用于先搭角色立绘框架，后续手动或生成素材再补 file。修改先进入预览。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: '角色 id、名字或别名' },
        sprites: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              emotion: { type: 'string', description: '表情名，如 默认、微笑、生气' },
              prompt: { type: 'string', description: '该表情的生图提示词' },
            },
            required: ['emotion', 'prompt'],
          },
        },
      },
      required: ['character', 'sprites'],
    },
    run: async (args) => {
      const character = asString(args.character);
      if (!character) throw new Error('plan_character_sprites 需要 character。');
      const sprites = asRecordArray(args.sprites);
      if (!sprites) throw new Error('plan_character_sprites 需要非空 sprites。');
      return { tool: 'plan_character_sprites', character, sprites } satisfies StagedWrite;
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
    name: 'plan_assets',
    description:
      '规划缺失的待生成图片素材卡，不创建真实文件。用于缺少背景/CG素材时先搭素材框架：填写 category(background 或 cg)、title、prompt、targetStem、可选 sceneFile/style/negativePrompt。若背景需要出现在脚本中，后续写 changeBg:<targetStem>.png -next; 或在 insert_dialogue_block 的 background.asset 使用 <targetStem>.png。立绘不要用此工具，改用 plan_character_sprites。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        assets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: ['background', 'cg'], description: '素材类型；背景用 background，剧情画用 cg' },
              title: { type: 'string', description: '素材卡标题/用途名' },
              sceneFile: { type: 'string', description: '可选：关联场景文件名，如 start.txt' },
              targetStem: { type: 'string', description: '可选：建议生成文件名 stem，不含扩展名；脚本引用时使用 <targetStem>.png' },
              prompt: { type: 'string', description: '图片生成提示词，包含地点/时间/天气/氛围/镜头/主体' },
              style: { type: 'string', description: '可选：画风约束' },
              negativePrompt: { type: 'string', description: '可选：负面提示词' },
            },
            required: ['category', 'title', 'prompt'],
          },
        },
      },
      required: ['assets'],
    },
    run: async (args) => {
      const assets = asRecordArray(args.assets);
      if (!assets) throw new Error('plan_assets 需要非空 assets。');
      return { tool: 'plan_assets', assets } satisfies StagedWrite;
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
