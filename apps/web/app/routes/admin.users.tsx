import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminAccounts, AdminMembers, AdminTenantList } from "@clash/web-ui/components/admin/AdminUsers";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "users");
  const { me, tenantId } = context;
  return loadAdminData(context, async () => {
    const [members, tenants, accounts] = await Promise.all([
      tenantId ? adminApi.members(tenantId).then((result) => result.members) : Promise.resolve(null),
      adminCan(me, "tenants.list") ? adminApi.tenants().then((result) => result.tenants) : Promise.resolve(null),
      adminCan(me, "admin_accounts.read") ? adminApi.adminAccounts().then((result) => result.accounts) : Promise.resolve(null),
    ]);
    return {
      me,
      page: context.page,
      tenantId,
      members,
      tenants,
      accounts,
      canWriteAdminAccounts: adminCan(me, "admin_accounts.write"),
    };
  });
}

export default function AdminUsersRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      {data.members ? <AdminMembers members={data.members} /> : null}
      {data.tenants ? <AdminTenantList tenants={data.tenants} basePath="/admin/users" /> : null}
      {data.accounts ? (
        <AdminAccounts
          accounts={data.accounts}
          currentAdminId={data.me.admin.id}
          canWrite={data.canWriteAdminAccounts}
          onChanged={refresh}
        />
      ) : null}
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
