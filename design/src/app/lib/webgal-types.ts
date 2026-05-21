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
