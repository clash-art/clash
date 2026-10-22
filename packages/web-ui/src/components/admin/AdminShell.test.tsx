// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError, type AdminMe } from "../../lib/adminClient";
import { stubAdminFetch } from "../../test-support/admin";
import { AdminErrorAlert } from "./AdminKit";
import { AdminLogin } from "./AdminLogin";
import { AdminShell } from "./AdminShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const staff: AdminMe = {
  admin: { id: "adm_1", email: "ops@admin.test", name: "Ops", role: "platform_admin" },
  permissions: ["usage.read_all", "catalog.read", "upstreams.read", "packages.read", "abuse.read", "tenants.list"],
  promptAccess: false,
};

const navLabels = () =>
  Array.from(screen.getByRole("navigation", { name: "Admin sections" }).querySelectorAll("a"), (link) => link.textContent);

describe("AdminShell", () => {
  it("lists only the pages the admin account's role opens", () => {
    render(
      <MemoryRouter>
        <AdminShell me={{ ...staff, permissions: ["tenants.list"] }} tenantScoped={false} onTenantChange={() => undefined}>
          <p>page</p>
        </AdminShell>
      </MemoryRouter>,
    );
    expect(navLabels()).toEqual(["Users & teams", "Budgets & limits"]);
  });

  it("shows the signed-in admin account and signs out through the admin auth, then opens the admin sign-in", async () => {
    const calls = stubAdminFetch(() => Response.json({ success: true }));
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route
            path="/admin"
            element={
              <AdminShell me={staff} tenantScoped={false} onTenantChange={() => undefined}>
                <p>page</p>
              </AdminShell>
            }
          />
          <Route path="/admin/login" element={<p>admin sign-in</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("ops@admin.test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("admin sign-in")).toBeInTheDocument();
    // The admin session only: never the product /api/better-auth sign-out.
    expect(calls).toEqual([{ method: "POST", path: "/api/admin-auth/sign-out", body: {} }]);
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

describe("AdminLogin", () => {
  const signIn = (email: string, password: string) => {
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
    fireEvent.submit(screen.getByRole("form", { name: "Admin sign-in" }));
  };

  it("signs in through the admin auth endpoint and reports success", async () => {
    const calls = stubAdminFetch(() => Response.json({ redirect: false, token: "t" }));
    const onSignedIn = vi.fn();
    render(<AdminLogin onSignedIn={onSignedIn} />);
    signIn(" ops@admin.test ", "a-long-password-1");
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([
      { method: "POST", path: "/api/admin-auth/sign-in/email", body: { email: "ops@admin.test", password: "a-long-password-1" } },
    ]);
  });

  it("shows the coded refusal and stays on the form", async () => {
    for (const [response, code] of [
      [Response.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, { status: 401 }), "INVALID_EMAIL_OR_PASSWORD"],
      [Response.json({ code: "ADMIN_ACCOUNT_DISABLED", message: "This admin account is disabled." }, { status: 403 }), "ADMIN_ACCOUNT_DISABLED"],
      [Response.json({ message: "Too many requests. Please try again later." }, { status: 429 }), "HTTP_429"],
    ] as const) {
      stubAdminFetch(() => response);
      const onSignedIn = vi.fn();
      render(<AdminLogin onSignedIn={onSignedIn} />);
      signIn("ops@admin.test", "wrong-password-1");
      expect(await screen.findByText(code)).toBeInTheDocument();
      expect(onSignedIn).not.toHaveBeenCalled();
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
