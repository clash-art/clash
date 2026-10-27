import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { AdminUsage } from "@clash/web-ui/components/admin/AdminUsage";
import { adminApi, type UsageFilters } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage } from "../lib/adminRoute";
import { filtersFromSearch, searchFromFilters } from "../lib/adminFilters";

const USAGE_FILTERS = ["userId", "keyId", "modelCode", "kind", "status", "from", "to", "cursor"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "usage");
  const filters: UsageFilters = {
    ...filtersFromSearch(context.url.searchParams, USAGE_FILTERS),
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
  };
  const usage = await loadAdminData(context, () => adminApi.usage(filters));
  return { me: context.me, page: context.page, tenantId: context.tenantId, filters, usage };
}

export default function AdminUsageRoute() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  return (
    <AdminRouteFrame context={data}>
      <AdminUsage
        key={data.tenantId ?? "platform"}
        usage={data.usage}
        filters={data.filters}
        onFiltersChange={(filters) => setSearchParams(searchFromFilters(filters))}
        promptAccess={data.me.promptAccess}
      />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
