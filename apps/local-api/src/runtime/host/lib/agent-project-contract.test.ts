import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps Clash navigation out of generated repository instruction files", async () => {
  const bundleScript = await readFile(
    new URL(
      "../../../../../../packages/cli/scripts/bundle-agents.ts",
      import.meta.url,
    ),
    "utf8",
  );

  expect(bundleScript).not.toMatch(/AGENTS-prelude|AGENTS\.md|CLAUDE\.md|GEMINI\.md/);
  expect(bundleScript).toMatch(/skills/);
});

it("pins the local-first project invariants for repository coding agents", async () => {
  const repositoryContract = await readFile(
    new URL("../../../../../../AGENTS.md", import.meta.url),
    "utf8",
  );

  expect(repositoryContract).toMatch(/project\.toml.*project reference/is);
  expect(repositoryContract).toMatch(/agent.*owns.*working tree/is);
  expect(repositoryContract).toMatch(/same local replica/is);
  expect(repositoryContract).toMatch(/cloud.*replicator/is);
  expect(repositoryContract).toMatch(/apply.*CAS.*copy-on-write/is);
  expect(repositoryContract).toMatch(/status.*diagnostic/is);
  expect(repositoryContract).toMatch(/force.*not.*privilege/is);
  expect(repositoryContract).not.toMatch(/force\s*\/\s*admin|force-admin/is);
});
