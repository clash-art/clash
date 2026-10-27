import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminReconciliation } from "@clash/web-ui/components/admin/AdminReconciliation";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "reconciliation");
  const [{ runs }, { reports }] = await loadAdminData(context, () =>
    Promise.all([adminApi.reconcileRuns(), adminApi.reconcileReports()]),
  );
  return {
    me: context.me,
    page: context.page,
    tenantId: context.tenantId,
    runs,
    reports,
    canWrite: adminCan(context.me, "reconciliation.write"),
  };
}

export default function AdminReconciliationRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      <AdminReconciliation runs={data.runs} reports={data.reports} canWrite={data.canWrite} onChanged={refresh} />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
