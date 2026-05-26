export interface WebGalScene {
  nodes: WebGalNode[];
}

export type WebGalNode =
  | { type: 'dialogue'; character?: string; text: string }
  | { type: 'narration'; text: string }
  | { type: 'changeBg'; file: string; transition?: string }
  | { type: 'changeFigure'; file: string; position: 'left' | 'center' | 'right'; transition?: string }
  | { type: 'miniAvatar'; file: string }
  | { type: 'bgm'; file: string }
  | { type: 'playEffect'; file: string }
  | { type: 'playVideo'; file: string }
  | { type: 'choice'; options: { label: string; scene: string }[] }
  | { type: 'changeScene'; scene: string }
  | { type: 'comment'; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseJsonBlock(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}

function normalizeSceneNode(node: Record<string, unknown>): Record<string, unknown> {
  const type = node.type === 'choose' ? 'choice' : node.type === 'narrator' ? 'narration' : node.type;
  if (type === 'dialogue') {
    return {
      ...node,
      type,
      text: node.text ?? node.content,
      character: node.character ?? node.speaker,
    };
  }
  if (type === 'narration' || type === 'comment') {
    return { ...node, type, text: node.text ?? node.content };
  }
  if (['changeBg', 'changeFigure', 'miniAvatar', 'bgm', 'playEffect', 'playVideo'].includes(String(type))) {
    return { ...node, type, file: node.file ?? node.asset ?? node.content };
  }
  if (type === 'choice') {
    return { ...node, type, options: node.options ?? node.choices };
  }
  if (type === 'changeScene') {
    return { ...node, type, scene: node.scene ?? node.target ?? node.content };
  }
  return { ...node, type };
}

function normalizeWebGalScene(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return value;
  return {
    ...value,
    nodes: value.nodes.map((node) => isRecord(node) ? normalizeSceneNode(node) : node),
  };
}

function isWebGalScene(value: unknown): value is WebGalScene {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return false;
  return value.nodes.every((node) => {
    if (!isRecord(node) || !isString(node.type)) return false;
    switch (node.type) {
      case 'dialogue':
        return isString(node.text) && (node.character === undefined || isString(node.character));
      case 'narration':
      case 'comment':
        return isString(node.text);
      case 'changeBg':
      case 'miniAvatar':
      case 'bgm':
      case 'playEffect':
      case 'playVideo':
        return isString(node.file);
      case 'changeFigure':
        return isString(node.file) && ['left', 'center', 'right'].includes(String(node.position));
      case 'choice':
        return Array.isArray(node.options) && node.options.every((option) =>
          isRecord(option) && isString(option.label) && isString(option.scene),
        );
      case 'changeScene':
        return isString(node.scene);
      default:
        return false;
    }
  });
}

export function extractWebGalJsonBlocks(content: string): { raw: string; scene: WebGalScene | null }[] {
  const blocks: { raw: string; scene: WebGalScene | null }[] = [];
  const regex = /```(?:webgal-json|json)\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const raw = match[1];
    try {
      const parsed = normalizeWebGalScene(parseJsonBlock(raw));
      blocks.push({ raw, scene: isWebGalScene(parsed) ? parsed : null });
    } catch {
      blocks.push({ raw, scene: null });
    }
  }

  return blocks;
}

export function extractWebGalJson(content: string): WebGalScene | null {
  return extractWebGalJsonBlocks(content).find((block) => block.scene)?.scene ?? null;
}

export function stripWebGalJsonBlocks(content: string, replacement = '[已生成 WebGAL 结构化内容]'): string {
  return content.replace(/```(?:webgal-json|story-edit-json|json)\s*[\s\S]*?```/gi, replacement);
}

export function summarizeScene(scene: WebGalScene): string {
  const counts = new Map<string, number>();
  for (const node of scene.nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }

  const labels: Record<string, string> = {
    dialogue: '段对话',
    narration: '段旁白',
    changeBg: '个换背景',
    changeFigure: '个立绘',
    miniAvatar: '个小头像',
    bgm: '个 BGM',
    playEffect: '个音效',
    playVideo: '个视频',
    choice: '个选择肢',
    changeScene: '个场景跳转',
    comment: '条注释',
  };

  return Array.from(counts.entries())
    .map(([type, count]) => `${count} ${labels[type] ?? type}`)
    .join(' · ');
}

function withFlags(file: string, flags: string[]): string {
  return [file, ...flags].filter(Boolean).join(' ');
}

export function webGalJsonToScript(scene: WebGalScene): string {
  return scene.nodes.map((node) => {
    switch (node.type) {
      case 'dialogue':
        return `${node.character || ''}:${node.text};`;
      case 'narration':
        return `:${node.text};`;
      case 'changeBg':
        return `changeBg:${withFlags(node.file, [node.transition ? `-${node.transition}` : '', '-next'])};`;
      case 'changeFigure':
        return `changeFigure:${withFlags(node.file, [`-${node.position}`, node.transition ? `-${node.transition}` : '', '-next'])};`;
      case 'miniAvatar':
        return `miniAvatar:${node.file};`;
      case 'bgm':
        return `bgm:${node.file};`;
      case 'playEffect':
        return `playEffect:${node.file};`;
      case 'playVideo':
        return `playVideo:${node.file};`;
      case 'choice':
        return `choose:${node.options.map((option) => `${option.label}:${option.scene}`).join('|')};`;
      case 'changeScene':
        return `changeScene:${node.scene};`;
      case 'comment':
        return `;${node.text}`;
      default:
        return '';
    }
  }).filter(Boolean).join('\n');
}
