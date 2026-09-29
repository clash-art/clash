import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function fingerprint(path: string): string {
  const hash = createHash("sha256");
  function visit(current: string): void {
    if (statSync(current).isDirectory()) {
      for (const entry of readdirSync(current).sort()) {
        if (
          entry === "node_modules" ||
          entry.startsWith(".") ||
          /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)
        )
          continue;
        hash.update(entry + "\0");
        visit(join(current, entry));
      }
    } else {
      hash.update(readFileSync(current));
    }
  }
  visit(path);
  return hash.digest("hex");
}

/** Build-only receipt: keep it outside dist/client so local paths never ship. */
export function recordRendererInputs(
  receipt: string,
  inputs: readonly string[],
): void {
  const files = Object.fromEntries(
    [...new Set(inputs)].sort().map((path) => [relative(dirname(receipt), path), fingerprint(path)]),
  );
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, JSON.stringify({ version: 1, files }, null, 2) + "\n");
}

export function assertRendererInputsAreFresh(receipt: string): void {
  try {
    const data = JSON.parse(readFileSync(receipt, "utf8")) as {
      version: number;
      files: Record<string, string>;
    };
    if (
      data.version !== 1 ||
      !data.files ||
      Object.keys(data.files).length === 0
    )
      throw new Error("Missing build inputs");
    for (const [path, expected] of Object.entries(data.files)) {
      if (fingerprint(resolve(dirname(receipt), path)) !== expected)
        throw new Error(`Changed renderer input: ${path}`);
    }
  } catch (cause) {
    throw new Error(
      "Refusing to package a stale or unverified project renderer. Rebuild with `pnpm build:package clash` from the repository root.",
      { cause },
    );
  }
}
