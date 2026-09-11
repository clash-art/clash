import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ExecutablePluginManifestSchema,
  ExecutablePluginActivationReceiptSchema,
  ExecutablePluginGeneratorRegistrationSchema,
  ExecutablePluginViewRegistrationSchema,
  isSafePluginRelativePath,
  generatorDefinitionFromExecutablePluginRegistration,
  pluginIdSchema,
  validateExecutablePluginPackage,
  type ExecutablePluginContractTestDocument,
  type ExecutablePluginGeneratorDocument,
  type ExecutablePluginGeneratorRegistration,
  type ExecutablePluginViewDocument,
  type ExecutablePluginViewRegistration,
  type ExecutablePluginModelBindingDocument,
  type ExecutablePluginProviderDocument,
  type GeneratorDefinition,
} from "@clash/shared-types";

import {
  createExecutablePluginActivationReceipt,
  executablePluginDirectoryContentHash,
  executablePluginActivationReceiptPath,
  runExecutablePluginContractTests,
  type ExecutablePluginContractTestRun,
} from "./host/lib/actions-loader.js";

export interface HostExecutablePluginPackage {
  id: string;
  manifest: unknown;
  files: Record<string, string>;
}

export interface ActivatedHostExecutablePluginPackage {
  targetDir: string;
  contractTests?: ExecutablePluginContractTestRun;
}

function decodeJsonDocuments<T>(
  paths: readonly { path: string }[],
  files: Record<string, string>,
  kind: string,
): Record<string, T> {
  const documents: Record<string, T> = {};
  for (const declaration of paths) {
    const encoded = files[declaration.path];
    if (typeof encoded !== "string") {
      throw new Error(`Missing declared ${kind}: ${declaration.path}`);
    }
    try {
      documents[declaration.path] = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      ) as T;
    } catch (error) {
      throw new Error(
        `Invalid ${kind} JSON at ${declaration.path}: ${(error as Error).message}`,
      );
    }
  }
  return documents;
}

function validateHostExecutablePluginArtifacts(
  input: HostExecutablePluginPackage,
) {
  const manifest = ExecutablePluginManifestSchema.parse(input.manifest);
  if (input.id !== manifest.id) {
    throw new Error(
      `Package id ${input.id} does not match plugin manifest id ${manifest.id}.`,
    );
  }
  if (manifest.runtime.kind !== "local") {
    throw new Error(`Plugin ${manifest.id} is not a local executable plugin.`);
  }
  for (const path of Object.keys(input.files)) {
    if (!isSafePluginRelativePath(path)) {
      throw new Error(`Refusing suspicious plugin package path: ${path}`);
    }
  }
  if (typeof input.files[manifest.runtime.entrypoint] !== "string") {
    throw new Error(
      `Plugin entrypoint ${manifest.runtime.entrypoint} is missing.`,
    );
  }

  const cards = decodeJsonDocuments(
    manifest.contributes.cards,
    input.files,
    "Card document",
  );
  const providers = decodeJsonDocuments<ExecutablePluginProviderDocument>(
    manifest.contributes.providers,
    input.files,
    "Provider document",
  );
  const modelBindings =
    decodeJsonDocuments<ExecutablePluginModelBindingDocument>(
      manifest.contributes.modelBindings,
      input.files,
      "model Provider binding",
    );
  const generators = decodeJsonDocuments<ExecutablePluginGeneratorDocument>(
    manifest.contributes.generators,
    input.files,
    "Generator document",
  );
  const views = decodeJsonDocuments<ExecutablePluginViewDocument>(
    manifest.contributes.views,
    input.files,
    "View document",
  );
  const contractTests =
    decodeJsonDocuments<ExecutablePluginContractTestDocument>(
      manifest.contractTests.map((path) => ({ path })),
      input.files,
      "contract test",
    );
  return validateExecutablePluginPackage(manifest, cards, contractTests, {
    providers,
    modelBindings,
    generators,
    views,
  });
}

export function validateHostExecutablePluginPackage(
  input: HostExecutablePluginPackage,
) {
  return validateHostExecutablePluginArtifacts(input).manifest;
}

async function writeHostPackageDirectory(
  directory: string,
  input: HostExecutablePluginPackage,
): Promise<void> {
  const manifest = validateHostExecutablePluginPackage(input);
  for (const [relativePath, encoded] of Object.entries(input.files)) {
    const destination = join(directory, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(encoded, "base64"));
  }
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function contractTestHostPackage(
  directory: string,
  input: HostExecutablePluginPackage,
): Promise<ExecutablePluginContractTestRun | undefined> {
  const manifest = validateHostExecutablePluginPackage(input);
  if (manifest.contributes.functions.length === 0) return undefined;
  return runExecutablePluginContractTests(directory);
}

async function writeActivationReceipt(
  actionsRoot: string,
  pluginDir: string,
  expectedContentHash?: string,
): Promise<void> {
  const receipt = await createExecutablePluginActivationReceipt(pluginDir);
  if (expectedContentHash && receipt.contentHash !== expectedContentHash) {
    throw new Error("Active plugin changed during revalidation; activate a new version.");
  }
  const target = executablePluginActivationReceiptPath(
    actionsRoot,
    receipt.pluginId,
  );
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), `.${receipt.pluginId}-`));
  const stagedReceipt = join(staging, "receipt.json");
  try {
    await writeFile(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    await rename(stagedReceipt, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Install a host-owned executable plugin atomically.
 *
 * The CLI may prepare or download a package, but only the daemon owns the live
 * actions directory and its activation receipts. Bundled plugins use this same
 * host path during startup, so local-api never reaches back into CLI commands.
 */
export async function activateHostExecutablePluginPackage(
  input: HostExecutablePluginPackage,
  actionsRoot: string,
): Promise<ActivatedHostExecutablePluginPackage> {
  const manifest = validateHostExecutablePluginPackage(input);
  const targetDir = join(actionsRoot, manifest.id);
  if (existsSync(targetDir)) {
    const existing = ExecutablePluginManifestSchema.parse(
      JSON.parse(await readFile(join(targetDir, "manifest.json"), "utf8")),
    );
    throw new Error(
      `Executable plugin ${manifest.id} version ${existing.version} is already active.`,
    );
  }

  await mkdir(actionsRoot, { recursive: true });
  const stagingDir = await mkdtemp(`${actionsRoot}.staging-${manifest.id}-`);
  let contractTests: ExecutablePluginContractTestRun | undefined;
  try {
    await writeHostPackageDirectory(stagingDir, input);
    contractTests = await contractTestHostPackage(stagingDir, input);
    await rename(stagingDir, targetDir);
    await writeActivationReceipt(actionsRoot, targetDir);
    return {
      targetDir,
      ...(contractTests ? { contractTests } : {}),
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    if (existsSync(targetDir))
      await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}

export interface ValidatedHostExecutablePluginPackage {
  id: string;
  version: string;
  generatorRegistrations: ExecutablePluginGeneratorRegistration[];
  generatorDefinitions: GeneratorDefinition[];
  viewRegistrations: ExecutablePluginViewRegistration[];
  contractTests?: ExecutablePluginContractTestRun;
}

function generatorArtifactsFor(
  validatedPackage: ReturnType<typeof validateHostExecutablePluginArtifacts>,
  schemaHash: string,
): Pick<
  ValidatedHostExecutablePluginPackage,
  "generatorRegistrations" | "generatorDefinitions"
> {
  const { manifest } = validatedPackage;
  const generatorRegistrations = Object.values(validatedPackage.generators)
    .map((document) =>
      ExecutablePluginGeneratorRegistrationSchema.parse({
        pluginId: manifest.id,
        version: manifest.version,
        schemaHash,
        document,
      }),
    )
    .sort((left, right) =>
      left.document.spec.definitionId.localeCompare(
        right.document.spec.definitionId,
      ),
    );
  return {
    generatorRegistrations,
    generatorDefinitions: generatorRegistrations.map((registration) =>
      generatorDefinitionFromExecutablePluginRegistration(registration),
    ),
  };
}

function viewArtifactsFor(
  validatedPackage: ReturnType<typeof validateHostExecutablePluginArtifacts>,
  schemaHash: string,
): Pick<ValidatedHostExecutablePluginPackage, "viewRegistrations"> {
  const { manifest } = validatedPackage;
  return {
    viewRegistrations: Object.values(validatedPackage.views)
      .map((document) =>
        ExecutablePluginViewRegistrationSchema.parse({
          pluginId: manifest.id,
          version: manifest.version,
          schemaHash,
          document,
        }),
      )
      .sort((left, right) =>
        left.document.spec.definitionId.localeCompare(
          right.document.spec.definitionId,
        ),
      ),
  };
}

/** Validate and execute a package's declared contracts without activating it. */
export async function validateHostExecutablePluginPackageContracts(
  input: HostExecutablePluginPackage,
  actionsRoot: string,
): Promise<ValidatedHostExecutablePluginPackage> {
  const validatedPackage = validateHostExecutablePluginArtifacts(input);
  const { manifest } = validatedPackage;
  await mkdir(dirname(actionsRoot), { recursive: true });
  const stagingDir = await mkdtemp(`${actionsRoot}.validate-${manifest.id}-`);
  try {
    await writeHostPackageDirectory(stagingDir, input);
    const contractTests = await contractTestHostPackage(stagingDir, input);
    const { schemaHash } =
      await createExecutablePluginActivationReceipt(stagingDir);
    return {
      id: manifest.id,
      version: manifest.version,
      ...generatorArtifactsFor(validatedPackage, schemaHash),
      ...viewArtifactsFor(validatedPackage, schemaHash),
      ...(contractTests ? { contractTests } : {}),
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export interface UpdatedHostExecutablePluginPackage extends ActivatedHostExecutablePluginPackage {
  id: string;
  version: string;
  rollbackDir?: string;
}

/**
 * Validate, contract-test, and atomically switch the daemon-owned active package.
 * The displaced version stays under `.rollback` until an explicit rollback.
 */
export async function activateOrUpdateHostExecutablePluginPackage(
  input: HostExecutablePluginPackage,
  actionsRoot: string,
): Promise<UpdatedHostExecutablePluginPackage> {
  const manifest = validateHostExecutablePluginPackage(input);
  const targetDir = join(actionsRoot, manifest.id);
  let sameVersion = false;
  let unchangedManifest: string | undefined;
  if (existsSync(join(targetDir, "manifest.json"))) {
    const manifestBytes = await readFile(join(targetDir, "manifest.json"), "utf8");
    const existing = ExecutablePluginManifestSchema.parse(
      JSON.parse(manifestBytes),
    );
    if (existing.version === manifest.version) {
      if (!isDeepStrictEqual(existing, manifest)) {
        throw new Error(`Executable plugin ${manifest.id} version ${manifest.version} is already active; bump the version before changing its manifest.`);
      }
      sameVersion = true;
      unchangedManifest = manifestBytes;
    }
  }

  await mkdir(actionsRoot, { recursive: true });
  const stagingDir = await mkdtemp(`${actionsRoot}.staging-${manifest.id}-`);
  let rollbackDir: string | undefined;
  try {
    await writeHostPackageDirectory(stagingDir, input);
    if (sameVersion) {
      // Host schema defaults and JSON formatting must not rewrite an unchanged
      // artifact during explicit revalidation of an older activation.
      await writeFile(join(stagingDir, "manifest.json"), unchangedManifest!);
      const stored = ExecutablePluginActivationReceiptSchema.parse(JSON.parse(await readFile(
        executablePluginActivationReceiptPath(actionsRoot, manifest.id), "utf8",
      )));
      const [activeHash, stagedHash] = await Promise.all([
        executablePluginDirectoryContentHash(targetDir),
        executablePluginDirectoryContentHash(stagingDir),
      ]);
      if (stored.pluginId !== manifest.id || stored.version !== manifest.version ||
        stored.contentHash !== activeHash || stored.contentHash !== stagedHash) {
        throw new Error(`Executable plugin ${manifest.id} version ${manifest.version} is already active; bump the version before changing executable code.`);
      }
      const contractTests = await contractTestHostPackage(stagingDir, input);
      await writeActivationReceipt(actionsRoot, targetDir, stored.contentHash);
      await rm(stagingDir, { recursive: true, force: true });
      return { id: manifest.id, version: manifest.version, targetDir, ...(contractTests ? { contractTests } : {}) };
    }
    const contractTests = await contractTestHostPackage(stagingDir, input);
    if (existsSync(targetDir)) {
      const rollbackRoot = join(actionsRoot, ".rollback", manifest.id);
      await mkdir(rollbackRoot, { recursive: true });
      const existing = JSON.parse(
        await readFile(join(targetDir, "manifest.json"), "utf8"),
      ) as { version?: string };
      rollbackDir = join(
        rollbackRoot,
        `${String(Date.now()).padStart(16, "0")}-${existing.version ?? "unknown"}`,
      );
      await rename(targetDir, rollbackDir);
    }

    try {
      await rename(stagingDir, targetDir);
      await writeActivationReceipt(actionsRoot, targetDir);
    } catch (error) {
      if (existsSync(targetDir) && !existsSync(stagingDir)) {
        try {
          await rename(targetDir, stagingDir);
        } catch {
          // Receipt verification remains fail-closed if recovery itself fails.
        }
      }
      if (rollbackDir && !existsSync(targetDir))
        await rename(rollbackDir, targetDir);
      throw error;
    }
    return {
      id: manifest.id,
      version: manifest.version,
      targetDir,
      ...(rollbackDir ? { rollbackDir } : {}),
      ...(contractTests ? { contractTests } : {}),
    };
  } catch (error) {
    if (existsSync(stagingDir))
      await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

/** Restore the newest retained daemon-owned package version. */
export async function rollbackHostExecutablePluginPackage(
  actionsRoot: string,
  inputId: string,
): Promise<{ id: string; targetDir: string; version: string }> {
  const id = pluginIdSchema.parse(inputId);
  const rollbackRoot = join(actionsRoot, ".rollback", id);
  const entries = (await readdir(rollbackRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{16}-/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const selected = entries[0];
  if (!selected) throw new Error(`No rollback version is available for ${id}.`);

  const targetDir = join(actionsRoot, id);
  const selectedDir = join(rollbackRoot, selected);
  const displacedDir = join(
    actionsRoot,
    ".rollback-displaced",
    id,
    String(Date.now()),
  );
  if (existsSync(targetDir)) {
    await mkdir(dirname(displacedDir), { recursive: true });
    await rename(targetDir, displacedDir);
  }
  try {
    await rename(selectedDir, targetDir);
    await writeActivationReceipt(actionsRoot, targetDir);
  } catch (error) {
    if (existsSync(targetDir) && !existsSync(selectedDir)) {
      try {
        await rename(targetDir, selectedDir);
      } catch {
        // Receipt verification remains fail-closed if recovery itself fails.
      }
    }
    if (existsSync(displacedDir) && !existsSync(targetDir)) {
      await rename(displacedDir, targetDir);
    }
    throw error;
  }
  const restored = ExecutablePluginManifestSchema.parse(
    JSON.parse(await readFile(join(targetDir, "manifest.json"), "utf8")),
  );
  return { id, targetDir, version: restored.version };
}

async function collectHostPackageFiles(
  root: string,
  directory: string,
  output: Record<string, string>,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "manifest.json")
      continue;
    const absolutePath = join(directory, entry.name);
    const relativePath = absolutePath
      .slice(root.length + 1)
      .split("\\")
      .join("/");
    if (!isSafePluginRelativePath(relativePath)) {
      throw new Error(
        `Refusing suspicious active plugin path: ${relativePath}`,
      );
    }
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Active plugins cannot contain symbolic links: ${relativePath}`,
      );
    }
    if (metadata.isDirectory()) {
      await collectHostPackageFiles(root, absolutePath, output);
    } else if (metadata.isFile()) {
      output[relativePath] = (await readFile(absolutePath)).toString("base64");
    }
  }
}

/** Return an attested active package for a CLI checkout. */
export async function readHostExecutablePluginPackage(
  actionsRoot: string,
  inputId: string,
): Promise<
  HostExecutablePluginPackage &
    Pick<
      ValidatedHostExecutablePluginPackage,
      "generatorRegistrations" | "generatorDefinitions"
      | "viewRegistrations"
    > & { version: string }
> {
  const id = pluginIdSchema.parse(inputId);
  const pluginDir = join(actionsRoot, id);
  const manifest = ExecutablePluginManifestSchema.parse(
    JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8")),
  );
  const storedReceipt = ExecutablePluginActivationReceiptSchema.parse(
    JSON.parse(
      await readFile(
        executablePluginActivationReceiptPath(actionsRoot, id),
        "utf8",
      ),
    ),
  );
  const currentReceipt =
    await createExecutablePluginActivationReceipt(pluginDir);
  if (
    storedReceipt.pluginId !== currentReceipt.pluginId ||
    storedReceipt.version !== currentReceipt.version ||
    storedReceipt.schemaHash !== currentReceipt.schemaHash ||
    storedReceipt.contentHash !== currentReceipt.contentHash
  ) {
    throw new Error(
      `Active plugin ${id} differs from its activation receipt; restore or reactivate it before checkout.`,
    );
  }
  const files: Record<string, string> = {};
  await collectHostPackageFiles(pluginDir, pluginDir, files);
  const validatedPackage = validateHostExecutablePluginArtifacts({
    id,
    manifest,
    files,
  });
  return {
    id,
    version: manifest.version,
    manifest,
    files,
    ...generatorArtifactsFor(validatedPackage, currentReceipt.schemaHash),
    ...viewArtifactsFor(validatedPackage, currentReceipt.schemaHash),
  };
}

/** Move an active package out of daemon-owned storage; keep it recoverable in trash. */
export async function removeHostExecutablePluginPackage(
  actionsRoot: string,
  inputId: string,
): Promise<{ id: string; removed: boolean; trashDir?: string }> {
  const id = pluginIdSchema.parse(inputId);
  const targetDir = join(actionsRoot, id);
  if (!existsSync(targetDir)) return { id, removed: false };
  const trashDir = join(actionsRoot, ".trash", `${id}-${Date.now()}`);
  await mkdir(dirname(trashDir), { recursive: true });
  await rename(targetDir, trashDir);
  const receiptPath = executablePluginActivationReceiptPath(actionsRoot, id);
  if (existsSync(receiptPath)) {
    const receiptTrash = join(trashDir, ".activation-receipt.json");
    await rename(receiptPath, receiptTrash);
  }
  return { id, removed: true, trashDir };
}

export async function listHostExecutablePluginPackages(
  actionsRoot: string,
): Promise<
  Array<{
    id: string;
    name?: string;
    version?: string;
    targetDir: string;
    drifted: boolean;
  }>
> {
  if (!existsSync(actionsRoot)) return [];
  const results = [];
  for (const entry of await readdir(actionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const targetDir = join(actionsRoot, entry.name);
    let manifest: { id?: string; name?: string; version?: string };
    try {
      manifest = JSON.parse(
        await readFile(join(targetDir, "manifest.json"), "utf8"),
      ) as typeof manifest;
    } catch {
      continue;
    }
    const id = manifest.id ?? entry.name;
    let drifted = false;
    try {
      await readHostExecutablePluginPackage(actionsRoot, id);
    } catch {
      drifted = true;
    }
    results.push({
      id,
      ...(manifest.name ? { name: manifest.name } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      targetDir,
      drifted,
    });
  }
  return results.sort((left, right) => left.id.localeCompare(right.id));
}
