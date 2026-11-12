import { DEFAULT_RECIPE_STEPS } from './flow-state';

export const FLOW_PHASES = [
  { title: '故事与角色', description: '确定故事骨架和人物', ids: ['plan', 'memory', 'outline', 'character', 'anchorPlan'] },
  { title: '对白与场景', description: '把故事写成可编辑的场景', ids: ['dialogist', 'assetPlan', 'scene'] },
  { title: '素材制作', description: '生成图片和语音，绑定导入的音频', ids: ['assetQueue'] },
];

const STEP_INFO: Record<string, { title: string; description: string }> = {
  plan: { title: '故事规划', description: '生成故事梗概与核心冲突' },
  memory: { title: '世界观设定', description: '整理背景、规则与术语' },
  outline: { title: '章节大纲', description: '规划章节、场景和分支' },
  character: { title: '角色设计', description: '建立角色档案与关系' },
  anchorPlan: { title: '角色立绘定锚', description: '规划角色默认基础立绘与参考图锚点' },
  dialogist: { title: '对白创作', description: '为各场景创作对白与表演提示' },
  assetPlan: { title: '素材规划', description: '整理图片、语音与音乐需求，无需素材接口' },
  asset: { title: '素材规划', description: '整理素材需求' },
  scene: { title: '场景编排', description: '编译并保存 WebGAL 场景文件，无需额外接口' },
  assetQueue: { title: '素材生成与绑定', description: '调用素材接口生成文件并放入场景' },
};

export function stepTitle(id: string) { return STEP_INFO[id]?.title ?? id; }
export function stepDescription(id: string) { return STEP_INFO[id]?.description ?? '查看步骤的输入、结果与运行记录'; }

export function missingScopeInputs(selectedIds: readonly string[]) {
  const selected = new Set(selectedIds);
  return DEFAULT_RECIPE_STEPS.filter((step) => selected.has(step.id))
    .flatMap((step) => step.dependsOn.filter((id) => !selected.has(id)).map((dependency) => ({ step: step.id, dependency })));
}

/** An explicit repair action, never applied automatically on checkbox change. */
export function includeRequiredSteps(selectedIds: readonly string[]) {
  const selected = new Set(selectedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of DEFAULT_RECIPE_STEPS) {
      if (!selected.has(step.id)) continue;
      for (const id of step.dependsOn) {
        if (!selected.has(id)) { selected.add(id); changed = true; }
      }
    }
  }
  return DEFAULT_RECIPE_STEPS.filter((step) => selected.has(step.id)).map((step) => step.id);
}

export function excludeDependentSteps(selectedIds: readonly string[]) {
  const selected = new Set(selectedIds);
  for (const step of DEFAULT_RECIPE_STEPS) {
    if (step.dependsOn.some((id) => !selected.has(id))) selected.delete(step.id);
  }
  return DEFAULT_RECIPE_STEPS.filter((step) => selected.has(step.id)).map((step) => step.id);
}
