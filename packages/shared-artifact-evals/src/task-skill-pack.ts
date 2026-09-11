import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import type { ArtifactBenchmarkCase } from "./types";

const PackCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    packs: z.record(
      z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      z
        .object({
          description: z.string().min(1),
          skills: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
  })
  .strict();

/** Resolve before locking the Environment so the existing installer and digest
 * checks cover the exact task selection, never every skill in the catalog. */
export async function resolveTaskSkillPack(
  task: Pick<ArtifactBenchmarkCase, "skills" | "skillPack">,
  suiteRoot: string,
): Promise<string[]> {
  if (!task.skillPack) return task.skills;
  const catalogPath = resolve(suiteRoot, task.skillPack.path);
  const catalog = PackCatalogSchema.parse(
    JSON.parse(await readFile(catalogPath, "utf8")),
  );
  const pack = Object.hasOwn(catalog.packs, task.skillPack.id)
    ? catalog.packs[task.skillPack.id]
    : undefined;
  if (!pack)
    throw new Error(
      `Unknown task skill pack '${task.skillPack.id}' in ${catalogPath}`,
    );
  const paths = [
    ...pack.skills.map((path) => resolve(dirname(catalogPath), path)),
    ...task.skills.map((path) => resolve(suiteRoot, path)),
  ];
  return [...new Set(paths)].map((path) => relative(resolve(suiteRoot), path));
}
