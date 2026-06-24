/**
 * Node-level diff between two scene node lists, for the AI change preview.
 *
 * afterNodes are re-parsed from patched text, so their ids don't line up with
 * beforeNodes — we match on a semantic fingerprint via LCS (same algorithm as
 * createLineDiff in story-agent.ts), then collapse adjacent removed+added of
 * the same type into a single "modified" entry.
 */

import type { WebGalNode } from './webgal-types';

export interface NodeDiffEntry {
  kind: 'added' | 'removed' | 'modified' | 'context';
  before?: WebGalNode;
  after?: WebGalNode;
}

/** Stable semantic key for matching nodes across a re-parse. */
function nodeFingerprint(n: WebGalNode): string {
  return [
    n.type,
    n.character ?? '',
    n.content ?? '',
    n.asset ?? '',
    n.figurePosition ?? '',
    n.figureId ?? '',
    n.figureCharacter ?? '',
    n.figureEmotion ?? '',
    n.next ? 'next' : '',
    n.when ?? '',
    n.targetScene ?? '',
    n.labelName ?? '',
    n.varName ?? '',
    n.varValue ?? '',
    (n.choices ?? []).map((c) => `${c.text}>${c.target ?? ''}`).join('|'),
    (n.flags ?? []).map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join(','),
  ].join('');
}

function lcsDiff(before: WebGalNode[], after: WebGalNode[]): NodeDiffEntry[] {
  const bKeys = before.map(nodeFingerprint);
  const aKeys = after.map(nodeFingerprint);
  const table: number[][] = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = bKeys[i] === aKeys[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: NodeDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (bKeys[i] === aKeys[j]) {
      out.push({ kind: 'context', before: before[i], after: after[j] });
      i += 1; j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'removed', before: before[i] });
      i += 1;
    } else {
      out.push({ kind: 'added', after: after[j] });
      j += 1;
    }
  }
  while (i < before.length) { out.push({ kind: 'removed', before: before[i] }); i += 1; }
  while (j < after.length) { out.push({ kind: 'added', after: after[j] }); j += 1; }
  return out;
}

/** Collapse adjacent removed+added (or added+removed) of the same type into modified. */
function collapseModified(entries: NodeDiffEntry[]): NodeDiffEntry[] {
  const out: NodeDiffEntry[] = [];
  for (let k = 0; k < entries.length; k += 1) {
    const cur = entries[k];
    const next = entries[k + 1];
    if (
      next &&
      ((cur.kind === 'removed' && next.kind === 'added') || (cur.kind === 'added' && next.kind === 'removed'))
    ) {
      const removed = cur.kind === 'removed' ? cur.before : next.before;
      const added = cur.kind === 'added' ? cur.after : next.after;
      if (removed && added && removed.type === added.type) {
        out.push({ kind: 'modified', before: removed, after: added });
        k += 1; // consume the pair
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

/** Full ordered diff sequence (context + added + removed + modified), unfiltered. */
export function computeFullNodeDiff(before: WebGalNode[], after: WebGalNode[]): NodeDiffEntry[] {
  return collapseModified(lcsDiff(before, after));
}

/**
 * Returns only the changed entries (added/removed/modified) plus one context
 * node of padding around each change for orientation. Empty when identical.
 */
export function computeNodeDiff(before: WebGalNode[], after: WebGalNode[]): NodeDiffEntry[] {
  const full = computeFullNodeDiff(before, after);
  if (!full.some((e) => e.kind !== 'context')) return [];

  const keep = new Set<number>();
  full.forEach((e, idx) => {
    if (e.kind === 'context') return;
    for (let k = Math.max(0, idx - 1); k <= Math.min(full.length - 1, idx + 1); k += 1) keep.add(k);
  });
  return full.filter((_, idx) => keep.has(idx));
}

/** Counts for the summary badge (+added ✏modified -removed). */
export function summarizeNodeDiff(entries: NodeDiffEntry[]): { added: number; removed: number; modified: number } {
  return {
    added: entries.filter((e) => e.kind === 'added').length,
    removed: entries.filter((e) => e.kind === 'removed').length,
    modified: entries.filter((e) => e.kind === 'modified').length,
  };
}
