import { createStructuredLogger } from "@clash/shared-runtime/logging";

const actionLog = createStructuredLogger({ component: "local-api", module: "plugins", level: process.env.CLASH_LOG_LEVEL === "debug" ? "debug" : "info" });
/**
 * Local executable-plugin host.
 *
 * Every child is an activated `clash.plugin/v1` package. Invocations and
 * Host-owned dependencies travel over the versioned stdio protocol; plugin
 * processes never receive a Clash API key or a second websocket mutation path.
 */

import { providerRegistrationsFrom } from "./provider-declarations.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { deepStrictEqual } from "node:assert";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
  writeFileSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  ExecutablePluginActivationReceiptSchema,
  executablePluginDependencyError,
  ExecutablePluginManifestSchema,
  ExecutablePluginInvocationSchema,
  generatorDefinitionFromExecutablePluginRegistration,
  isSafePluginRelativePath,
  validateExecutablePluginPackage,
  type ExecutablePluginResult,
  type ExecutablePluginManifest,
  type ExecutablePluginBinding,
  type ExecutablePluginCardRegistration,
  type ExecutablePluginProviderRegistration,
  type ExecutablePluginFunctionExport,
  type ExecutablePluginModelBindingRegistration,
  type ExecutablePluginGeneratorRegistration,
  type ExecutablePluginViewRegistration,
  type GeneratorDefinition,
  type ExecutablePluginActivationReceipt,
  type ExecutablePluginCardDocument,
  type ExecutablePluginProviderDocument,
  type ExecutablePluginModelBindingDocument,
  type ExecutablePluginGeneratorDocument,
  type ExecutablePluginViewDocument,
  type ExecutablePluginContractTestDocument,
  resolvePluginLanguage,
} from "@clash/shared-types";
import { paths } from "./platform.js";
import {
  PluginStdioSession,
  type PluginBroker,
} from "./plugin-stdio-runner.js";
import {
  createModulePluginEndpoint,
  type PluginExecutionEndpoint,
} from "./plugin-module-runner.js";
import { providerHttpInstrumentationPythonPath } from "../../../provider-http-instrumentation-python.js";
import type {
  LoadedTrustedBundledPluginModule,
  TrustedBundledPluginModuleRegistration,
} from "../../../bundled-plugin-modules.js";

export { executablePluginDependencyError, PluginStdioSession };
export type { PluginBroker };

const RESTART_BACKOFF_MIN_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 60_000;
const HEALTHY_UPTIME_MS = 60_000;
const FAST_EXIT_DISABLE_MS = 2_000;
const SHUTDOWN_GRACE_MS = 5_000;
const PYTHON_DEPS_STAMP = ".clash-python-deps.json";
/**
 * Debounce window for fs.watch events. node's watcher fires
 * multiple times for a single semantic change (atomic rename →
 * rename + change; CLI install writes many files → change-per-file).
 * 500ms collapses those into one reconcile pass without making the
 * UX feel laggy.
 */
const WATCH_DEBOUNCE_MS = 500;

function actionsDir(): string {
  return join(paths().configDir, "actions");
}

export interface ActionEnv {
  /** Kernel-owned asset/store/tool context for v1 stdio plugins. */
  pluginBroker?: PluginBroker;
  /** Override for embedded/self-hosted kernels that share local hosting code. */
  actionsRoot?: string;
  /** Test-runner-owned HTTP recording/replay preloaded outside plugin business code. */
  providerHttpInstrumentation?: ProviderHttpInstrumentationLaunch;
  /**
   * Workspace source directories that should restart one already-attested plugin in development.
   *
   * This is deliberately only a restart signal. It does not replace the manifest, entrypoint or
   * activation receipt, so a normal/production host cannot use it to run unactivated code. The
   * local-api development entrypoint installs an attested launcher that loads the named source and
   * then supplies these roots so edits are picked up without rebuilding a package.
   */
  developmentPluginWatchRoots?: Readonly<Record<string, readonly string[]>>;
  /** Closed Host trust registry for first-party modules; never populated from disk or a manifest. */
  trustedBundledPluginModules?: readonly TrustedBundledPluginModuleRegistration[];
  /** Resolves one entry from the closed registry to its immutable packaged module payload. */
  loadTrustedBundledPluginModule?: (
    pluginId: string,
  ) => Promise<LoadedTrustedBundledPluginModule>;
}

export interface ProviderHttpInstrumentationLaunch {
  mode: "record" | "replay";
  trafficPath: string;
  activeStubPath?: string;
  modulePath: string;
  loaderPath?: string;
}

type LocalExecutablePluginManifest = ExecutablePluginManifest & {
  runtime: Extract<ExecutablePluginManifest["runtime"], { kind: "local" }>;
};

interface HostedActionPackage {
  manifest: LocalExecutablePluginManifest;
  cards: Record<string, ExecutablePluginCardDocument>;
  providers: Record<string, ExecutablePluginProviderDocument>;
  modelBindings: Record<string, ExecutablePluginModelBindingDocument>;
  generators: Record<string, ExecutablePluginGeneratorDocument>;
  views: Record<string, ExecutablePluginViewDocument>;
  contractTests: Record<string, ExecutablePluginContractTestDocument>;
}

async function readHostedPackage(dir: string): Promise<HostedActionPackage> {
  const raw = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const manifest = ExecutablePluginManifestSchema.parse(raw);
  if (manifest.runtime.kind !== "local") {
    throw new Error(`runtime=${manifest.runtime.kind} is not local`);
  }
  const localManifest: LocalExecutablePluginManifest = {
    ...manifest,
    runtime: manifest.runtime,
  };
  const cards: Record<string, unknown> = {};
  for (const card of localManifest.contributes.cards) {
    cards[card.path] = JSON.parse(await readFile(join(dir, card.path), "utf8"));
  }
  const providers: Record<string, unknown> = {};
  for (const provider of localManifest.contributes.providers) {
    providers[provider.path] = JSON.parse(
      await readFile(join(dir, provider.path), "utf8"),
    );
  }
  const modelBindings: Record<string, unknown> = {};
  for (const binding of localManifest.contributes.modelBindings) {
    modelBindings[binding.path] = JSON.parse(
      await readFile(join(dir, binding.path), "utf8"),
    );
  }
  const generators: Record<string, unknown> = {};
  for (const generator of localManifest.contributes.generators) {
    generators[generator.path] = JSON.parse(
      await readFile(join(dir, generator.path), "utf8"),
    );
  }
  const views: Record<string, unknown> = {};
  for (const view of localManifest.contributes.views) {
    views[view.path] = JSON.parse(
      await readFile(join(dir, view.path), "utf8"),
    );
  }
  const contractTests: Record<string, unknown> = {};
  for (const path of localManifest.contractTests) {
    contractTests[path] = JSON.parse(await readFile(join(dir, path), "utf8"));
  }
  return {
    ...validateExecutablePluginPackage(localManifest, cards, contractTests, {
      providers,
      modelBindings,
      generators,
      views,
    }),
    manifest: localManifest,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function executablePluginSchemaHash(
  manifest: ExecutablePluginManifest,
  cards: Record<string, ExecutablePluginCardDocument>,
  providers: Record<string, ExecutablePluginProviderDocument> = {},
  modelBindings: Record<string, ExecutablePluginModelBindingDocument> = {},
  generators: Record<string, ExecutablePluginGeneratorDocument> = {},
  views: Record<string, ExecutablePluginViewDocument> = {},
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        apiVersion: manifest.apiVersion,
        id: manifest.id,
        version: manifest.version,
        contributes: manifest.contributes,
        cards,
        providers,
        modelBindings,
        generators,
        views,
      }),
    )
    .digest("hex")}`;
}

async function executablePluginContentFiles(
  root: string,
  directory: string,
  output: Array<{ path: string; contents: Buffer }>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const path = relative(root, absolutePath).split("\\").join("/");
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Executable plugin content cannot contain symbolic links: ${path}`,
      );
    }
    if (metadata.isDirectory()) {
      await executablePluginContentFiles(root, absolutePath, output);
      continue;
    }
    if (metadata.isFile())
      output.push({ path, contents: await readFile(absolutePath) });
  }
}

export async function executablePluginDirectoryContentHash(
  pluginDirInput: string,
): Promise<`sha256:${string}`> {
  const pluginDir = realpathSync(pluginDirInput);
  const files: Array<{ path: string; contents: Buffer }> = [];
  await executablePluginContentFiles(pluginDir, pluginDir, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.contents.byteLength));
    digest.update("\0");
    digest.update(file.contents);
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

export function executablePluginActivationReceiptPath(
  actionsRoot: string,
  pluginId: string,
): string {
  return join(`${actionsRoot}.activations`, `${pluginId}.json`);
}

export async function createExecutablePluginActivationReceipt(
  pluginDir: string,
): Promise<ExecutablePluginActivationReceipt> {
  const hostedPackage = await readHostedPackage(pluginDir);
  return ExecutablePluginActivationReceiptSchema.parse({
    apiVersion: "clash.plugin.activation/v1",
    pluginId: hostedPackage.manifest.id,
    version: hostedPackage.manifest.version,
    schemaHash: executablePluginSchemaHash(
      hostedPackage.manifest,
      hostedPackage.cards,
      hostedPackage.providers,
      hostedPackage.modelBindings,
      hostedPackage.generators,
      hostedPackage.views,
    ),
    contentHash: await executablePluginDirectoryContentHash(pluginDir),
    activatedAt: new Date().toISOString(),
  });
}

async function verifyExecutablePluginActivation(
  actionsRoot: string,
  pluginDir: string,
  manifest: ExecutablePluginManifest,
  cards: Record<string, ExecutablePluginCardDocument>,
  providers: Record<string, ExecutablePluginProviderDocument>,
  modelBindings: Record<string, ExecutablePluginModelBindingDocument>,
  generators: Record<string, ExecutablePluginGeneratorDocument>,
  views: Record<string, ExecutablePluginViewDocument>,
): Promise<void> {
  const receiptFile = executablePluginActivationReceiptPath(
    actionsRoot,
    manifest.id,
  );
  let receipt: ExecutablePluginActivationReceipt;
  try {
    receipt = ExecutablePluginActivationReceiptSchema.parse(
      JSON.parse(await readFile(receiptFile, "utf8")),
    );
  } catch (error) {
    throw new Error(
      `Plugin ${manifest.id} has no valid activation receipt; use clash plugin activate. ` +
        `${(error as Error).message}`,
    );
  }
  const schemaHash = executablePluginSchemaHash(
    manifest,
    cards,
    providers,
    modelBindings,
    generators,
    views,
  );
  const contentHash = await executablePluginDirectoryContentHash(pluginDir);
  if (
    receipt.pluginId !== manifest.id ||
    receipt.version !== manifest.version ||
    receipt.schemaHash !== schemaHash ||
    receipt.contentHash !== contentHash
  ) {
    throw new Error(
      `Plugin ${manifest.id}@${manifest.version} differs from its activated content; ` +
        "bump the version and run clash plugin activate.",
    );
  }
}

interface LoadedAction {
  manifest: LocalExecutablePluginManifest;
  /** Absolute path to the action's directory. */
  dir: string;
  cards: Record<string, ExecutablePluginCardDocument>;
  providers: Record<string, ExecutablePluginProviderDocument>;
  modelBindings: Record<string, ExecutablePluginModelBindingDocument>;
  generators: Record<string, ExecutablePluginGeneratorDocument>;
  views: Record<string, ExecutablePluginViewDocument>;
  schemaHash: `sha256:${string}`;
}

export type PluginExecutionRealm = "bundled-module" | "process-stdio";

interface SupervisedActionBase {
  loaded: LoadedAction;
  realm: PluginExecutionRealm;
  endpoint: PluginExecutionEndpoint | null;
  /** Set when stop() is called so no new invocation or restart can begin. */
  stopping: boolean;
}

interface SupervisedBundledModule extends SupervisedActionBase {
  realm: "bundled-module";
}

interface SupervisedProcessStdio extends SupervisedActionBase {
  realm: "process-stdio";
  child: ChildProcess | null;
  startedAt: number;
  backoffMs: number;
  /** Pending restart timer (so stop() can clear it). */
  restartTimer: NodeJS.Timeout | null;
}

type SupervisedAction = SupervisedBundledModule | SupervisedProcessStdio;

interface PythonDepsStamp {
  requirements?: Record<string, string>;
}

export class ActionsHost {
  private actions = new Map<string, SupervisedAction>();
  /** Index by directory name (== entry) so the watcher can map fs paths to supervised entries. */
  private dirIndex = new Map<string, string>(); // dirName → action id
  private env: ActionEnv;
  private stopping = false;
  private watcher: FSWatcher | null = null;
  private developmentWatchers = new Map<string, FSWatcher>();
  private developmentPluginsPendingRestart = new Set<string>();
  private watchDebounce: NodeJS.Timeout | null = null;
  private readonly root: string;
  private readonly trustedBundledPluginIds: ReadonlySet<string>;

  constructor(env: ActionEnv) {
    this.env = env;
    this.root = env.actionsRoot ?? actionsDir();
    this.trustedBundledPluginIds = new Set(
      (env.trustedBundledPluginModules ?? []).map(({ id }) => id),
    );
  }

  /**
   * Scan $CLASH_HOME/actions/ and spawn a subprocess per local-runtime
   * action. No-op if the dir doesn't exist (a brand-new local host install
   * just doesn't host any actions yet).
   */
  async start(): Promise<{ spawned: string[]; skipped: string[] }> {
    const spawned: string[] = [];
    const skipped: string[] = [];
    const root = this.root;

    await this.loadTrustedBundledModules();

    // Ensure the dir exists so we can immediately watch it. Without this,
    // a brand-new install would silently skip the watcher and the user
    // would have to restart the daemon after their first `action install`.
    // We create with mode 0755; mkdirSync is idempotent thanks to recursive.
    try {
      mkdirSync(root, { recursive: true });
    } catch (e) {
      process.stderr.write(
        `actions: could not create ${root}: ${(e as Error).message}\n`,
      );
    }

    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (e: any) {
      if (e.code === "ENOENT") {
        process.stderr.write(`actions: no ${root} — skipping action host\n`);
        this.startWatcher();
        this.startDevelopmentWatchers();
        return { spawned, skipped };
      }
      throw e;
    }

    for (const entry of entries) {
      const result = await this.tryLoadAndSpawn(entry);
      if (result === "spawned") spawned.push(entry);
      else if (result === "skipped") skipped.push(entry);
    }

    this.startWatcher();
    this.startDevelopmentWatchers();
    return { spawned, skipped };
  }

  /** Load only modules named by the Host's closed first-party registry. */
  private async loadTrustedBundledModules(): Promise<void> {
    const registrations = this.env.trustedBundledPluginModules ?? [];
    if (registrations.length === 0) return;
    const load = this.env.loadTrustedBundledPluginModule;
    if (!load) {
      throw new Error(
        "Trusted bundled Plugin registrations require a Host module loader.",
      );
    }

    for (const registration of registrations) {
      try {
        if (this.actions.has(registration.id)) {
          throw new Error(
            `Trusted bundled Plugin id ${registration.id} is registered more than once.`,
          );
        }
        const packaged = await load(registration.id);
        if (packaged.id !== registration.id) {
          throw new Error(
            `Trusted bundled registration ${registration.id} loaded ${packaged.id}.`,
          );
        }
        const hostedPackage = await readHostedPackage(
          dirname(packaged.manifestPath),
        );
        const { manifest, cards, providers, modelBindings, generators, views } =
          hostedPackage;
        if (manifest.id !== registration.id) {
          throw new Error(
            `Trusted bundled registration ${registration.id} contains manifest ${manifest.id}.`,
          );
        }
        const schemaHash = executablePluginSchemaHash(
          manifest,
          cards,
          providers,
          modelBindings,
          generators,
          views,
        );
        const endpoint = createModulePluginEndpoint({
          manifest,
          schemaHash,
          module: packaged.plugin,
          broker:
            this.env.pluginBroker ??
            (async () => {
              throw new Error(
                "Clash local plugin host context is unavailable.",
              );
            }),
        });
        this.actions.set(manifest.id, {
          realm: "bundled-module",
          loaded: {
            manifest,
            dir: dirname(packaged.manifestPath),
            cards,
            providers,
            modelBindings,
            generators,
            views,
            schemaHash,
          },
          endpoint,
          stopping: false,
        });
      } catch (error) {
        process.stderr.write(
          `actions: bundled module ${registration.id} unavailable: ${(error as Error).message}\n`,
        );
      }
    }
  }

  /**
   * Read $CLASH_HOME/actions/<dirName>/manifest.json, validate, and spawn
   * (or skip) the subprocess. Returns the outcome so callers can update
   * their counters. Shared between start() and the fs.watch reconciler.
   */
  private async tryLoadAndSpawn(
    dirName: string,
  ): Promise<"spawned" | "skipped" | "ignored"> {
    const dir = join(this.root, dirName);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) return "ignored";
    } catch {
      return "ignored";
    }

    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      process.stderr.write(
        `actions: ${dirName}: no manifest.json — skipping\n`,
      );
      return "skipped";
    }

    let hostedPackage: HostedActionPackage;
    try {
      hostedPackage = await readHostedPackage(dir);
    } catch (e) {
      process.stderr.write(
        `actions: ${dirName}: invalid manifest.json (${(e as Error).message}) — skipping\n`,
      );
      return "skipped";
    }
    const { manifest, cards, providers, modelBindings, generators, views } =
      hostedPackage;
    if (this.trustedBundledPluginIds.has(manifest.id)) {
      process.stderr.write(
        `actions: ${manifest.id}: installed package cannot shadow a trusted bundled module — skipping\n`,
      );
      return "skipped";
    }
    try {
      await verifyExecutablePluginActivation(
        this.root,
        dir,
        manifest,
        cards,
        providers,
        modelBindings,
        generators,
        views,
      );
    } catch (error) {
      process.stderr.write(
        `actions: ${manifest.id}: ${(error as Error).message} — skipping\n`,
      );
      return "skipped";
    }

    const entrypoint = manifest.runtime.entrypoint;
    if (!isSafePluginRelativePath(entrypoint)) {
      process.stderr.write(
        `actions: ${manifest.id}: unsafe entrypoint ${entrypoint} — skipping\n`,
      );
      return "skipped";
    }
    const entrypointPath = join(dir, entrypoint);
    if (!existsSync(entrypointPath)) {
      process.stderr.write(
        `actions: ${manifest.id}: entrypoint ${entrypoint} missing — skipping\n`,
      );
      return "skipped";
    }

    const loaded: LoadedAction = {
      manifest,
      dir,
      cards,
      providers,
      modelBindings,
      generators,
      views,
      schemaHash: executablePluginSchemaHash(
        manifest,
        cards,
        providers,
        modelBindings,
        generators,
        views,
      ),
    };
    const supervised: SupervisedProcessStdio = {
      loaded,
      realm: "process-stdio",
      endpoint: null,
      child: null,
      startedAt: 0,
      backoffMs: RESTART_BACKOFF_MIN_MS,
      stopping: false,
      restartTimer: null,
    };
    this.actions.set(manifest.id, supervised);
    this.dirIndex.set(dirName, manifest.id);
    this.spawnOne(supervised);
    return "spawned";
  }

  /**
   * Stop every supervised action — SIGTERM, then SIGKILL after 5s grace.
   * Resolves once all children have exited (or the grace timer fires).
   */
  async stopAll(): Promise<void> {
    this.stopping = true;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* already closed */
      }
      this.watcher = null;
    }
    for (const watcher of this.developmentWatchers.values()) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    this.developmentWatchers.clear();
    this.developmentPluginsPendingRestart.clear();
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    const pending: Promise<void>[] = [];

    for (const sup of this.actions.values()) {
      sup.stopping = true;
      sup.endpoint?.close();
      sup.endpoint = null;
      if (sup.realm === "bundled-module") continue;
      if (sup.restartTimer) {
        clearTimeout(sup.restartTimer);
        sup.restartTimer = null;
      }
      if (!sup.child) continue;

      pending.push(
        new Promise<void>((resolve) => {
          const child = sup.child!;
          let resolved = false;
          const finish = () => {
            if (resolved) return;
            resolved = true;
            resolve();
          };
          child.once("exit", finish);
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          setTimeout(() => {
            if (!resolved) {
              try {
                child.kill("SIGKILL");
              } catch {
                /* already gone */
              }
              // give SIGKILL a moment to land; either way, resolve so
              // shutdown isn't blocked indefinitely on a stuck child.
              setTimeout(finish, 500);
            }
          }, SHUTDOWN_GRACE_MS);
        }),
      );
    }

    await Promise.all(pending);
  }

  /** Convenience for diagnostics — what's currently being hosted. */
  listIds(): string[] {
    return [...this.actions.keys()];
  }

  /** Host-private execution facts. They never enter a binding or invocation. */
  listExecutionDiagnostics(): Array<{
    pluginId: string;
    version: string;
    realm: PluginExecutionRealm;
    ready: boolean;
  }> {
    return [...this.actions.values()]
      .map((supervised) => ({
        pluginId: supervised.loaded.manifest.id,
        version: supervised.loaded.manifest.version,
        realm: supervised.realm,
        ready: supervised.endpoint !== null,
      }))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  /** Activated declarative Cards currently eligible for Kernel discovery. */
  listCards(): ExecutablePluginCardRegistration[] {
    const registrations: ExecutablePluginCardRegistration[] = [];
    for (const supervised of this.actions.values()) {
      const { manifest, cards, schemaHash } = supervised.loaded;
      if (!supervised.endpoint) continue;
      for (const document of Object.values(cards)) {
        registrations.push({
          pluginId: manifest.id,
          version: manifest.version,
          schemaHash,
          runtime: manifest.runtime,
          document,
        });
      }
    }
    return registrations.sort((left, right) =>
      `${left.pluginId}:${left.document.spec.id}`.localeCompare(
        `${right.pluginId}:${right.document.spec.id}`,
      ),
    );
  }

  /** Activated Provider definitions, independent from the Model Card catalog. */
  /**
   * Every installed Provider's declaration, spawned or not.
   *
   * This used to skip any plugin with no live session, which made a freshly installed Provider
   * invisible: connecting an account reads the declaration to validate its settings, and the plugin
   * is only spawned once it has an account. `--set apiKey=...` answered "this provider does not
   * declare an apiKey setting" for a manifest that declared exactly that.
   *
   * A session gates *invoking* a plugin, which is still checked where invoking happens.
   */
  listProviders(): ExecutablePluginProviderRegistration[] {
    return providerRegistrationsFrom(this.actions.values());
  }

  /**
   * What one activated plugin's entry points declare they can answer.
   *
   * The host reads this before believing an acceptance. A plugin that takes work without declaring
   * poll has spent money on a result nobody can collect, and the only cheap moment to notice is
   * before the node is marked as running.
   */
  listFunctionExports(pluginId: string): ExecutablePluginFunctionExport[] {
    const supervised = this.actions.get(pluginId);
    if (!supervised) return [];
    const { manifest } = supervised.loaded;
    return manifest.contributes.functions;
  }

  /** Activated provider-side implementations that attach to Cards by id. */
  listModelBindings(): ExecutablePluginModelBindingRegistration[] {
    const registrations: ExecutablePluginModelBindingRegistration[] = [];
    for (const supervised of this.actions.values()) {
      const { manifest, modelBindings, schemaHash } = supervised.loaded;
      if (!supervised.endpoint) continue;
      for (const document of Object.values(modelBindings)) {
        registrations.push({
          pluginId: manifest.id,
          version: manifest.version,
          schemaHash,
          runtime: manifest.runtime,
          document,
        });
      }
    }
    return registrations.sort((left, right) =>
      `${left.pluginId}:${left.document.spec.id}`.localeCompare(
        `${right.pluginId}:${right.document.spec.id}`,
      ),
    );
  }

  /** Activated native Generator definitions with semantic package provenance only. */
  listGenerators(): ExecutablePluginGeneratorRegistration[] {
    const registrations: ExecutablePluginGeneratorRegistration[] = [];
    for (const supervised of this.actions.values()) {
      const { manifest, generators, schemaHash } = supervised.loaded;
      for (const document of Object.values(generators)) {
        registrations.push({
          pluginId: manifest.id,
          version: manifest.version,
          schemaHash,
          document,
        });
      }
    }
    return registrations.sort((left, right) =>
      `${left.pluginId}:${left.document.spec.definitionId}`.localeCompare(
        `${right.pluginId}:${right.document.spec.definitionId}`,
      ),
    );
  }

  /** Activated declarative Views; no executable endpoint or Generator ownership is implied. */
  listViews(): ExecutablePluginViewRegistration[] {
    const registrations: ExecutablePluginViewRegistration[] = [];
    for (const supervised of this.actions.values()) {
      const { manifest, views, schemaHash } = supervised.loaded;
      for (const document of Object.values(views)) {
        registrations.push({
          pluginId: manifest.id,
          version: manifest.version,
          schemaHash,
          document,
        });
      }
    }
    return registrations.sort((left, right) =>
      `${left.pluginId}:${left.document.spec.definitionId}`.localeCompare(
        `${right.pluginId}:${right.document.spec.definitionId}`,
      ),
    );
  }

  /** Resolve one immutable Generator definition without exposing its Host execution realm. */
  resolveGeneratorDefinition(
    pluginId: string,
    definitionId: string,
  ): GeneratorDefinition {
    const supervised = this.actions.get(pluginId);
    if (!supervised) {
      throw new Error(`Executable plugin ${pluginId} is not installed.`);
    }
    const document = Object.values(supervised.loaded.generators).find(
      (candidate) => candidate.spec.definitionId === definitionId,
    );
    if (!document) {
      throw new Error(
        `Executable plugin ${pluginId} does not export Generator ${definitionId}.`,
      );
    }
    return generatorDefinitionFromExecutablePluginRegistration({
      pluginId,
      version: supervised.loaded.manifest.version,
      schemaHash: supervised.loaded.schemaHash,
      document,
    });
  }

  /** Resolve the active immutable contract before a Canvas node is authored. */
  resolveBinding(
    pluginId: string,
    exportId: string,
    kind: "action" | "provider-projector" | "provider-executor",
  ): ExecutablePluginBinding {
    const supervised = this.actions.get(pluginId);
    if (!supervised) {
      throw new Error(`Executable plugin ${pluginId} is not installed.`);
    }
    if (!supervised.endpoint) {
      throw new Error(`Executable plugin ${pluginId} is not running.`);
    }
    const exported = supervised.loaded.manifest.contributes.functions.find(
      (entry) => entry.id === exportId && entry.kind === kind,
    );
    if (!exported) {
      throw new Error(
        `Executable plugin ${pluginId} does not export ${kind} ${exportId}.`,
      );
    }
    return {
      pluginId,
      version: supervised.loaded.manifest.version,
      exportId,
      schemaHash: supervised.loaded.schemaHash,
    };
  }

  /** Invoke one exact, already-supervised plugin through its Host-selected execution endpoint. */
  async invoke(
    pluginId: string,
    invocation: unknown,
    options: { timeoutMs?: number; accountId?: string } = {},
  ): Promise<ExecutablePluginResult> {
    const supervised = this.actions.get(pluginId);
    if (!supervised?.endpoint) {
      throw new Error(`Executable plugin ${pluginId} is not running.`);
    }
    const parsed = ExecutablePluginInvocationSchema.parse(invocation);
    if (
      !supervised.loaded.schemaHash ||
      parsed.target.schemaHash !== supervised.loaded.schemaHash
    ) {
      throw new Error(
        `Executable plugin ${pluginId} schema hash does not match the pinned invocation.`,
      );
    }
    const exported = supervised.loaded.manifest.contributes.functions.find(
      (entry) =>
        entry.id === parsed.target.exportId &&
        entry.kind === parsed.target.kind,
    );
    if (!exported) {
      throw new Error(
        `Executable plugin ${pluginId} does not export ${parsed.target.kind} ${parsed.target.exportId}.`,
      );
    }
    const pinnedInvocation =
      parsed.target.kind === "action"
        ? ExecutablePluginInvocationSchema.parse({
            ...parsed,
            // An Action's delivery contract belongs to the schema-hashed function export. The
            // scheduler supplies frozen references, but cannot widen or replace how plugin code
            // may consume their bytes.
            assetInputs: exported.assetInputs ?? [],
          })
        : parsed;
    return await supervised.endpoint.invoke(pinnedInvocation, options);
  }

  // ─── fs.watch / reconciliation ──────────────────────────────
  //
  // node's fs.watch is intentionally minimal — it tells us *something*
  // changed under the actions directory but not what. So we use it purely as a
  // change signal and call reconcile() (a full diff between disk state
  // and the supervised map) on a 500ms debounce. That keeps the logic
  // robust against:
  //   - editor save-and-rename (atomic rename → multiple change events)
  //   - CLI install writing handler.py before manifest.json (interim
  //     state is "manifest exists but entrypoint missing")
  //   - `rm -rf` deleting many files in quick succession
  //
  // recursive:true is supported on macOS/Windows. On Linux it requires
  // Node 24+; if the host is older we log and fall back to top-level
  // watching (good enough for "add/remove an action dir" — only nested
  // file edits without a manifest touch get missed).

  private startWatcher(): void {
    if (this.stopping) return;
    if (this.watcher) return;
    const root = this.root;
    try {
      this.watcher = watch(
        root,
        { recursive: true, persistent: false },
        (_eventType, filename) => {
          // Ignore swap/temp files that editors create — they churn the
          // debouncer for changes we don't care about.
          if (typeof filename === "string" && /\.swp$|~$|\.swx$/.test(filename))
            return;
          this.scheduleReconcile();
        },
      );
      this.watcher.on("error", (err) => {
        actionLog.warn("plugin.watcher_failed", { error: err });
      });
      actionLog.debug("plugin.watching", () => ({ directory: root }));
    } catch (e) {
      // Likely linux <20 without recursive support, or an exotic FS.
      // We still function — just no auto-reload.
      process.stderr.write(
        `actions: fs.watch unavailable (${(e as Error).message}); auto-reload disabled\n`,
      );
    }
  }

  /**
   * Watch first-party workspace sources only when the development entrypoint explicitly supplies
   * them. Installed packages keep using the normal actions-root watcher above.
   */
  private startDevelopmentWatchers(): void {
    if (this.stopping) return;
    for (const [pluginId, sourceRoots] of Object.entries(
      this.env.developmentPluginWatchRoots ?? {},
    )) {
      for (const sourceRoot of new Set(sourceRoots)) {
        const watcherKey = `${pluginId}\0${sourceRoot}`;
        if (this.developmentWatchers.has(watcherKey)) continue;
        try {
          const watcher = watch(
            sourceRoot,
            { recursive: true, persistent: false },
            (_eventType, filename) => {
              if (
                typeof filename === "string" &&
                /\.swp$|~$|\.swx$/.test(filename)
              )
                return;
              this.developmentPluginsPendingRestart.add(pluginId);
              this.scheduleReconcile();
            },
          );
          watcher.on("error", (error) => {
            process.stderr.write(
              `actions: development source watcher error id=${pluginId} ` +
                `root=${sourceRoot} ${error.message}\n`,
            );
          });
          this.developmentWatchers.set(watcherKey, watcher);
          actionLog.debug("plugin.source_watching", () => ({ pluginId, directory: sourceRoot }));
        } catch (error) {
          process.stderr.write(
            `actions: development source watch unavailable id=${pluginId} root=${sourceRoot} ` +
              `(${(error as Error).message})\n`,
          );
        }
      }
    }
  }

  private scheduleReconcile(): void {
    if (this.stopping) return;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      this.reconcile().catch((e) => {
        actionLog.error("plugin.reconcile_failed", { error: e });
      });
    }, WATCH_DEBOUNCE_MS);
  }

  /**
   * Diff disk against the supervised map:
   *   - new dir with valid manifest                  → tryLoadAndSpawn
   *   - existing id, manifest version changed        → restart subprocess
   *   - dir / manifest disappeared                   → stopOne
   *
   * Logged as `actions: reloaded id=…` so the host log surfaces each
   * lifecycle event in one place (alongside the existing
   * `actions: spawn id=…` and `actions: exit id=…` lines).
   */
  private async reconcile(): Promise<void> {
    if (this.stopping) return;

    const developmentPluginsToRestart = [
      ...this.developmentPluginsPendingRestart,
    ];
    for (const pluginId of developmentPluginsToRestart) {
      this.developmentPluginsPendingRestart.delete(pluginId);
    }

    let entries: string[];
    const root = this.root;
    try {
      entries = await readdir(root);
    } catch (e: any) {
      if (e.code === "ENOENT") {
        // The watched directory owns only installed process packages. Bundled modules come from an
        // immutable Host registry and remain available when a user removes or recreates actions/.
        for (const [id, supervised] of [...this.actions.entries()]) {
          if (supervised.realm === "process-stdio") {
            await this.stopOne(id, "dir-removed");
          }
        }
        return;
      }
      throw e;
    }

    const liveDirs = new Set<string>();

    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      const manifestPath = join(dir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      liveDirs.add(entry);

      // Read the manifest fresh — same validation as start().
      let hostedPackage: HostedActionPackage;
      try {
        hostedPackage = await readHostedPackage(dir);
      } catch {
        // Half-written manifest mid-install. Skip; debounce will fire
        // again once the writer finishes.
        continue;
      }
      const { manifest } = hostedPackage;
      if (this.trustedBundledPluginIds.has(manifest.id)) {
        process.stderr.write(
          `actions: ${manifest.id}: installed package cannot shadow a trusted bundled module — ignored\n`,
        );
        continue;
      }
      try {
        await verifyExecutablePluginActivation(
          this.root,
          dir,
          manifest,
          hostedPackage.cards,
          hostedPackage.providers,
          hostedPackage.modelBindings,
          hostedPackage.generators,
          hostedPackage.views,
        );
      } catch (error) {
        const active = this.actions.get(manifest.id);
        if (active)
          await this.stopOne(manifest.id, "activation-receipt-mismatch");
        process.stderr.write(
          `actions: ${manifest.id}: ${(error as Error).message} — disabled\n`,
        );
        continue;
      }

      const entrypoint = manifest.runtime.entrypoint;
      if (!isSafePluginRelativePath(entrypoint)) continue;
      if (!existsSync(join(dir, entrypoint))) continue;

      const existing = this.actions.get(manifest.id);
      if (!existing) {
        process.stderr.write(
          `actions: new manifest detected dir=${entry} id=${manifest.id}\n`,
        );
        await this.tryLoadAndSpawn(entry);
        actionLog.info("plugin.reloaded", { pluginId: manifest.id, reason: "added" });
        continue;
      }

      // Restart on version change, entrypoint change, or any
      // material manifest delta. We compare on serialized manifest
      // so renames / parameter tweaks also pick up — the cost of a
      // restart is small and correctness > minimal disturbance.
      const oldKey = manifestKey(existing.loaded.manifest);
      const newKey = manifestKey(manifest);
      if (oldKey !== newKey) {
        process.stderr.write(
          `actions: manifest changed id=${manifest.id} (was v=${existing.loaded.manifest.version ?? "?"} now v=${manifest.version ?? "?"})\n`,
        );
        await this.restartOne(entry, manifest, dir);
        process.stderr.write(
          `actions: reloaded id=${manifest.id} (restarted)\n`,
        );
      }
    }

    // Anything we host but is no longer on disk → SIGTERM.
    for (const [dirName, id] of [...this.dirIndex.entries()]) {
      if (!liveDirs.has(dirName)) {
        await this.stopOne(id, "manifest-removed");
        actionLog.info("plugin.reloaded", { pluginId: id, reason: "removed" });
      }
    }

    for (const pluginId of developmentPluginsToRestart) {
      const dirName = [...this.dirIndex.entries()].find(
        ([, id]) => id === pluginId,
      )?.[0];
      if (!dirName || !this.actions.has(pluginId)) continue;
      process.stderr.write(
        `actions: development source changed id=${pluginId}\n`,
      );
      await this.stopOne(pluginId, "development-source-changed");
      const result = await this.tryLoadAndSpawn(dirName);
      process.stderr.write(
        `actions: reloaded id=${pluginId} (development-source-${result})\n`,
      );
    }
  }

  /**
   * SIGTERM the given action and drop it from the supervised map. Used
   * by the watcher when a manifest disappears (CLI uninstall, rm -rf).
   * Mirrors stopAll() for a single entry; reason is logged for grep-ability.
   */
  private async stopOne(id: string, reason: string): Promise<void> {
    const sup = this.actions.get(id);
    if (!sup) return;
    actionLog.info("plugin.stopping", { pluginId: id, reason });

    sup.stopping = true;
    sup.endpoint?.close();
    sup.endpoint = null;
    if (sup.realm === "bundled-module") {
      this.actions.delete(id);
      return;
    }
    if (sup.restartTimer) {
      clearTimeout(sup.restartTimer);
      sup.restartTimer = null;
    }

    const child = sup.child;
    if (child) {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        child.once("exit", finish);
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          if (!resolved) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
            setTimeout(finish, 500);
          }
        }, SHUTDOWN_GRACE_MS);
      });
    }

    this.actions.delete(id);
    // Drop the dir → id mapping too. find-by-value because the dirIndex
    // is keyed by directory name, not id.
    for (const [dirName, mappedId] of this.dirIndex.entries()) {
      if (mappedId === id) this.dirIndex.delete(dirName);
    }
  }

  /**
   * Replace an existing supervised action with a freshly-loaded one.
   * Internally: stopOne (SIGTERM) then tryLoadAndSpawn against the new
   * manifest. Used by reconcile() when a manifest version (or any
   * material field) changes on disk.
   */
  private async restartOne(
    dirName: string,
    _newManifest: LocalExecutablePluginManifest,
    _dir: string,
  ): Promise<void> {
    const oldId = this.dirIndex.get(dirName);
    if (oldId) await this.stopOne(oldId, "manifest-changed");
    await this.tryLoadAndSpawn(dirName);
  }

  // ─── internals ──────────────────────────────────────────────

  private spawnOne(sup: SupervisedProcessStdio): void {
    if (this.stopping || sup.stopping) return;

    const { manifest, dir } = sup.loaded;
    const executableRuntime = manifest.runtime;
    const entrypoint = executableRuntime.entrypoint;
    const entrypointPath = join(dir, entrypoint);
    const runtimeDir = realpathSync(dir);
    const runtimeEntrypointPath = realpathSync(entrypointPath);

    // Locate the workspace clash-sdk python source so the subprocess can
    // import it without a pip install. In dev, this lives at
    //   <repo>/packages/clash-sdk/python
    // Development resolves the SDK from the workspace without depending on a
    // compiled CLI location. Packaged installs provide CLASH_ACTIONS_SDK_PATH.
    const sdkPythonDir = resolveSdkPythonDir();

    const childEnv = credentialFreePluginEnv(manifest);

    // Pick interpreter by entrypoint file extension.
    //
    // - `.py`              → prepared Python runtime (managed venv by default,
    //                        or CLASH_ACTIONS_PYTHON as an explicit interpreter)
    // - `.js` / `.mjs`     → explicit desktop Node runtime, else process.execPath
    // - `.ts`              → not supported in production; reject so action
    //                        authors compile to .js (the marketplace install
    //                        endpoint serves built .js, not .ts).
    //
    // Executable plugins may use either the JS action SDK or the Python
    // stdio helper. The Host is interpreter-agnostic and binds both to the
    // same clash.plugin/v1 invocation/result protocol.
    const ext = entrypoint.toLowerCase().slice(entrypoint.lastIndexOf("."));
    let bin: string;
    let args: string[];
    if (ext === ".py") {
      const pythonBin = resolveExecutablePluginPythonBin({
        manifestId: manifest.id,
        pluginDir: runtimeDir,
        logPrefix: "",
      });
      if (!pythonBin) {
        process.stderr.write(
          `actions: ${manifest.id}: no Python runtime available for plugin — set CLASH_ACTIONS_PYTHON or install the app-managed runtime\n`,
        );
        return;
      }
      bin = pythonBin;
      args = executablePluginPythonArgs(
        runtimeEntrypointPath,
        executableRuntime.args,
      );
      Object.assign(
        childEnv,
        executablePluginPythonEnv(manifest, sdkPythonDir),
      );
      if (this.env.providerHttpInstrumentation) {
        Object.assign(
          childEnv,
          providerHttpInstrumentationPythonEnvironment(
            this.env.providerHttpInstrumentation,
            childEnv,
          ),
        );
      }
    } else if (ext === ".js" || ext === ".mjs") {
      bin = resolveExecutablePluginNodePath();
      args = executablePluginNodeArgs(
        runtimeEntrypointPath,
        executableRuntime.args,
        this.env.providerHttpInstrumentation,
      );
      if (this.env.providerHttpInstrumentation) {
        Object.assign(
          childEnv,
          providerHttpInstrumentationEnvironment(
            this.env.providerHttpInstrumentation,
          ),
        );
      }
    } else if (ext === ".ts") {
      process.stderr.write(
        `actions: ${manifest.id}: .ts entrypoint not supported — compile to .js before installing\n`,
      );
      return;
    } else {
      process.stderr.write(
        `actions: ${manifest.id}: unknown entrypoint extension '${ext}' — expected .py / .js / .mjs\n`,
      );
      return;
    }

    actionLog.info("plugin.starting", { pluginId: manifest.id });

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: runtimeDir,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      process.stderr.write(
        `actions: ${manifest.id}: spawn failed (${(e as Error).message})\n`,
      );
      return;
    }

    sup.child = child;
    sup.startedAt = Date.now();

    if (!child.stdin || !child.stdout) {
      process.stderr.write(
        `actions: ${manifest.id}: stdio pipes unavailable — disabling\n`,
      );
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      return;
    }
    sup.endpoint = new PluginStdioSession({
      manifest,
      stdin: child.stdin,
      stdout: child.stdout,
      broker:
        this.env.pluginBroker ??
        (async () => {
          throw new Error("Clash local plugin host context is unavailable.");
        }),
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`plugin[${manifest.id}]: ${chunk.toString("utf8")}`);
    });

    child.once("exit", (code, signal) => {
      const uptime = Date.now() - sup.startedAt;
      actionLog[this.stopping || sup.stopping || code === 0 ? "info" : "warn"]("plugin.exited", { pluginId: manifest.id, code, signal, uptimeMs: uptime });
      sup.child = null;
      sup.endpoint?.close();
      sup.endpoint = null;

      // If we ran healthy for a while, reset backoff. Otherwise scale.
      if (uptime > HEALTHY_UPTIME_MS) {
        sup.backoffMs = RESTART_BACKOFF_MIN_MS;
      }

      if (this.stopping || sup.stopping) return;

      if (uptime < FAST_EXIT_DISABLE_MS) {
        sup.stopping = true;
        actionLog.error("plugin.disabled", { pluginId: manifest.id, reason: "fast_exit", code, signal, uptimeMs: uptime });
        return;
      }

      const delay = sup.backoffMs;
      sup.backoffMs = Math.min(sup.backoffMs * 2, RESTART_BACKOFF_MAX_MS);
      actionLog.warn("plugin.restarting", { pluginId: manifest.id, delayMs: delay });
      sup.restartTimer = setTimeout(() => {
        sup.restartTimer = null;
        this.spawnOne(sup);
      }, delay);
    });

    child.once("error", (err) => {
      actionLog.error("plugin.child_failed", { pluginId: manifest.id, error: err });
    });
  }
}

/**
 * Hash-equivalent of a manifest for change detection. We could deep-compare
 * but reconcile() only fires on a watcher tick — JSON.stringify is fast
 * enough, and key order is stable since we control the writer.
 */
function manifestKey(m: LocalExecutablePluginManifest): string {
  return JSON.stringify(m);
}

export function credentialFreePluginEnv(
  manifest: Pick<ExecutablePluginManifest, "id" | "version">,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CLASH_PLUGIN_ID: manifest.id,
    CLASH_PLUGIN_VERSION: manifest.version,
    CLASH_PLUGIN_TRANSPORT: "stdio",
    // Safe runtime flag, not a credential. It makes process.execPath usable
    // when the host is Electron and is ignored by a standalone Node binary.
    ELECTRON_RUN_AS_NODE: "1",
  };
  // Only process-launch essentials cross the host boundary. In particular,
  // no CLASH_API_KEY or provider credential is inherited from the local host.
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
  ]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  // Provider runtime tuning is not a credential. Keep the exception scoped to
  // the plugin that owns the setting so arbitrary plugins cannot enumerate
  // host configuration by choosing a familiar environment key.
  if (
    manifest.id === "clash.minimax" &&
    inherited.CLASH_MINIMAX_TIMEOUT_MS !== undefined
  ) {
    env.CLASH_MINIMAX_TIMEOUT_MS = inherited.CLASH_MINIMAX_TIMEOUT_MS;
  }
  return env;
}

export function resolveExecutablePluginNodePath(
  inherited: NodeJS.ProcessEnv = process.env,
  fallback = process.execPath,
): string {
  return inherited.CLASH_NODE_EXEC_PATH?.trim() || fallback;
}

export interface ExecutablePluginContractTestRun {
  passed: number;
  tests: Array<{ id: string; status: "passed" }>;
}

export function providerHttpInstrumentationEnvironment(
  instrumentation: ProviderHttpInstrumentationLaunch,
): NodeJS.ProcessEnv {
  validateProviderHttpInstrumentationLaunch(instrumentation);
  return {
    CLASH_PROVIDER_TRAFFIC_MODE: instrumentation.mode,
    CLASH_PROVIDER_TRAFFIC_PATH: instrumentation.trafficPath,
    ...(instrumentation.activeStubPath
      ? { CLASH_PROVIDER_TRAFFIC_STUB_PATH: instrumentation.activeStubPath }
      : {}),
  };
}

export function providerHttpInstrumentationPythonEnvironment(
  instrumentation: ProviderHttpInstrumentationLaunch,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pythonPath = providerHttpInstrumentationPythonPath();
  const inheritedPythonPath = inherited.PYTHONPATH?.trim();
  return {
    ...providerHttpInstrumentationEnvironment(instrumentation),
    PYTHONPATH: inheritedPythonPath
      ? `${pythonPath}${delimiter}${inheritedPythonPath}`
      : pythonPath,
  };
}

export function executablePluginNodeArgs(
  entrypointPath: string,
  runtimeArgs: readonly string[],
  instrumentation?: ProviderHttpInstrumentationLaunch,
): string[] {
  // Plugins are ordinary subprocesses. Runtime arguments follow the entrypoint
  // so Node treats them as plugin arguments rather than interpreter flags.
  return [
    ...(instrumentation
      ? providerHttpInstrumentationNodeArgs(instrumentation)
      : []),
    entrypointPath,
    ...runtimeArgs,
  ];
}

export function providerHttpInstrumentationNodeArgs(
  instrumentation: ProviderHttpInstrumentationLaunch,
): string[] {
  validateProviderHttpInstrumentationLaunch(instrumentation);
  return [
    ...(instrumentation.loaderPath
      ? [`--import=${instrumentation.loaderPath}`]
      : []),
    `--import=${instrumentation.modulePath}`,
  ];
}

function validateProviderHttpInstrumentationLaunch(
  instrumentation: ProviderHttpInstrumentationLaunch,
): void {
  for (const [label, path] of [
    ["trafficPath", instrumentation.trafficPath],
    ["modulePath", instrumentation.modulePath],
    ...(instrumentation.loaderPath
      ? [["loaderPath", instrumentation.loaderPath] as const]
      : []),
    ...(instrumentation.activeStubPath
      ? [["activeStubPath", instrumentation.activeStubPath] as const]
      : []),
  ] as const) {
    if (!isAbsolute(path)) {
      throw new Error(
        `Provider HTTP instrumentation ${label} must be absolute.`,
      );
    }
  }
  if (instrumentation.mode === "record" && !instrumentation.activeStubPath) {
    throw new Error(
      "Provider HTTP recording requires an absolute activeStubPath.",
    );
  }
}

function executablePluginPythonArgs(
  entrypointPath: string,
  runtimeArgs: readonly string[],
): string[] {
  // -B: no .pyc writes inside the attested package; -s: no user site-packages.
  return ["-B", "-s", entrypointPath, ...runtimeArgs];
}

function executablePluginPythonEnv(
  manifest: Pick<ExecutablePluginManifest, "id" | "version">,
  sdkPythonDir: string | null,
): NodeJS.ProcessEnv {
  const env = credentialFreePluginEnv(manifest);
  if (sdkPythonDir) env.PYTHONPATH = sdkPythonDir;
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONNOUSERSITE = "1";
  return env;
}

/**
 * App-internal Python prepared for the local ASR/TTS model runtimes. Reused
 * for Python plugins so a packaged desktop install needs no system Python.
 * Path mirrors apps/local-api/src/managed-local-model-python.ts.
 */
function managedLocalModelsPythonBin(): string | null {
  const venvDir = join(
    paths().configDir,
    "runtimes",
    "python",
    "local-models",
    "venv",
  );
  const bin = managedPythonBin(venvDir);
  return existsSync(bin) ? bin : null;
}

/**
 * Interpreter for a Python executable plugin, in order:
 * 1. CLASH_ACTIONS_PYTHON (explicit override; dev/test hermetic path)
 * 2. the local-models venv the app already maintains for ASR/TTS — only for
 *    dependency-free plugins so plugin pip installs never pollute it
 * 3. the actions-managed venv (created on demand), where a plugin's
 *    requirements.txt installs through the existing stamped machinery
 */
function resolveExecutablePluginPythonBin(opts: {
  manifestId: string;
  pluginDir: string;
  logPrefix: string;
}): string | null {
  const hasRequirements = existsSync(join(opts.pluginDir, "requirements.txt"));
  const explicit = process.env.CLASH_ACTIONS_PYTHON;
  if (explicit) {
    if (!hasRequirements) return explicit;
    return preparePythonRuntimeDeps({
      pythonBin: explicit,
      stampDir: explicitPythonStampDir(explicit),
      actionId: opts.manifestId,
      actionDir: opts.pluginDir,
      logPrefix: opts.logPrefix,
    });
  }
  if (!hasRequirements) {
    const localModelsPython = managedLocalModelsPythonBin();
    if (localModelsPython) return localModelsPython;
  }
  const venvDir = managedPythonVenvDir();
  const pythonBin = managedPythonBin(venvDir);
  if (!existsSync(pythonBin)) {
    mkdirSync(venvDir, { recursive: true });
    process.stderr.write(
      `${opts.logPrefix}actions: python venv create path=${venvDir}\n`,
    );
    if (
      !runPythonSetup(
        "python3",
        ["-m", "venv", venvDir],
        opts.logPrefix,
        opts.manifestId,
      )
    ) {
      return null;
    }
  }
  return preparePythonRuntimeDeps({
    pythonBin,
    stampDir: venvDir,
    actionId: opts.manifestId,
    actionDir: opts.pluginDir,
    logPrefix: opts.logPrefix,
  });
}

/**
 * Run an unpacked draft's declarative contracts through the same stdio runtime
 * adapter used by ActionsHost. Host-dependency responses come exclusively from
 * the contract document's inert fixtures.
 */
export async function runExecutablePluginContractTests(
  pluginDirInput: string,
): Promise<ExecutablePluginContractTestRun> {
  const pluginDir = realpathSync(pluginDirInput);
  const hostedPackage = await readHostedPackage(pluginDir);
  const {
    manifest,
    cards,
    providers,
    modelBindings,
    generators,
    views,
    contractTests,
  } = hostedPackage;
  if (
    manifest.runtime.kind !== "local" ||
    manifest.runtime.transport !== "stdio"
  ) {
    throw new Error(`Plugin ${manifest.id} is not a local stdio plugin.`);
  }
  if (manifest.contractTests.length === 0) {
    throw new Error(`Plugin ${manifest.id} declares no contract tests.`);
  }
  const entrypointPath = realpathSync(
    join(pluginDir, manifest.runtime.entrypoint),
  );
  const extension = manifest.runtime.entrypoint
    .toLowerCase()
    .slice(manifest.runtime.entrypoint.lastIndexOf("."));
  // The extension whitelist validates the runtime dispatch shapes the host supports.
  // It no longer decides *which* interpreter runs -- the manifest declares that.
  if (extension !== ".js" && extension !== ".mjs" && extension !== ".py") {
    throw new Error(
      `Contract-tested v1 plugins require a .js, .mjs or .py entrypoint; got ${extension || "none"}.`,
    );
  }
  const language = resolvePluginLanguage(manifest.runtime) ?? "node";
  const sdkPythonDir = language === "python" ? resolveSdkPythonDir() : null;
  const spawnPlan =
    language === "python"
      ? (() => {
          const pythonBin = resolveExecutablePluginPythonBin({
            manifestId: manifest.id,
            pluginDir,
            logPrefix: "",
          });
          if (!pythonBin) {
            throw new Error(
              `Plugin ${manifest.id} needs a Python runtime — set CLASH_ACTIONS_PYTHON or install the app-managed runtime.`,
            );
          }
          return {
            bin: pythonBin,
            args: executablePluginPythonArgs(
              entrypointPath,
              manifest.runtime.args,
            ),
            env: executablePluginPythonEnv(manifest, sdkPythonDir),
          };
        })()
      : {
          bin: resolveExecutablePluginNodePath(),
          args: executablePluginNodeArgs(entrypointPath, manifest.runtime.args),
          env: credentialFreePluginEnv(manifest),
        };
  const schemaHash = executablePluginSchemaHash(
    manifest,
    cards,
    providers,
    modelBindings,
    generators,
    views,
  );
  const completed: ExecutablePluginContractTestRun["tests"] = [];

  for (const path of manifest.contractTests) {
    const contractTest = contractTests[path];
    const child: ChildProcess = spawn(spawnPlan.bin, spawnPlan.args, {
      cwd: pluginDir,
      env: spawnPlan.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    if (!child.stdin || !child.stdout) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      throw new Error(
        `Contract test ${contractTest.id} could not open plugin stdio.`,
      );
    }
    if (process.env.CLASH_CONTRACT_TRACE) {
      console.error(
        "[contract] spawn",
        spawnPlan.bin,
        spawnPlan.args.join(" "),
        "cwd=" + pluginDir,
      );
      child.stdout?.on("data", (c: Buffer) =>
        console.error("[contract] <-", c.toString("utf8").slice(0, 200)),
      );
    }
    let fixtureIndex = 0;
    const session: PluginStdioSession = new PluginStdioSession({
      manifest,
      stdin: child.stdin,
      stdout: child.stdout,
      broker: async (request) => {
        const fixture = contractTest.brokerFixtures[fixtureIndex];
        if (!fixture) {
          throw new Error(
            `Contract test ${contractTest.id} made undeclared broker request ` +
              `${canonicalJson(request.operation)}.`,
          );
        }
        try {
          deepStrictEqual(request.operation, fixture.operation);
        } catch {
          throw new Error(
            `Contract test ${contractTest.id} broker request ${canonicalJson(request.operation)} ` +
              `did not match fixture ${canonicalJson(fixture.operation)}.`,
          );
        }
        fixtureIndex += 1;
        if (fixture.response.status === "error") {
          throw new Error(
            `${fixture.response.error.code}: ${fixture.response.error.message}`,
          );
        }
        return fixture.response.result;
      },
    });

    try {
      const invocationId = `contract:${contractTest.id}`;
      const result: ExecutablePluginResult = await session.invoke(
        {
          protocol: "clash.plugin.invoke/v1",
          invocationId,
          taskId: `contract:${contractTest.id}`,
          projectId: contractTest.context.projectId,
          ...(contractTest.context.nodeId
            ? { nodeId: contractTest.context.nodeId }
            : {}),
          target: {
            pluginId: manifest.id,
            version: manifest.version,
            exportId: contractTest.target.exportId,
            schemaHash,
            kind: contractTest.target.kind,
          },
          input: contractTest.input,
          // Without these a poll case silently runs as a submit, and the suite reports a pass for a
          // path it never exercised.
          operation: contractTest.operation,
          ...(contractTest.pollState === undefined
            ? {}
            : { pollState: contractTest.pollState }),
          actor: { kind: "system", id: "contract-test-runner" },
        },
        { timeoutMs: contractTest.timeoutMs },
      );
      if (process.env.CLASH_CONTRACT_TRACE)
        console.error("[contract] answered", contractTest.id);
      if (fixtureIndex !== contractTest.brokerFixtures.length) {
        throw new Error(
          `Contract test ${contractTest.id} consumed ${fixtureIndex} of ` +
            `${contractTest.brokerFixtures.length} broker fixtures.`,
        );
      }
      const actual: unknown =
        result.status === "completed"
          ? { status: result.status, outputs: result.outputs }
          : result.status === "accepted"
            ? { status: result.status, pollState: result.pollState }
            : { status: result.status, error: result.error };
      try {
        deepStrictEqual(actual, contractTest.expect);
      } catch {
        throw new Error(
          `Contract test ${contractTest.id} result mismatch. ` +
            `Expected ${canonicalJson(contractTest.expect)}, got ${canonicalJson(actual)}.`,
        );
      }
      completed.push({ id: contractTest.id, status: "passed" });
    } catch (error) {
      const details = stderr.trim();
      throw new Error(
        `${(error as Error).message}${details ? `\nPlugin stderr:\n${details}` : ""}`,
      );
    } finally {
      session.close();
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  return { passed: completed.length, tests: completed };
}

/**
 * Best-effort: find the workspace `packages/clash-sdk/python` directory.
 * Used to inject PYTHONPATH so action
 * authors don't need a `pip install` step during dev.
 */
function resolveSdkPythonDir(): string | null {
  // CLASH_ACTIONS_SDK_PATH lets prod / packaged installs point at a
  // pip-installed location without bundling the source tree.
  if (process.env.CLASH_ACTIONS_SDK_PATH) {
    return process.env.CLASH_ACTIONS_SDK_PATH;
  }
  const candidates = [
    resolve(process.cwd(), "packages/clash-sdk/python"),
    resolve(process.cwd(), "../../packages/clash-sdk/python"),
    resolve(process.cwd(), "../clash-sdk/python"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function managedPythonVenvDir(): string {
  return process.env.CLASH_ACTIONS_VENV || join(actionsDir(), ".venv");
}

function managedPythonBin(venvDir: string): string {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function explicitPythonStampDir(pythonBin: string): string {
  const key = Buffer.from(pythonBin).toString("base64url").slice(0, 80);
  return join(actionsDir(), ".python-deps", key);
}

function preparePythonRuntimeDeps(opts: {
  pythonBin: string;
  stampDir: string;
  actionId: string;
  actionDir: string;
  logPrefix: string;
}): string | null {
  const { pythonBin } = opts;
  const stamp = readPythonDepsStamp(opts.stampDir);
  let changed = false;
  const requirementsPath = join(opts.actionDir, "requirements.txt");
  if (existsSync(requirementsPath)) {
    const requirements = stamp.requirements ?? {};
    const requirementsKey = fileVersionKey(requirementsPath);
    if (requirements[opts.actionDir] !== requirementsKey) {
      process.stderr.write(
        `${opts.logPrefix}actions: python deps install id=${opts.actionId} requirements=${requirementsPath}\n`,
      );
      if (
        !runPythonSetup(
          pythonBin,
          ["-m", "pip", "install", "-r", requirementsPath],
          opts.logPrefix,
          opts.actionId,
        )
      ) {
        return null;
      }
      requirements[opts.actionDir] = requirementsKey;
      stamp.requirements = requirements;
      changed = true;
    }
  }

  if (changed) writePythonDepsStamp(opts.stampDir, stamp);
  return pythonBin;
}

function runPythonSetup(
  bin: string,
  args: string[],
  logPrefix: string,
  actionId: string,
): boolean {
  const result = spawnSync(bin, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.status === 0) return true;
  const detail =
    result.error instanceof Error
      ? result.error.message
      : `exit=${result.status}`;
  process.stderr.write(
    `${logPrefix}actions: python deps failed id=${actionId} command=${bin} ${args.join(" ")} ${detail}\n`,
  );
  return false;
}

function readPythonDepsStamp(venvDir: string): PythonDepsStamp {
  const path = join(venvDir, PYTHON_DEPS_STAMP);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PythonDepsStamp;
  } catch {
    return {};
  }
}

function writePythonDepsStamp(venvDir: string, stamp: PythonDepsStamp): void {
  mkdirSync(venvDir, { recursive: true });
  writeFileSync(
    join(venvDir, PYTHON_DEPS_STAMP),
    JSON.stringify(stamp, null, 2) + "\n",
  );
}

function fileVersionKey(path: string): string {
  const s = statSync(path);
  return `${s.size}:${Math.round(s.mtimeMs)}`;
}

export { pruneOrphanActivationReceipts } from "./orphan-receipts.js";
