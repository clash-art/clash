// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError, type AdminMe } from "../../lib/adminClient";
import { chooseOption } from "../../test-support/admin";
import { AdminErrorAlert } from "./AdminKit";
import { AdminShell } from "./AdminShell";

afterEach(cleanup);

const tenantAdmin: AdminMe = {
  userId: "u1",
  platformRoles: [],
  platformPermissions: [],
  tenants: [
    {
      tenantId: "team:a",
      name: "Studio A",
      kind: "team",
      role: "admin",
      permissions: ["tenant.read", "usage.read", "budgets.read", "budgets.write", "keys.read", "limits.write", "members.read", "audit.read", "billing.read"],
    },
    { tenantId: "team:b", name: "Studio B", kind: "team", role: "viewer", permissions: ["tenant.read", "usage.read", "budgets.read", "members.read"] },
  ],
  promptAccess: false,
};

const navLabels = () =>
  Array.from(screen.getByRole("navigation", { name: "Admin sections" }).querySelectorAll("a"), (link) => link.textContent);

describe("AdminShell", () => {
  it("lists only the pages the caller can open; platform pages stay hidden from tenant roles", () => {
    render(
      <MemoryRouter>
        <AdminShell me={tenantAdmin} tenantId="team:a" tenantScoped onTenantChange={() => undefined}>
          <p>page</p>
        </AdminShell>
      </MemoryRouter>,
    );
    const labels = navLabels();
    expect(labels).toContain("Budgets & limits");
    for (const platformOnly of ["Models & prices", "Upstreams", "Packages", "Abuse"]) expect(labels).not.toContain(platformOnly);
    expect(screen.getByText("Tenant admin")).toBeInTheDocument();
  });

  it("switches tenants through the shared select, with an all-tenants scope for platform staff", () => {
    const onTenantChange = vi.fn();
    const staff: AdminMe = {
      ...tenantAdmin,
      platformRoles: ["platform_admin"],
      platformPermissions: ["usage.read_all", "catalog.read", "upstreams.read", "packages.read", "abuse.read"],
    };
    render(
      <MemoryRouter>
        <AdminShell me={staff} tenantId="team:a" tenantScoped onTenantChange={onTenantChange}>
          <p>page</p>
        </AdminShell>
      </MemoryRouter>,
    );
    expect(navLabels()).toEqual(expect.arrayContaining(["Models & prices", "Upstreams", "Packages", "Abuse"]));
    chooseOption("Tenant", "Studio B · viewer");
    expect(onTenantChange).toHaveBeenLastCalledWith("team:b");
    chooseOption("Tenant", "All tenants (platform)");
    expect(onTenantChange).toHaveBeenLastCalledWith(undefined);
  });

  it("has no tenant switcher on platform pages", () => {
    render(
      <MemoryRouter>
        <AdminShell me={tenantAdmin} tenantScoped={false} onTenantChange={() => undefined}>
          <p>page</p>
        </AdminShell>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("combobox", { name: "Tenant" })).toBeNull();
  });
});

describe("AdminErrorAlert", () => {
  it("shows the server's error code and message", () => {
    render(<AdminErrorAlert error={new AdminApiError(409, "GATEWAY_LAST_OWNER", "A tenant must keep at least one owner.")} />);
    expect(screen.getByText("GATEWAY_LAST_OWNER")).toBeInTheDocument();
    expect(screen.getByText("A tenant must keep at least one owner.")).toBeInTheDocument();
  });

  it("renders nothing without an error", () => {
    const { container } = render(<AdminErrorAlert error={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
