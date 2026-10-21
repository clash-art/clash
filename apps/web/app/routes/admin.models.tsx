import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { AdminCatalog, AdminPrices } from "@clash/web-ui/components/admin/AdminCatalog";
import { adminApi, adminCan } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, AdminRouteFrame, loadAdminData, loadAdminPage, useAdminRefresh } from "../lib/adminRoute";

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await loadAdminPage(request, "models");
  const canReadPrices = adminCan(context.me, "prices.read");
  return loadAdminData(context, async () => {
    const [{ versions }, prices] = await Promise.all([
      adminApi.catalog(),
      canReadPrices ? adminApi.prices().then((result) => result.versions) : Promise.resolve(null),
    ]);
    const requested = context.url.searchParams.get("version");
    const chosen =
      versions.find((entry) => entry.version === requested)?.version ??
      versions.find((entry) => entry.live)?.version ??
      versions[0]?.version;
    const selected = chosen ? (await adminApi.catalogVersion(chosen)).version : null;
    return {
      me: context.me,
      page: context.page,
      tenantId: context.tenantId,
      versions,
      selected,
      prices,
      canWriteCatalog: adminCan(context.me, "catalog.write"),
      canWritePrices: adminCan(context.me, "prices.write"),
    };
  });
}

export default function AdminModelsRoute() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const refresh = useAdminRefresh();
  return (
    <AdminRouteFrame context={data}>
      <AdminCatalog
        versions={data.versions}
        selected={data.selected}
        canWrite={data.canWriteCatalog}
        onSelect={(version) => setSearchParams({ version })}
        onChanged={refresh}
      />
      {data.prices ? <AdminPrices versions={data.prices} canWrite={data.canWritePrices} onChanged={refresh} /> : null}
    </AdminRouteFrame>
  );
}

export const ErrorBoundary = AdminRouteErrorBoundary;
