import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("plugin MCP gateway authors and manages plugins through the discovered local Host", async () => {
  let module: Record<string, unknown> = {};
  try {
    module = (await import("./plugin-mcp-gateway.js")) as Record<
      string,
      unknown
    >;
  } catch {
    // RED until the real plugin lifecycle gateway exists.
  }
  assert.equal(typeof module.createPluginMcpGateway, "function");

  const workspace = await mkdtemp(join(tmpdir(), "clash-plugin-mcp-"));
  const activatedPackages = new Map<string, Record<string, unknown>>();
  const hostOrigin = "http://127.0.0.1:49321";
  const request: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    assert.equal(url.origin, hostOrigin);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (
      url.pathname === "/api/v1/local/plugins/validate" &&
      init?.method === "POST"
    ) {
      if (
        body?.id !== "acme.caption-helper" ||
        typeof body?.files?.["handler.py"] !== "string"
      ) {
        return json({ error: "incomplete plugin package" }, 422);
      }
      return json({ contractTests: { passed: 1 } });
    }
    if (
      url.pathname === "/api/v1/local/plugins/activate" &&
      init?.method === "POST"
    ) {
      activatedPackages.set(body.id, body);
      return json({
        id: body.id,
        version: body.manifest.version,
        targetDir: `/managed/actions/${body.id}`,
        rollbackDir: `/managed/rollback/${body.id}`,
        contractTests: { passed: 1 },
      });
    }
    if (
      url.pathname === "/api/v1/local/plugins" &&
      (init?.method === undefined || init.method === "GET")
    ) {
      return json([
        {
          id: "acme.caption-helper",
          name: "Caption Helper",
          version: "0.1.0",
          targetDir: "/managed/actions/acme.caption-helper",
          drifted: false,
        },
      ]);
    }
    if (
      url.pathname === "/api/v1/local/plugins/acme.caption-helper/package" &&
      (init?.method === undefined || init.method === "GET")
    ) {
      return json({
        ...activatedPackages.get("acme.caption-helper"),
        version: "0.1.0",
      });
    }
    if (url.pathname === "/api/marketplace/registry") return json({ plugins: [{ id: "acme.marketplace-helper", type: "plugin", runtime: "local", packageId: "acme.marketplace-helper", installation: { kind: "executable-plugin", pluginId: "acme.marketplace-helper", packageId: "acme.marketplace-helper" } }], skills: [] });
    if (
      url.pathname ===
        "/api/marketplace/plugins/acme.marketplace-helper/install" &&
      init?.method === "POST"
    ) {
      return json({
        id: "acme.marketplace-helper",
        packageId: "acme.marketplace-helper",
        installed: true,
        targetDir: "/managed/actions/acme.marketplace-helper",
      });
    }
    if (
      url.pathname === "/api/v1/local/plugins/acme.caption-helper/rollback" &&
      init?.method === "POST"
    ) {
      return json({
        targetDir: "/managed/actions/acme.caption-helper",
        version: "0.0.9",
      });
    }
    if (
      url.pathname === "/api/v1/local/plugins/acme.caption-helper" &&
      init?.method === "DELETE"
    ) {
      return json({
        id: "acme.caption-helper",
        removed: true,
        trashDir: "/managed/trash/acme.caption-helper",
      });
    }
    return json(
      { error: `Unhandled ${init?.method ?? "GET"} ${url.pathname}` },
      404,
    );
  };

  const createGateway = module.createPluginMcpGateway as (options: {
    client: {
      resolveConnection(): Promise<{ endpoint: string }>;
    };
    request: typeof fetch;
  }) => {
    invoke(name: string, input: Record<string, unknown>): Promise<unknown>;
  };
  const gateway = createGateway({
    client: {
      resolveConnection: async () => ({ endpoint: hostOrigin }),
    },
    request,
  });

  const created = (await gateway.invoke("clash_plugin_create", {
    cwd: workspace,
    directory: "drafts/caption-helper",
    id: "acme.caption-helper",
    name: "Caption Helper",
    kind: "action",
    language: "python",
  })) as Record<string, unknown>;
  const draftPath = join(workspace, "drafts", "caption-helper");
  assert.deepEqual(created, {
    created: true,
    path: draftPath,
    manifest: join(draftPath, "manifest.json"),
    card: join(draftPath, "cards", "acme.caption-helper.json"),
    contract: join(draftPath, "contract-tests", "acme.caption-helper.json"),
    contractTests: { passed: 1 },
  });
  assert.match(
    await readFile(join(draftPath, "handler.py"), "utf8"),
    /EXPORT_ID/,
  );

  assert.deepEqual(
    await gateway.invoke("clash_plugin_validate", {
      cwd: workspace,
      directory: "drafts/caption-helper",
    }),
    {
      valid: true,
      id: "acme.caption-helper",
      version: "0.1.0",
      path: draftPath,
      contractTests: { passed: 1 },
    },
  );
  assert.deepEqual(
    await gateway.invoke("clash_plugin_activate", {
      cwd: workspace,
      directory: "drafts/caption-helper",
    }),
    {
      activated: true,
      id: "acme.caption-helper",
      version: "0.1.0",
      path: "/managed/actions/acme.caption-helper",
      rollbackPath: "/managed/rollback/acme.caption-helper",
      contractTests: { passed: 1 },
    },
  );
  assert.deepEqual(await gateway.invoke("clash_plugin_list", {}), [
    {
      id: "acme.caption-helper",
      name: "Caption Helper",
      version: "0.1.0",
      targetDir: "/managed/actions/acme.caption-helper",
      drifted: false,
    },
  ]);
  assert.deepEqual(
    await gateway.invoke("clash_plugin_checkout", {
      cwd: workspace,
      directory: "drafts/checked-out",
      id: "acme.caption-helper",
    }),
    {
      checkedOut: true,
      pluginDir: join(workspace, "drafts", "checked-out"),
      id: "acme.caption-helper",
      version: "0.1.0",
    },
  );
  assert.deepEqual(
    await gateway.invoke("clash_plugin_install", {
      id: "acme.marketplace-helper",
      installation: { scope: "projects", projectIds: ["project-a"] },
    }),
    {
      id: "acme.marketplace-helper",
      installed: true,
      installation: { scope: "projects", projectIds: ["project-a"] },
    },
  );
  assert.deepEqual(
    await gateway.invoke("clash_plugin_rollback", {
      id: "acme.caption-helper",
    }),
    {
      rolledBack: true,
      id: "acme.caption-helper",
      targetDir: "/managed/actions/acme.caption-helper",
      version: "0.0.9",
    },
  );
  assert.deepEqual(
    await gateway.invoke("clash_plugin_uninstall", {
      id: "acme.caption-helper",
    }),
    {
      uninstalled: true,
      id: "acme.caption-helper",
      removed: true,
      trashDir: "/managed/trash/acme.caption-helper",
    },
  );
});
