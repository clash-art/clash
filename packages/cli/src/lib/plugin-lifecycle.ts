import { marketplaceInstallation, type MarketplaceInstallableItem } from "@clash/shared-types/marketplace-installation";
import type { HostInstallScope } from "@clash/shared-types";
import { pluginIdSchema } from "@clash/shared-types";
import {
  lstat,
  mkdir as mkdirAsync,
  readFile as readFileAsync,
  readdir as readdirAsync,
  rm,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ExecutablePluginManifestSchema,
  isSafePluginRelativePath,
  validateExecutablePluginPackage,
  type ExecutablePluginGeneratorDocument,
  type ExecutablePluginViewDocument,
} from "@clash/shared-types";
import { getServerUrl } from "./config";
import { assertDraftOutsideManagedStorage } from "./plugin-draft-location";
import { buildPluginEntrypointIfDeclared } from "./plugin-build";

/**
 * Plugin package lifecycle is owned by local-api. The CLI prepares packages
 * and sends them through the local host protocol; it never writes live host
 * storage or starts plugin subprocesses itself.
 */
export { assertDraftOutsideManagedStorage };

export interface LocalPluginHostRequest {
  <T>(path: string, init?: RequestInit): Promise<T>;
}

export function createLocalPluginHostRequest(options: {
  serverUrl: string;
  apiKey?: string;
  request?: typeof fetch;
}): LocalPluginHostRequest {
  const request = options.request ?? fetch;
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request(
      `${options.serverUrl.replace(/\/+$/, "")}${path}`,
      {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(options.apiKey
            ? { Authorization: `Bearer ${options.apiKey}` }
            : {}),
          ...(init?.headers ?? {}),
        },
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    } & T;
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `Local Clash host returned ${response.status} ${response.statusText}.`,
      );
    }
    return body;
  };
}

async function requestLocalPluginHost<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return createLocalPluginHostRequest({ serverUrl: getServerUrl() })(
    path,
    init,
  );
}

/** Portable executable-plugin archive used by validation and activation. */
interface ActionPackage {
  id: string;
  manifest: Record<string, unknown> & { id: string; version?: string };
  /** path → base64-encoded contents. */
  files: Record<string, string>;
}

export interface ValidatedDownloadedActionPackage extends ActionPackage {
  format: "executable-plugin";
  generators: Record<string, ExecutablePluginGeneratorDocument>;
  views: Record<string, ExecutablePluginViewDocument>;
}

export interface LocalMarketplaceInstallResult {
  id: string;
  installed: true;
  installation: HostInstallScope;
}

export async function tryInstallLocalMarketplacePlugin(options: {
  packageId: string;
  serverUrl: string;
  installation: HostInstallScope;
  apiKey?: string;
  request?: typeof fetch;
}): Promise<LocalMarketplaceInstallResult | null> {
  const request = createLocalPluginHostRequest(options);
  const catalog = await request<{ plugins?: MarketplaceInstallableItem[]; skills?: MarketplaceInstallableItem[] }>("/api/marketplace/registry");
  const items = [...(catalog.plugins ?? []), ...(catalog.skills ?? [])];
  const item = items.find((candidate) => candidate.id === options.packageId)
    ?? items.find((candidate) => candidate.packageId === options.packageId);
  if (!item) return null;
  const target = marketplaceInstallation(item);
  if (!target) throw new Error("This Host does not offer installation for this plugin.");
  const path = target.kind === "skill"
    ? `/api/marketplace/skills/${encodeURIComponent(target.skillId)}/install`
    : `/api/marketplace/plugins/${encodeURIComponent(target.packageId)}/install`;
  const result = await request<{ installed?: boolean; id?: string; skillId?: string }>(path, {
    method: "POST",
    body: JSON.stringify(options.installation),
  });
  if (result.installed !== true || (target.kind === "skill" ? result.skillId : result.id) !== item.id) {
    throw new Error("Host did not confirm plugin installation.");
  }
  return { id: item.id, installed: true, installation: options.installation };
}

function packageRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** Validate the complete package in memory before the installer mutates disk. */
export function validateDownloadedActionPackage(
  input: unknown,
): ValidatedDownloadedActionPackage {
  const pkg = packageRecord(input, "Action package");
  const id = typeof pkg.id === "string" ? pkg.id : "";
  if (!id) throw new Error("Action package id is required.");
  const manifestInput = packageRecord(pkg.manifest, "Action package manifest");
  const filesInput = packageRecord(pkg.files, "Action package files");
  const files: Record<string, string> = {};
  for (const [path, contents] of Object.entries(filesInput)) {
    if (!isSafePluginRelativePath(path)) {
      throw new Error(`Refusing suspicious file path in package: ${path}`);
    }
    if (typeof contents === "string") files[path] = contents;
  }

  if (manifestInput.apiVersion !== "clash.plugin/v1") {
    throw new Error(
      "Unsupported package protocol; expected a clash.plugin/v1 executable plugin.",
    );
  }
  const parsedManifest = ExecutablePluginManifestSchema.parse(manifestInput);
  const contributions = parsedManifest.contributes;
  if (parsedManifest.id !== id) {
    throw new Error(
      `Package id ${id} does not match plugin manifest id ${parsedManifest.id}.`,
    );
  }
  if (
    parsedManifest.runtime.kind === "local" &&
    typeof files[parsedManifest.runtime.entrypoint] !== "string"
  ) {
    throw new Error(
      `Plugin entrypoint ${parsedManifest.runtime.entrypoint} is missing.`,
    );
  }
  const cardDocuments: Record<string, unknown> = {};
  for (const card of contributions.cards) {
    const encoded = files[card.path];
    if (typeof encoded !== "string") {
      throw new Error(`Missing declared Card document: ${card.path}`);
    }
    try {
      cardDocuments[card.path] = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
    } catch (error) {
      throw new Error(
        `Invalid Card JSON at ${card.path}: ${(error as Error).message}`,
      );
    }
  }
  const providerDocuments: Record<string, unknown> = {};
  for (const provider of contributions.providers) {
    const encoded = files[provider.path];
    if (typeof encoded !== "string") {
      throw new Error(`Missing declared Provider document: ${provider.path}`);
    }
    try {
      providerDocuments[provider.path] = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
    } catch (error) {
      throw new Error(
        `Invalid Provider JSON at ${provider.path}: ${(error as Error).message}`,
      );
    }
  }
  const modelBindingDocuments: Record<string, unknown> = {};
  for (const binding of contributions.modelBindings) {
    const encoded = files[binding.path];
    if (typeof encoded !== "string") {
      throw new Error(
        `Missing declared model Provider binding: ${binding.path}`,
      );
    }
    try {
      modelBindingDocuments[binding.path] = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
    } catch (error) {
      throw new Error(
        `Invalid model Provider binding JSON at ${binding.path}: ${(error as Error).message}`,
      );
    }
  }
  const generatorDocuments: Record<string, unknown> = {};
  for (const generator of contributions.generators) {
    const encoded = files[generator.path];
    if (typeof encoded !== "string") {
      throw new Error(`Missing declared Generator document: ${generator.path}`);
    }
    try {
      generatorDocuments[generator.path] = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
    } catch (error) {
      throw new Error(
        `Invalid Generator JSON at ${generator.path}: ${(error as Error).message}`,
      );
    }
  }
  const viewDocuments: Record<string, unknown> = {};
  for (const view of contributions.views) {
    const encoded = files[view.path];
    if (typeof encoded !== "string") {
      throw new Error(`Missing declared View document: ${view.path}`);
    }
    try {
      viewDocuments[view.path] = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
    } catch (error) {
      throw new Error(
        `Invalid View JSON at ${view.path}: ${(error as Error).message}`,
      );
    }
  }
  const contractTestDocuments: Record<string, unknown> = {};
  for (const path of parsedManifest.contractTests) {
    const encoded = files[path];
    if (typeof encoded !== "string") {
      throw new Error(`Missing declared contract test: ${path}`);
    }
    try {
      contractTestDocuments[path] = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
    } catch (error) {
      throw new Error(
        `Invalid contract test JSON at ${path}: ${(error as Error).message}`,
      );
    }
  }
  const validated = validateExecutablePluginPackage(
    parsedManifest,
    cardDocuments,
    contractTestDocuments,
    {
      providers: providerDocuments,
      modelBindings: modelBindingDocuments,
      generators: generatorDocuments,
      views: viewDocuments,
    },
  );
  return {
    id,
    format: "executable-plugin",
    manifest: validated.manifest,
    files,
    generators: validated.generators,
    views: validated.views,
  };
}

export interface ActivatedDownloadedActionPackage {
  id: string;
  version: string;
  targetDir: string;
  rollbackDir?: string;
  contractTests?: PluginContractTestRun;
}

export interface PluginContractTestRun {
  passed: number;
  results?: unknown[];
}

export interface ValidatedExecutablePluginDraft {
  package: ValidatedDownloadedActionPackage & { format: "executable-plugin" };
  contractTests: PluginContractTestRun;
}

export interface ScaffoldExecutablePluginDraftOptions {
  pluginDir: string;
  id: string;
  name?: string;
  kind?: "action" | "provider-projector" | "provider-executor";
  /**
   * Implementation language. TypeScript drafts carry source only and the host
   * compiles them; Python runs its source directly and declares no build.
   */
  language?: "ts" | "python";
  hostRequest?: LocalPluginHostRequest;
}

export interface ScaffoldedExecutablePluginDraft {
  pluginDir: string;
  manifestPath: string;
  cardPath: string;
  contractTestPath: string;
  contractTests: PluginContractTestRun;
}

export interface CheckoutExecutablePluginDraftOptions {
  id: string;
  pluginDir: string;
  hostRequest?: LocalPluginHostRequest;
}

/**
 * Copy one attested active package to a separate agent-editable draft. This
 * keeps exploratory edits from invalidating the running package receipt.
 */
export async function checkoutExecutablePluginDraft(
  options: CheckoutExecutablePluginDraftOptions,
): Promise<{ pluginDir: string; id: string; version: string }> {
  // One rule, in one place. A local copy of the pattern is a rule that can be right here and wrong
  // at activation, which is where an id mistake used to surface -- as a regex, in a schema error,
  // in a file the author had not opened.
  const id = pluginIdSchema.parse(options.id);
  const targetDir = resolve(options.pluginDir);
  const requestHost = options.hostRequest ?? requestLocalPluginHost;
  const pkg = await requestHost<
    ValidatedDownloadedActionPackage & {
      version: string;
    }
  >(`/api/v1/local/plugins/${encodeURIComponent(id)}/package`);
  if (pkg.id !== id) {
    throw new Error(`Host returned plugin ${pkg.id} for ${id}.`);
  }

  await mkdirAsync(dirname(targetDir), { recursive: true });
  try {
    await mkdirAsync(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Plugin draft directory already exists: ${targetDir}`);
    }
    throw error;
  }
  try {
    await writeFileAsync(
      join(targetDir, "manifest.json"),
      `${JSON.stringify(pkg.manifest, null, 2)}\n`,
    );
    for (const [relativePath, encoded] of Object.entries(pkg.files)) {
      const destination = join(targetDir, relativePath);
      await mkdirAsync(dirname(destination), { recursive: true });
      await writeFileAsync(destination, Buffer.from(encoded, "base64"));
    }
    return { pluginDir: targetDir, id, version: pkg.version };
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultPluginName(id: string): string {
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/**
 * Create a complete, editable local plugin package for an agent. The generated
 * Card, manifest, stdio handler and declarative contract are validated before
 * the directory is handed back. Existing paths are never merged or replaced.
 */
export async function scaffoldExecutablePluginDraft(
  options: ScaffoldExecutablePluginDraftOptions,
): Promise<ScaffoldedExecutablePluginDraft> {
  const pluginDir = resolve(options.pluginDir);
  const id = options.id.trim();
  const name = options.name?.trim() || defaultPluginName(id);
  const kind = options.kind ?? "action";
  if (
    kind !== "action" &&
    kind !== "provider-projector" &&
    kind !== "provider-executor"
  ) {
    throw new Error(`Unsupported plugin kind ${String(kind)}.`);
  }
  const language = options.language ?? "ts";
  if (language !== "ts" && language !== "python") {
    throw new Error(
      `Unsupported plugin language ${String(language)}; use ts or python.`,
    );
  }

  const functionKind = kind;
  const cardKind = kind === "action" ? "action-card" : "model-card";
  const outputSlot = kind === "action" ? "result" : "request";
  // An action returns rendered text; a projector returns the prompt it composed.
  const valueKey = kind === "action" ? "text" : "prompt";
  const cardPath = `cards/${id}.json`;
  const contractTestPath = `contract-tests/${id}.json`;
  const manifest = {
    apiVersion: "clash.plugin/v1",
    id,
    version: "0.1.0",
    name,
    description: `Agent-editable ${kind} plugin.`,
    runtime:
      language === "python"
        ? // Python runs its source directly, so there is nothing to build.
          {
            kind: "local",
            transport: "stdio",
            language: "python",
            entrypoint: "handler.py",
          }
        : // TypeScript is compiled by the host before validation, contract tests, and
          // activation, so the draft carries source only and never a stale bundle.
          {
            kind: "local",
            transport: "stdio",
            language: "node",
            entrypoint: "dist/stdio.mjs",
            build: { source: "src/stdio.ts" },
          },
    contributes: {
      cards: [{ id, kind: cardKind, path: cardPath }],
      functions: [{ id, kind: functionKind }],
    },
    contractTests: [contractTestPath],
  };
  const card =
    kind === "action"
      ? {
          apiVersion: "clash.card/v1",
          kind: "action-card",
          spec: {
            id,
            name,
            description:
              "Edit this Card to define the user-facing inputs and output.",
            parameters: [],
            outputType: "text",
            input: {
              requiresPrompt: true,
              inputMode: {},
              promptModalities: ["text"],
            },
            functionExportId: id,
          },
        }
      : {
          apiVersion: "clash.card/v1",
          kind: "model-card",
          spec: {
            id,
            aliases: [],
            name,
            provider: "fal",
            kind: "video",
            description:
              "Replace the placeholder upstream route and extend this Card.",
            parameters: [],
            defaultParams: {},
            defaultAspectRatio: "16:9",
            input: {
              requiresPrompt: true,
              inputMode: {},
              promptModalities: ["text"],
            },
            providerImplementations: [
              {
                providerId: "fal",
                upstreamId: `${id}:default`,
                upstreamModel: "replace-me",
                apiShape: "custom",
                projectorExportId: id,
              },
            ],
          },
        };
  const expectedValue =
    kind === "action"
      ? { text: "Describe the result" }
      : { prompt: "Describe the result" };
  const contractTest = {
    apiVersion: "clash.plugin.contract-test/v1",
    id: `${id}-basic`,
    target: { exportId: id, kind: functionKind },
    input: { values: { prompt: "Describe the result" }, references: [] },
    expect: {
      status: "completed",
      outputs: [
        {
          slot: kind === "action" ? "result" : "request",
          kind: "value",
          value: expectedValue,
        },
      ],
    },
  };

  // Reject malformed ids or generated contracts before touching the target.
  validateExecutablePluginPackage(
    manifest,
    { [cardPath]: card },
    { [contractTestPath]: contractTest },
  );

  await mkdirAsync(dirname(pluginDir), { recursive: true });
  try {
    await mkdirAsync(pluginDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Plugin draft directory already exists: ${pluginDir}`);
    }
    throw error;
  }

  try {
    await mkdirAsync(join(pluginDir, "cards"));
    await mkdirAsync(join(pluginDir, "contract-tests"));
    await writeFileAsync(
      join(pluginDir, "manifest.json"),
      jsonDocument(manifest),
    );
    await writeFileAsync(join(pluginDir, cardPath), jsonDocument(card));
    await writeFileAsync(
      join(pluginDir, contractTestPath),
      jsonDocument(contractTest),
    );
    if (language === "python") {
      // Python is the case with nothing to build, so the draft ships the program the
      // plugin runtime executes.
      await writeFileAsync(
        join(pluginDir, "handler.py"),
        [
          "import json",
          "import sys",
          "",
          `EXPORT_ID = ${JSON.stringify(id)}`,
          "",
          "for line in sys.stdin:",
          "    invocation = json.loads(line)",
          '    if invocation.get("protocol") != "clash.plugin.invoke/v1":',
          "        continue",
          '    prompt = (invocation.get("input") or {}).get("values", {}).get("prompt") or ""',
          '    if (invocation.get("target") or {}).get("exportId") == EXPORT_ID:',
          "        result = {",
          '            "protocol": "clash.plugin.result/v1",',
          '            "invocationId": invocation["invocationId"],',
          '            "status": "completed",',
          `            "outputs": [{"slot": ${JSON.stringify(outputSlot)}, "kind": "value", "value": {${JSON.stringify(valueKey)}: prompt}}],`,
          "        }",
          "    else:",
          "        result = {",
          '            "protocol": "clash.plugin.result/v1",',
          '            "invocationId": invocation["invocationId"],',
          '            "status": "failed",',
          '            "error": {"code": "invalid_request", "message": "Unknown export", "retryable": False, "requestState": "rejected"},',
          "        }",
          '    sys.stdout.write(json.dumps(result) + "\\n")',
          "    sys.stdout.flush()",
          "",
        ].join("\n"),
      );
    } else {
      // TypeScript drafts carry source only. The host compiles it before validation,
      // contract tests, and activation, so an edited draft can never be checked
      // against a stale bundle.
      await mkdirAsync(join(pluginDir, "src"), { recursive: true });
      await writeFileAsync(
        join(pluginDir, "src", "stdio.ts"),
        [
          'import { definePlugin } from "@clash/action-sdk";',
          "",
          `const exportId = ${JSON.stringify(id)};`,
          "",
          "void definePlugin({",
          "  executors: {",
          "    [exportId]: {",
          "      async submit(invocation, context) {",
          '        const prompt = typeof invocation.input.values.prompt === "string" ? invocation.input.values.prompt : "";',
          "        // context.reference and context.upload resolve and save invocation-scoped media.",
          "        return {",
          '          status: "completed",',
          `          outputs: [{ slot: ${JSON.stringify(outputSlot)}, kind: "value", value: { ${valueKey}: prompt } }],`,
          "        };",
          "      },",
          "    },",
          "  },",
          "}).start();",
          "",
        ].join("\n"),
      );
    }
    await writeFileAsync(
      join(pluginDir, "AGENTS.md"),
      [
        "# Executable Plugin Authoring",
        "",
        "This directory is intentionally agent-editable.",
        "",
        "- Keep `manifest.json`, every Card, and every contract on the versioned Clash v1 schemas.",
        "- Declare Cards, Providers, bindings, functions, and host tools under `manifest.json#contributes`.",
        "- Keep provider wire-shape translation in the handler; keep user-facing fields in the Card.",
        "- Read account credentials and settings only from the Host-scoped `context.store`; never accept them from invocation values.",
        "- Use the SDK's typed `context.reference`, `context.upload`, and output shapes for Clash-owned assets.",
        "- Import the bundled SDK from `@clash/action-sdk`; validate/activate resolves it automatically, without a separate npm installation.",
        "- Provider HTTP belongs to the plugin and uses its runtime's normal HTTP client directly.",
        "- Run `clash plugin validate .` after edits.",
        "- Bump `manifest.json` version for code or schema changes, then run `clash plugin activate .`.",
        "",
      ].join("\n"),
    );

    const validated = await validateExecutablePluginDraft(
      pluginDir,
      options.hostRequest,
    );
    return {
      pluginDir,
      manifestPath: join(pluginDir, "manifest.json"),
      cardPath: join(pluginDir, cardPath),
      contractTestPath: join(pluginDir, contractTestPath),
      contractTests: validated.contractTests,
    };
  } catch (error) {
    await rm(pluginDir, { recursive: true, force: true });
    throw error;
  }
}

async function collectPluginDraftFiles(
  root: string,
  directory: string,
  output: Record<string, string>,
): Promise<void> {
  for (const entry of await readdirAsync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const absolutePath = join(directory, entry.name);
    const relativePath = absolutePath
      .slice(root.length + 1)
      .split("\\")
      .join("/");
    if (!isSafePluginRelativePath(relativePath)) {
      throw new Error(`Refusing suspicious draft path: ${relativePath}`);
    }
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Executable plugin drafts cannot contain symbolic links: ${relativePath}`,
      );
    }
    if (metadata.isDirectory()) {
      await collectPluginDraftFiles(root, absolutePath, output);
      continue;
    }
    if (!metadata.isFile() || relativePath === "manifest.json") continue;
    output[relativePath] = (await readFileAsync(absolutePath)).toString(
      "base64",
    );
  }
}

/** Load and strictly validate an agent-edited unpacked plugin directory. */
export async function packageExecutablePluginDraft(
  pluginDir: string,
): Promise<ValidatedDownloadedActionPackage & { format: "executable-plugin" }> {
  const manifest = JSON.parse(
    await readFileAsync(join(pluginDir, "manifest.json"), "utf8"),
  ) as {
    id?: unknown;
  };
  if (typeof manifest.id !== "string") {
    throw new Error("Executable plugin draft manifest id is required.");
  }
  const files: Record<string, string> = {};
  await collectPluginDraftFiles(pluginDir, pluginDir, files);
  const validated = validateDownloadedActionPackage({
    id: manifest.id,
    manifest,
    files,
  });
  if (validated.format !== "executable-plugin") {
    throw new Error(
      "Agent draft activation requires a clash.plugin/v1 package.",
    );
  }
  return validated as ValidatedDownloadedActionPackage & {
    format: "executable-plugin";
  };
}

/** Validate Cards/manifest and execute every declared contract without mutating active state. */
export async function validateExecutablePluginDraft(
  pluginDir: string,
  hostRequest: LocalPluginHostRequest = requestLocalPluginHost,
): Promise<ValidatedExecutablePluginDraft> {
  // Compile before packaging, so the manifest, the content hash, and the contract
  // tests all describe the source that is actually present. Leaving this to the
  // author meant an edited `src/` could report `valid: true` while every check ran
  // against the previous bundle.
  await buildDeclaredPluginEntrypoint(pluginDir);
  const pkg = await packageExecutablePluginDraft(pluginDir);
  const validated = await hostRequest<{
    contractTests?: PluginContractTestRun;
  }>("/api/v1/local/plugins/validate", {
    method: "POST",
    body: JSON.stringify(pkg),
  });
  const contractTests = validated.contractTests ?? { passed: 0 };
  return { package: pkg, contractTests };
}

/** Read the draft manifest and compile its entrypoint when one is declared derived. */
async function buildDeclaredPluginEntrypoint(pluginDir: string): Promise<void> {
  let runtime: unknown;
  try {
    const manifest = JSON.parse(
      await readFileAsync(join(pluginDir, "manifest.json"), "utf8"),
    ) as { runtime?: unknown; spec?: { runtime?: unknown } };
    runtime = manifest.runtime ?? manifest.spec?.runtime;
  } catch {
    // A malformed or missing manifest is reported by validation itself, with a much
    // better message than anything this step could produce.
    return;
  }
  if (!runtime || typeof runtime !== "object") return;
  await buildPluginEntrypointIfDeclared(
    pluginDir,
    runtime as { kind?: string },
  );
}

export interface ActivateExecutablePluginDraftOptions {
  pluginDir: string;
  hostRequest?: LocalPluginHostRequest;
  /** Omission preserves the active package's existing scope. */
  installation?: HostInstallScope;
}

/**
 * Agent self-evolution gate: validate and test a draft, ask for any capability
 * increase, then atomically replace the active package with rollback retained.
 */
export async function activateExecutablePluginDraft(
  options: ActivateExecutablePluginDraftOptions,
): Promise<
  ActivatedDownloadedActionPackage & {
    contractTests: PluginContractTestRun;
  }
> {
  await buildDeclaredPluginEntrypoint(options.pluginDir);
  const pkg = await packageExecutablePluginDraft(options.pluginDir);
  const activated = await (
    options.hostRequest ?? requestLocalPluginHost
  )<ActivatedDownloadedActionPackage>("/api/v1/local/plugins/activate", {
    method: "POST",
    body: JSON.stringify({ ...pkg, ...(options.installation ? { installation: options.installation } : {}) }),
  });
  return {
    ...activated,
    contractTests: activated.contractTests ?? { passed: 0 },
  };
}

/** Ask the local-api host to validate and atomically activate a package. */
export async function activateDownloadedActionPackage(
  input: unknown,
  _legacyRoot?: string,
): Promise<ActivatedDownloadedActionPackage> {
  const pkg = validateDownloadedActionPackage(input);
  if (pkg.format !== "executable-plugin") {
    throw new Error(
      "Legacy local action packages are no longer supported by local-api.",
    );
  }
  return requestLocalPluginHost<ActivatedDownloadedActionPackage>(
    "/api/v1/local/plugins/activate",
    { method: "POST", body: JSON.stringify(pkg) },
  );
}

/** Ask the local-api host to restore the newest retained package version. */
export async function rollbackDownloadedActionPackage(
  id: string,
  hostRequest: LocalPluginHostRequest = requestLocalPluginHost,
): Promise<{ targetDir: string; version: string }> {
  return hostRequest<{ targetDir: string; version: string }>(
    `/api/v1/local/plugins/${encodeURIComponent(pluginIdSchema.parse(id))}/rollback`,
    { method: "POST" },
  );
}
