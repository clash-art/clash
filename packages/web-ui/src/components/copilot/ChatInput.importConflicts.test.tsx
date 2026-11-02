// @vitest-environment jsdom
import { forwardRef, Suspense, useImperativeHandle } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setRuntimeConfigOverride } from "../../lib/runtimeConfig";
import { ChatInput } from "./ChatInput";

const milkdownInsert = vi.hoisted(() => vi.fn());

vi.mock("../MilkdownEditor", () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({
      clear: vi.fn(),
      focus: vi.fn(),
      insertAtCursor: milkdownInsert,
    }));
    return <div data-testid="milkdown-editor" />;
  }),
}));

// Interpolated values stay visible so a notice can be checked for the names it
// shows without loading the locale bundles.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.values(values)
            .map((value) => String(value))
            .join(" | ")}`
        : key,
  }),
}));

const PROJECT = "project-import-conflicts";
const assetsBase = `/api/v1/projects/${PROJECT}/assets`;

function asset(id: string, name: string, state: "active" | "trashed") {
  const url = `https://media.clash.test${assetsBase}/${id}/media`;
  return {
    id,
    kind: "image",
    name,
    metadata: { originalName: name, contentType: "image/png", bytes: 3 },
    lifecycle:
      state === "active"
        ? { state }
        : {
            state,
            deleteOperationId: "delete:old",
            deletedAt: "2026-11-01T00:00:00.000Z",
            purgeAfter: "2026-12-01T00:00:00.000Z",
          },
    status: "ready",
    url,
    thumbnailUrl: url,
  };
}

/**
 * The Host's answers, keyed by dropped file: `fresh.png` is new, `again.png`
 * is already held by an active Asset, `binned.png` only by a trashed one.
 */
function hostFetch() {
  const imports: Array<{ file: string; duplicateContent: string | null }> = [];
  const restores: string[] = [];
  const existing = asset("asset-existing-hero", "Existing hero", "active");
  const binned = asset("asset-binned-hero", "Binned hero", "trashed");
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://host.test");
      if (url.pathname === `${assetsBase}/import-file`) {
        const file = (init?.body as File).name;
        const duplicateContent = url.searchParams.get("duplicateContent");
        const projectAssetId = url.searchParams.get("projectAssetId")!;
        imports.push({ file, duplicateContent });
        if (file === "again.png" && duplicateContent === "reject") {
          return Response.json(
            {
              error: "duplicate",
              code: "PROJECT_ASSET_DUPLICATE_CONTENT",
              projectAssetId,
              existingProjectAssetIds: [existing.id],
            },
            { status: 409 },
          );
        }
        if (file === "binned.png" && duplicateContent === "reject") {
          return Response.json(
            {
              error: "trashed",
              code: "PROJECT_ASSET_TRASHED",
              projectAssetId,
              existingProjectAssetIds: [binned.id],
            },
            { status: 409 },
          );
        }
        return Response.json(asset(projectAssetId, file, "active"), {
          status: 201,
        });
      }
      const holders = [existing, binned];
      if (url.pathname === `${assetsBase}/batch`) {
        const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
        return Response.json({
          assets: holders.filter((holder) => ids.includes(holder.id)),
        });
      }
      if (url.pathname === `${assetsBase}/${binned.id}/restore`) {
        restores.push(binned.id);
        return Response.json(asset(binned.id, "Binned hero", "active"), {
          headers: { "x-clash-read-receipt": "receipt:restored" },
        });
      }
      const held = holders.find(
        (holder) => url.pathname === `${assetsBase}/${holder.id}`,
      );
      if (held) {
        return Response.json(held, {
          headers: { "x-clash-read-receipt": `receipt:${held.id}` },
        });
      }
      // Voice-input readiness.
      return Response.json({
        asr: {
          enabled: false,
          ready: false,
          provider: "builtin-funasr",
          base_url: null,
          model: "iic/SenseVoiceSmall",
        },
      });
    });
  return { fetchSpy, imports, restores, existing, binned };
}

async function dropFiles(names: string[]) {
  const { container } = render(
    <Suspense fallback={<div>Loading</div>}>
      <ChatInput
        input=""
        projectId={PROJECT}
        onInputChange={() => undefined}
        onSubmit={() => undefined}
      />
    </Suspense>,
  );
  await screen.findByTestId("milkdown-editor");
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: {
      files: names.map(
        (name) => new File(["png"], name, { type: "image/png" }),
      ),
    },
  });
  return container;
}

function notice(container: HTMLElement, kind: "duplicate" | "trashed") {
  return container.querySelector<HTMLElement>(
    `[data-import-conflict="${kind}"]`,
  );
}

describe("ChatInput duplicate and trashed drops", () => {
  beforeEach(() => setRuntimeConfigOverride({ mode: "local" }));
  afterEach(() => {
    setRuntimeConfigOverride(undefined);
    cleanup();
    milkdownInsert.mockClear();
    vi.restoreAllMocks();
  });

  it("imports the new files of a batch and reports the duplicate and the trashed one by Asset name", async () => {
    const host = hostFetch();
    const container = await dropFiles(["fresh.png", "again.png", "binned.png"]);

    await waitFor(() => expect(notice(container, "duplicate")).toBeTruthy());
    await waitFor(() => expect(notice(container, "trashed")).toBeTruthy());
    await waitFor(() => expect(milkdownInsert).toHaveBeenCalledOnce());

    // Every drop asks the Host for the same duplicate check the MCP import
    // uses; nothing besides the new file was imported.
    expect(host.imports).toEqual(
      expect.arrayContaining([
        { file: "fresh.png", duplicateContent: "reject" },
        { file: "again.png", duplicateContent: "reject" },
        { file: "binned.png", duplicateContent: "reject" },
      ]),
    );
    expect(host.imports).toHaveLength(3);
    expect(milkdownInsert.mock.calls[0]![0]).toContain("![fresh.png](");

    const duplicate = notice(container, "duplicate")!;
    expect(duplicate.textContent).toContain(
      "copilot.chatInput.importConflict.duplicate",
    );
    expect(duplicate.textContent).toContain("again.png");
    expect(duplicate.textContent).toContain("Existing hero");
    const trashed = notice(container, "trashed")!;
    expect(trashed.textContent).toContain(
      "copilot.chatInput.importConflict.trashed",
    );
    expect(trashed.textContent).toContain("binned.png");
    expect(trashed.textContent).toContain("Binned hero");
    // Restoring is the only way back for a trashed file; no copy is offered.
    expect(
      within(trashed).queryByRole("button", {
        name: "copilot.chatInput.importConflict.importAnyway",
      }),
    ).toBeNull();
  });

  it("attaches the existing Asset without importing again", async () => {
    const host = hostFetch();
    const container = await dropFiles(["again.png"]);
    await waitFor(() => expect(notice(container, "duplicate")).toBeTruthy());

    fireEvent.click(
      within(notice(container, "duplicate")!).getByRole("button", {
        name: "copilot.chatInput.importConflict.useExisting",
      }),
    );

    await waitFor(() =>
      expect(milkdownInsert).toHaveBeenCalledWith(
        `![Existing hero](${host.existing.url} "clash-project-asset:${host.existing.id}") `,
      ),
    );
    expect(notice(container, "duplicate")).toBeNull();
    expect(host.imports).toHaveLength(1);
  });

  it("imports an intentional second copy only when asked", async () => {
    const host = hostFetch();
    const container = await dropFiles(["again.png"]);
    await waitFor(() => expect(notice(container, "duplicate")).toBeTruthy());

    fireEvent.click(
      within(notice(container, "duplicate")!).getByRole("button", {
        name: "copilot.chatInput.importConflict.importAnyway",
      }),
    );

    await waitFor(() => expect(milkdownInsert).toHaveBeenCalledOnce());
    expect(host.imports).toEqual([
      { file: "again.png", duplicateContent: "reject" },
      { file: "again.png", duplicateContent: "allow" },
    ]);
    expect(milkdownInsert.mock.calls[0]![0]).toContain("![again.png](");
    expect(notice(container, "duplicate")).toBeNull();
  });

  it("restores the trashed Asset through the observed-CAS flow and attaches it", async () => {
    const host = hostFetch();
    const container = await dropFiles(["binned.png"]);
    await waitFor(() => expect(notice(container, "trashed")).toBeTruthy());

    fireEvent.click(
      within(notice(container, "trashed")!).getByRole("button", {
        name: "copilot.chatInput.importConflict.restore",
      }),
    );

    await waitFor(() =>
      expect(milkdownInsert).toHaveBeenCalledWith(
        `![Binned hero](${host.binned.url} "clash-project-asset:${host.binned.id}") `,
      ),
    );
    expect(host.restores).toEqual([host.binned.id]);
    const restore = host.fetchSpy.mock.calls.find(([input]) =>
      String(input).endsWith(`/${host.binned.id}/restore`),
    );
    expect(
      new Headers(restore?.[1]?.headers).get("x-clash-if-match"),
    ).toBeTruthy();
    expect(notice(container, "trashed")).toBeNull();
    expect(host.imports).toHaveLength(1);
  });

  it("keeps the notice with the reason when its action fails, and dismisses it on request", async () => {
    const host = hostFetch();
    const container = await dropFiles(["binned.png"]);
    await waitFor(() => expect(notice(container, "trashed")).toBeTruthy());
    host.fetchSpy.mockImplementation(async () =>
      Response.json(
        { error: "Host offline", code: "HOST_UNAVAILABLE" },
        { status: 409 },
      ),
    );

    fireEvent.click(
      within(notice(container, "trashed")!).getByRole("button", {
        name: "copilot.chatInput.importConflict.restore",
      }),
    );

    await waitFor(() =>
      expect(notice(container, "trashed")!.textContent).toContain(
        "Host offline",
      ),
    );
    expect(milkdownInsert).not.toHaveBeenCalled();

    fireEvent.click(
      within(notice(container, "trashed")!).getByRole("button", {
        name: "copilot.chatInput.importConflict.dismiss",
      }),
    );
    expect(notice(container, "trashed")).toBeNull();
  });
});
