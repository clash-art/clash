import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Build-time identity: callers need not scan native dependencies on every CLI invocation. */
export async function writeRuntimeDependencyIdentity(dependenciesDir: string, runtimeDir: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      // npm's command links may be dereferenced by Desktop staging; neither
      // they nor installer bookkeeping defines the modules loaded by the Host.
      if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
      const relative = `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
      } else {
        throw new Error(`Runtime dependency must be a materialized regular file: ${path}`);
      }
    }
  };
  await visit(dependenciesDir, "node_modules");
  const identity = `sha256:${hash.digest("hex")}`;
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "runtime-dependencies.sha256"), identity + "\n");
  return identity;
}
