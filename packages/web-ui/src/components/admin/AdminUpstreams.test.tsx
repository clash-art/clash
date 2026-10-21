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
  credential: { kind: "sealed", secretRef: null, fields: ["apiKey"], keyVersion: "v1", rotatedAt: null },
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const type = (form: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });

describe("AdminUpstreams", () => {
  it("shows credential metadata only, and no controls without upstreams.write", () => {
    render(<AdminUpstreams upstreams={[account]} canWrite={false} onChanged={() => undefined} />);
    expect(screen.getByText("sealed apiKey")).toBeInTheDocument();
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
