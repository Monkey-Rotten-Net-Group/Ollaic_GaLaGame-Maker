import { useCallback, useEffect, useRef, useState } from "react";
import {
  DebugCommand,
  getRuntimeInfo,
  getRuntimeUrl,
  setRuntimeProject,
} from "../lib/webgal-ipc";
import { wrapScriptWithEntryVariables } from "../lib/scene-entry-state";

export interface RuntimePreviewOptions {
  entryVariables?: Record<string, string | number | boolean | null | undefined>;
}

/** TEMP_SCENE previews the draft in memory; it never writes the project files. */
export function useRuntimePreview(
  projectPath: string | null,
  source: string,
  enabled: boolean,
  options?: RuntimePreviewOptions,
) {
  const [url, setUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const lastSentRef = useRef<string | null>(null);
  const pendingJumpRef = useRef<{
    project: string | null;
    scene: string;
    sentence: number;
  } | null>(null);
  const syncTimerRef = useRef<number>();
  const frameLoadedRef = useRef(false);
  const engineInitializedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !projectPath) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    setUrl(null);
    setReady(false);
    setError(null);
    lastSentRef.current = null;
    frameLoadedRef.current = false;
    engineInitializedRef.current = false;
    void (async () => {
      try {
        await setRuntimeProject(projectPath);
        if (cancelled) return;
        const info = await getRuntimeInfo();
        if (cancelled) return;
        if (!info.installed)
          throw new Error("请先在应用设置中安装或选择 WebGAL 引擎。");
        const runtimeUrl = await getRuntimeUrl();
        if (cancelled) return;
        const wsUrl = new URL("/api/webgalsync", runtimeUrl);
        wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(wsUrl);
        socketRef.current = socket;
        // Open the engine only after our observer is attached, so its first
        // SYNCFC heartbeat cannot be lost. Socket-open alone isn't engine-ready.
        socket.onopen = () => {
          if (cancelled) return;
          const embeddedUrl = new URL(runtimeUrl);
          embeddedUrl.searchParams.set("ollaicPreview", "1");
          setUrl(embeddedUrl.toString());
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data));
            if (
              !cancelled &&
              frameLoadedRef.current &&
              message.data?.command === DebugCommand.SYNCFC
            )
              setReady(true);
          } catch {
            /* Ignore messages outside the WebGAL debug protocol. */
          }
        };
        socket.onerror = () => {
          if (!cancelled) setError("预览连接失败，请重连。");
        };
        socket.onclose = () => {
          if (!cancelled) {
            setReady(false);
            setError("预览连接已断开，请重连。");
          }
        };
      } catch (err) {
        if (!cancelled)
          setError(String(err instanceof Error ? err.message : err));
      }
    })();
    return () => {
      cancelled = true;
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [projectPath, enabled, revision]);

  const sync = useCallback(() => {
    const socket = socketRef.current;
    if (!ready || socket?.readyState !== WebSocket.OPEN) return;
    const rawScript = sourceRef.current;
    const currentOptions = optionsRef.current;
    const script = currentOptions?.entryVariables
      ? wrapScriptWithEntryVariables(rawScript, currentOptions.entryVariables)
      : rawScript;
    if (!engineInitializedRef.current) {
      // The engine's entry overlay lives outside its React game-state flags.
      // This debug command dismisses it so TEMP_SCENE is actually visible.
      socket.send(
        JSON.stringify({
          event: "message",
          data: {
            command: DebugCommand.REFETCH_TEMPLATE_FILES,
            sceneMsg: {},
            stageSyncMsg: {},
            message: "",
          },
        }),
      );
      engineInitializedRef.current = true;
    }
    const target = pendingJumpRef.current;
    const jumping = target?.project === projectPath;
    socket.send(
      JSON.stringify({
        event: "message",
        data: {
          command: jumping ? DebugCommand.JUMP : DebugCommand.TEMP_SCENE,
          sceneMsg: jumping
            ? { scene: target.scene, sentence: target.sentence }
            : {},
          stageSyncMsg: {},
          message: jumping ? "Sync" : script,
        },
      }),
    );
    pendingJumpRef.current = null;
    lastSentRef.current = script;
  }, [ready, projectPath]);

  const jump = useCallback(
    (scene: string, sentence: number) => {
      window.clearTimeout(syncTimerRef.current);
      pendingJumpRef.current = { project: projectPath, scene, sentence };
      sync();
    },
    [projectPath, sync],
  );

  const serializedVariables = JSON.stringify(options?.entryVariables ?? {});
  useEffect(() => {
    const script = options?.entryVariables
      ? wrapScriptWithEntryVariables(source, options.entryVariables)
      : source;
    if (!ready || script === lastSentRef.current) return;
    syncTimerRef.current = window.setTimeout(sync, 450);
    return () => window.clearTimeout(syncTimerRef.current);
  }, [source, serializedVariables, ready, sync, options?.entryVariables]);

  return {
    url,
    ready,
    error,
    sync,
    jump,
    onFrameLoad: () => {
      frameLoadedRef.current = true;
    },
    reconnect: () => setRevision((value) => value + 1),
    revision,
  };
}
