/**
 * The admin console frame (#353, #392): navigation to the pages the caller's
 * platform grants open, and the tenant a tenant-scoped page is narrowed to
 * (chosen from the tenant list) with a way back to all tenants. Pages the
 * caller cannot open are not listed; the server refuses them anyway.
 */
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { ArrowLeft, ShieldCheck } from "@phosphor-icons/react";

import { ADMIN_PAGES, canOpenAdminPage, type AdminMe } from "../../lib/adminClient";
import { AppPage, AppPageInset } from "../AppPage";
import { Button } from "../ui/button";

export function AdminShell({
  me,
  tenantId,
  tenantScoped,
  onTenantChange,
  children,
}: {
  me: AdminMe;
  /** The tenant the current page shows; undefined for the platform-wide view. */
  tenantId?: string;
  /** Whether the current page has a tenant scope to switch. */
  tenantScoped: boolean;
  onTenantChange: (tenantId: string | undefined) => void;
  children: ReactNode;
}) {
  const pages = ADMIN_PAGES.filter((page) => canOpenAdminPage(me, page));
  return (
    <div className="min-h-screen bg-warm-page text-slate-950 dark:text-slate-50">
      <div className="sticky top-0 z-10 border-b border-warm-border bg-warm-surface/85 backdrop-blur">
        <AppPageInset width="wide" className="flex flex-wrap items-center gap-3 py-3">
          <Link to="/" aria-label="Back to home" className="text-stone-500 hover:text-slate-950 dark:hover:text-slate-50">
            <ArrowLeft size={20} />
          </Link>
          <ShieldCheck size={20} weight="duotone" className="text-red-500" />
          <h1 className="font-display text-xl font-semibold tracking-tight">Gateway admin</h1>
          <span className="text-xs text-stone-500">Platform admin</span>
          {tenantScoped && tenantId ? (
            <div className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-stone-500">Tenant</span>
              <code className="text-xs">{tenantId}</code>
              <Button size="sm" onClick={() => onTenantChange(undefined)}>
                All tenants
              </Button>
            </div>
          ) : null}
        </AppPageInset>
      </div>
      <AppPage width="wide" className="grid gap-6 md:grid-cols-[12rem_1fr]">
        <nav aria-label="Admin sections" className="flex flex-row flex-wrap gap-1 md:flex-col">
          {pages.map((page) => (
            <NavLink
              key={page.key}
              to={page.path}
              end={page.key === "overview"}
              className={({ isActive }) =>
                `rounded-lg px-3 py-1.5 text-sm ${isActive ? "app-interactive-selected font-semibold" : "text-stone-600 hover:bg-warm-muted/50 dark:text-stone-300"}`
              }
            >
              {page.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 space-y-8">{children}</div>
      </AppPage>
    </div>
  );
}
