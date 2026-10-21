import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminMembers, AdminPlatformAdmins, AdminTenantList } from "@clash/web-ui/components/admin/AdminUsers";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "users");
  const { me, tenantId } = context;
  return loadAdminData(context, async () => {
    const [members, tenants, admins] = await Promise.all([
      tenantId ? adminApi.members(tenantId).then((result) => result.members) : Promise.resolve(null),
      adminCan(me, "tenants.list") ? adminApi.tenants().then((result) => result.tenants) : Promise.resolve(null),
      adminCan(me, "platform_roles.read") ? adminApi.platformAdmins().then((result) => result.admins) : Promise.resolve(null),
    ]);
    return {
      me,
      page: context.page,
      tenantId,
      members,
      tenants,
      admins,
      canWriteRoles: tenantId ? adminCan(me, "roles.write", tenantId) : false,
      canWritePlatformRoles: adminCan(me, "platform_roles.write"),
    };
  });
}

export default function AdminUsersRoute() {
  const data = useLoaderData<typeof loader>();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      {data.tenantId && data.members ? (
        <AdminMembers tenantId={data.tenantId} members={data.members} canWriteRoles={data.canWriteRoles} onChanged={refresh} />
      ) : null}
      {data.tenants ? <AdminTenantList tenants={data.tenants} basePath="/admin/users" /> : null}
      {data.admins ? <AdminPlatformAdmins admins={data.admins} canWrite={data.canWritePlatformRoles} onChanged={refresh} /> : null}
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
