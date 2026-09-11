import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";

describe("marketplace registry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves first-party repo-hosted video skills and merges remote community entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            version: 1,
            actions: [{ id: "community.grid-split", title: "Grid Split" }],
            skills: [{ id: "community.caption-polish", title: "Caption Polish" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const app = createApp();
    const res = await app.request("/api/marketplace/registry", {}, {});
    expect(res.status).toBe(200);

    const body = await res.json() as {
      version: number;
      marketplaceSemantics?: {
        skillBoundary?: string;
        artifactContract?: {
          publicInterfaces?: string[];
          hostOwnedInternals?: string[];
        };
      };
      actions: Array<{ id: string }>;
      skills: Array<{ id: string; source?: string; kind?: string }>;
      thirdPartyReferences: Array<{ name: string; license: string; usage: string }>;
    };

    expect(body.version).toBe(1);
    expect(body.marketplaceSemantics).toEqual(
      expect.objectContaining({
        skillBoundary: "portable-artifact-contract",
        artifactContract: expect.objectContaining({
          publicInterfaces: expect.arrayContaining(["action", "asset", "timeline-cas-apply"]),
          hostOwnedInternals: expect.arrayContaining([
            "snapshot.bin",
            "project.sqlite",
            "loro-crdt-doc",
            "runtime-secrets",
          ]),
        }),
      }),
    );
    expect(body.thirdPartyReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "OpenMontage",
          license: "AGPL-3.0",
          usage: "research-only",
        }),
        expect.objectContaining({
          name: "Montage AI",
          license: "PolyForm-Noncommercial-1.0.0",
          usage: "research-only",
        }),
      ]),
    );
    expect(body.actions).toEqual([]);
    // The ten `clash.action.production.*` entries were removed with the `clash production` command
    // family they invoked; every one of them resolved to nothing. Asserted absent so the registry is
    // never repopulated with ids that have no implementation -- a listing that cannot run is worse
    // than a missing one, because it fails only after a user picks it.
    expect(body.actions.filter((item) => item.id.startsWith("clash.action.production."))).toEqual([]);
    expect(body.skills.some((item) => item.id === "community.caption-polish")).toBe(true);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "clash.video.agentic-video-architecture",
          source: "first-party",
          kind: "architecture",
        }),
        expect.objectContaining({
          id: "clash.video.agentic-video-creator",
          source: "first-party",
          kind: "detail",
        }),
      ]),
    );
  });

  it("falls back to the bundled registry when the remote community registry is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    const app = createApp();
    const res = await app.request("/api/marketplace/registry", {}, {});
    expect(res.status).toBe(200);
    const body = await res.json() as {
      actions: Array<{ id: string }>;
      skills: Array<{ id: string }>;
    };

    expect(body.actions).toEqual([]);
    expect(body.actions.filter((item) => item.id.startsWith("clash.action.production."))).toEqual([]);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "clash.video.agentic-video-architecture" }),
      ]),
    );
    expect(body.actions.some((item) => item.id.startsWith("community."))).toBe(false);
    expect(body.skills.some((item) => item.id.startsWith("community."))).toBe(false);
  });

  it("keeps first-party skill entries when remote registry repeats an id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            version: 1,
            actions: [],
            skills: [
              {
                id: "clash.video.agentic-video-architecture",
                title: "Remote Override",
                source: "remote",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const app = createApp();
    const res = await app.request("/api/marketplace/registry", {}, {});
    const body = await res.json() as { skills: Array<{ id: string; title?: string; source?: string }> };
    const duplicates = body.skills.filter((item) => item.id === "clash.video.agentic-video-architecture");

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toEqual(
      expect.objectContaining({
        title: "Agentic Video Architecture",
        source: "first-party",
      }),
    );
  });
});
