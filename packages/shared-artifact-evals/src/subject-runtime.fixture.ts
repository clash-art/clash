import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Lays down the files `pack:distribution --self-contained` adds to a package:
 * a Node, the media binaries, the dependency identity and the manifest.
 */
export async function writeSelfContainedRuntime(
  pluginRoot: string,
  options: { node?: string; platform?: string; nodePath?: string } = {},
): Promise<{ nodeSha256: string; dependenciesSha256: string }> {
  const node = options.node ?? "#!/bin/sh\nexit 0\n";
  const files = {
    "node/bin/node": node,
    "node_modules/@ffmpeg-installer/target/ffmpeg": "ffmpeg bytes",
    "node_modules/@ffprobe-installer/target/ffprobe": "ffprobe bytes",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(pluginRoot, path)), { recursive: true });
    await writeFile(join(pluginRoot, path), content);
    await chmod(join(pluginRoot, path), 0o755);
  }
  const dependenciesSha256 = sha256("dependency tree");
  await mkdir(join(pluginRoot, "runtime"), { recursive: true });
  await writeFile(
    join(pluginRoot, "runtime", "runtime-dependencies.sha256"),
    `sha256:${dependenciesSha256}\n`,
  );
  await writeFile(
    join(pluginRoot, "self-contained.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: options.platform ?? process.platform,
      arch: process.arch,
      node: {
        version: "24.18.0",
        path: options.nodePath ?? "node/bin/node",
        sha256: sha256(node),
      },
      runtimeDependencies: { sha256: `sha256:${dependenciesSha256}` },
      media: {
        ffmpeg: {
          path: "node_modules/@ffmpeg-installer/target/ffmpeg",
          sha256: sha256("ffmpeg bytes"),
        },
        ffprobe: {
          path: "node_modules/@ffprobe-installer/target/ffprobe",
          sha256: sha256("ffprobe bytes"),
        },
      },
    }),
  );
  return { nodeSha256: sha256(node), dependenciesSha256 };
}
