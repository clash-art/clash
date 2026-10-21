import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { AdminAudit } from "@clash/web-ui/components/admin/AdminAudit";
import { adminApi, type AuditFilters } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage } from "../lib/adminRoute";
import { filtersFromSearch, searchFromFilters } from "../lib/adminFilters";

const AUDIT_FILTERS = ["actorUserId", "action", "targetType", "targetId"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "audit");
  const filters: AuditFilters = {
    ...filtersFromSearch(context.url.searchParams, AUDIT_FILTERS),
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
  };
  const { entries } = await loadAdminData(context, () => adminApi.audit(filters));
  return { me: context.me, page: context.page, tenantId: context.tenantId, filters, entries };
}

export default function AdminAuditRoute() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  return (
    <AdminRouteFrame context={data}>
      <AdminAudit
        key={data.tenantId ?? "platform"}
        entries={data.entries}
        filters={data.filters}
        onFiltersChange={(filters) => setSearchParams(searchFromFilters(filters))}
      />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
