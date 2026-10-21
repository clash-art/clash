import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminOverview } from "@clash/web-ui/components/admin/AdminOverview";
import { adminApi } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "overview");
  const { overview } = await loadAdminData(context, () => adminApi.overview(context.tenantId));
  const tenant = context.me.tenants.find((entry) => entry.tenantId === context.tenantId);
  return {
    me: context.me,
    page: context.page,
    tenantId: context.tenantId,
    overview,
    scopeLabel: context.tenantId ? `Tenant ${tenant?.name ?? context.tenantId}` : "All tenants",
  };
}

export default function AdminOverviewRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <AdminRouteFrame context={data}>
      <AdminOverview overview={data.overview} scopeLabel={data.scopeLabel} />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
