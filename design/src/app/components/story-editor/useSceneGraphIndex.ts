import { useCallback, useEffect, useRef, useState } from 'react';
import { loadScene, parseSceneHeader, readFileText, type SceneHeader } from '../../lib/webgal-ipc';
import { extractSceneLinks, type SceneLink, type WebGalNode } from '../../lib/webgal-types';

function linksEqual(left: SceneLink[], right: SceneLink[]) {
  return left.length === right.length
    && left.every((link, index) => link.kind === right[index]?.kind && link.target === right[index]?.target);
}

export function useSceneGraphIndex(currentSceneName: string, nodes: WebGalNode[]) {
  const [headers, setHeaders] = useState<Record<string, SceneHeader>>({});
  const [links, setLinks] = useState<Record<string, SceneLink[]>>({});
  const previousNodesRef = useRef(nodes);

  const refresh = useCallback(async (projectPath: string, scenes: string[]) => {
    const entries = await Promise.all(scenes.map(async (name) => {
      try {
        const [text, sceneNodes] = await Promise.all([
          readFileText(projectPath, name),
          loadScene(projectPath, name),
        ]);
        return [name, parseSceneHeader(text), extractSceneLinks(sceneNodes)] as const;
      } catch {
        return [name, {}, [] as SceneLink[]] as const;
      }
    }));
    setHeaders(Object.fromEntries(entries.map(([name, header]) => [name, header])));
    setLinks(Object.fromEntries(entries.map(([name, , sceneLinks]) => [name, sceneLinks])));
  }, []);

  useEffect(() => {
    if (previousNodesRef.current === nodes) return;
    previousNodesRef.current = nodes;
    const currentLinks = extractSceneLinks(nodes);
    setLinks((existing) => {
      const previous = existing[currentSceneName];
      return previous && linksEqual(previous, currentLinks)
        ? existing
        : { ...existing, [currentSceneName]: currentLinks };
    });
  }, [currentSceneName, nodes]);

  const updateHeader = useCallback((name: string, header: SceneHeader) => {
    setHeaders((existing) => ({ ...existing, [name]: header }));
  }, []);

  const updateCurrentLinks = useCallback((sceneName: string, sceneNodes: WebGalNode[]) => {
    setLinks((existing) => ({ ...existing, [sceneName]: extractSceneLinks(sceneNodes) }));
  }, []);

  return { headers, links, refresh, updateHeader, updateCurrentLinks };
}
