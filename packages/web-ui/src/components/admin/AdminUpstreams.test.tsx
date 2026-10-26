// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpstreamAccount } from "../../lib/adminClient";
import { chooseOption, gatewayError, stubAdminFetch } from "../../test-support/admin";
import { AdminUpstreams } from "./AdminUpstreams";
import { RateLimitForm } from "./RateLimitForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const account: UpstreamAccount = {
  id: "gwu_1",
  providerId: "official",
  upstreamId: "openai",
  apiShape: "openai-compatible",
  region: "us",
  label: "primary",
  enabled: true,
  priority: 1,
  weight: null,
  rateLimit: null,
  credential: { kind: "sealed", secretRef: null, fields: ["apiKey"], keyVersion: "v1", keyPrefix: "sk-live", rotatedAt: null },
  draining: null,
  nextKeyVersion: "v2",
  health: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

/** v3 is active while v2 drains; v1 was revoked, so the next rotation adds v4. */
const rotating: UpstreamAccount = {
  ...account,
  credential: { kind: "secret_ref", secretRef: "GATEWAY_UPSTREAM_OPENAI", fields: ["apiKey"], keyVersion: "v3", keyPrefix: null, secretPresent: false, rotatedAt: "2026-10-02T00:00:00.000Z" },
  draining: { kind: "sealed", secretRef: null, fields: ["apiKey"], keyVersion: "v2", keyPrefix: "sk-live", since: "2026-10-02T00:00:00.000Z" },
  nextKeyVersion: "v4",
  health: {
    state: "open",
    consecutiveFailures: 5,
    openUntil: "2026-10-02T00:00:30.000Z",
    lastFailureCode: "GATEWAY_UPSTREAM_ERROR",
    lastFailureAt: "2026-10-02T00:00:00.000Z",
    lastSuccessAt: null,
  },
};

const type = (form: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });

describe("AdminUpstreams", () => {
  it("shows credential metadata only, and no controls without upstreams.write", () => {
    render(<AdminUpstreams upstreams={[account]} canWrite={false} onChanged={() => undefined} />);
    expect(screen.getByText(/^sealed apiKey · v1 · sk-live…$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate key" })).toBeNull();
    expect(screen.queryByRole("form", { name: "New upstream account" })).toBeNull();
  });

  it("sends a new API key once and clears it from the form after the request", async () => {
    const calls = stubAdminFetch(() => Response.json({ upstream: account }, { status: 201 }));
    const onChanged = vi.fn();
    render(<AdminUpstreams upstreams={[]} canWrite onChanged={onChanged} />);
    const form = screen.getByRole("form", { name: "New upstream account" });
    type(form, "Upstream id", "openai");
    type(form, "API key", "sk-live-secret-value");
    fireEvent.submit(form);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/admin/gateway/upstreams",
        body: { providerId: "official", upstreamId: "openai", priority: null, weight: null, credential: { apiKey: "sk-live-secret-value" } },
      },
    ]);
    expect(within(form).getByLabelText("API key")).toHaveValue("");
  });

  it("references a Worker secret by name and shows a refused rotation's coded error, still clearing the field", async () => {
    stubAdminFetch(() => gatewayError(503, "GATEWAY_ENCRYPTION_KEY_MISSING", "The gateway credential encryption key is not configured."));
    render(<AdminUpstreams upstreams={[account]} canWrite onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    const form = screen.getByRole("form", { name: "Rotate primary" });
    type(form, "API key", "sk-next-secret-value");
    fireEvent.submit(form);
    expect(await within(form.parentElement!).findByText("GATEWAY_ENCRYPTION_KEY_MISSING")).toBeInTheDocument();
    expect(within(form).getByLabelText("API key")).toHaveValue("");

    const calls = stubAdminFetch(() => Response.json({ upstream: account }));
    chooseOption("Credential kind", "Worker secret name", form);
    type(form, "Secret name", "GATEWAY_UPSTREAM_OPENAI");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/admin/gateway/upstreams/gwu_1/rotate",
      body: { credential: { secretRef: "GATEWAY_UPSTREAM_OPENAI" } },
    });
  });

  it("shows the draining version, an unbound secret and an open circuit, with no revoke controls without upstreams.write", () => {
    render(<AdminUpstreams upstreams={[rotating]} canWrite={false} onChanged={() => undefined} />);
    expect(screen.getByText(/secret GATEWAY_UPSTREAM_OPENAI · v3/)).toBeInTheDocument();
    expect(screen.getByText("unbound")).toBeInTheDocument();
    expect(screen.getByText(/sealed apiKey · v2 · sk-live…/)).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("5 failed · GATEWAY_UPSTREAM_ERROR")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke v2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Roll back to v2" })).toBeNull();
  });

  it("offers revoke only while a version drains", () => {
    render(<AdminUpstreams upstreams={[account]} canWrite onChanged={() => undefined} />);
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Revoke / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Roll back/ })).toBeNull();
  });

  it("rotates to the server's next version, revoking the previous ones at once when asked", async () => {
    const calls = stubAdminFetch(() => Response.json({ upstream: rotating }));
    const onChanged = vi.fn();
    render(<AdminUpstreams upstreams={[rotating]} canWrite onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    const form = screen.getByRole("form", { name: "Rotate primary" });
    expect(within(form).getByRole("button", { name: "Rotate to v4" })).toBeInTheDocument();
    type(form, "Secret name", "GATEWAY_UPSTREAM_OPENAI_NEXT");
    type(form, "Reason", "leaked");
    fireEvent.click(within(form).getByRole("checkbox", { name: "Revoke previous versions now" }));
    fireEvent.submit(form);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/admin/gateway/upstreams/gwu_1/rotate",
        body: { credential: { secretRef: "GATEWAY_UPSTREAM_OPENAI_NEXT" }, drain: false, reason: "leaked" },
      },
    ]);
  });

  it("revokes the draining version, or the active one to roll back, with the reason", async () => {
    const calls = stubAdminFetch(() => Response.json({ upstream: account }));
    const onChanged = vi.fn();
    render(<AdminUpstreams upstreams={[rotating]} canWrite onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke v2" }));
    const drained = screen.getByRole("form", { name: "Revoke v2 of primary" });
    type(drained, "Reason", "drained");
    fireEvent.submit(drained);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Roll back to v2" }));
    const rollback = screen.getByRole("form", { name: "Revoke v3 of primary" });
    expect(within(rollback).getByText("Revoke v3 and serve v2 again.")).toBeInTheDocument();
    fireEvent.submit(rollback);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/admin/gateway/upstreams/gwu_1/revoke", body: { keyVersion: "v2", reason: "drained" } },
      { method: "POST", path: "/api/v1/admin/gateway/upstreams/gwu_1/revoke", body: { keyVersion: "v3" } },
    ]);
  });

  it("shows a refused revoke's coded error", async () => {
    stubAdminFetch(() => gatewayError(409, "GATEWAY_UPSTREAM_LAST_KEY", "The upstream account's only key cannot be revoked."));
    render(<AdminUpstreams upstreams={[rotating]} canWrite onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke v2" }));
    const form = screen.getByRole("form", { name: "Revoke v2 of primary" });
    fireEvent.submit(form);
    expect(await within(form.parentElement!).findByText("GATEWAY_UPSTREAM_LAST_KEY")).toBeInTheDocument();
  });

  it("disables an account through PATCH", async () => {
    const calls = stubAdminFetch(() => Response.json({ upstream: { ...account, enabled: false } }));
    render(<AdminUpstreams upstreams={[account]} canWrite onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/v1/admin/gateway/upstreams/gwu_1", body: { enabled: false } });
  });
});

describe("RateLimitForm", () => {
  it("refuses a non-integer limit before calling the server", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<RateLimitForm label="Key limit" value={null} onSave={onSave} />);
    const form = screen.getByRole("form", { name: "Key limit" });
    type(form, "Requests/min", "1.5");
    fireEvent.submit(form);
    expect(await within(form).findByText(/must be a positive whole number/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the parsed limit, and null once every field is cleared", async () => {
    const onSave = vi.fn(async () => undefined);
    const onDone = vi.fn();
    render(<RateLimitForm label="Key limit" value={{ concurrency: 2 }} onSave={onSave} onDone={onDone} />);
    const form = screen.getByRole("form", { name: "Key limit" });
    type(form, "Requests/min", "60");
    fireEvent.submit(form);
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ requestsPerMinute: 60, concurrency: 2 }));
    type(form, "Requests/min", "");
    type(form, "Concurrent", "");
    fireEvent.submit(form);
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(null));
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("configures media jobs in flight like every other bound", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<RateLimitForm label="Member limit" value={{ mediaJobs: 1 }} onSave={onSave} />);
    const form = screen.getByRole("form", { name: "Member limit" });
    expect(within(form).getByLabelText("Media jobs")).toHaveValue("1");
    type(form, "Media jobs", "3");
    fireEvent.submit(form);
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ mediaJobs: 3 }));
  });

  it("shows the server's refusal", async () => {
    render(
      <RateLimitForm
        label="Key limit"
        value={null}
        onSave={() => Promise.reject(Object.assign(new Error("Forbidden."), { name: "AdminApiError" }))}
      />,
    );
    const form = screen.getByRole("form", { name: "Key limit" });
    type(form, "Concurrent", "3");
    fireEvent.submit(form);
    expect(await within(form).findByText("Forbidden.")).toBeInTheDocument();
  });

  it("is read-only text when the caller may not write limits", () => {
    render(<RateLimitForm label="Key limit" value={{ requestsPerMinute: 30 }} onSave={async () => undefined} disabled />);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("30 rpm")).toBeInTheDocument();
  });
});
