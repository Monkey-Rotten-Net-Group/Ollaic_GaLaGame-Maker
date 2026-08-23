import { invoke } from '@tauri-apps/api/core';
import type { ProjectMemory } from './project-memory';

export const NARRATIVE_CONTEXT_LIMITS = Object.freeze({
  totalChars: 8_000,
  memoryChars: 2_400,
  factsChars: 2_000,
  sceneChars: 3_000,
  maxFacts: 50,
  factChars: 320,
});

export interface AcceptedNarrativeFact {
  id: string;
  acceptedAt: string;
  summary: string;
}

export interface NarrativeContextDocument {
  version: 1;
  acceptedFacts: AcceptedNarrativeFact[];
}

export function emptyNarrativeContext(): NarrativeContextDocument {
  return { version: 1, acceptedFacts: [] };
}

function boundedHeadTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = '\n... [中间内容已按确定性上限省略] ...\n';
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (remaining - head))}`;
}

function memoryText(memory: ProjectMemory | null): string {
  if (!memory) return '（未设置项目记忆）';
  return [
    memory.worldSetting ? `世界观：${memory.worldSetting}` : '',
    memory.writingStyle ? `写作风格：${memory.writingStyle}` : '',
    memory.userPreferences ? `用户偏好：${memory.userPreferences}` : '',
  ].filter(Boolean).join('\n') || '（未设置项目记忆）';
}

function numberedScene(source: string): string {
  return source.split('\n').map((line, index) => `${index + 1} | ${line}`).join('\n');
}

export function buildNarrativeContext(input: {
  projectId?: string;
  sceneName: string;
  sceneDisplayName: string;
  sceneSource: string;
  memory: ProjectMemory | null;
  document: NarrativeContextDocument;
}): string {
  const facts = input.document.acceptedFacts
    .slice(-NARRATIVE_CONTEXT_LIMITS.maxFacts)
    .map(fact => `- ${fact.summary}`)
    .join('\n') || '（尚无已确认变更）';
  const value = [
    '【强制叙事上下文 v1】',
    `稳定标识：project=${input.projectId || 'local-project'}；scene=${input.sceneName}`,
    `当前场景：${input.sceneDisplayName}`,
    '【规范项目记忆】',
    boundedHeadTail(memoryText(input.memory), NARRATIVE_CONTEXT_LIMITS.memoryChars),
    '【已确认事实】',
    boundedHeadTail(facts, NARRATIVE_CONTEXT_LIMITS.factsChars),
    '【当前场景首尾摘要】',
    boundedHeadTail(numberedScene(input.sceneSource), NARRATIVE_CONTEXT_LIMITS.sceneChars),
  ].join('\n');
  return boundedHeadTail(value, NARRATIVE_CONTEXT_LIMITS.totalChars);
}

export function appendAcceptedFact(
  document: NarrativeContextDocument,
  fact: AcceptedNarrativeFact,
): NarrativeContextDocument {
  const normalized = {
    ...fact,
    summary: boundedHeadTail(fact.summary.trim(), NARRATIVE_CONTEXT_LIMITS.factChars),
  };
  return {
    version: 1,
    acceptedFacts: [...document.acceptedFacts.filter(item => item.id !== fact.id), normalized]
      .slice(-NARRATIVE_CONTEXT_LIMITS.maxFacts),
  };
}

export async function readNarrativeContext(projectPath: string): Promise<NarrativeContextDocument> {
  return (await invoke<NarrativeContextDocument | null>('read_narrative_context', { projectPath }))
    ?? emptyNarrativeContext();
}

export async function saveNarrativeContext(
  projectPath: string,
  document: NarrativeContextDocument,
): Promise<void> {
  await invoke<void>('save_narrative_context', { projectPath, document });
}
