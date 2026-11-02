/**
 * Minimal app-wide notification store. Framework-free so any handler can call
 * `toast.error(...)`; <Toaster /> (mounted once in App) renders the queue.
 */
export type ToastTone = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastOptions {
  description?: string;
  /** Milliseconds before auto-dismiss. Errors stay until dismissed unless set. */
  duration?: number;
}

const DEFAULT_DURATION_MS: Record<ToastTone, number | null> = {
  success: 3000,
  info: 4000,
  error: null,
};
const MAX_VISIBLE = 4;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

function push(tone: ToastTone, title: string, options: ToastOptions = {}): number {
  const id = nextId++;
  items = [...items, { id, tone, title, description: options.description }].slice(-MAX_VISIBLE);
  const duration = options.duration ?? DEFAULT_DURATION_MS[tone];
  if (duration !== null) timers.set(id, setTimeout(() => dismissToast(id), duration));
  emit();
  return id;
}

export const toast = {
  success: (title: string, options?: ToastOptions) => push('success', title, options),
  error: (title: string, options?: ToastOptions) => push('error', title, options),
  info: (title: string, options?: ToastOptions) => push('info', title, options),
};

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): ToastItem[] {
  return items;
}

/** Turns an unknown thrown value into readable text for a toast description. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
