import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db";
import { getProjectById, listProjectsWithAssets } from "./projects-d1";

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

vi.mock("./asset-signing", () => ({
  signAssetPath: vi.fn(
    async (_env: unknown, key: string) => `/assets/${key}?signed=1`,
  ),
}));

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    ownerId: "user-1",
    name: "create some dog images",
    description: null,
    createdAt: new Date("2026-06-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    ...overrides,
  };
}

function asset(id: string, srcR2Key: string, createdAt: string) {
  return {
    id,
    srcR2Key,
    coverR2Key: null,
    kind: "image",
    createdAt: new Date(createdAt),
    importedAt: new Date(createdAt),
  };
}

describe("listProjectsWithAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to project asset refs when room nodes are unavailable", async () => {
    const fallbackAssets = [
      asset(
        "asset-6",
        "projects/project-1/assets/dog-6.png",
        "2026-06-03T00:06:00.000Z",
      ),
      asset(
        "asset-5",
        "projects/project-1/assets/dog-5.png",
        "2026-06-03T00:05:00.000Z",
      ),
      asset(
        "asset-4",
        "projects/project-1/assets/dog-4.png",
        "2026-06-03T00:04:00.000Z",
      ),
      asset(
        "asset-3",
        "projects/project-1/assets/dog-3.png",
        "2026-06-03T00:03:00.000Z",
      ),
      asset(
        "asset-2",
        "projects/project-1/assets/dog-2.png",
        "2026-06-03T00:02:00.000Z",
      ),
      asset(
        "asset-1",
        "projects/project-1/assets/dog-1.png",
        "2026-06-03T00:01:00.000Z",
      ),
    ];

    const db = {
      query: {
        projects: {
          findMany: vi.fn().mockResolvedValue([project()]),
        },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(fallbackAssets),
              }),
            }),
          }),
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const [result] = await listProjectsWithAssets(
      { DB: {} as D1Database },
      "user-1",
      1,
    );

    expect(result.assets).toHaveLength(4);
    expect(result.assetCount).toBe(6);
    expect(result.assets.map((a: { url: string }) => a.url)).toEqual([
      "/assets/projects/project-1/assets/dog-6.png?signed=1",
      "/assets/projects/project-1/assets/dog-5.png?signed=1",
      "/assets/projects/project-1/assets/dog-4.png?signed=1",
      "/assets/projects/project-1/assets/dog-3.png?signed=1",
    ]);
  });
});

describe("synced Project Assets (#84)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function emptyLegacyDb(found: "findMany" | "findFirst") {
    return {
      query: {
        projects: {
          [found]: vi
            .fn()
            .mockResolvedValue(found === "findMany" ? [project()] : project()),
        },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
  }

  function room(assetIds: string[] | null) {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | string) => {
      const request = typeof input === "string" ? new Request(input) : input;
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/nodes"))
        return Response.json(
          assetIds?.map((assetId, i) => ({
            id: `node-${i}`,
            type: "image",
            data: { assetId },
          })) ?? [],
        );
      return assetIds
        ? Response.json({ assets: assetIds.map((id) => ({ id })) })
        : new Response("unavailable", { status: 503 });
    });
    return {
      requests,
      ROOM: {
        idFromName: (name: string) => name,
        get: () => ({ fetch }),
      } as never,
    };
  }

  it("counts Project Assets the room holds, not only legacy D1 Asset rows", async () => {
    vi.mocked(getDb).mockReturnValue(
      emptyLegacyDb("findMany") as unknown as ReturnType<typeof getDb>,
    );
    const { ROOM, requests } = room(["asset-a", "asset-b"]);

    const [result] = await listProjectsWithAssets(
      { DB: {} as D1Database, ROOM },
      "user-1",
      1,
    );

    expect(result.assetCount).toBe(2);
    const list = requests.find((r) => r.url.endsWith("/assets-list"));
    expect(list?.headers.get("x-internal-loro")).toBe("true");
    expect(list?.headers.get("x-loro-project-id")).toBe("project-1");
  });

  it("keeps the legacy count when the room cannot list Project Assets", async () => {
    vi.mocked(getDb).mockReturnValue(
      emptyLegacyDb("findFirst") as unknown as ReturnType<typeof getDb>,
    );
    const { ROOM } = room(null);

    const result = await getProjectById(
      { DB: {} as D1Database, ROOM },
      "user-1",
      "project-1",
    );

    expect(result?.assetCount).toBe(0);
  });
});

describe("getProjectById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes fallback project asset refs for detail pages", async () => {
    const fallbackAssets = [
      asset(
        "asset-2",
        "projects/project-1/assets/dog-2.png",
        "2026-06-03T00:02:00.000Z",
      ),
      asset(
        "asset-1",
        "projects/project-1/assets/dog-1.png",
        "2026-06-03T00:01:00.000Z",
      ),
    ];

    const db = {
      query: {
        projects: {
          findFirst: vi.fn().mockResolvedValue(project()),
        },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(fallbackAssets),
              }),
            }),
          }),
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await getProjectById(
      { DB: {} as D1Database },
      "user-1",
      "project-1",
    );

    expect(result?.assetCount).toBe(2);
    expect(result?.assets).toEqual([
      expect.objectContaining({
        id: "asset-2",
        url: "/assets/projects/project-1/assets/dog-2.png?signed=1",
        type: "image",
      }),
      expect.objectContaining({
        id: "asset-1",
        url: "/assets/projects/project-1/assets/dog-1.png?signed=1",
        type: "image",
      }),
    ]);
    expect(result?.assets[0]).not.toHaveProperty("storageKey");
    expect(result?.assets[1]).not.toHaveProperty("storageKey");
  });
});
