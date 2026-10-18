import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/**
 * Build-time identity for the Host runtime payload: the entry bundle plus the
 * immutable directories it imports from. The launcher reads this instead of
 * hashing the whole 121 MB tree on every start.
 *
 * `runtime-dependencies.sha256` remains a separate identity because the
 * desktop packager rewrites it after copying the runtime into the app.
 */
export const LOCAL_DAEMON_RUNTIME_MANIFEST_FILE =
  "local-daemon-runtime.manifest.json";

export const LOCAL_DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION = 1;

export interface LocalDaemonRuntimeManifestFile {
  /** POSIX-relative to the runtime directory; `local-api.cjs` is the entry. */
  path: string;
  size: number;
  /** Hex sha256 of the file bytes. */
  sha256: string;
}

export interface LocalDaemonRuntimeManifest {
  schemaVersion: typeof LOCAL_DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION;
  entry: string;
  /** Directories walked by the runtime's cheap file-set/size check. */
  roots: string[];
  /** sha256 over every `path\0size\0sha256\n` line, in sorted path order. */
  treeDigest: string;
  files: LocalDaemonRuntimeManifestFile[];
}

export interface WriteLocalDaemonRuntimeManifestOptions {
  runtimeDir: string;
  entryFile?: string;
  payloadRoots?: readonly string[];
}

async function fileIdentity(
  runtimeDir: string,
  path: string,
): Promise<LocalDaemonRuntimeManifestFile> {
  const bytes = await readFile(path);
  return {
    path: relative(runtimeDir, path).split(sep).join("/"),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Writes the manifest beside the entry. The manifest itself is not listed, so
 * regenerating it cannot change its own digest.
 */
export async function writeLocalDaemonRuntimeManifest(
  options: WriteLocalDaemonRuntimeManifestOptions,
): Promise<LocalDaemonRuntimeManifest> {
  const runtimeDir = options.runtimeDir;
  const entryFile = options.entryFile ?? "local-api.cjs";
  const payloadRoots = options.payloadRoots ?? ["bundled-plugins", "project-ui"];
  const entryPath = join(runtimeDir, entryFile);
  await stat(entryPath);

  const files: LocalDaemonRuntimeManifestFile[] = [
    await fileIdentity(runtimeDir, entryPath),
  ];
  const roots: string[] = [];
  for (const root of payloadRoots) {
    const rootPath = join(runtimeDir, root);
    const info = await stat(rootPath).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    roots.push(root);
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          files.push(await fileIdentity(runtimeDir, path));
        } else {
          throw new Error(
            `Host runtime payload must be a regular file or directory: ${path}`,
          );
        }
      }
    };
    await visit(rootPath);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const treeDigest = createHash("sha256");
  for (const file of files) {
    treeDigest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  const manifest: LocalDaemonRuntimeManifest = {
    schemaVersion: LOCAL_DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION,
    entry: entryFile,
    roots,
    treeDigest: treeDigest.digest("hex"),
    files,
  };
  const manifestPath = join(runtimeDir, LOCAL_DAEMON_RUNTIME_MANIFEST_FILE);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
