// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError, type AdminMe } from "../../lib/adminClient";
import { AdminErrorAlert } from "./AdminKit";
import { AdminShell } from "./AdminShell";

afterEach(cleanup);

const staff: AdminMe = {
  userId: "u1",
  platformRoles: ["platform_admin"],
  platformPermissions: ["usage.read_all", "catalog.read", "upstreams.read", "packages.read", "abuse.read", "tenants.list"],
  promptAccess: false,
};

const navLabels = () =>
  Array.from(screen.getByRole("navigation", { name: "Admin sections" }).querySelectorAll("a"), (link) => link.textContent);

describe("AdminShell", () => {
  it("lists only the pages the caller's platform grants open", () => {
    render(
      <MemoryRouter>
        <AdminShell me={{ ...staff, platformPermissions: ["tenants.list"] }} tenantScoped={false} onTenantChange={() => undefined}>
          <p>page</p>
        </AdminShell>
      </MemoryRouter>,
    );
    expect(navLabels()).toEqual(["Users & teams", "Budgets & limits"]);
  });

  it("shows the tenant a scoped page is narrowed to, with a way back to all tenants", () => {
    const onTenantChange = vi.fn();
    render(
      <MemoryRouter>
        <AdminShell me={staff} tenantId="team:a" tenantScoped onTenantChange={onTenantChange}>
          <p>page</p>
        </AdminShell>
      </MemoryRouter>,
    );
    expect(navLabels()).toEqual(expect.arrayContaining(["Models & prices", "Upstreams", "Packages", "Abuse"]));
    expect(screen.getByText("team:a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All tenants" }));
    expect(onTenantChange).toHaveBeenLastCalledWith(undefined);
  });

  it("has no tenant scope on platform pages or the all-tenants view", () => {
    for (const props of [{ tenantId: "team:a", tenantScoped: false }, { tenantScoped: true }]) {
      render(
        <MemoryRouter>
          <AdminShell me={staff} {...props} onTenantChange={() => undefined}>
            <p>page</p>
          </AdminShell>
        </MemoryRouter>,
      );
      expect(screen.queryByRole("button", { name: "All tenants" })).toBeNull();
      cleanup();
    }
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
