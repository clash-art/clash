import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { BenchmarkSubjectRecord } from "./backend-types";
import { hashRegularFile } from "./environment-lock";

/** Written by `plugins/clash` `pack:distribution --self-contained`. */
const MANIFEST = "self-contained.json";

const SHA256 = /^[0-9a-f]{64}$/u;

export type SubjectBundledRuntime = {
  /** Runner-private absolute path of the Node the subject ships. */
  nodeExecPath: string;
  record: NonNullable<BenchmarkSubjectRecord["bundledRuntime"]>;
};

function inside(root: string, path: unknown, label: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path)) {
    throw new Error(`Self-contained subject manifest has no ${label} path`);
  }
  const absolute = resolve(root, path);
  const offset = relative(root, absolute);
  if (!offset || offset.startsWith("..") || isAbsolute(offset)) {
    throw new Error(`Self-contained subject ${label} escapes the package`);
  }
  return absolute;
}

/**
 * Reads the runtime a self-contained subject carries and re-hashes each binary,
 * so the record describes the files that will run rather than the manifest's
 * claim. Returns `undefined` for a subject that relies on the caller's Node.
 */
export async function readSubjectBundledRuntime(
  pluginRoot: string,
): Promise<SubjectBundledRuntime | undefined> {
  const root = await realpath(pluginRoot);
  let text: string;
  try {
    text = await readFile(join(root, MANIFEST), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const manifest = JSON.parse(text) as {
    schemaVersion?: unknown;
    platform?: unknown;
    arch?: unknown;
    node?: { version?: unknown; path?: unknown; sha256?: unknown };
    runtimeDependencies?: { sha256?: unknown };
    media?: Record<string, { path?: unknown; sha256?: unknown } | undefined>;
  };
  if (manifest.schemaVersion !== 1) {
    throw new Error("Self-contained subject manifest has an unknown schema");
  }
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  ) {
    throw new Error(
      `Self-contained subject targets ${String(manifest.platform)}-${String(manifest.arch)}, not ${process.platform}-${process.arch}`,
    );
  }
  const verified = async (
    entry: { path?: unknown; sha256?: unknown } | undefined,
    label: string,
  ) => {
    const path = inside(root, entry?.path, label);
    const evidence = await hashRegularFile(path);
    if (typeof entry?.sha256 !== "string" || entry.sha256 !== evidence.sha256) {
      throw new Error(
        `Self-contained subject ${label} differs from its manifest digest`,
      );
    }
    return { path, sha256: evidence.sha256 };
  };
  const node = await verified(manifest.node, "Node");
  const ffmpeg = await verified(manifest.media?.ffmpeg, "ffmpeg");
  const ffprobe = await verified(manifest.media?.ffprobe, "ffprobe");
  const nodeVersion = manifest.node?.version;
  if (
    typeof nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(nodeVersion)
  ) {
    throw new Error("Self-contained subject manifest has no Node version");
  }
  // The dependency tree identity is written beside the runtime at pack time.
  const dependencies = (
    await readFile(join(root, "runtime", "runtime-dependencies.sha256"), "utf8")
  )
    .trim()
    .replace(/^sha256:/u, "");
  if (
    !SHA256.test(dependencies) ||
    manifest.runtimeDependencies?.sha256 !== `sha256:${dependencies}`
  ) {
    throw new Error(
      "Self-contained subject dependency identity differs from its manifest",
    );
  }
  return {
    nodeExecPath: node.path,
    record: {
      platform: process.platform,
      arch: process.arch,
      node: { version: nodeVersion, sha256: node.sha256 },
      runtimeDependenciesSha256: dependencies,
      ffmpegSha256: ffmpeg.sha256,
      ffprobeSha256: ffprobe.sha256,
    },
  };
}
