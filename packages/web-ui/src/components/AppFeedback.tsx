import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Button } from './ui/button';
import { InlineAlert, ToastViewport, type FeedbackTone } from './ui/feedback';
import { IconButton } from './ui/icon-button';

type FeedbackVariant = FeedbackTone;

interface FeedbackInput {
  title: string;
  message?: string;
  variant?: FeedbackVariant;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  /** Let an accepted toast visually promote into desktop chrome state. */
  exitToDesktopChrome?: boolean;
}

interface FeedbackToast extends Required<FeedbackInput> {
  id: string;
  expiresAt: number | null;
  remainingMs: number | null;
}

interface AppFeedbackContextValue {
  notify(input: FeedbackInput): void;
}

const noopFeedback: AppFeedbackContextValue = {
  notify: () => undefined,
};

const AppFeedbackContext = createContext<AppFeedbackContextValue>(noopFeedback);

const APP_FEEDBACK_EVENT = 'clash:app-feedback';

/**
 * Composition roots and non-React callbacks use this to reach the same toast
 * viewport. The provider owns the presentation; this only carries the input.
 */
export function emitAppFeedback(input: FeedbackInput): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<FeedbackInput>(APP_FEEDBACK_EVENT, { detail: input }),
  );
}

const TOAST_DURATION_MS = 5_000;
const WARNING_TOAST_DURATION_MS = 7_000;

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  return matches;
}

function normalizedFeedback(input: FeedbackInput): Required<FeedbackInput> {
  return {
    title: input.title,
    message: input.message ?? '',
    variant: input.variant ?? 'info',
    actionLabel: input.actionLabel ?? '',
    onAction: input.onAction ?? (() => undefined),
    actionHref: input.actionHref ?? '',
    exitToDesktopChrome: input.exitToDesktopChrome ?? false,
  };
}

function toastDuration(input: Required<FeedbackInput>): number | null {
  if (input.variant === 'error' || input.actionLabel) return null;
  if (input.variant === 'warning') return WARNING_TOAST_DURATION_MS;
  return TOAST_DURATION_MS;
}

export function AppFeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<FeedbackToast[]>([]);
  const shouldReduceMotion = usePrefersReducedMotion();

  const notify = useCallback((input: FeedbackInput) => {
    const normalized = normalizedFeedback(input);
    const duration = toastDuration(normalized);
    const item: FeedbackToast = {
      ...normalized,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      expiresAt: duration === null ? null : Date.now() + duration,
      remainingMs: duration,
    };
    setToasts((prev) => [item, ...prev].slice(0, 4));
  }, []);

  useEffect(() => {
    const handleFeedback = (event: Event) => {
      const detail = (event as CustomEvent<FeedbackInput>).detail;
      if (detail && typeof detail.title === 'string') notify(detail);
    };
    window.addEventListener(APP_FEEDBACK_EVENT, handleFeedback);
    return () => window.removeEventListener(APP_FEEDBACK_EVENT, handleFeedback);
  }, [notify]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((toast) => toast.expiresAt === null || now < toast.expiresAt));
    }, 500);
    return () => window.clearInterval(timer);
  }, [toasts.length]);

  const value = useMemo(() => ({ notify }), [notify]);

  const pauseToast = useCallback((id: string) => {
    const now = Date.now();
    setToasts((prev) => prev.map((toast) => {
      if (toast.id !== id || toast.expiresAt === null) return toast;
      return {
        ...toast,
        expiresAt: null,
        remainingMs: Math.max(0, toast.expiresAt - now),
      };
    }));
  }, []);

  const resumeToast = useCallback((id: string) => {
    const now = Date.now();
    setToasts((prev) => prev.map((toast) => {
      if (toast.id !== id || toast.remainingMs === null || toast.variant === 'error' || toast.actionLabel) return toast;
      return { ...toast, expiresAt: now + toast.remainingMs };
    }));
  }, []);

  return (
    <AppFeedbackContext.Provider value={value}>
      {children}
      <ToastViewport>
        <AnimatePresence mode="popLayout">
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={shouldReduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={shouldReduceMotion
                ? { opacity: 0 }
                : toast.exitToDesktopChrome
                  ? { opacity: 0, y: 'calc(-100vh + 3.25rem)', scale: 0.3 }
                  : { opacity: 0, x: 12, scale: 0.98 }}
              transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="w-full"
            >
              <InlineAlert
                tone={toast.variant}
                density="toast"
                title={toast.title}
                message={toast.message}
                onMouseEnter={() => pauseToast(toast.id)}
                onMouseLeave={() => resumeToast(toast.id)}
                onFocusCapture={() => pauseToast(toast.id)}
                onBlurCapture={() => resumeToast(toast.id)}
                action={(
                  <span className="flex items-start gap-1">
                    {toast.actionLabel ? (
                  toast.actionHref ? (
                    <Link
                      to={toast.actionHref}
                      onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
                      className="inline-flex rounded-lg px-2.5 py-1 text-xs font-semibold opacity-90 transition-colors hover:bg-black/5 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      {toast.actionLabel}
                    </Link>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => {
                        toast.onAction();
                        setToasts((prev) => prev.filter((item) => item.id !== toast.id));
                      }}
                      className="min-h-0 border-0 bg-transparent px-2.5 py-1 text-xs font-semibold text-current opacity-90 shadow-none hover:bg-black/5 hover:opacity-100"
                    >
                      {toast.actionLabel}
                    </Button>
                  )
                    ) : null}
                    <IconButton
                      label="Dismiss notification"
                      icon={<X className="h-3.5 w-3.5" weight="bold" />}
                      size="sm"
                      onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
                      className="shrink-0 text-current opacity-60 hover:bg-black/5 hover:text-current hover:opacity-100"
                    />
                  </span>
                )}
                className="pointer-events-auto w-full"
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </ToastViewport>
    </AppFeedbackContext.Provider>
  );
}

export function useAppFeedback(): AppFeedbackContextValue {
  return useContext(AppFeedbackContext);
}

export type { FeedbackInput, FeedbackVariant };
