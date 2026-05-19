export interface WebGalScene {
  nodes: WebGalNode[];
}

export type WebGalNode =
  | { type: 'dialogue'; character?: string; text: string }
  | { type: 'narration'; text: string }
  | { type: 'changeBg'; file: string; transition?: string }
  | { type: 'changeFigure'; file: string; position: 'left' | 'center' | 'right'; transition?: string }
  | { type: 'bgm'; file: string }
  | { type: 'choice'; options: { label: string; scene: string }[] }
  | { type: 'changeScene'; scene: string }
  | { type: 'comment'; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWebGalScene(value: unknown): value is WebGalScene {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return false;
  return value.nodes.every((node) => isRecord(node) && typeof node.type === 'string');
}

export function extractWebGalJson(content: string): WebGalScene | null {
  const match = content.match(/```webgal-json\s*([\s\S]*?)```/i);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    return isWebGalScene(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
      case 'bgm':
        return `bgm:${node.file};`;
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
