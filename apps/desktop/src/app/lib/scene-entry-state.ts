import type { StoryPlan } from "./pipeline-types";

export interface InferredEntryState {
  variables: Record<string, string>;
  precedingScenes: string[];
}

/**
 * Apply a single WebGAL effect mutation safely to an in-memory variables dictionary.
 * Supported patterns:
 * - `var=val`
 * - `var=var+N` or `var+=N`
 * - `var=var-N` or `var-=N`
 */
export function applyEffectMutation(
  variables: Record<string, string>,
  effect: string,
): void {
  const trimmed = effect.trim().replace(/;$/, "");
  if (!trimmed) return;

  // Pattern: var+=N or var-=N
  const plusEqMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*\+=\s*(.+)$/);
  if (plusEqMatch) {
    const [, varId, valStr] = plusEqMatch;
    const current = Number(variables[varId] ?? 0);
    const delta = Number(valStr);
    variables[varId] = String(
      Number.isFinite(delta) ? current + delta : valStr,
    );
    return;
  }

  const minusEqMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*-=\s*(.+)$/);
  if (minusEqMatch) {
    const [, varId, valStr] = minusEqMatch;
    const current = Number(variables[varId] ?? 0);
    const delta = Number(valStr);
    variables[varId] = String(
      Number.isFinite(delta) ? current - delta : valStr,
    );
    return;
  }

  // Pattern: var=...
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx <= 0) return;

  const varId = trimmed.slice(0, eqIdx).trim();
  const expr = trimmed.slice(eqIdx + 1).trim();

  // Pattern: var=var+N
  const addPattern = new RegExp(`^${varId}\\s*\\+\\s*(\\d+(?:\\.\\d+)?)$`);
  const addMatch = expr.match(addPattern);
  if (addMatch) {
    const current = Number(variables[varId] ?? 0);
    const delta = Number(addMatch[1]);
    variables[varId] = String(current + delta);
    return;
  }

  // Pattern: var=var-N
  const subPattern = new RegExp(`^${varId}\\s*-\\s*(\\d+(?:\\.\\d+)?)$`);
  const subMatch = expr.match(subPattern);
  if (subMatch) {
    const current = Number(variables[varId] ?? 0);
    const delta = Number(subMatch[1]);
    variables[varId] = String(current - delta);
    return;
  }

  // Direct assignment: var=val
  variables[varId] = expr;
}

/**
 * Given a StoryPlan and a target scene (by ID or filename), derive the simulated
 * entry variable values by walking a topological path from entryScene and accumulating
 * all BranchEdge.effects along the way.
 */
export function deriveSceneEntryVariables(
  plan: StoryPlan,
  targetSceneIdOrFile: string,
): InferredEntryState {
  const variables: Record<string, string> = {};

  // 1. Initialize with plan default variables
  for (const v of plan.variables ?? []) {
    variables[v.id] = v.initialValue ?? "0";
  }

  const scenePlans = plan.scenePlans ?? [];
  const resolveCanonicalNode = (idOrFile: string): string => {
    const matched = scenePlans.find(
      (scene) => scene.id === idOrFile || scene.file === idOrFile,
    );
    return matched ? matched.id : idOrFile;
  };

  // 2. Resolve target scene canonical node key
  const targetNode = resolveCanonicalNode(targetSceneIdOrFile);
  const rawEntry = plan.branches?.entryScene;
  if (!rawEntry) {
    return { variables, precedingScenes: [] };
  }
  const entryNode = resolveCanonicalNode(rawEntry);
  if (targetNode === entryNode) {
    return { variables, precedingScenes: [] };
  }

  // 3. BFS search from entryNode to targetNode (normalizing both scene IDs and filenames)
  const edges = plan.branches?.edges ?? [];
  const queue: Array<{
    current: string;
    path: string[];
    effects: string[];
  }> = [{ current: entryNode, path: [rawEntry], effects: [] }];
  const visited = new Set<string>([entryNode]);

  let foundPath: { path: string[]; effects: string[] } | null = null;

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (step.current === targetNode) {
      foundPath = { path: step.path, effects: step.effects };
      break;
    }

    for (const edge of edges) {
      const fromNode = resolveCanonicalNode(edge.from);
      const toNode = resolveCanonicalNode(edge.to);
      if (fromNode === step.current && !visited.has(toNode)) {
        visited.add(toNode);
        queue.push({
          current: toNode,
          path: [...step.path, edge.to],
          effects: [...step.effects, ...(edge.effects ?? [])],
        });
      }
    }
  }

  // 4. Apply accumulated effects
  if (foundPath) {
    for (const effect of foundPath.effects) {
      applyEffectMutation(variables, effect);
    }
    return {
      variables,
      precedingScenes: foundPath.path.slice(0, -1),
    };
  }

  return { variables, precedingScenes: [] };
}

/**
 * Wrap a WebGAL scene script with pre-injected `setVar:` commands at the top
 * for in-memory live preview execution.
 */
export function wrapScriptWithEntryVariables(
  scriptSource: string,
  variables?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!variables || Object.keys(variables).length === 0) {
    return scriptSource;
  }

  const setVarCommands = Object.entries(variables)
    .filter(([, val]) => val != null)
    .map(([key, val]) => `setVar:${key}=${String(val)};`);

  if (setVarCommands.length === 0) {
    return scriptSource;
  }

  const header = [
    "; --- Ollaic Injected Entry State ---",
    ...setVarCommands,
    "; -----------------------------------",
    "",
  ].join("\n");

  return `${header}${scriptSource}`;
}
