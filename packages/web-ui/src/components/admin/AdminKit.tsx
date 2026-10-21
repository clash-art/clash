/**
 * Shared pieces of the gateway admin console (#353): sections, tables, the
 * coded-error alert, labelled fields and the action hook every form uses.
 */
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { AdminApiError } from "../../lib/adminClient";
import { InlineAlert } from "../ui/feedback";
import { Input, type InputProps } from "../ui/input";

export function AdminSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
          {description ? <p className="text-sm text-stone-500 dark:text-stone-400">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function AdminCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-warm-border bg-warm-surface/80 p-4 shadow-sm ${className}`}>{children}</div>
  );
}

export interface AdminColumn<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
  align?: "left" | "right";
}

export function AdminTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  empty,
}: {
  label: string;
  columns: AdminColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty: string;
}) {
  if (rows.length === 0)
    return (
      <p className="rounded-xl border border-dashed border-warm-border px-4 py-6 text-center text-sm text-stone-500">
        {empty}
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-xl border border-warm-border bg-warm-surface/80">
      <table aria-label={label} className="w-full text-left text-sm">
        <thead className="border-b border-warm-border text-xs uppercase tracking-wide text-stone-500">
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" className={`px-3 py-2 font-medium ${column.align === "right" ? "text-right" : ""}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-warm-border">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="align-top">
              {columns.map((column) => (
                <td key={column.header} className={`px-3 py-2 ${column.align === "right" ? "text-right tabular-nums" : ""}`}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The server's coded refusal, shown verbatim so the operator sees what failed. */
export function AdminErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const coded = error instanceof AdminApiError ? error : null;
  return (
    <InlineAlert
      tone="error"
      title={coded ? coded.code : "Request failed"}
      message={error instanceof Error ? error.message : String(error)}
    />
  );
}

export function AdminField({ label, hint, ...props }: InputProps & { label: string; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
      <span>{label}</span>
      <Input controlSize="sm" aria-label={label} {...props} />
      {hint ? <span className="font-normal text-stone-500">{hint}</span> : null}
    </label>
  );
}

/**
 * Runs one admin action: tracks pending state, keeps the coded error for
 * display, and calls `onDone` (usually revalidation) only after success.
 */
export function useAdminAction(onDone?: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        await action();
        onDone?.();
        return true;
      } catch (caught) {
        setError(caught);
        return false;
      } finally {
        setPending(false);
      }
    },
    [onDone],
  );
  const submit = useCallback(
    (action: () => Promise<unknown>) => (event: FormEvent) => {
      event.preventDefault();
      void run(action);
    },
    [run],
  );
  return { pending, error, setError, run, submit };
}

export function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function StatusPill({ tone, children }: { tone: "ok" | "muted" | "warn"; children: ReactNode }) {
  const tones = {
    ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    muted: "bg-stone-500/10 text-stone-600 dark:text-stone-300",
    warn: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
