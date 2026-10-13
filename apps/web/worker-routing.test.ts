import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// workerd-only protocol module; Node has no `tracing`, so the gateway
// keeps the no-op OTel provider in tests.
vi.mock("cloudflare:workers", () => ({ tracing: undefined }));
import worker, { type Env } from "./workers/app";

function gatewayEnv(): Env {
  return {
    ASSETS: {
      fetch: async () => new Response("static boundary", { status: 404 }),
    },
    API_CF: {
      fetch: async () => new Response("api boundary", { status: 418 }),
    },
  } as unknown as Env;
}

describe("web worker Asset routing boundary", () => {
  it.each(["snapshot", "updates", "metadata"])(
    "routes Project Loro %s to the authenticated API boundary",
    async (suffix) => {
      const response = await worker.fetch(
        new Request(`https://clash.test/loro/project/${suffix}`),
        gatewayEnv(),
      );
      expect(response.status).toBe(418);
    },
  );
  it("does not carve anonymous upload out to api-cf", async () => {
    const response = await worker.fetch(
      new Request("https://clash.test/upload", { method: "POST" }),
      gatewayEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("static boundary");
  });

  it("keeps signed Asset delivery isolated as a transport route", async () => {
    const response = await worker.fetch(
      new Request("https://clash.test/assets/capability?exp=1&sig=opaque"),
      gatewayEnv(),
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("api boundary");
  });
});

describe("cloud browser login gateway", () => {
  it.each([
    ["/api/v1/cloud", "GET"],
    ["/api/v1/cli-auth/token", "POST"],
  ])(
    "forwards public protocol endpoint %s without accepting caller identity",
    async (path, method) => {
      const env = gatewayEnv();
      let received: Request | undefined;
      env.API_CF = {
        fetch: async (request) => {
          received = request;
          return new Response("backend validated", { status: 200 });
        },
      };
      const response = await worker.fetch(
        new Request("https://clash.test" + path, {
          method,
          headers: { "x-user-id": "forged" },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(received?.headers.has("x-user-id")).toBe(false);
    },
  );
  it.each([
    "/api/v1/cloud/account",
    "/api/v1/cli-auth/authorize",
    "/api/v1/projects",
  ])("still requires authentication for %s", async (path) => {
    const response = await worker.fetch(
      new Request("https://clash.test" + path, {
        headers: { "x-user-id": "forged" },
      }),
      gatewayEnv(),
    );
    expect(response.status).toBe(401);
  });
});

/**
 * `run_worker_first` decides which paths reach this Worker at all: anything
 * outside the list is answered by the SPA assets layer (HTML shell for GET,
 * 405 for writes) before `fetch` runs, so a prefix the gateway proxies but
 * the list omits is silently dead on the deployed origin.
 */
function runWorkerFirstBySection(toml: string): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  let section = "";
  let open: string[] | undefined;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (open) {
      for (const match of line.matchAll(/"([^"]+)"/g)) open.push(match[1]);
      if (line.includes("]")) open = undefined;
      continue;
    }
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) section = header[1];
    else if (/^run_worker_first\s*=\s*\[/.test(line)) {
      open = lists[section] = [];
      for (const match of line.matchAll(/"([^"]+)"/g)) open.push(match[1]);
      if (line.includes("]")) open = undefined;
    }
  }
  return lists;
}

describe("apps/web/wrangler.toml run_worker_first", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const lists = runWorkerFirstBySection(
    readFileSync(resolve(here, "wrangler.toml"), "utf8"),
  );
  const source = readFileSync(resolve(here, "workers/app.ts"), "utf8");
  const handler = source.slice(source.indexOf("export default {"));
  const prefixes = [
    ...handler.matchAll(/path\s*\.\s*startsWith\(\s*["'](\/[^"']*)["']/g),
  ].map((match) => match[1]);
  const exact = [...handler.matchAll(/path\s*===\s*["'](\/[^"']*)["']/g)].map(
    (match) => match[1],
  );

  it("finds the gateway's routed paths in the Worker source", () => {
    expect(prefixes).toContain("/loro/");
    expect(exact).toContain("/health");
  });

  it.each(["assets", "env.staging.assets"])(
    "[%s] sends every path the Worker handles to the Worker first",
    (section) => {
      const list = lists[section];
      expect(list, `missing run_worker_first in [${section}]`).toBeDefined();
      const globs = list
        .filter((entry) => entry.endsWith("*"))
        .map((entry) => entry.slice(0, -1));
      const missing = [
        ...prefixes.filter(
          (prefix) => !globs.some((glob) => prefix.startsWith(glob)),
        ),
        ...exact.filter(
          (path) =>
            !list.includes(path) && !globs.some((glob) => path.startsWith(glob)),
        ),
      ];
      expect(missing).toEqual([]);
    },
  );
});
