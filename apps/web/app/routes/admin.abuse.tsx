import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminAbuse } from "@clash/web-ui/components/admin/AdminAbuse";
import { adminApi } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "abuse");
  const { abuse } = await loadAdminData(context, () => adminApi.abuse());
  return { me: context.me, page: context.page, tenantId: context.tenantId, abuse };
}

export default function AdminAbuseRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <AdminRouteFrame context={data}>
      <AdminAbuse abuse={data.abuse} />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
