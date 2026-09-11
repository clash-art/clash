import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const pending = new Map<string, Promise<void>>();

/** Materialize Host-scoped installations in shared native skill directories. */
export async function ensureProjectSkillLinks(options: {
  cwd: string;
  nativeDirectories: readonly string[];
  initialSkills: ReadonlyMap<string, string>;
  installedSkills?: ReadonlyMap<string, string>;
}): Promise<void> {
  const previous = pending.get(options.cwd) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => install(options));
  pending.set(options.cwd, work);
  try {
    await work;
  } finally {
    if (pending.get(options.cwd) === work) pending.delete(options.cwd);
  }
}

async function install({
  cwd,
  nativeDirectories,
  initialSkills,
  installedSkills,
}: Parameters<typeof ensureProjectSkillLinks>[0]) {
  const canonical = join(cwd, ".agents", "skills");
  await localDirectory(dirname(canonical));
  const current = await entry(canonical);
  if (current && !current.isDirectory()) {
    throw new Error(`Project skills must be a local directory: ${canonical}`);
  }
  // Only a new directory gets defaults. Existing user entries stay intact;
  // explicit Host installations below are reconciled separately.
  if (!current) {
    const legacySelections = await Promise.all(
      nativeDirectories.map((directory) => entry(join(cwd, directory))),
    );
    await mkdir(canonical);
    if (!legacySelections.some((selection) => selection?.isDirectory())) {
      for (const [name, source] of initialSkills) {
        await symlink(source, join(canonical, name), "dir");
      }
    }
  }
  // Host configuration owns installation scope. This only materializes links;
  // stale files are never interpreted as configuration or automatically pruned.
  for (const [name, source] of installedSkills ?? []) {
    const target = join(canonical, name);
    const existing = await entry(target);
    if (existing) {
      if (
        existing.isSymbolicLink() &&
        resolve(canonical, await readlink(target)) === source
      )
        continue;
      throw new Error(
        `Existing workspace entry blocks installed skill '${name}': ${target}`,
      );
    }
    await symlink(source, target, "dir");
  }
  for (const directory of new Set(nativeDirectories)) {
    const alias = join(cwd, directory);
    if (alias === canonical) continue;
    await localDirectory(dirname(alias));
    const existing = await entry(alias);
    if (existing?.isSymbolicLink()) {
      if (resolve(dirname(alias), await readlink(alias)) === canonical)
        continue;
      throw new Error(`Native skills already point elsewhere: ${alias}`);
    }
    if (existing) {
      if (!existing.isDirectory())
        throw new Error(
          `Existing workspace entry blocks native skills: ${alias}`,
        );
      await consolidate(alias, canonical);
    }
    await symlink(relative(dirname(alias), canonical), alias, "dir");
  }
}

/** Move legacy entries, preserving contents. Conflicting names need a merge. */
async function consolidate(legacy: string, canonical: string): Promise<void> {
  const moves: Array<{ source: string; target: string }> = [];
  const duplicates: string[] = [];
  for (const name of await readdir(legacy)) {
    const source = join(legacy, name);
    const target = join(canonical, name);
    const targetEntry = await entry(target);
    if (!targetEntry) {
      moves.push({ source, target });
    } else if (
      (await entry(source))?.isSymbolicLink() &&
      targetEntry.isSymbolicLink() &&
      resolve(legacy, await readlink(source)) ===
        resolve(canonical, await readlink(target))
    ) {
      duplicates.push(source);
    } else {
      throw new Error(
        `Conflicting project skill '${name}': merge ${source} with ${target} before restarting the session.`,
      );
    }
  }
  for (const { source, target } of moves) {
    // Preserve relative symlinks when relocating their directory entry.
    if ((await entry(source))?.isSymbolicLink()) {
      await symlink(resolve(legacy, await readlink(source)), target, "dir");
      await unlink(source);
    } else {
      await rename(source, target);
    }
  }
  for (const source of duplicates) await unlink(source);
  await rmdir(legacy);
}

async function entry(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function localDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory())
    throw new Error(`Expected a local workspace directory: ${path}`);
}
