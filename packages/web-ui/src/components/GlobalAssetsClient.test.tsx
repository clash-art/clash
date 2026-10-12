// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GlobalAssetsClient from "./GlobalAssetsClient";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GlobalAssetsClient", () => {
  it("teaches the first upload with the Clash assets artwork", () => {
    render(<GlobalAssetsClient initialAssets={[]} />);

    const emptyUpload = screen.getByRole("button", {
      name: /Build your reusable library/i,
    });
    const artwork = emptyUpload.querySelector("img");
    expect(artwork).toHaveAttribute(
      "src",
      "/brand/avatar-assets.png",
    );
    expect(artwork).toHaveAttribute("data-ui", "brand-asset");
    expect(artwork).toHaveAttribute("data-asset-role", "feature");
    expect(
      emptyUpload.querySelector('[data-slot="assets-empty-artwork"]'),
    ).toHaveAttribute("data-ui", "artwork-slot");
    expect(screen.getByRole("button", { name: "Add assets" })).toBeTruthy();
  });

  it("renders import failures through the shared feedback surface", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Upload failed"));

    render(<GlobalAssetsClient initialAssets={[]} />);
    const input = screen.getByLabelText("Upload global assets");
    fireEvent.change(input, {
      target: { files: [new File(["image"], "broken.png", { type: "image/png" })] },
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-ui", "feedback");
    expect(alert).toHaveAttribute("data-tone", "error");
  });

  it("uploads a local file into the global library without requiring a project", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "global:asset-1",
          kind: "image",
          name: "hero.png",
          lifecycle: { state: "active" },
          metadata: {
            originalName: "hero.png",
            bytes: 5,
            contentType: "image/png",
          },
          status: "ready",
          url: "https://media.clash.test/api/v1/libraries/personal/assets/global%3Aasset-1/media",
          thumbnailUrl:
            "https://media.clash.test/api/v1/libraries/personal/assets/global%3Aasset-1/media",
        }),
        { status: 201 },
      ),
    );

    render(<GlobalAssetsClient initialAssets={[]} />);
    const input = screen.getByLabelText(
      "Upload global assets",
    ) as HTMLInputElement;
    const file = new File(["image"], "hero.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("hero.png")).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain(
      "/api/v1/libraries/personal/assets/import-file",
    );
    expect(
      new URL(
        String(fetchSpy.mock.calls[0]?.[0]),
        "http://host.test",
      ).searchParams.get("kind"),
    ).toBe("image");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(file);
  });

  it("keeps device availability separate from library Trash and restores only trashed entries", async () => {
    const unavailableActive = {
      id: "global:remote-only",
      kind: "video" as const,
      name: "remote.mp4",
      lifecycle: { state: "active" as const },
      metadata: {},
      status: "unavailable" as const,
    };
    const active = {
      id: "global:hero",
      kind: "image" as const,
      name: "hero.png",
      lifecycle: { state: "active" as const },
      metadata: {},
      status: "ready" as const,
      url: "https://media.clash.test/hero.png",
    };
    const trashed = {
      ...active,
      lifecycle: {
        state: "trashed" as const,
        deleteOperationId: "delete-1",
        deletedAt: "2026-08-13T00:00:00.000Z",
        purgeAfter: "2026-09-12T00:00:00.000Z",
      },
      status: "unavailable" as const,
      url: undefined,
    };
    const restored = { ...active, lifecycle: { state: "active" as const } };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(trashed), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(restored), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    render(<GlobalAssetsClient initialAssets={[unavailableActive, active]} />);

    expect(screen.getByText("Unavailable on this device")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Restore remote.mp4" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Move hero.png to Trash" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Restore hero.png" }),
      ).toBeTruthy(),
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "/api/v1/libraries/personal/assets/global%3Ahero",
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("DELETE");

    fireEvent.click(screen.getByRole("button", { name: "Restore hero.png" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Move hero.png to Trash" }),
      ).toBeTruthy(),
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain(
      "/api/v1/libraries/personal/assets/global%3Ahero/restore",
    );
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ deleteOperationId: "delete-1" }),
    });
  });
});
