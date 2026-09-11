import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const MetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

/** Native Codex still discovers user skills with --ignore-user-config.
 * Disable its automatic instructions block and supply only this locked Task's
 * metadata through developer_instructions. Bodies remain native files, loaded
 * on demand. Both options are documented in the upstream config schema:
 * https://developers.openai.com/codex/config-schema.json
 */
export async function renderCodexTaskSkillContext(
  workspace: string,
): Promise<string> {
  const root = join(workspace, ".agents", "skills");
  const folders = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const skills = await Promise.all(
    folders
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = join(root, entry.name, "SKILL.md");
        const source = await readFile(path, "utf8");
        const frontmatter = source.match(
          /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u,
        )?.[1];
        if (!frontmatter)
          throw new Error(`Task skill has no YAML frontmatter: ${path}`);
        return { ...MetadataSchema.parse(parseYaml(frontmatter)), path };
      }),
  );
  return `# Task skills

The following skills are mounted for this Task. Read the matching skill file when its description applies, then load only the relevant supporting references. Preserve the user's requested scope. Use these task-local copies as the skill catalog for this run; other machine or project skills are outside this Task's selection.

${skills.length ? JSON.stringify(skills, null, 2) : "No skills are mounted for this Task."}`;
}
