import { useSyncExternalStore } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { dismissToast, getToasts, subscribeToasts, type ToastTone } from '../lib/toast';

const TONE_ICON: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

/** Renders the shared toast queue. Mount once at the app root. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

  return (
    <section aria-label="通知" aria-live="polite" className="ollaic-toaster">
      {toasts.map((item) => {
        const Icon = TONE_ICON[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : undefined}
            className={`ollaic-toast ollaic-toast--${item.tone}`}
          >
            <Icon className="ollaic-toast__icon size-4" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="ollaic-toast__title">{item.title}</p>
              {item.description && <p className="ollaic-toast__description">{item.description}</p>}
            </div>
            <button
              type="button"
              className="ollaic-toast__close"
              aria-label="关闭通知"
              onClick={() => dismissToast(item.id)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
