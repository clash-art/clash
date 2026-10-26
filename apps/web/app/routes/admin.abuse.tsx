import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminAbuse } from "@clash/web-ui/components/admin/AdminAbuse";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "abuse");
  const { abuse } = await loadAdminData(context, () => adminApi.abuse());
  return {
    me: context.me,
    page: context.page,
    tenantId: context.tenantId,
    abuse,
    can: { suspend: adminCan(context.me, "abuse.suspend"), thresholds: adminCan(context.me, "abuse.thresholds.write") },
  };
}

export default function AdminAbuseRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      <AdminAbuse abuse={data.abuse} can={data.can} onChanged={refresh} />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
