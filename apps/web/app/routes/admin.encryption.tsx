import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminEncryption } from "@clash/web-ui/components/admin/AdminEncryption";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "encryption");
  const ring = await loadAdminData(context, () => adminApi.encryption());
  return {
    me: context.me,
    page: context.page,
    tenantId: context.tenantId,
    ring,
    canRotate: adminCan(context.me, "encryption.rotate"),
  };
}

export default function AdminEncryptionRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      <AdminEncryption ring={data.ring} canRotate={data.canRotate} onChanged={refresh} />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
