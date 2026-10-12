import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** V8 writes and runs generated code, which the hardened runtime forbids without these. */
export const NODE_ENTITLEMENTS = join(dirname(fileURLToPath(import.meta.url)), "node.entitlements.plist");

export type MacSigning = {
  /** A Developer ID Application identity: its name or SHA-1 hash. */
  identity: string;
  /** Searched instead of the default keychain list when set. */
  keychain?: string;
};

/** The Desktop identity, when the workflow imported it; unsigned otherwise. */
export function macSigningFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): MacSigning | undefined {
  const identity = env.CLASH_CLI_MAC_SIGN_IDENTITY?.trim();
  if (platform !== "darwin" || !identity) return undefined;
  return { identity, keychain: env.CLASH_CLI_MAC_SIGN_KEYCHAIN?.trim() || undefined };
}

const THIN_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);

/** Mach-O by content: notarization rejects any unsigned one, whatever its name. */
export async function isMachO(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    if (bytesRead < 8) return false;
    const magic = header.readUInt32BE(0);
    // A universal binary shares its magic with Java classes, whose next word is a version above 40.
    return THIN_MAGIC.has(magic) || (magic === 0xcafebabe && header.readUInt32BE(4) < 20);
  } finally {
    await handle.close();
  }
}

export async function machOFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && (await isMachO(path))) found.push(path);
  }
  return found.sort();
}

/** Developer ID signature with the hardened runtime and a secure timestamp, as notarization requires. */
export async function signMachO(path: string, signing: MacSigning, entitlements?: string): Promise<void> {
  await execute("codesign", [
    "--force", "--options", "runtime", "--timestamp",
    "--sign", signing.identity,
    ...(signing.keychain ? ["--keychain", signing.keychain] : []),
    ...(entitlements ? ["--entitlements", entitlements] : []),
    path,
  ]);
}

/** Signs every Mach-O below `root` in place and returns how many there were. */
export async function signMachOTree(root: string, signing: MacSigning): Promise<number> {
  const files = await machOFiles(root);
  // Sequential: each signature waits on Apple's timestamp service.
  for (const file of files) await signMachO(file, signing);
  return files.length;
}
