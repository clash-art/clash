import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminPackages } from "@clash/web-ui/components/admin/AdminPackages";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "packages");
  const [{ packages }, { packs }] = await loadAdminData(context, () =>
    Promise.all([adminApi.packages(), adminApi.topupPacks()]),
  );
  return {
    me: context.me,
    page: context.page,
    tenantId: context.tenantId,
    packages,
    packs,
    canWrite: adminCan(context.me, "packages.write"),
    canRollover: adminCan(context.me, "billing.rollover"),
  };
}

export default function AdminPackagesRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      <AdminPackages
        packages={data.packages}
        packs={data.packs}
        canWrite={data.canWrite}
        canRollover={data.canRollover}
        onChanged={refresh}
      />
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
