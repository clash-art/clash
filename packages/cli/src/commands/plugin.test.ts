import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activateDownloadedActionPackage,
  activateExecutablePluginDraft,
  checkoutExecutablePluginDraft,
  rollbackDownloadedActionPackage,
  scaffoldExecutablePluginDraft,
  tryInstallLocalMarketplacePlugin,
  validateDownloadedActionPackage,
} from "../lib/plugin-lifecycle";
import { pluginCommand } from "./plugin";

function executablePackage(version = "1.0.0") {
  return {
    id: "test.plugin",
    manifest: {
      apiVersion: "clash.plugin/v1",
      id: "test.plugin",
      version,
      name: "Test Plugin",
      runtime: {
        kind: "local",
        transport: "stdio",
        language: "node",
        entrypoint: "handler.mjs",
      },
      contributes: { cards: [], functions: [] },
      contractTests: [],
    },
    files: {
      "handler.mjs": Buffer.from("export {};\n").toString("base64"),
    },
  };
}

function generatorPackage() {
  const pkg = executablePackage();
  pkg.manifest.contributes = {
    cards: [],
    functions: [{ id: "render", kind: "action" }],
    generators: [
      {
        id: "test-generator",
        kind: "generator",
        path: "generators/test-generator.json",
      },
    ],
  } as never;
  const files: Record<string, string> = pkg.files;
  files["generators/test-generator.json"] = Buffer.from(
    JSON.stringify({
      apiVersion: "clash.generator/v1",
      kind: "generator",
      spec: {
        definitionId: "test-generator",
        stateSchema: { type: "object" },
        editPolicy: "advance-head",
        persistentInputs: [],
        actions: [
          {
            id: "render",
            executorExportId: "render",
            parametersSchema: { type: "object" },
            invocationInputs: [],
            outputs: [
              {
                slot: "media",
                assetType: { kind: "media", mediaKind: "image" },
                cardinality: { minItems: 1, maxItems: 1 },
              },
            ],
          },
        ],
      },
    }),
  ).toString("base64");
  return pkg;
}

test("plugin CLI exposes draft and lifecycle commands", () => {
  const commandNames = pluginCommand.commands.map((command) => command.name());
  for (const name of [
    "create",
    "checkout",
    "validate",
    "activate",
    "rollback",
  ]) {
    assert.ok(commandNames.includes(name), `missing plugin ${name}`);
  }
});

for (const kind of ["skill", "executable-plugin"] as const) {
  test(`plugin install routes ${kind} through its Host descriptor with project scope`, async () => {
    const item = kind === "skill"
      ? { id: "test.skill", type: "skill", installation: { kind, skillId: "test.skill" } }
      : { id: "test.plugin", type: "plugin", runtime: "local", packageId: "test.package", installation: { kind, pluginId: "test.plugin", packageId: "test.package" } };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const scope = { scope: "projects" as const, projectIds: ["project-a"] };
    const result = await tryInstallLocalMarketplacePlugin({
      packageId: item.id,
      serverUrl: "http://127.0.0.1:49321",
      installation: scope,
      apiKey: "local-token",
      request: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json(calls.length === 1
          ? { skills: kind === "skill" ? [item] : [], plugins: kind === "skill" ? [] : [item] }
          : { installed: true, ...(kind === "skill" ? { skillId: item.id } : { id: item.id }) });
      },
    });
    assert.equal(calls[0]?.url, "http://127.0.0.1:49321/api/marketplace/registry");
    assert.equal(calls[1]?.url, kind === "skill"
      ? "http://127.0.0.1:49321/api/marketplace/skills/test.skill/install"
      : "http://127.0.0.1:49321/api/marketplace/plugins/test.package/install");
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), scope);
    assert.equal(result?.id, item.id);
    assert.equal(result?.installed, true);
  });
}

test("downloaded executable packages are validated before reaching the host", () => {
  const validated = validateDownloadedActionPackage(executablePackage());
  assert.equal(validated.format, "executable-plugin");
  assert.equal(validated.id, "test.plugin");
  assert.throws(
    () =>
      validateDownloadedActionPackage({ ...executablePackage(), files: {} }),
    /entrypoint .* is missing/i,
  );
  assert.throws(
    () =>
      validateDownloadedActionPackage({
        id: "legacy-action",
        manifest: {
          id: "legacy-action",
          name: "Legacy Action",
          runtime: "local",
          outputType: "text",
        },
        files: {},
      }),
    /expected a clash\.plugin\/v1 executable plugin/i,
  );
});

test("downloaded packages expose validated native Generator documents", () => {
  const validated = validateDownloadedActionPackage(generatorPackage());

  assert.deepEqual(Object.keys(validated.generators), [
    "generators/test-generator.json",
  ]);
  assert.equal(
    validated.generators["generators/test-generator.json"]?.spec.definitionId,
    "test-generator",
  );
  const document = validated.generators["generators/test-generator.json"]!;
  assert.equal("runtime" in document, false);
  assert.equal("realm" in document, false);
});

test("plugin lifecycle is a local-api client and never writes daemon storage", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) }
        : {}),
    });
    if (url.endsWith("/api/v1/local/plugins/test.plugin/package")) {
      return Response.json({ ...executablePackage(), version: "1.0.0" });
    }
    if (url.endsWith("/rollback")) {
      return Response.json({
        targetDir: "/host/actions/test.plugin",
        version: "0.9.0",
      });
    }
    return Response.json({
      id: "test.plugin",
      version: "1.0.0",
      targetDir: "/host/actions/test.plugin",
      contractTests: { passed: 0 },
    });
  };
  process.env.CLASH_API_URL = "http://127.0.0.1:49321";
  try {
    const activated =
      await activateDownloadedActionPackage(executablePackage());
    assert.equal(activated.targetDir, "/host/actions/test.plugin");

    const workspace = await mkdtemp(join(tmpdir(), "clash-plugin-client-"));
    const checkout = await checkoutExecutablePluginDraft({
      id: "test.plugin",
      pluginDir: join(workspace, "draft"),
    });
    assert.equal(checkout.version, "1.0.0");
    assert.equal(
      JSON.parse(
        await readFile(join(checkout.pluginDir, "manifest.json"), "utf8"),
      ).id,
      "test.plugin",
    );
    await rollbackDownloadedActionPackage("test.plugin");

    assert.deepEqual(
      calls.map(({ url, method }) => [new URL(url).pathname, method]),
      [
        ["/api/v1/local/plugins/activate", "POST"],
        ["/api/v1/local/plugins/test.plugin/package", "GET"],
        ["/api/v1/local/plugins/test.plugin/rollback", "POST"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLASH_API_URL;
  }
});

test("plugin scaffold asks local-api to validate the generated package", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id: "test.caption-helper",
      version: "0.1.0",
      contractTests: { passed: 1 },
    });
  process.env.CLASH_API_URL = "http://127.0.0.1:49321";
  try {
    const workspace = await mkdtemp(join(tmpdir(), "clash-plugin-scaffold-"));
    const created = await scaffoldExecutablePluginDraft({
      pluginDir: join(workspace, "caption-helper"),
      id: "test.caption-helper",
      kind: "action",
    });
    assert.equal(created.contractTests.passed, 1);
    const manifest = JSON.parse(
      await readFile(created.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    assert.ok(manifest.contributes);
    assert.equal("exports" in manifest, false);
    assert.equal("permissions" in manifest, false);
    const guidance = await readFile(
      join(created.pluginDir, "AGENTS.md"),
      "utf8",
    );
    assert.match(guidance, /contributes/);
    assert.match(guidance, /context\.store/);
    assert.doesNotMatch(
      guidance,
      /permissions|network\.fetch|credential\.handle/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLASH_API_URL;
  }
});


test("plugin draft activation forwards explicit scope and leaves omitted scope unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clash-plugin-activation-scope-"));
  try {
    const pkg = executablePackage();
    await writeFile(join(dir, "manifest.json"), JSON.stringify(pkg.manifest));
    await writeFile(join(dir, "handler.mjs"), Buffer.from(pkg.files["handler.mjs"], "base64"));
    const bodies: Record<string, unknown>[] = [];
    const hostRequest = async <T>(_path: string, init?: RequestInit): Promise<T> => {
      bodies.push(JSON.parse(String(init?.body)));
      return { id: pkg.id, version: "1.0.0", targetDir: "/host/actions/test.plugin" } as T;
    };
    await activateExecutablePluginDraft({ pluginDir: dir, hostRequest, installation: { scope: "projects", projectIds: ["project-a"] } });
    await activateExecutablePluginDraft({ pluginDir: dir, hostRequest });
    assert.deepEqual(bodies[0]?.installation, { scope: "projects", projectIds: ["project-a"] });
    assert.equal(Object.hasOwn(bodies[1]!, "installation"), false);
    const activate = pluginCommand.commands.find(command => command.name() === "activate")!;
    assert.ok(activate.options.some(option => option.long === "--project"));
    assert.ok(activate.options.some(option => option.long === "--global"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
