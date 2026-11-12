import type { StoryPlan } from "./pipeline-types";

export interface InferredEntryState {
  variables: Record<string, string>;
  precedingScenes: string[];
}

type EvalResult =
  | { ok: true; value: number }
  | { ok: false; reason: "invalid" | "div_zero" };

type ArithmeticToken =
  | { kind: "number"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" };

function tokenizeArithmetic(expr: string): ArithmeticToken[] | null {
  const tokens: ArithmeticToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (
      ch === "+" ||
      ch === "-" ||
      ch === "*" ||
      ch === "/" ||
      ch === "(" ||
      ch === ")"
    ) {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = expr.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!match) return null;
      const num = Number(match[0]);
      if (!Number.isFinite(num)) return null;
      tokens.push({ kind: "number", value: num });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      const match = expr.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_.]*/);
      if (!match) return null;
      tokens.push({ kind: "ident", value: match[0] });
      i += match[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

function evaluateNumericExpression(
  expr: string,
  variables: Record<string, string>,
  selfVarId: string,
): EvalResult {
  const tokens = tokenizeArithmetic(expr);
  if (!tokens || tokens.length === 0) return { ok: false, reason: "invalid" };
  let pos = 0;
  let divZero = false;

  const peek = (): ArithmeticToken | undefined => tokens[pos];
  const consume = (): ArithmeticToken | undefined => tokens[pos++];

  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === "+" || next.value === "-")) {
        consume();
        const right = parseTerm();
        if (right === null) return null;
        left = next.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.value === "*" || next.value === "/")) {
        consume();
        const right = parseFactor();
        if (right === null) return null;
        if (next.value === "/") {
          if (right === 0) {
            divZero = true;
            return null;
          }
          left = left / right;
        } else {
          left = left * right;
        }
      } else {
        break;
      }
    }
    return left;
  };

  const parseFactor = (): number | null => {
    const next = peek();
    if (!next) return null;
    if (next.kind === "op" && (next.value === "+" || next.value === "-")) {
      consume();
      const inner = parseFactor();
      if (inner === null) return null;
      return next.value === "-" ? -inner : inner;
    }
    if (next.kind === "op" && next.value === "(") {
      consume();
      const inner = parseExpr();
      if (inner === null) return null;
      const close = consume();
      if (close?.kind !== "op" || close.value !== ")") return null;
      return inner;
    }
    if (next.kind === "number") {
      consume();
      return next.value;
    }
    if (next.kind === "ident") {
      consume();
      if (next.value === "true" || next.value === "false") return null;
      if (Object.prototype.hasOwnProperty.call(variables, next.value)) {
        const raw = variables[next.value].trim();
        if (raw === "") return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
      }
      if (next.value === selfVarId) {
        return 0;
      }
      return null;
    }
    return null;
  };

  const result = parseExpr();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
    return { ok: false, reason: divZero ? "div_zero" : "invalid" };
  }
  return { ok: true, value: result };
}

/**
 * Apply a single WebGAL effect mutation safely to an in-memory variables dictionary.
 * Supported patterns:
 * - `var=val` or arithmetic expressions with `+`, `-`, `*`, `/`, and `(...)`
 * - `var+=expr`, `var-=expr`, `var*=expr`, `var/=expr`
 */
export function applyEffectMutation(
  variables: Record<string, string>,
  effect: string,
): void {
  const trimmed = effect.trim().replace(/;$/, "").trim();
  if (!trimmed) return;

  // Pattern: var+=expr, var-=expr, var*=expr, var/=expr
  const compoundMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*([+\-*/])=\s*(.+)$/);
  if (compoundMatch) {
    const [, varId, operator, rhsExpr] = compoundMatch;
    const rawCurrent = variables[varId];
    const current =
      rawCurrent === undefined || rawCurrent.trim() === ""
        ? 0
        : Number(rawCurrent.trim());
    const rhsResult = evaluateNumericExpression(rhsExpr, variables, varId);
    if (rhsResult.ok && Number.isFinite(current)) {
      if (operator === "/" && rhsResult.value === 0) return;
      const next =
        operator === "+"
          ? current + rhsResult.value
          : operator === "-"
            ? current - rhsResult.value
            : operator === "*"
              ? current * rhsResult.value
              : current / rhsResult.value;
      if (Number.isFinite(next)) {
        variables[varId] = String(next);
      }
      return;
    }
    if (!rhsResult.ok && rhsResult.reason === "div_zero") return;
    if (operator === "+" || operator === "-") {
      variables[varId] = rhsExpr.trim();
    }
    return;
  }

  // Pattern: var=expr
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx <= 0) return;

  const varId = trimmed.slice(0, eqIdx).trim();
  const expr = trimmed.slice(eqIdx + 1).trim();
  if (!varId || !expr || expr.startsWith("=")) return;

  const evalResult = evaluateNumericExpression(expr, variables, varId);
  if (evalResult.ok) {
    variables[varId] = String(evalResult.value);
    return;
  }
  if (evalResult.reason === "div_zero") return;

  // Direct non-numeric assignment: var=val
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
