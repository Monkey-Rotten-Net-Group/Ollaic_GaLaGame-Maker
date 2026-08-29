import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialFlowState, recordsFromSnapshot, reduceFlowEvent } from '../lib/flow-state';
import {
  assetQueueDeleteArtifact,
  assetQueueGet,
  assetQueuePreviewArtifact,
  listenPipelineEvents,
  pipelineClearRunHistory,
  pipelineExportRunHistory,
  pipelineGetPlan,
  pipelineGetState,
  pipelineListRuns,
  pipelinePause,
  pipelineResume,
  pipelineResumeRun,
  pipelineRetryStep,
  pipelineSetRunPinned,
  pipelineSkipStep,
  pipelineStart,
  pipelineStepOnce,
  pipelineStop,
  pipelineUpdateDependencies,
  pipelineUpdateStepPrompt,
} from '../lib/pipeline-ipc';
import { isAssetQueueStep } from '../lib/pipeline-types';
import type { AssetQueueState, PipelineEventRecord } from '../lib/pipeline-types';

export function useFlowRunController(projectPath: string) {
  const [state, dispatch] = useReducer(reduceFlowEvent, undefined, initialFlowState);
  const [prompt, setPrompt] = useState('');
  const [allowLocalFallback, setAllowLocalFallback] = useState(false);
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof pipelineGetPlan>>>(null);
  const [assetQueue, setAssetQueue] = useState<AssetQueueState | null>(null);
  const [events, setEvents] = useState<PipelineEventRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detached, setDetached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef<string | null>(null);
  const loadRequestRef = useRef(0);
  const planRequestRef = useRef(0);
  const assetQueueRequestRef = useRef(0);
  const subscriptionRef = useRef(0);
  const assetQueueStepIdsRef = useRef<Set<string>>(new Set());
  const assetQueueStep = state.steps.find(isAssetQueueStep) ?? null;
  assetQueueStepIdsRef.current = new Set(state.steps.filter(isAssetQueueStep).map((step) => step.id));

  const refreshPlan = useCallback(async () => {
    const request = ++planRequestRef.current;
    const storyPlan = await pipelineGetPlan(projectPath);
    if (request === planRequestRef.current) setPlan(storyPlan);
  }, [projectPath]);

  const refreshAssetQueue = useCallback(async () => {
    const request = ++assetQueueRequestRef.current;
    try {
      const queue = await assetQueueGet(projectPath);
      if (request === assetQueueRequestRef.current) {
        setAssetQueue(queue?.runId === runIdRef.current ? queue : null);
      }
    } catch {
      // Queue state is supplementary; Agent Flow controls must remain usable.
    }
  }, [projectPath]);

  const previewAssetArtifact = useCallback((taskId: string, attempt: number) => (
    assetQueuePreviewArtifact(projectPath, taskId, attempt)
  ), [projectPath]);

  const updateAssetArtifact = useCallback(async (
    action: typeof assetQueueDeleteArtifact,
    taskId: string,
    attempt: number,
  ) => {
    const queue = await action(projectPath, taskId, attempt);
    if (queue.runId === runIdRef.current) setAssetQueue(queue);
  }, [projectPath]);

  const subscribe = useCallback(async (runId: string) => {
    const subscription = ++subscriptionRef.current;
    unlistenRef.current?.();
    unlistenRef.current = null;
    runIdRef.current = runId;
    const unlisten = await listenPipelineEvents(runId, (event) => {
      if (event.runId !== runId || runIdRef.current !== runId || subscriptionRef.current !== subscription) return;
      dispatch(event);
      setEvents((current) => [...current, { event, receivedAt: Date.now() }]);
      if (event.type === 'runPersistenceFailed') setError(event.error);
      if (event.type === 'stepSucceeded' || event.type === 'runCompleted') void refreshPlan();
      if ('stepId' in event && assetQueueStepIdsRef.current.has(event.stepId)) void refreshAssetQueue();
    });
    if (subscriptionRef.current !== subscription || runIdRef.current !== runId) {
      unlisten();
      return;
    }
    unlistenRef.current = unlisten;
  }, [refreshAssetQueue, refreshPlan]);

  const refresh = useCallback(async (runId: string) => {
    const snapshot = await pipelineGetState(runId, projectPath);
    if (!snapshot) return;
    dispatch({ type: 'stateHydrated', state: snapshot });
    setEvents((current) => current.length ? current : recordsFromSnapshot(snapshot));
  }, [projectPath]);

  const loadLatest = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [runs, storyPlan] = await Promise.all([
        pipelineListRuns(projectPath),
        pipelineGetPlan(projectPath),
      ]);
      if (request !== loadRequestRef.current) return;
      setPlan(storyPlan);
      const latest = runs[0];
      if (!latest) {
        dispatch({ type: 'reset' });
        setEvents([]);
        setAssetQueue(null);
        setDetached(false);
        runIdRef.current = null;
        return;
      }
      let snapshot = latest;
      let live = false;
      if (latest.status === 'running' || latest.status === 'paused') {
        try {
          const current = await pipelineGetState(latest.runId, projectPath);
          if (request !== loadRequestRef.current) return;
          if (current) {
            snapshot = current;
            live = true;
          }
        } catch {
          // Missing in-memory state means this is a true restart recovery.
        }
        if (request !== loadRequestRef.current) return;
      }
      dispatch({ type: 'stateHydrated', state: snapshot });
      setPrompt(snapshot.prompt);
      setEvents(recordsFromSnapshot(snapshot));
      runIdRef.current = snapshot.runId;
      setDetached(!live);
      if (snapshot.status === 'running' || snapshot.status === 'paused') await subscribe(snapshot.runId);
    } catch (err) {
      if (request === loadRequestRef.current) setError(String(err));
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [projectPath, subscribe]);

  useEffect(() => {
    setAssetQueue(null);
    void loadLatest();
    return () => {
      loadRequestRef.current += 1;
      planRequestRef.current += 1;
      assetQueueRequestRef.current += 1;
      subscriptionRef.current += 1;
      runIdRef.current = null;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [loadLatest]);

  useEffect(() => {
    if (!assetQueueStep) {
      setAssetQueue(null);
      return;
    }
    void refreshAssetQueue();
    if (assetQueueStep.status !== 'running') return;
    const timer = window.setInterval(() => void refreshAssetQueue(), 1000);
    return () => window.clearInterval(timer);
  }, [assetQueueStep, refreshAssetQueue]);

  const runCommand = useCallback(async (command: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await command();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const start = useCallback(async () => {
    if (!prompt.trim()) return;
    await runCommand(async () => {
      setEvents([]);
      planRequestRef.current += 1;
      runIdRef.current = null;
      subscriptionRef.current += 1;
      unlistenRef.current?.();
      unlistenRef.current = null;
      dispatch({ type: 'reset' });
      setAssetQueue(null);
      const runId = await pipelineStart(projectPath, prompt.trim(), allowLocalFallback);
      await subscribe(runId);
      setDetached(false);
      await Promise.all([refresh(runId), refreshPlan()]);
    });
  }, [allowLocalFallback, projectPath, prompt, refresh, refreshPlan, runCommand, subscribe]);

  const pause = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await pipelinePause(runId, projectPath);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand]);

  const resume = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      if (detached) {
        await pipelineResumeRun(projectPath, runId);
        setDetached(false);
      } else {
        await pipelineResume(runId, projectPath);
      }
      await subscribe(runId);
      await refresh(runId);
    });
  }, [detached, projectPath, refresh, runCommand, subscribe]);

  const stepOnce = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await subscribe(runId);
      await pipelineStepOnce(runId, projectPath);
      setDetached(false);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand, subscribe]);

  const stop = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await pipelineStop(runId, projectPath);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand]);

  const togglePinned = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await pipelineSetRunPinned(runId, !state.pinned, projectPath);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand, state.pinned]);

  const clearHistory = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId || !window.confirm('清除这个 run 的全部步骤尝试记录？当前输出不会删除。')) return;
    await runCommand(async () => {
      await pipelineClearRunHistory(runId, projectPath);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand]);

  const exportHistory = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      const content = await pipelineExportRunHistory(runId, projectPath);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${runId}-history.json`;
      link.click();
      URL.revokeObjectURL(url);
    });
  }, [projectPath, runCommand]);

  const retryStep = useCallback(async (stepId: string) => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await subscribe(runId);
      await pipelineRetryStep(runId, stepId, projectPath);
      setDetached(false);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand, subscribe]);

  const updatePromptAndRetry = useCallback(async (stepId: string, stepPrompt: string) => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await subscribe(runId);
      await pipelineUpdateStepPrompt(runId, stepId, stepPrompt, projectPath);
      await pipelineRetryStep(runId, stepId, projectPath);
      setDetached(false);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand, subscribe]);

  const skipStep = useCallback(async (stepId: string) => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await pipelineSkipStep(runId, stepId, projectPath);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand]);

  const updateDependencies = useCallback(async (stepId: string, dependsOn: string[]) => {
    const runId = runIdRef.current;
    if (!runId) return;
    await runCommand(async () => {
      await pipelineUpdateDependencies(runId, stepId, dependsOn, projectPath);
      await refresh(runId);
    });
  }, [projectPath, refresh, runCommand]);

  return {
    state,
    prompt,
    setPrompt,
    allowLocalFallback,
    setAllowLocalFallback,
    plan,
    assetQueue,
    events,
    busy,
    loading,
    detached,
    error,
    loadLatest,
    start,
    pause,
    resume,
    stepOnce,
    stop,
    togglePinned,
    clearHistory,
    exportHistory,
    retryStep,
    updatePromptAndRetry,
    skipStep,
    updateDependencies,
    previewAssetArtifact,
    updateAssetArtifact,
  };
}
