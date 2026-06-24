/**
 * Shared node-display helpers: icon, type color, and one-line summary for a
 * WebGalNode. Single source of truth for editor node lists and the AI
 * change-preview MiniNodeCard.
 */

import {
  MessageCircle, GitBranch, Image as ImageIcon, User, Music, Film, Tag,
  ArrowRight, Type, Monitor, Variable, Keyboard, Wand2, Move, Award,
} from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from './webgal-types';
import { typeBorderClass } from './webgal-types';
import type { Character } from './character-types';

export const commandIcons: Partial<Record<WebGalCommandType, typeof MessageCircle>> = {
  dialogue: MessageCircle,
  narrator: Type,
  intro: Monitor,
  choose: GitBranch,
  changeBg: ImageIcon,
  changeFigure: User,
  miniAvatar: User,
  changeScene: ArrowRight,
  callScene: ArrowRight,
  end: ArrowRight,
  bgm: Music,
  playEffect: Music,
  playVideo: Film,
  label: Tag,
  jumpLabel: Tag,
  setVar: Variable,
  setTextbox: Monitor,
  getUserInput: Keyboard,
  setAnimation: Wand2,
  setTransform: Move,
  unlockCg: Award,
  unlockBgm: Award,
  comment: Type,
};

/** Border + faint background classes per command type. Re-exported as
 *  typeColors for backwards-compat with consumers like MiniNodeCard. */
export const typeColors: Partial<Record<WebGalCommandType, string>> = typeBorderClass;

/**
 * Display label for a changeFigure node: "角色：立绘名称" instead of the raw
 * image filename. Prefers the fields written by the figure picker
 * (figureCharacter / figureEmotion); otherwise infers the owning character and
 * sprite form by matching the filename against each character's sprites.
 * Falls back to the filename when no character owns the figure.
 */
export function figureLabel(node: WebGalNode, characters: Character[] = []): string {
  const filename = node.asset || node.content || '';
  let charName = node.figureCharacter;
  let emotion = node.figureEmotion;

  if (!charName && !emotion && filename && filename !== 'none') {
    for (const character of characters) {
      const sprite = character.sprites.find((s) => s.file === filename);
      if (sprite) {
        charName = character.name;
        emotion = sprite.emotion;
        break;
      }
    }
  }

  if (charName) return emotion ? `${charName}：${emotion}` : charName;
  return filename || '未选择立绘';
}

function flagLabel(node: WebGalNode): string {
  const parts: string[] = [];
  if (node.figurePosition) parts.push(node.figurePosition);
  if (node.figureId) parts.push(`id=${node.figureId}`);
  if (node.next) parts.push('next');
  if (node.when) parts.push(`when=${node.when}`);
  return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

function figureSummary(node: WebGalNode): string {
  const file = node.asset || node.content || '未选择立绘';
  const character = node.figureCharacter?.trim();
  const emotion = node.figureEmotion?.trim();
  const owner = character
    ? `${character}${emotion ? `：${emotion}` : ''}`
    : emotion
      ? `表情：${emotion}`
      : '';
  return `${owner ? `${owner} · ` : ''}${file}${flagLabel(node)}`;
}

/** One-line human summary of a node's payload. */
export function getNodeSummary(node: WebGalNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.character ? `${node.character}: ${node.content}` : node.content;
    case 'narrator':
      return node.content;
    case 'changeBg':
    case 'miniAvatar':
      return node.asset || node.content;
    case 'changeFigure':
      return figureSummary(node);
    case 'choose':
      return node.choices?.map(c => c.text).join(' / ') || node.content;
    case 'changeScene':
    case 'callScene':
      return node.targetScene || node.content;
    case 'label':
    case 'jumpLabel':
      return node.labelName || node.content;
    case 'setVar':
      return node.varName ? `${node.varName} = ${node.varValue}` : node.content;
    case 'intro':
      return node.introLines?.join(' | ') || node.content;
    case 'bgm':
    case 'playEffect':
    case 'playVideo':
      return node.asset || node.content;
    case 'setAnimation':
      return node.animationName || node.content;
    case 'comment':
      return node.content;
    default:
      return node.content || '—';
  }
}
