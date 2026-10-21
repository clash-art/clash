import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminUpstreams } from "@clash/web-ui/components/admin/AdminUpstreams";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "upstreams");
  const { upstreams } = await loadAdminData(context, () => adminApi.upstreams());
  return {
    me: context.me,
    page: context.page,
    tenantId: context.tenantId,
    upstreams,
    canWrite: adminCan(context.me, "upstreams.write"),
  };
}

export default function AdminUpstreamsRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      <AdminUpstreams upstreams={data.upstreams} canWrite={data.canWrite} onChanged={refresh} />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
