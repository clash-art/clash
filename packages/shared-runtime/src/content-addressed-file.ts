import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ContentAddressedFilePublication =
  "created" | "existing" | "repaired";

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function syncDirectory(path: string): Promise<void> {
  // Windows cannot flush a directory handle; the file's own fsync is the durability there.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publishes immutable bytes without exposing a partial canonical final. A
 * mismatched existing final at the hash-derived path is writer-owned crash
 * residue, so an exact temporary file atomically repairs it.
 */
export async function publishContentAddressedFile(
  path: string,
  bytes: Uint8Array,
  options: {
    isValidForIdentity: (candidate: Uint8Array) => boolean;
  },
): Promise<ContentAddressedFilePublication> {
  if (!options.isValidForIdentity(bytes)) {
    throw new Error(
      "Content-addressed candidate does not match its path identity.",
    );
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${randomUUID()}.content-addressed.tmp`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o444);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      await syncDirectory(directory);
      return "created";
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const repairLock = `${path}.repair-lock`;
    let lockHeld = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(repairLock);
        lockHeld = true;
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await delay(5);
      }
    }
    if (!lockHeld) {
      throw new Error("Content-addressed repair is already in progress.");
    }
    try {
      let existing: Buffer;
      try {
        existing = await readFile(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          await link(temporaryPath, path);
          await syncDirectory(directory);
          return "created";
        } catch (publishError) {
          if (!isAlreadyExists(publishError)) throw publishError;
          existing = await readFile(path);
        }
      }
      if (existing.equals(Buffer.from(bytes))) {
        await chmod(path, 0o444);
        return "existing";
      }
      if (options.isValidForIdentity(existing)) {
        throw new Error(
          "Content-addressed identity collision: existing bytes differ.",
        );
      }
      await rename(temporaryPath, path);
      temporaryExists = false;
      await syncDirectory(directory);
      return "repaired";
    } finally {
      await rm(repairLock, { recursive: true, force: true });
      await syncDirectory(directory).catch(() => undefined);
    }
  } finally {
    if (temporaryExists) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
