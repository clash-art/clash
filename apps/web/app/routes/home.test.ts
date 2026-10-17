// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { loader as homeLoader } from "./home";

// The session is a page-lifetime cache (#160): each case loads fresh modules.
let loader: typeof homeLoader;

beforeEach(async () => {
  vi.resetModules();
  ({ loader } = await import("./home"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
});

describe("home loader marketplace feed", () => {
  it.each(["local", "desktop"] as const)(
    "opens the %s product home without a Better Auth session",
    async (mode) => {
      globalThis.__CLASH_RUNTIME_CONFIG__ = {
        mode,
        apiBaseUrl: "http://127.0.0.1:8789",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const path = new URL(String(input), "http://clash.local").pathname;
          if (path === "/api/better-auth/get-session") {
            throw new Error("Local Home must not depend on Better Auth");
          }
          if (path === "/api/v1/projects") {
            return Response.json({ projects: [] });
          }
          if (path === "/api/marketplace/feed") {
            return Response.json({ version: 1, featuredPlugins: [] });
          }
          if (
            path === "/api/settings/actions" ||
            path === "/api/v1/local/plugins" ||
            path === "/api/settings/skills"
          ) {
            return Response.json([]);
          }
          throw new Error(`Unexpected request: ${path}`);
        }),
      );

      await expect(loader({} as never)).resolves.toEqual({
        authed: true,
        projects: [],
        marketplaceFeed: {
          featuredPlugins: [],
          installedActionIds: [],
          installedPluginIds: [],
          installedSkillIds: [],
        },
      });
    },
  );

  it("redirects an unauthenticated hosted visitor to login instead of rendering Landing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    await expect(loader({} as never)).rejects.toMatchObject({ status: 302 });
  });

  it("shares one get-session across layout and home loader re-runs", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://clash.local").pathname;
      if (path === "/api/better-auth/get-session") {
        return Response.json({ user: { id: "user-1" } });
      }
      if (path === "/api/marketplace/feed") {
        return Response.json({ version: 1, featuredPlugins: [] });
      }
      if (path === "/api/v1/projects") {
        return Response.json({ projects: [] });
      }
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { loader: layoutLoader } = await import(
      "../layouts/appLayoutLoader"
    );

    for (let navigation = 0; navigation < 3; navigation += 1) {
      await expect(layoutLoader({} as never)).resolves.toEqual({
        isAuthenticated: true,
      });
      await expect(loader({} as never)).resolves.toMatchObject({
        authed: true,
      });
    }

    const sessionReads = fetchMock.mock.calls.filter(
      ([input]) =>
        new URL(String(input), "http://clash.local").pathname ===
        "/api/better-auth/get-session",
    );
    expect(sessionReads).toHaveLength(1);
  });

  it("redirects when the hosted project read reports an expired session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/better-auth/get-session") {
          return Response.json({ user: { id: "user-1" } });
        }
        if (path === "/api/v1/projects") {
          return new Response(null, { status: 401 });
        }
        if (path === "/api/marketplace/feed") {
          return Response.json({ version: 1, featuredPlugins: [] });
        }
        return Response.json([]);
      }),
    );

    await expect(loader({} as never)).rejects.toMatchObject({ status: 302 });
  });

  it("maps the Plugin feed and its matching installed Plugin ids into Home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/better-auth/get-session") {
          return Response.json({ user: { id: "user-1" } });
        }
        if (path === "/api/v1/projects") {
          return Response.json({ projects: [{ id: "project-1" }] });
        }
        if (path === "/api/marketplace/feed") {
          return Response.json({
            version: 1,
            featuredPlugins: [
              {
                id: "clash.storyboard",
                type: "plugin",
                name: "Storyboard",
                artwork: { src: "/brand/avatar-storyboard.png" },
              },
              {
                id: "clash.video.sd25-pe",
                type: "skill",
                name: "sd25-pe",
              },
            ],
          });
        }
        if (path === "/api/marketplace/registry") {
          throw new Error("Home must not read the full Marketplace registry");
        }
        if (path === "/api/settings/actions") {
          return Response.json([{ actionId: "action-1" }]);
        }
        if (path === "/api/settings/skills") {
          return Response.json([{ skillId: "clash.video.sd25-pe" }]);
        }
        if (path === "/api/v1/local/plugins") {
          return Response.json([{ id: "clash.storyboard", drifted: false }]);
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    await expect(loader({} as never)).resolves.toEqual({
      authed: true,
      projects: [{ id: "project-1" }],
      marketplaceFeed: {
        featuredPlugins: [
          {
            id: "clash.storyboard",
            type: "plugin",
            name: "Storyboard",
            artwork: { src: "/brand/avatar-storyboard.png" },
          },
          {
            id: "clash.video.sd25-pe",
            type: "skill",
            name: "sd25-pe",
          },
        ],
        installedActionIds: ["action-1"],
        installedPluginIds: ["clash.storyboard"],
        installedSkillIds: ["clash.video.sd25-pe"],
      },
    });
  });

  it("degrades feed failures without hiding authenticated projects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/better-auth/get-session") {
          return Response.json({ user: { id: "user-1" } });
        }
        if (path === "/api/v1/projects") {
          return Response.json({ projects: [{ id: "project-1" }] });
        }
        throw new TypeError("runtime offline");
      }),
    );

    await expect(loader({} as never)).resolves.toEqual({
      authed: true,
      projects: [{ id: "project-1" }],
      marketplaceFeed: {
        featuredPlugins: [],
        installedActionIds: [],
        installedPluginIds: [],
        installedSkillIds: [],
      },
    });
  });

  it("preserves authentication redirects from installed feed sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/better-auth/get-session") {
          return Response.json({ user: { id: "user-1" } });
        }
        if (path === "/api/v1/local/plugins") {
          return new Response(null, { status: 401 });
        }
        if (path === "/api/v1/projects") {
          return Response.json({ projects: [] });
        }
        return Response.json(
          path === "/api/marketplace/feed"
            ? { version: 1, featuredPlugins: [] }
            : [],
        );
      }),
    );

    await expect(loader({} as never)).rejects.toMatchObject({ status: 302 });
  });
});
