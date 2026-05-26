/**
 * WebGAL script data model.
 * Maps to the WebGAL .txt scene file format.
 * Ref: https://docs.openwebgal.com/webgal-script/base.html
 */

export type WebGalCommandType =
  // Story
  | 'dialogue'
  | 'narrator'
  | 'intro'
  | 'choose'
  // Scene control
  | 'changeBg'
  | 'changeFigure'
  | 'miniAvatar'
  | 'changeScene'
  | 'callScene'
  | 'end'
  // Audio
  | 'bgm'
  | 'playEffect'
  | 'playVideo'
  // Control flow
  | 'label'
  | 'jumpLabel'
  | 'setVar'
  | 'setTextbox'
  | 'getUserInput'
  // Effects
  | 'setAnimation'
  | 'setTransform'
  // Gallery
  | 'unlockCg'
  | 'unlockBgm'
  // Meta
  | 'comment';

export interface WebGalFlag {
  key: string;
  value: string | true; // true for boolean flags like -next, -left
}

export interface ChoiceBranch {
  text: string;
  target: string; // scene file or label
}

export interface WebGalNode {
  id: string;
  type: WebGalCommandType;

  // -- Core content (the argument after ':') --
  content: string;

  // -- Flags (e.g. -next, -left, -volume=30) --
  flags: WebGalFlag[];

  // -- Type-specific fields (derived from content+flags for easy editing) --
  // dialogue / narrator
  character?: string;
  voice?: string;

  // changeBg / changeFigure / miniAvatar
  asset?: string;
  figurePosition?: 'left' | 'center' | 'right';
  figureId?: string;
  figureCharacter?: string;
  figureEmotion?: string;

  // choose
  choices?: ChoiceBranch[];

  // changeScene / callScene
  targetScene?: string;

  // label / jumpLabel
  labelName?: string;

  // setVar
  varName?: string;
  varValue?: string;

  // getUserInput
  inputTitle?: string;
  inputButton?: string;

  // intro
  introLines?: string[];

  // setAnimation
  animationName?: string;
  animationTarget?: string;

  // audio
  volume?: number;

  // gallery
  displayName?: string;

  // common flags
  next?: boolean;
  when?: string;

  // -- Visual editor layout --
  position: { x: number; y: number };
  connections: string[]; // IDs of downstream nodes
}

// -- UI metadata --

export const commandCategories = {
  story: ['dialogue', 'narrator', 'intro', 'choose'] as WebGalCommandType[],
  scene: ['changeBg', 'changeFigure', 'miniAvatar', 'changeScene', 'callScene', 'end'] as WebGalCommandType[],
  audio: ['bgm', 'playEffect', 'playVideo'] as WebGalCommandType[],
  control: ['label', 'jumpLabel', 'setVar', 'setTextbox', 'getUserInput', 'comment'] as WebGalCommandType[],
  effects: ['setAnimation', 'setTransform', 'unlockCg', 'unlockBgm'] as WebGalCommandType[],
};

export const commandLabels: Record<WebGalCommandType, string> = {
  dialogue: '对话',
  narrator: '旁白',
  intro: '黑屏文字',
  choose: '选项分支',
  changeBg: '切换背景',
  changeFigure: '切换立绘',
  miniAvatar: '小头像',
  changeScene: '切换场景',
  callScene: '调用场景',
  end: '结束',
  bgm: '背景音乐',
  playEffect: '音效',
  playVideo: '播放视频',
  label: '标签',
  jumpLabel: '跳转标签',
  setVar: '设置变量',
  setTextbox: '文本框控制',
  getUserInput: '用户输入',
  setAnimation: '设置动画',
  setTransform: '设置变换',
  unlockCg: '解锁CG',
  unlockBgm: '解锁BGM',
  comment: '注释',
};

export const categoryLabels: Record<string, string> = {
  story: '剧情',
  scene: '场景',
  audio: '音频',
  control: '流程控制',
  effects: '效果',
};

const METADATA_KEYS = new Set(['章节', 'chapter', '大纲', 'outline', '描述', 'desc']);

/** Returns true if a comment node is a scene-header metadata line (章节/大纲). */
export function isMetadataComment(node: WebGalNode): boolean {
  if (node.type !== 'comment') return false;
  const colon = node.content.indexOf(':');
  if (colon === -1) return false;
  return METADATA_KEYS.has(node.content.slice(0, colon).trim().toLowerCase());
}

/** A scene-to-scene jump derived from a node in the source scene. */
export interface SceneLink {
  target: string;
  kind: 'change' | 'call' | 'choose';
  /** For choose-branches, the visible option text. */
  label?: string;
}

function looksLikeSceneFile(target: string): boolean {
  return /\.txt$/i.test(target.trim());
}

/** Collect outgoing scene-level jumps (changeScene / callScene / choose targets). */
export function extractSceneLinks(nodes: WebGalNode[]): SceneLink[] {
  const links: SceneLink[] = [];
  for (const node of nodes) {
    if (node.type === 'changeScene' && node.targetScene) {
      links.push({ target: node.targetScene, kind: 'change' });
    } else if (node.type === 'callScene' && node.targetScene) {
      links.push({ target: node.targetScene, kind: 'call' });
    } else if (node.type === 'choose' && node.choices) {
      for (const c of node.choices) {
        if (c.target && looksLikeSceneFile(c.target)) {
          links.push({ target: c.target, kind: 'choose', label: c.text });
        }
      }
    }
  }
  return links;
}
