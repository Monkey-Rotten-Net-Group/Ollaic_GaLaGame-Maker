import { invoke } from '@tauri-apps/api/core';

export interface ProjectMemory {
  worldSetting: string;
  writingStyle: string;
  userPreferences: string;
  updatedAt: string;
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
  const parts = [
    memory.worldSetting ? `世界观：${memory.worldSetting}` : '',
    memory.writingStyle ? `写作风格：${memory.writingStyle}` : '',
    memory.userPreferences ? `用户偏好：${memory.userPreferences}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `【项目记忆】\n${parts.join('\n')}` : '';
}
