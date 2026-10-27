import {
  ArrowRight, FileText, GitBranch, Image, MessageCircle, Music, Users, Wand2,
} from 'lucide-react';
import type { WebGalCommandType, WebGalNode } from '../../lib/webgal-types';

export function getCommandSummary(node: WebGalNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.character ? `${node.character}: ${node.content || '(空对白)'}` : node.content || '(空对白)';
    case 'narrator':
      return node.content || '(空旁白)';
    case 'choose':
      return node.choices?.map((choice) => `${choice.text} -> ${choice.target}`).join(' / ') || node.content || '(空选项)';
    case 'changeBg':
    case 'changeFigure':
    case 'miniAvatar':
    case 'bgm':
    case 'playEffect':
    case 'playVideo':
      return node.asset || node.content || '未选择素材';
    case 'changeScene':
    case 'callScene':
      return node.targetScene || node.content || '未选择场景';
    case 'label':
    case 'jumpLabel':
      return node.labelName || node.content || '未命名标签';
    case 'setVar':
      return node.varName ? `${node.varName} = ${node.varValue ?? ''}` : node.content || '未设置变量';
    case 'setAnimation':
      return `${node.animationName || node.content || '未设置动画'}${node.animationTarget ? ` -> ${node.animationTarget}` : ''}`;
    case 'intro':
      return node.introLines?.join(' / ') || node.content || '(空黑屏文字)';
    case 'end':
      return '场景结束';
    default:
      return node.content || '—';
  }
}

export function commandIconFor(type: WebGalCommandType) {
  switch (type) {
    case 'dialogue':
      return MessageCircle;
    case 'choose':
      return GitBranch;
    case 'changeBg':
      return Image;
    case 'changeFigure':
    case 'miniAvatar':
      return Users;
    case 'bgm':
    case 'playEffect':
      return Music;
    case 'setAnimation':
    case 'setTransform':
      return Wand2;
    case 'changeScene':
    case 'callScene':
      return ArrowRight;
    default:
      return FileText;
  }
}

export function commandToneFor(type: WebGalCommandType): string {
  switch (type) {
    case 'dialogue':
      return 'text-primary';
    case 'choose':
      return 'text-tertiary';
    case 'changeBg':
      return 'text-primary';
    case 'bgm':
    case 'playEffect':
      return 'text-tertiary';
    default:
      return 'text-on-surface-variant';
  }
}
