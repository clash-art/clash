import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminBudgets } from "@clash/web-ui/components/admin/AdminBudgets";
import { AdminTenantList } from "@clash/web-ui/components/admin/AdminUsers";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "budgets");
  const { me, tenantId } = context;
  return loadAdminData(context, async () => {
    // Platform staff without a chosen tenant pick one from the tenant list.
    if (!tenantId) {
      const { tenants } = await adminApi.tenants();
      return { me, page: context.page, tenantId, tenants, tenant: null };
    }
    const [budgets, keys, members] = await Promise.all([
      adminApi.budgets(tenantId),
      adminCan(me, "keys.read", tenantId) ? adminApi.keys(tenantId).then((result) => result.keys) : Promise.resolve([]),
      adminCan(me, "members.read", tenantId) ? adminApi.members(tenantId).then((result) => result.members) : Promise.resolve([]),
    ]);
    return {
      me,
      page: context.page,
      tenantId,
      tenants: null,
      tenant: {
        id: tenantId,
        ...budgets,
        keys,
        members,
        can: {
          budgetsWrite: adminCan(me, "budgets.write", tenantId),
          limitsWrite: adminCan(me, "limits.write", tenantId),
          walletAdjust: adminCan(me, "wallet.adjust"),
          subscriptionLimits: adminCan(me, "subscription.limits.write"),
        },
      },
    };
  });
}

export default function AdminBudgetsRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  const tenant = data.tenant;
  return (
    <AdminRouteFrame context={data}>
      {tenant ? (
        <AdminBudgets
          key={tenant.id}
          tenantId={tenant.id}
          wallet={tenant.wallet}
          budgets={tenant.budgets}
          subscription={tenant.subscription}
          keys={tenant.keys}
          members={tenant.members}
          can={tenant.can}
          onChanged={refresh}
        />
      ) : null}
      {data.tenants ? <AdminTenantList tenants={data.tenants} basePath="/admin/budgets" /> : null}
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
