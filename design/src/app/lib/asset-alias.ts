const aliasKey = (projectId: string) => `asset-alias-${projectId}`;

export function getAliasMap(projectId: string): Record<string, string> {
  if (!projectId || typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(aliasKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function setAlias(projectId: string, filename: string, alias: string): void {
  if (!projectId || !filename || typeof window === 'undefined') return;
  const next = { ...getAliasMap(projectId) };
  const trimmed = alias.trim();
  if (trimmed) {
    next[filename] = trimmed;
  } else {
    delete next[filename];
  }
  localStorage.setItem(aliasKey(projectId), JSON.stringify(next));
}

export function removeAlias(projectId: string, filename: string): void {
  if (!projectId || !filename || typeof window === 'undefined') return;
  const next = { ...getAliasMap(projectId) };
  delete next[filename];
  localStorage.setItem(aliasKey(projectId), JSON.stringify(next));
}

export function getAlias(projectId: string, filename: string): string {
  return getAliasMap(projectId)[filename] || filename;
}
