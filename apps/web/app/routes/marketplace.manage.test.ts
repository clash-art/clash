import { afterEach, describe, expect, it, vi } from "vitest";

import { loader } from "./marketplace.manage";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Marketplace manage loader", () => {
  it("makes official picks discoverable without mixing in uncurated generic skills", async () => {
    const picked = {
      id: "example.pick",
      name: "Community creation skill",
      type: "skill",
      source: "community",
      curation: { collection: "official-picks", curator: "Clash" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const pathname = new URL(String(input), "http://clash.local").pathname;
        if (pathname === "/api/marketplace/registry")
          return Response.json({
            version: 1,
            plugins: [],
            actions: [],
            skills: [picked, { id: "generic", name: "Generic", type: "skill" }],
          });
        return Response.json([]);
      }),
    );
    expect((await loader()).items).toEqual([picked]);
  });
  it("loads official plugins and actions while excluding generic skills from the Store", async () => {
    const storyboard = {
      id: "clash.storyboard",
      name: "Storyboard",
      type: "plugin",
      packageId: "clash.storyboard",
    };
    const action = {
      id: "codex-imagegen",
      name: "Codex ImageGen",
      type: "action",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/marketplace/registry") {
          return Response.json({
            version: 1,
            actions: [action],
            plugins: [storyboard],
            skills: [
              {
                id: "clash.openai.define-goal",
                type: "skill",
                name: "Define goal",
              },
            ],
          });
        }
        if (path === "/api/v1/local/plugins") {
          return Response.json([{ id: "clash.storyboard", drifted: false }]);
        }
        return Response.json([]);
      }),
    );

    await expect(loader()).resolves.toEqual({
      items: [action, storyboard],
      installedActionIds: [],
      installedSkillIds: [],
      installedPluginIds: ["clash.storyboard"],
    });
  });

  it("renders an empty marketplace when local installed-item reads time out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException(
          "signal is aborted without reason",
          "AbortError",
        );
      }),
    );

    await expect(loader()).resolves.toEqual({
      items: [],
      installedActionIds: [],
      installedSkillIds: [],
      installedPluginIds: [],
    });
  });

  it("keeps registry and healthy install state when one installed source is malformed", async () => {
    const registryItem = {
      id: "codex-imagegen",
      name: "Codex ImageGen",
      type: "action",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/marketplace/registry") {
          return Response.json({
            version: 1,
            actions: [registryItem],
            skills: [],
          });
        }
        if (path === "/api/settings/actions") {
          return Response.json([{ actionId: "codex-imagegen" }]);
        }
        return Response.json({ error: "bad local skill state" });
      }),
    );

    await expect(loader()).resolves.toEqual({
      items: [registryItem],
      installedActionIds: ["codex-imagegen"],
      installedSkillIds: [],
      installedPluginIds: [],
    });
  });

  it("finishes after the local timeout when one installed source never responds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/settings/skills") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return Response.json(
          path === "/api/marketplace/registry"
            ? { version: 1, actions: [], skills: [] }
            : [],
        );
      }),
    );

    const result = loader();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual({
      items: [],
      installedActionIds: [],
      installedSkillIds: [],
      installedPluginIds: [],
    });
  });

  it("degrades a malformed registry payload instead of failing the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        return Response.json(
          path === "/api/marketplace/registry"
            ? { version: 1, actions: null, skills: { bad: true } }
            : [],
        );
      }),
    );

    await expect(loader()).resolves.toEqual({
      items: [],
      installedActionIds: [],
      installedSkillIds: [],
      installedPluginIds: [],
    });
  });

  it("preserves authentication redirects from installed-item sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/settings/skills") {
          return new Response(null, { status: 401 });
        }
        return Response.json(
          path === "/api/marketplace/registry"
            ? { version: 1, actions: [], skills: [] }
            : [],
        );
      }),
    );

    await expect(loader()).rejects.toMatchObject({ status: 302 });
  });
});

it("does not present drifted packages as usable installed plugins", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const pathname = new URL(String(input), "http://clash.local").pathname;
    if (pathname === "/api/v1/local/plugins") return Response.json([{ id: "valid", drifted: false }, { id: "drifted", drifted: true }]);
    if (pathname === "/api/marketplace/registry") return Response.json({ version: 1, actions: [], skills: [], plugins: [] });
    return Response.json([]);
  }));
  expect((await loader()).installedPluginIds).toEqual(["valid"]);
});
