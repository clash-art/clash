import { readFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { parse as parseYaml } from "yaml";

import { ArtifactBenchmarkSuiteSchema } from "./schemas";
import type { ArtifactBenchmarkSuite } from "./types";
import { resolveTaskSkillPack } from "./task-skill-pack";

function formatSuiteIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.join(".") : "suite"}: ${issue.message}`,
    )
    .join("; ");
}

export async function loadBenchmarkSuite(
  path: string,
): Promise<ArtifactBenchmarkSuite> {
  const source = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw =
      extname(path).toLowerCase() === ".json"
        ? JSON.parse(source)
        : parseYaml(source);
  } catch (error) {
    throw new Error(
      `Unable to parse benchmark suite '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = ArtifactBenchmarkSuiteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid benchmark suite '${path}': ${formatSuiteIssues(parsed.error.issues)}`,
    );
  }
  return {
    ...parsed.data,
    cases: await Promise.all(
      parsed.data.cases.map(async (task) => ({
        ...task,
        skills: await resolveTaskSkillPack(task, dirname(path)),
      })),
    ),
  };
}
