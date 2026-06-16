import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Image, Loader2, Search, Sparkles, Trash2, Plus, X } from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from '../lib/webgal-types';
import { commandLabels } from '../lib/webgal-types';
import { AssetPickerButton } from './AssetPicker';
import type { Character } from '../lib/character-types';
import {
  aliasesForCategory,
  emptyAssetMetadata,
  loadAssetMetadata,
  type AssetMetadata,
} from '../lib/asset-metadata';
import { listScenes, sceneDisplayName, type SceneHeader } from '../lib/webgal-ipc';
import { listAssets, type AssetInfo } from '../lib/assets-ipc';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface DetailPanelProps {
  node: WebGalNode;
  onUpdateNode: (updates: Partial<WebGalNode>) => void;
  onDeleteNode: () => void;
  onClose: () => void;
  characterNames?: string[];
  projectPath?: string;
  characters?: Character[];
  projectId?: string;
  suggestedFigureCharacter?: string;
  /** All scene filenames in the project (for scene-jump / choice target pickers). */
  scenes?: string[];
  /** Per-scene headers, for showing chapter names in the scene picker. */
  sceneHeaders?: Record<string, SceneHeader>;
}

const typeOptions: { value: WebGalCommandType; label: string }[] = [
  { value: 'dialogue', label: '对话' },
  { value: 'narrator', label: '旁白' },
  { value: 'intro', label: '黑屏文字' },
  { value: 'choose', label: '选项分支' },
  { value: 'changeBg', label: '切换背景' },
  { value: 'changeFigure', label: '切换立绘' },
  { value: 'miniAvatar', label: '小头像' },
  { value: 'changeScene', label: '切换场景' },
  { value: 'callScene', label: '调用场景' },
  { value: 'end', label: '结束' },
  { value: 'bgm', label: '背景音乐' },
  { value: 'playEffect', label: '音效' },
  { value: 'playVideo', label: '播放视频' },
  { value: 'label', label: '标签' },
  { value: 'jumpLabel', label: '跳转标签' },
  { value: 'setVar', label: '设置变量' },
  { value: 'setTextbox', label: '文本框控制' },
  { value: 'getUserInput', label: '用户输入' },
  { value: 'setAnimation', label: '设置动画' },
  { value: 'setTransform', label: '设置变换' },
  { value: 'unlockCg', label: '解锁CG' },
  { value: 'unlockBgm', label: '解锁BGM' },
  { value: 'comment', label: '注释' },
];

const inputClass = 'w-full px-3 py-2 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm';
const labelClass = 'block text-xs uppercase tracking-widest text-muted-foreground mb-1.5';

export function DetailPanel({
  node,
  onUpdateNode,
  onDeleteNode,
  onClose,
  characterNames,
  projectPath,
  characters = [],
  projectId,
  suggestedFigureCharacter,
  scenes = [],
  sceneHeaders = {},
}: DetailPanelProps) {
  const [metadata, setMetadata] = useState<AssetMetadata>(() => emptyAssetMetadata());

  useEffect(() => {
    if (!projectPath) {
      setMetadata(emptyAssetMetadata());
      return;
    }
    let cancelled = false;
    loadAssetMetadata(projectPath, projectId)
      .then((next) => {
        if (!cancelled) setMetadata(next);
      })
      .catch(() => {
        if (!cancelled) setMetadata(emptyAssetMetadata());
      });
    return () => { cancelled = true; };
  }, [projectId, projectPath]);

  return (
    <div className="flex-1 border-r border-border bg-card/50 backdrop-blur-sm flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-1 font-mono-family">
            指令编辑
          </h3>
          <div className="text-base font-medium font-display-family">
            {commandLabels[node.type]}
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors" aria-label="关闭">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Type selector */}
        <div>
          <label className={`${labelClass} font-mono-family`}>指令类型</label>
          <select
            value={node.type}
            onChange={(e) => onUpdateNode({ type: e.target.value as WebGalCommandType })}
            className={`${inputClass} font-mono-family`}
            aria-label="指令类型"
          >
            {typeOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Type-specific fields */}
        {renderTypeFields(node, onUpdateNode, characterNames, projectPath, characters, metadata, suggestedFigureCharacter, scenes, sceneHeaders)}

        {/* Common flags */}
        <div className="pt-3 border-t border-border space-y-3">
          <label className={`${labelClass} font-mono-family`}>通用选项</label>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={node.next ?? false}
              onChange={(e) => onUpdateNode({ next: e.target.checked })}
              className="rounded border-border"
            />
            <span>-next (立即执行下一条)</span>
          </label>

          <div>
            <label className={`${labelClass} font-mono-family`}>条件 (-when)</label>
            <input
              type="text"
              value={node.when || ''}
              onChange={(e) => onUpdateNode({ when: e.target.value || undefined })}
              className={`${inputClass} font-mono-family`}
              placeholder="例: score>10"
              
              aria-label="条件"
            />
          </div>
        </div>

        {/* Raw content preview */}
        <div className="pt-3 border-t border-border">
          <label className={`${labelClass} font-mono-family`}>
            节点 ID
          </label>
          <div className="text-xs text-muted-foreground font-mono-family">
            {node.id}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border space-y-2">
        <button
          onClick={onDeleteNode}
          className="w-full px-4 py-2 bg-destructive/10 text-destructive rounded-md hover:bg-destructive/20 transition-colors text-sm"
          aria-label="删除指令"
        >
          删除指令
        </button>
      </div>
    </div>
  );
}

function renderTypeFields(
  node: WebGalNode,
  onUpdate: (updates: Partial<WebGalNode>) => void,
  characterNames?: string[],
  projectPath?: string,
  characters: Character[] = [],
  metadata: AssetMetadata = emptyAssetMetadata(),
  suggestedFigureCharacter?: string,
  scenes: string[] = [],
  sceneHeaders: Record<string, SceneHeader> = {},
) {
  const backgroundAliases = aliasesForCategory(metadata, 'background');
  const figureAliases = aliasesForCategory(metadata, 'figure');
  const bgmAliases = aliasesForCategory(metadata, 'bgm');
  const sfxAliases = aliasesForCategory(metadata, 'sfx');
  const vocalAliases = aliasesForCategory(metadata, 'vocal');
  const videoAliases = aliasesForCategory(metadata, 'video');

  switch (node.type) {
    case 'dialogue':
      return (
        <>
          <div>
            <label className={`${labelClass} font-mono-family`}>角色名</label>
            <input
              type="text"
              value={node.character || ''}
              onChange={(e) => onUpdate({ character: e.target.value })}
              className={inputClass}
              placeholder="留空则继承上一句角色"
              list="character-suggestions"
              aria-label="角色名"
            />
            {characterNames && characterNames.length > 0 && (
              <datalist id="character-suggestions">
                {characterNames.map(name => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className={`${labelClass} font-mono-family mb-0`}>对话内容</label>
              <button className="p-1 hover:bg-primary/10 rounded transition-colors group" aria-label="AI 生成对话">
                <Sparkles className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
              </button>
            </div>
            <textarea
              value={node.content}
              onChange={(e) => onUpdate({ content: e.target.value })}
              className={`${inputClass} h-24 resize-none font-body-family`}
              placeholder="输入对话内容..."
              aria-label="对话内容"
            />
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>语音文件</label>
            <div className="flex gap-1">
              <input
                type="text"
                value={node.voice || ''}
                onChange={(e) => onUpdate({ voice: e.target.value || undefined })}
                className={`${inputClass} flex-1 font-mono-family`}
                placeholder="例: v1.wav"
                aria-label="语音文件"
              />
              {projectPath && (
                <AssetPickerButton
                  projectPath={projectPath}
                  category="vocal"
                  currentValue={node.voice || ''}
                  aliases={vocalAliases}
                  onSelect={(name) => onUpdate({ voice: name === 'none' ? undefined : name })}
                />
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">作为当前对白的 -voice 标记保存，不会新建独立音频指令</p>
          </div>
        </>
      );

    case 'narrator':
      return (
        <>
          <div>
            <label className={`${labelClass} font-mono-family`}>旁白内容</label>
            <textarea
              value={node.content}
              onChange={(e) => onUpdate({ content: e.target.value })}
              className={`${inputClass} h-24 resize-none font-body-family`}
              placeholder="输入旁白文本..."
              aria-label="旁白内容"
            />
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>语音文件</label>
            <div className="flex gap-1">
              <input
                type="text"
                value={node.voice || ''}
                onChange={(e) => onUpdate({ voice: e.target.value || undefined })}
                className={`${inputClass} flex-1 font-mono-family`}
                placeholder="例: narrator_01.wav"
                aria-label="旁白语音文件"
              />
              {projectPath && (
                <AssetPickerButton
                  projectPath={projectPath}
                  category="vocal"
                  currentValue={node.voice || ''}
                  aliases={vocalAliases}
                  onSelect={(name) => onUpdate({ voice: name === 'none' ? undefined : name })}
                />
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">作为当前旁白的 -voice 标记保存，不会新建独立音频指令</p>
          </div>
        </>
      );

    case 'intro':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>
            黑屏文字（每行用回车分隔）
          </label>
          <textarea
            value={(node.introLines || []).join('\n')}
            onChange={(e) => onUpdate({ introLines: e.target.value.split('\n'), content: e.target.value.split('\n').join('|') })}
            className={`${inputClass} h-28 resize-none font-body-family`}
            placeholder="第一行&#10;第二行&#10;第三行"
            aria-label="黑屏文字"
          />
        </div>
      );

    case 'choose':
      return <ChoiceEditor node={node} onUpdate={onUpdate} scenes={scenes} sceneHeaders={sceneHeaders} />;

    case 'changeBg':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>背景图片</label>
          {projectPath && node.asset && node.asset !== 'none' && (
            <div className="mb-2 overflow-hidden rounded-md border border-border bg-secondary/20">
              <div className="aspect-video bg-secondary/30">
                <img
                  src={convertFileSrc(`${projectPath}/game/background/${node.asset}`)}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={(e) => { (e.currentTarget.style.display = 'none'); }}
                />
              </div>
              <div className="px-3 py-2 min-w-0">
                <div className="truncate text-sm">{backgroundAliases[node.asset] || node.asset}</div>
                {backgroundAliases[node.asset] && <div className="truncate text-[11px] text-muted-foreground font-mono-family">{node.asset}</div>}
              </div>
            </div>
          )}
          <div className="flex gap-1">
            <input
              type="text"
              value={node.asset || node.content}
              onChange={(e) => onUpdate({ asset: e.target.value, content: e.target.value })}
              className={`${inputClass} flex-1 font-mono-family`}
              placeholder="例: bg.webp 或 none"
              aria-label="背景图片"
            />
            {projectPath && (
              <AssetPickerButton
                projectPath={projectPath}
                category="background"
                currentValue={node.asset || node.content}
                aliases={backgroundAliases}
                onSelect={(name) => onUpdate({ asset: name, content: name })}
              />
            )}
          </div>
          {(node.asset || node.content) && (node.asset || node.content) !== 'none' && (
            <button
              type="button"
              onClick={() => onUpdate({ asset: 'none', content: 'none' })}
              className="mt-2 px-2 py-1 rounded bg-secondary hover:bg-secondary/70 text-xs"
            >
              清除
            </button>
          )}
          <p className="text-[10px] text-muted-foreground mt-1">放在 game/background/ 目录下</p>
        </div>
      );

    case 'changeFigure':
      return (
        <>
          <CharacterFigurePicker
            node={node}
            onUpdate={onUpdate}
            characters={characters}
            projectPath={projectPath}
            suggestedFigureCharacter={suggestedFigureCharacter}
          />
          <div>
            <label className={`${labelClass} font-mono-family`}>位置</label>
            <select
              value={node.figurePosition || 'center'}
              onChange={(e) => onUpdate({ figurePosition: e.target.value as 'left' | 'center' | 'right' })}
              className={inputClass}
              aria-label="立绘位置"
            >
              <option value="left">左侧</option>
              <option value="center">居中</option>
              <option value="right">右侧</option>
            </select>
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>自定义 ID</label>
            <input
              type="text"
              value={node.figureId || ''}
              onChange={(e) => onUpdate({ figureId: e.target.value || undefined })}
              className={`${inputClass} font-mono-family`}
              placeholder="可选，用于精确定位"
              aria-label="自定义 ID"
            />
          </div>
        </>
      );

    case 'miniAvatar':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>小头像文件</label>
          <div className="flex gap-1">
            <input
              type="text"
              value={node.asset || node.content}
              onChange={(e) => onUpdate({ asset: e.target.value, content: e.target.value })}
              className={`${inputClass} flex-1 font-mono-family`}
              placeholder="例: miniavatar.webp 或 none"
              aria-label="小头像文件"
            />
            {projectPath && (
              <AssetPickerButton
                projectPath={projectPath}
                category="figure"
                currentValue={node.asset || node.content}
                aliases={figureAliases}
                onSelect={(name) => onUpdate({ asset: name, content: name })}
              />
            )}
          </div>
        </div>
      );

    case 'changeScene':
    case 'callScene':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>
            目标场景
          </label>
          <SceneSelect
            value={node.targetScene || node.content || ''}
            scenes={scenes}
            sceneHeaders={sceneHeaders}
            onChange={(name) => onUpdate({ targetScene: name, content: name })}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            {node.type === 'callScene' ? 'callScene 执行完后会返回当前场景' : 'changeScene 会永久切换'}
          </p>
        </div>
      );

    case 'end':
      return (
        <p className="text-sm text-muted-foreground">结束当前场景，无需参数。</p>
      );

    case 'bgm':
    case 'playEffect':
    case 'playVideo':
      return (
        <>
          <div>
            <label className={`${labelClass} font-mono-family`}>
              {node.type === 'bgm' ? '音乐文件' : node.type === 'playEffect' ? '音效文件' : '视频文件'}
            </label>
            <div className="flex gap-1">
              <input
                type="text"
                value={node.asset || node.content}
                onChange={(e) => onUpdate({ asset: e.target.value, content: e.target.value })}
                className={`${inputClass} flex-1 font-mono-family`}
                placeholder={node.type === 'bgm' ? '例: bgm.mp3 或 none' : '例: effect.mp3'}
                aria-label={node.type === 'bgm' ? '音乐文件' : node.type === 'playEffect' ? '音效文件' : '视频文件'}
              />
              {projectPath && (
                <AssetPickerButton
                  projectPath={projectPath}
                  category={node.type === 'playEffect' ? 'sfx' : node.type === 'playVideo' ? 'video' : 'bgm'}
                  currentValue={node.asset || node.content}
                  aliases={
                    node.type === 'playEffect'
                      ? sfxAliases
                      : node.type === 'playVideo'
                        ? videoAliases
                        : bgmAliases
                  }
                  onSelect={(name) => onUpdate({ asset: name, content: name })}
                />
              )}
            </div>
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>音量 (0-100)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={node.volume ?? ''}
              onChange={(e) => onUpdate({ volume: e.target.value ? parseInt(e.target.value, 10) : undefined })}
              className={inputClass}
              placeholder="默认 100"
              aria-label="音量"
            />
          </div>
        </>
      );

    case 'label':
    case 'jumpLabel':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>
            标签名称
          </label>
          <input
            type="text"
            value={node.labelName || node.content}
            onChange={(e) => onUpdate({ labelName: e.target.value, content: e.target.value })}
            className={`${inputClass} font-mono-family`}
            placeholder="例: branch_a"
            aria-label="标签名称"
          />
        </div>
      );

    case 'setVar':
      return (
        <>
          <div>
              <label className={`${labelClass} font-mono-family`}>变量名</label>
              <input
                type="text"
                value={node.varName || ''}
                onChange={(e) => onUpdate({ varName: e.target.value, content: `${e.target.value}=${node.varValue || ''}` })}
                className={`${inputClass} font-mono-family`}
                placeholder="例: score"
                aria-label="变量名"
              />
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>值</label>
            <input
              type="text"
              value={node.varValue || ''}
              onChange={(e) => onUpdate({ varValue: e.target.value, content: `${node.varName || ''}=${e.target.value}` })}
              className={`${inputClass} font-mono-family`}
              placeholder="例: 1, true, 文本"
              aria-label="值"
            />
          </div>
        </>
      );

    case 'getUserInput':
      return (
        <>
          <div>
            <label className={`${labelClass} font-mono-family`}>存入变量</label>
              <input
                type="text"
                value={node.varName || node.content}
                onChange={(e) => onUpdate({ varName: e.target.value, content: e.target.value })}
                className={`${inputClass} font-mono-family`}
                placeholder="例: name"
                aria-label="存入变量"
              />
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>提示文字</label>
            <input
              type="text"
              value={node.inputTitle || ''}
              onChange={(e) => onUpdate({ inputTitle: e.target.value })}
              className={`${inputClass} font-mono-family`}
              placeholder="例: 请输入你的名字"
              aria-label="提示文字"
            />
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>按钮文字</label>
            <input
              type="text"
              value={node.inputButton || ''}
              onChange={(e) => onUpdate({ inputButton: e.target.value })}
              className={`${inputClass} font-mono-family`}
              placeholder="例: 确认"
              aria-label="按钮文字"
            />
          </div>
        </>
      );

    case 'setTextbox':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>操作</label>
          <select
            value={node.content || 'hide'}
            onChange={(e) => onUpdate({ content: e.target.value })}
            className={`${inputClass} font-mono-family`}
            aria-label="操作"
          >
            <option value="hide">隐藏</option>
            <option value="show">显示</option>
          </select>
        </div>
      );

    case 'setAnimation':
      return (
        <>
          <div>
            <label className={`${labelClass} font-mono-family`}>动画名称</label>
            <input
              type="text"
              value={node.animationName || node.content}
              onChange={(e) => onUpdate({ animationName: e.target.value, content: e.target.value })}
              className={`${inputClass} font-mono-family`}
              placeholder="例: enter-from-left"
              aria-label="动画名称"
            />
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>目标 (-target)</label>
            <input
              type="text"
              value={node.animationTarget || ''}
              onChange={(e) => onUpdate({ animationTarget: e.target.value || undefined })}
              className={`${inputClass} font-mono-family`}
              placeholder="例: fig-left"
              aria-label="动画目标"
            />
          </div>
        </>
      );

    case 'setTransform':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>变换 JSON</label>
          <textarea
            value={node.content}
            onChange={(e) => onUpdate({ content: e.target.value })}
            className={`${inputClass} h-24 resize-none font-mono-family`}
            placeholder='例: {"position":{"x":100,"y":0}}'
            aria-label="变换 JSON"
          />
        </div>
      );

    case 'unlockCg':
    case 'unlockBgm':
      return (
        <>
          <div>
            <label className={`${labelClass} font-mono-family`}>
              {node.type === 'unlockCg' ? 'CG 文件' : 'BGM 文件'}
            </label>
            <input
              type="text"
              value={node.asset || node.content}
              onChange={(e) => onUpdate({ asset: e.target.value, content: e.target.value })}
              className={`${inputClass} font-mono-family`}
              aria-label={node.type === 'unlockCg' ? 'CG 文件' : 'BGM 文件'}
            />
          </div>
          <div>
            <label className={`${labelClass} font-mono-family`}>显示名称</label>
            <input
              type="text"
              value={node.displayName || ''}
              onChange={(e) => onUpdate({ displayName: e.target.value || undefined })}
              className={`${inputClass} font-mono-family`}
              placeholder="在鉴赏中显示的名称"
              aria-label="显示名称"
            />
          </div>
        </>
      );

    case 'comment':
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>注释内容</label>
          <textarea
            value={node.content}
            onChange={(e) => onUpdate({ content: e.target.value })}
            className={`${inputClass} h-24 resize-none`}
            placeholder="写下备注..."
            aria-label="注释内容"
          />
        </div>
      );

    default:
      return (
        <div>
          <label className={`${labelClass} font-mono-family`}>内容</label>
          <textarea
            value={node.content}
            onChange={(e) => onUpdate({ content: e.target.value })}
            className={`${inputClass} h-24 resize-none`}
            aria-label="内容"
          />
        </div>
      );
  }
}

function findSpriteSelection(characters: Character[], filename: string) {
  if (!filename || filename === 'none') return null;
  for (const character of characters) {
    const sprite = character.sprites.find((item) => item.file === filename);
    if (sprite) return { character, sprite };
  }
  return null;
}

function figureAliasesFromCharacters(characters: Character[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const character of characters) {
    for (const sprite of character.sprites) {
      if (!sprite.file) continue;
      aliases[sprite.file] = `${character.name}_${sprite.emotion || '默认'}`;
    }
  }
  return aliases;
}

function CharacterFigurePicker({
  node,
  onUpdate,
  characters,
  projectPath,
  suggestedFigureCharacter,
}: {
  node: WebGalNode;
  onUpdate: (updates: Partial<WebGalNode>) => void;
  characters: Character[];
  projectPath?: string;
  suggestedFigureCharacter?: string;
}) {
  const filename = node.asset || node.content;
  const inferred = useMemo(() => findSpriteSelection(characters, filename), [characters, filename]);
  const selectedCharacterName = node.figureCharacter || inferred?.character.name || suggestedFigureCharacter || '';
  const selectedCharacter = characters.find((character) => character.name === selectedCharacterName);
  const figureAliases = useMemo(() => figureAliasesFromCharacters(characters), [characters]);

  useEffect(() => {
    if (!node.figureCharacter && !node.figureEmotion && inferred) {
      onUpdate({ figureCharacter: inferred.character.name, figureEmotion: inferred.sprite.emotion });
    }
  }, [inferred, node.figureCharacter, node.figureEmotion, onUpdate]);

  const chooseCharacter = (name: string) => {
    if (!name) {
      onUpdate({ figureCharacter: undefined, figureEmotion: undefined });
      return;
    }
    const character = characters.find((item) => item.name === name);
    const firstSprite = character?.sprites[0];
    onUpdate({
      figureCharacter: name,
      figureEmotion: firstSprite?.emotion,
      asset: firstSprite?.file || filename,
      content: firstSprite?.file || filename,
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className={`${labelClass} font-mono-family`}>关联角色</label>
        <select
          value={selectedCharacterName}
          onChange={(e) => chooseCharacter(e.target.value)}
          className={inputClass}
          aria-label="关联角色"
        >
          <option value="">无（手动输入文件名）</option>
          {characters.map((character) => (
            <option key={character.id} value={character.name}>{character.name}</option>
          ))}
        </select>
      </div>

      {selectedCharacter ? (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={`${labelClass} font-mono-family mb-0`}>表情形态</label>
            <span className="text-[10px] text-muted-foreground font-mono-family">{filename || 'none'}</span>
          </div>
          <CharacterEmotionDialog
            character={selectedCharacter}
            currentFile={filename}
            projectPath={projectPath}
            onSelect={(sprite) => onUpdate({
              asset: sprite.file,
              content: sprite.file,
              figureCharacter: selectedCharacter.name,
              figureEmotion: sprite.emotion,
            })}
          />
        </div>
      ) : (
        <div>
          <label className={`${labelClass} font-mono-family`}>立绘文件</label>
          <div className="flex gap-1">
            <input
              type="text"
              value={filename}
              onChange={(e) => onUpdate({
                asset: e.target.value,
                content: e.target.value,
                figureCharacter: undefined,
                figureEmotion: undefined,
              })}
              className={`${inputClass} flex-1 font-mono-family`}
              placeholder="例: stand.webp 或 none"
              aria-label="立绘文件"
            />
            {projectPath && (
              <AssetPickerButton
                projectPath={projectPath}
                category="figure"
                currentValue={filename}
                aliases={figureAliases}
                onSelect={(name) => onUpdate({
                  asset: name,
                  content: name,
                  figureCharacter: undefined,
                  figureEmotion: undefined,
                })}
              />
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">放在 game/figure/ 目录下</p>
        </div>
      )}
    </div>
  );
}

// 与 CharacterPanel 的立绘命名规则保持一致：文件名为
// `${characterPart}_${emotionPart}_${timestamp}.${ext}`，变体立绘只进素材库
// （figure/<角色ID>/），sprite.file 留空。此处据此把空 file 的卡片解析回实际图片。
function sanitizeFilenamePart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function spritePrefix(character: Character, emotion: string): string {
  const characterPart = sanitizeFilenamePart(character.name || character.id, 'character');
  return `${characterPart}_${sanitizeFilenamePart(emotion, 'sprite')}_`;
}

function figureFileTail(file: string): string {
  if (!file) return '';
  const slash = file.lastIndexOf('/');
  return slash >= 0 ? file.slice(slash + 1) : file;
}

// 把一个立绘卡片解析为「可写入脚本的限定文件名」与「可显示的图片源」。
// - sprite.file 非空：直接使用（主体图 / 旧数据）。
// - sprite.file 为空（变体）：按情绪前缀在素材库匹配最新生成图，回填限定路径。
interface ResolvedSprite {
  file: string;          // 写入脚本的限定文件名，如 "<角色ID>/xxx.png"
  src: string | null;    // convertFileSrc 后的可显示地址
}

function resolveSpriteImage(
  character: Character,
  sprite: Character['sprites'][number],
  assets: AssetInfo[],
  projectPath?: string,
): ResolvedSprite {
  if (sprite.file) {
    const match = assets.find((asset) => figureFileTail(asset.name) === figureFileTail(sprite.file));
    return {
      file: sprite.file,
      src: match
        ? convertFileSrc(match.path)
        : projectPath
          ? convertFileSrc(`${projectPath}/game/figure/${sprite.file}`)
          : null,
    };
  }
  const prefix = spritePrefix(character, sprite.emotion);
  const matches = assets
    .filter((asset) => figureFileTail(asset.name).startsWith(prefix))
    .sort((a, b) => figureFileTail(b.name).localeCompare(figureFileTail(a.name)));
  const newest = matches[0];
  if (!newest) return { file: '', src: null };
  return { file: `${character.id}/${figureFileTail(newest.name)}`, src: convertFileSrc(newest.path) };
}

function CharacterEmotionDialog({
  character,
  currentFile,
  projectPath,
  onSelect,
}: {
  character: Character;
  currentFile: string;
  projectPath?: string;
  onSelect: (sprite: Character['sprites'][number]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [assets, setAssets] = useState<AssetInfo[]>([]);

  // 立绘按角色存放在 figure/<角色ID>/（变体）与 figure/<角色ID>/main/（主体候选）。
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    (async () => {
      const [variants, candidates] = await Promise.all([
        listAssets(projectPath, `figure/${character.id}`).catch(() => [] as AssetInfo[]),
        listAssets(projectPath, `figure/${character.id}/main`).catch(() => [] as AssetInfo[]),
      ]);
      if (!cancelled) setAssets([...variants, ...candidates]);
    })();
    return () => { cancelled = true; };
  }, [open, projectPath, character.id]);

  const hasSelection = Boolean(currentFile) && currentFile !== 'none';
  // 当前选中文件直接据其限定路径出图：变体的 sprite.file 为空，无法用 find 反查，
  // 故不依赖 sprites 匹配，直接用 currentFile 渲染缩略图。
  const selectedSprite = character.sprites.find((sprite) => sprite.file === currentFile);
  const selectedSrc = hasSelection && projectPath
    ? convertFileSrc(`${projectPath}/game/figure/${currentFile}`)
    : null;
  const filtered = character.sprites.filter((sprite) =>
    `${sprite.emotion} ${sprite.file}`.toLowerCase().includes(search.toLowerCase()),
  );

  // 收集所有已被 sprite 条目关联的文件名（含前缀匹配的变体），剩余的为「未绑定」素材。
  const boundTails = useMemo(() => {
    const set = new Set<string>();
    for (const sprite of character.sprites) {
      if (sprite.file) {
        set.add(figureFileTail(sprite.file));
      } else {
        const prefix = spritePrefix(character, sprite.emotion);
        for (const asset of assets) {
          if (figureFileTail(asset.name).startsWith(prefix)) set.add(figureFileTail(asset.name));
        }
      }
    }
    return set;
  }, [character, assets]);

  const unboundAssets = useMemo(() => {
    const list = assets.filter((asset) => !boundTails.has(figureFileTail(asset.name)));
    return search
      ? list.filter((asset) => figureFileTail(asset.name).toLowerCase().includes(search.toLowerCase()))
      : list;
  }, [assets, boundTails, search]);

  const hasAnything = character.sprites.length > 0 || unboundAssets.length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-border bg-card/60 hover:bg-secondary/50 transition-colors overflow-hidden text-left"
      >
        {hasSelection ? (
          <div className="flex items-center gap-3 p-2">
            <div className="w-14 h-20 rounded bg-secondary/30 overflow-hidden flex-shrink-0 flex items-center justify-center">
              {selectedSrc ? (
                <img src={selectedSrc} alt="" className="w-full h-full object-cover object-top" />
              ) : (
                <Image className="w-6 h-6 text-muted-foreground/40" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm truncate">{selectedSprite?.emotion ? `${character.name} · ${selectedSprite.emotion}` : character.name}</div>
              <div className="mt-1 text-[11px] text-muted-foreground truncate font-mono-family">{figureFileTail(currentFile)}</div>
            </div>
          </div>
        ) : (
          <div className="p-3 text-sm text-muted-foreground">选择 {character.name} 的表情/姿态</div>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
            <DialogTitle className="text-base font-display-family">选择立绘 - {character.name}</DialogTitle>
            <DialogDescription className="text-xs">点击表情卡片后会写入对应立绘文件名。</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索表情、姿态或文件名..."
                className="w-full pl-10 pr-3 py-2 text-sm bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                aria-label="搜索表情"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-5">
            {!hasAnything ? (
              <div className="py-12 text-center text-sm text-muted-foreground">该角色暂无立绘，请先在素材库中添加。</div>
            ) : (
              <div className="space-y-4">
                {filtered.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {filtered.map((sprite) => {
                      const resolved = resolveSpriteImage(character, sprite, assets, projectPath);
                      const selected = (resolved.file || sprite.file) === currentFile;
                      return (
                        <button
                          type="button"
                          key={`${character.id}-${sprite.file}-${sprite.emotion}`}
                          onClick={() => { onSelect({ ...sprite, file: resolved.file || sprite.file }); setOpen(false); }}
                          className={`min-h-40 rounded-md border overflow-hidden bg-card/60 hover:bg-secondary/50 transition-colors text-left ${
                            selected ? 'border-primary bg-primary/10 text-primary' : 'border-border'
                          }`}
                        >
                          <div className="h-28 bg-secondary/30 flex items-center justify-center overflow-hidden">
                            {resolved.src ? (
                              <img src={resolved.src} alt="" className="w-full h-full object-cover object-top" />
                            ) : (
                              <Image className="w-7 h-7 text-muted-foreground/40" />
                            )}
                          </div>
                          <div className="px-2 py-1 text-center">
                            <div className="truncate text-xs">{sprite.emotion || '默认'}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {unboundAssets.length > 0 && (
                  <>
                    <div className="text-[11px] text-muted-foreground uppercase tracking-wide">未绑定素材</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {unboundAssets.map((asset) => {
                        const tail = figureFileTail(asset.name);
                        const qualifiedFile = `${character.id}/${tail}`;
                        const selected = qualifiedFile === currentFile;
                        return (
                          <button
                            type="button"
                            key={asset.path}
                            onClick={() => { onSelect({ emotion: '', file: qualifiedFile }); setOpen(false); }}
                            className={`min-h-40 rounded-md border overflow-hidden bg-card/60 hover:bg-secondary/50 transition-colors text-left ${
                              selected ? 'border-primary bg-primary/10 text-primary' : 'border-border'
                            }`}
                          >
                            <div className="h-28 bg-secondary/30 flex items-center justify-center overflow-hidden">
                              <img src={convertFileSrc(asset.path)} alt="" className="w-full h-full object-cover object-top" />
                            </div>
                            <div className="px-2 py-1 text-center">
                              <div className="truncate text-xs text-muted-foreground">{tail}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScenePickerButton({
  projectPath,
  currentValue,
  aliases,
  onSelect,
}: {
  projectPath: string;
  currentValue: string;
  aliases: Record<string, string>;
  onSelect: (scene: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scenes, setScenes] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listScenes(`${projectPath}/game/scene`)
      .then(setScenes)
      .catch(() => setScenes([]))
      .finally(() => setLoading(false));
  }, [open, projectPath]);

  const filtered = scenes.filter((scene) => {
    const q = search.toLowerCase();
    return scene.toLowerCase().includes(q) || (aliases[scene] || '').toLowerCase().includes(q);
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-2 py-1.5 text-xs rounded bg-secondary hover:bg-secondary/70 transition-colors border border-border flex items-center gap-1"
      >
        浏览
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
            <DialogTitle className="text-base font-display-family">选择场景文件</DialogTitle>
            <DialogDescription className="text-xs">读取 game/scene/ 下的 .txt 场景。</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索场景..."
                className="w-full pl-10 pr-3 py-2 text-sm bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                aria-label="搜索场景"
              />
            </div>
          </div>
          <div className="max-h-[55vh] overflow-y-auto p-3">
            {loading ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">暂无场景文件</div>
            ) : filtered.map((scene) => (
              <button
                key={scene}
                type="button"
                onClick={() => { onSelect(scene); setOpen(false); }}
                className={`w-full px-3 py-2 rounded-md text-left hover:bg-secondary/50 transition-colors ${
                  currentValue === scene ? 'bg-primary/10 text-primary' : ''
                }`}
              >
                <div className="text-sm truncate">{aliases[scene] || scene}</div>
                {aliases[scene] && <div className="mt-0.5 text-xs text-muted-foreground truncate font-mono-family">{scene}</div>}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Dropdown for picking a target scene by chapter name; stores the exact filename. */
function SceneSelect({
  value,
  scenes,
  sceneHeaders = {},
  onChange,
  placeholder = '选择目标场景…',
  allowEmpty = false,
  compact = false,
  showOutline = false,
  'aria-label': ariaLabel,
}: {
  value: string;
  scenes: string[];
  sceneHeaders?: Record<string, SceneHeader>;
  onChange: (scene: string) => void;
  placeholder?: string;
  allowEmpty?: boolean;
  compact?: boolean;
  /** Show "章节 — 大纲" instead of just the chapter name in the option list. */
  showOutline?: boolean;
  'aria-label'?: string;
}) {
  const known = !value || scenes.includes(value);
  const cls = compact
    ? 'w-full px-2 py-1 bg-background border border-border/50 rounded text-sm focus:outline-none focus:ring-1 focus:ring-primary/50'
    : inputClass;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cls}
      aria-label={ariaLabel ?? '目标场景'}
    >
      <option value="">{allowEmpty ? '（不跳转）' : placeholder}</option>
      {!known && value && <option value={value}>{value}（未找到）</option>}
      {scenes.map((s) => (
        <option key={s} value={s}>
          {showOutline ? sceneDisplayName(s, sceneHeaders[s]) : (sceneHeaders[s]?.chapter?.trim() || s)}
        </option>
      ))}
    </select>
  );
}

function ChoiceEditor({ node, onUpdate, scenes = [], sceneHeaders = {} }: {
  node: WebGalNode;
  onUpdate: (u: Partial<WebGalNode>) => void;
  scenes?: string[];
  sceneHeaders?: Record<string, SceneHeader>;
}) {
  const choices = node.choices || [];

  const add = () => {
    onUpdate({ choices: [...choices, { text: '新选项', target: '' }] });
  };

  const update = (idx: number, field: 'text' | 'target', value: string) => {
    const next = [...choices];
    next[idx] = { ...next[idx], [field]: value };
    onUpdate({ choices: next, content: next.map(c => c.target ? `${c.text}:${c.target}` : c.text).join('|') });
  };

  const remove = (idx: number) => {
    const next = choices.filter((_, i) => i !== idx);
    onUpdate({ choices: next, content: next.map(c => c.target ? `${c.text}:${c.target}` : c.text).join('|') });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className={`${labelClass} font-mono-family mb-0`}>选项分支</label>
        <button
          onClick={add}
          className="px-2 py-0.5 text-xs bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors flex items-center gap-1"
          aria-label="添加选项"
        >
          <Plus className="w-3 h-3" />
          添加
        </button>
      </div>

      <div className="space-y-2">
        {choices.map((choice, idx) => (
          <div key={idx} className="p-2.5 bg-input-background border border-border rounded-md">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-muted-foreground font-mono-family">
                选项 {idx + 1}
              </span>
              <button
                onClick={() => remove(idx)}
                className="p-0.5 hover:bg-destructive/10 rounded transition-colors group"
                aria-label={`Delete option ${idx + 1}`}
              >
                <Trash2 className="w-3 h-3 text-muted-foreground group-hover:text-destructive transition-colors" />
              </button>
            </div>
            <input
              type="text"
              value={choice.text}
              onChange={(e) => update(idx, 'text', e.target.value)}
              className="w-full px-2 py-1 mb-1.5 bg-background border border-border/50 rounded text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
              placeholder="选项文本"
              aria-label={`Option ${idx + 1} text`}
            />
            <SceneSelect
              value={choice.target}
              scenes={scenes}
              sceneHeaders={sceneHeaders}
              onChange={(name) => update(idx, 'target', name)}
              placeholder="跳转到场景…（留空则不跳转）"
              allowEmpty
              compact
              showOutline
              aria-label={`Option ${idx + 1} target scene`}
            />
          </div>
        ))}

        {choices.length === 0 && (
          <div className="text-center py-4 text-muted-foreground text-xs">
            点击上方添加选项分支
          </div>
        )}
      </div>
    </div>
  );
}
