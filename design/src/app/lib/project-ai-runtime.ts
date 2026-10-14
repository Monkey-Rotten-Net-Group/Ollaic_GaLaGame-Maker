import { useMemo, useSyncExternalStore, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

interface Cell {
  value: unknown;
  read: () => unknown;
  subscribe: (listener: () => void) => () => void;
  write: Dispatch<SetStateAction<unknown>>;
}

interface ProjectRuntime {
  cells: Map<string, Cell>;
  refs: Map<string, MutableRefObject<unknown>>;
}

const projects = new Map<string, ProjectRuntime>();

function runtime(key: string): ProjectRuntime {
  let value = projects.get(key);
  if (!value) {
    value = { cells: new Map(), refs: new Map() };
    projects.set(key, value);
  }
  return value;
}

function stateCell(key: string, field: string, initial: unknown): Cell {
  const cells = runtime(key).cells;
  let cell = cells.get(field);
  if (!cell) {
    const listeners = new Set<() => void>();
    const created: Cell = {
      value: typeof initial === 'function' ? initial() : initial,
      read: () => created.value,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      write: (next) => {
        const value = typeof next === 'function' ? next(created.value) : next;
        if (Object.is(value, created.value)) return;
        created.value = value;
        for (const listener of [...listeners]) listener();
      },
    };
    cell = created;
    cells.set(field, cell);
  }
  return cell;
}

// Async runs keep writing to these cells when their page has no subscribers.
export function useProjectAiState<T>(key: string, field: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const cell = useMemo(() => stateCell(key, field, initial), [key, field, initial]);
  const value = useSyncExternalStore(cell.subscribe, cell.read, cell.read);
  return [value as T, cell.write as Dispatch<SetStateAction<T>>];
}

export function projectAiRef<T>(key: string, field: string, initial: T): MutableRefObject<T> {
  const refs = runtime(key).refs;
  let ref = refs.get(field);
  if (!ref) {
    ref = { current: initial };
    refs.set(field, ref);
  }
  return ref as MutableRefObject<T>;
}

export function clearProjectAiRuntime(): void {
  projects.clear();
}
