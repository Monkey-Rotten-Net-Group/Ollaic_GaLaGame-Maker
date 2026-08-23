export interface EditorCommitCoordinator {
  beginCommit(sceneFiles: readonly string[]): Promise<void>;
  settleCommit(): void;
  canSave(sceneFile: string): boolean;
  startSave(sceneFile: string): (() => void) | null;
  cacheDraft<T>(sceneFile: string, draft: T): void;
  getDraft<T>(sceneFile: string): T | undefined;
  deleteDraft(sceneFile: string): void;
  clearDrafts(): void;
}

export function createEditorCommitCoordinator(): EditorCommitCoordinator {
  let inFlightScenes = new Set<string>();
  const drafts = new Map<string, unknown>();
  const activeSaveCounts = new Map<string, number>();
  const idleWaiters = new Map<string, Set<() => void>>();

  return {
    async beginCommit(sceneFiles) {
      inFlightScenes = new Set(sceneFiles);
      await Promise.all(sceneFiles.map((sceneFile) => {
        if ((activeSaveCounts.get(sceneFile) ?? 0) === 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const waiters = idleWaiters.get(sceneFile) ?? new Set();
          waiters.add(resolve);
          idleWaiters.set(sceneFile, waiters);
        });
      }));
    },
    settleCommit() {
      inFlightScenes.clear();
    },
    canSave(sceneFile) {
      return !inFlightScenes.has(sceneFile);
    },
    startSave(sceneFile) {
      if (inFlightScenes.has(sceneFile)) return null;
      activeSaveCounts.set(sceneFile, (activeSaveCounts.get(sceneFile) ?? 0) + 1);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const remaining = (activeSaveCounts.get(sceneFile) ?? 1) - 1;
        if (remaining > 0) {
          activeSaveCounts.set(sceneFile, remaining);
          return;
        }
        activeSaveCounts.delete(sceneFile);
        const waiters = idleWaiters.get(sceneFile);
        idleWaiters.delete(sceneFile);
        waiters?.forEach((resolve) => resolve());
      };
    },
    cacheDraft(sceneFile, draft) {
      drafts.set(sceneFile, draft);
    },
    getDraft<T>(sceneFile: string) {
      return drafts.get(sceneFile) as T | undefined;
    },
    deleteDraft(sceneFile) {
      drafts.delete(sceneFile);
    },
    clearDrafts() {
      drafts.clear();
    },
  };
}
