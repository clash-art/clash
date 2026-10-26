// @vitest-environment jsdom
/**
 * The managed "Clash official" row (#351) renders what the host answers and
 * nothing else: no row while none is published, the coded reason when it is
 * unavailable, and the published models grouped in the order served.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_MODEL_PROVIDER_ID, type OfficialModelProvider } from "@clash/shared-types";

const mocks = vi.hoisted(() => ({ readOfficialModelProvider: vi.fn() }));
vi.mock("@clash/web-ui/lib/clientActions", () => ({
  readOfficialModelProvider: mocks.readOfficialModelProvider,
}));

import { OfficialProviderRow } from "./SettingsOfficialProvider";

afterEach(() => {
  cleanup();
  mocks.readOfficialModelProvider.mockReset();
});

const head = { id: OFFICIAL_MODEL_PROVIDER_ID, label: "Official row", managed: true } as const;

describe("OfficialProviderRow", () => {
  it("renders nothing while the host lists no official row", async () => {
    mocks.readOfficialModelProvider.mockResolvedValue(null);
    const { container } = render(<OfficialProviderRow />);
    await vi.waitFor(() => expect(mocks.readOfficialModelProvider).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the coded reason when the row is unavailable", async () => {
    const row: OfficialModelProvider = { ...head, status: "unavailable", code: "SOME_CODE" };
    mocks.readOfficialModelProvider.mockResolvedValue(row);
    render(<OfficialProviderRow />);
    expect(await screen.findByText(row.code)).toBeInTheDocument();
  });

  it("lists the published catalog's models, grouped in the order the host serves them", async () => {
    const row: OfficialModelProvider = {
      ...head,
      status: "published",
      catalogVersion: "version-a",
      publishedAt: null,
      models: [
        { id: "m-video", name: "Video Model", kind: "video", upstreamIds: ["u1"] },
        { id: "m-image", name: "Image Model", kind: "image", upstreamIds: ["u2"] },
        { id: "m-text", name: "Text Model", kind: "text", upstreamIds: ["u3"] },
      ],
      upstreams: [],
    };
    mocks.readOfficialModelProvider.mockResolvedValue(row);
    render(<OfficialProviderRow />);
    const section = await screen.findByRole("region", { name: row.label });
    expect(section).toHaveTextContent(row.catalogVersion);
    const names = row.models.map((model) => model.name);
    const text = section.textContent ?? "";
    const positions = names.map((name) => text.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
