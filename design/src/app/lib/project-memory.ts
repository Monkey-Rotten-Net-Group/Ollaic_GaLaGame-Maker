import { invoke } from '@tauri-apps/api/core';

export interface ProjectMemory {
  worldSetting: string;
  writingStyle: string;
  userPreferences: string;
  updatedAt: string;
  entries?: MemoryEntry[];
}

export const MEMORY_CATEGORIES = {
  world: '世界观',
  character: '人物约束',
  plot: '剧情事实',
  style: '写作风格',
  preference: '创作偏好',
  constraint: '创作约束',
} as const;

export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;
export type MemorySource = 'user' | 'agent';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  enabled: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export function memoryEntries(memory: ProjectMemory | null): MemoryEntry[] {
  if (!memory) return [];
  if (memory.entries) return memory.entries;
  const fields = [
    ['worldSetting', 'world'], ['writingStyle', 'style'], ['userPreferences', 'preference'],
  ] as const;
  return fields.flatMap(([field, category]) => memory[field].trim() ? [{
    id: `legacy-${field}`, category, content: memory[field], enabled: true,
    source: 'user' as const, createdAt: memory.updatedAt, updatedAt: memory.updatedAt,
  }] : []);
}

export function addMemoryEntry(projectPath: string, category: MemoryCategory, content: string, source: MemorySource = 'user'): Promise<ProjectMemory> {
  return invoke('add_project_memory_entry', { projectPath, category, content, source });
}

export function updateMemoryEntry(projectPath: string, id: string, patch: Partial<Pick<MemoryEntry, 'category' | 'content' | 'enabled'>>, source: MemorySource = 'user', expectedUpdatedAt?: string): Promise<ProjectMemory> {
  return invoke('update_project_memory_entry', { projectPath, id, patch, source, expectedUpdatedAt });
}

export function deleteMemoryEntry(projectPath: string, id: string, expectedUpdatedAt?: string): Promise<ProjectMemory> {
  return invoke('delete_project_memory_entry', { projectPath, id, expectedUpdatedAt });
}

export function emptyProjectMemory(): ProjectMemory {
  return {
    worldSetting: '',
    writingStyle: '',
    userPreferences: '',
    updatedAt: new Date().toISOString(),
  };
}

export async function readProjectMemory(projectPath: string): Promise<ProjectMemory | null> {
  return invoke<ProjectMemory | null>('read_project_memory', { projectPath });
}

export async function saveProjectMemory(projectPath: string, memory: ProjectMemory): Promise<void> {
  return invoke<void>('save_project_memory', { projectPath, memory });
}

export function buildMemoryContext(memory: ProjectMemory | null): string {
  if (!memory) return '';
  const parts = memoryEntries(memory).filter((entry) => entry.enabled)
    .map((entry) => `[${entry.id}] ${MEMORY_CATEGORIES[entry.category]}：${entry.content}`);
  return parts.length > 0 ? `【项目记忆】\n${parts.join('\n')}` : '';
}
