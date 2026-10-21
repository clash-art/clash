/**
 * The admin console frame (#353): navigation to the pages the caller can open
 * and the tenant switcher for tenant-scoped pages. Pages the caller cannot
 * open are not listed; the server refuses them anyway.
 */
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { ArrowLeft, ShieldCheck } from "@phosphor-icons/react";

import { ADMIN_PAGES, canOpenAdminPage, type AdminMe } from "../../lib/adminClient";
import { AppPage, AppPageInset } from "../AppPage";
import { SelectMenu } from "../ui/select";

export const PLATFORM_SCOPE = "__platform__";

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
  const platform = me.platformRoles.includes("platform_admin");
  const options = [
    ...(platform ? [{ value: PLATFORM_SCOPE, label: "All tenants (platform)" }] : []),
    ...me.tenants.map((tenant) => ({ value: tenant.tenantId, label: `${tenant.name} · ${tenant.role}` })),
    // A tenant opened from the platform tenant list need not be one of the caller's own.
    ...(tenantId && !me.tenants.some((tenant) => tenant.tenantId === tenantId) ? [{ value: tenantId, label: tenantId }] : []),
  ];
  return (
    <div className="min-h-screen bg-warm-page text-slate-950 dark:text-slate-50">
      <div className="sticky top-0 z-10 border-b border-warm-border bg-warm-surface/85 backdrop-blur">
        <AppPageInset width="wide" className="flex flex-wrap items-center gap-3 py-3">
          <Link to="/" aria-label="Back to home" className="text-stone-500 hover:text-slate-950 dark:hover:text-slate-50">
            <ArrowLeft size={20} />
          </Link>
          <ShieldCheck size={20} weight="duotone" className="text-red-500" />
          <h1 className="font-display text-xl font-semibold tracking-tight">Gateway admin</h1>
          <span className="text-xs text-stone-500">{platform ? "Platform admin" : "Tenant admin"}</span>
          {tenantScoped && options.length > 0 ? (
            <div className="ml-auto w-64">
              <SelectMenu
                ariaLabel="Tenant"
                variant="field"
                size="sm"
                value={tenantId ?? PLATFORM_SCOPE}
                options={options}
                onValueChange={(value) => onTenantChange(value === PLATFORM_SCOPE ? undefined : value)}
              />
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
