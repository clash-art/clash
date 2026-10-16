import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function findRepoRoot(startDirectory: string): string {
  let directory = resolve(startDirectory);
  while (directory !== dirname(directory)) {
    if (statSync(join(directory, "pnpm-workspace.yaml"), { throwIfNoEntry: false })?.isFile()) {
      return directory;
    }
    directory = dirname(directory);
  }
  throw new Error("Could not find repository root");
}

const repoRoot = findRepoRoot(process.cwd());

function spell(...codes: number[]): string {
  return String.fromCharCode(...codes);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readScript(name: string): string {
  return readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function sourceFilesUnder(path: string): string[] {
  const root = join(repoRoot, path);
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === "release"
      ) {
        continue;
      }
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (/\.(ts|tsx|md|mjs|json)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function filesUnder(path: string): string[] {
  const root = join(repoRoot, path);
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === "release"
      ) {
        continue;
      }
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

describe("local data dir contract", () => {
  it("uses only the canonical local-api data directory in conformance scripts", () => {
    const googleAgentPlatform = readScript("google-agent-platform-conformance.ts");

    for (const script of [googleAgentPlatform]) {
      expect(script).toContain("defaultLocalApiDataDir(process.env)");
      expect(script).not.toContain("Application Support");
      expect(script).not.toContain("defaultDesktopDataDir");
    }
  });

  it("keeps broad app metadata file names out of local-first source, docs, and skills", () => {
    const forbiddenBroadStoreSpellings = [
      String.fromCharCode(100, 98, 46, 106, 115, 111, 110),
      String.fromCharCode(100, 98, 92, 46, 106, 115, 111, 110),
    ];
    const scannedFiles = [
      ...sourceFilesUnder("apps/local-api/src"),
      ...sourceFilesUnder("packages/cli/src"),
      ...sourceFilesUnder("packages/shared-runtime/src"),
      ...sourceFilesUnder("packages/shared-types/src"),
      ...sourceFilesUnder("packages/web-ui/src"),
      ...sourceFilesUnder("skills"),
      ...sourceFilesUnder("docs"),
    ];

    const matches = scannedFiles
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .flatMap(({ file, content }) =>
        forbiddenBroadStoreSpellings
          .filter((name) => content.includes(name))
          .map(() => `${file.slice(repoRoot.length + 1)} contains a forbidden app metadata spelling`),
      );

    expect(matches).toEqual([]);
  });

  it("keeps retired local-api JSON sidecars confined to one-way migration code and spec", () => {
    const forbiddenLocalConfigFiles = [
      spell(115, 121, 110, 99, 46, 106, 115, 111, 110),
      spell(97, 117, 100, 105, 111, 46, 106, 115, 111, 110),
      spell(104, 97, 114, 110, 101, 115, 115, 101, 115, 46, 106, 115, 111, 110),
    ];
    const scannedFiles = [
      ...sourceFilesUnder("apps/local-api/src"),
      ...sourceFilesUnder("apps/desktop/e2e"),
      ...sourceFilesUnder("packages/cli/src"),
      ...sourceFilesUnder("packages/shared-runtime/src"),
      ...sourceFilesUnder("packages/web-ui/src"),
      ...sourceFilesUnder("skills"),
      ...sourceFilesUnder("docs"),
    ].filter((file) => {
      const relative = file.slice(repoRoot.length + 1);
      return (
        relative !== "apps/local-api/src/local-data-dir-contract.test.ts"
        && relative !== "apps/local-api/src/local-acp.ts"
        && relative !== "docs/self-host-storage-spec.md"
      );
    });

    const forbiddenLocalConfigFilePatterns = forbiddenLocalConfigFiles.map((name) => ({
      name,
      // `audio.json()` reads a response held in a variable that shares the
      // stem; it is a call, not a file name.
      pattern: new RegExp(`(^|[^A-Za-z0-9._-])${escapeRegExp(name)}($|[^A-Za-z0-9._(-])`),
    }));
    // The model-generation plugin's Generator definition shares a retired
    // sidecar's file name but lives in the plugin package, not the data dir.
    const pluginGeneratorDefinition = [
      "plugins/model-generation/generators",
      forbiddenLocalConfigFiles[1],
    ].join("/");

    const matches = scannedFiles
      .map((file) => ({
        file,
        content: readFileSync(file, "utf8").replaceAll(pluginGeneratorDefinition, ""),
      }))
      .flatMap(({ file, content }) =>
        forbiddenLocalConfigFilePatterns
          .filter(({ pattern }) => pattern.test(content))
          .map(({ name }) => name)
          .map((name) => `${file.slice(repoRoot.length + 1)} contains removed local config sidecar ${name}`),
      );

    expect(matches).toEqual([]);
  });

  it("keeps broad app metadata file names out of the repository tree", () => {
    const forbiddenBroadStoreFilename = String.fromCharCode(100, 98, 46, 106, 115, 111, 110);
    const scannedFiles = [
      ...filesUnder(".github"),
      ...filesUnder("apps"),
      ...filesUnder("docs"),
      ...filesUnder("packages"),
      ...filesUnder("scripts"),
      ...filesUnder("skills"),
    ];

    const matches = scannedFiles
      .filter((file) => basename(file) === forbiddenBroadStoreFilename)
      .map((file) => `${file.slice(repoRoot.length + 1)} uses a forbidden broad app metadata filename`);

    expect(matches).toEqual([]);
  });

  it("keeps broad app-state file compatibility paths removed", () => {
    const spell = (...codes: number[]) => String.fromCharCode(...codes);
    const old = spell(108, 101, 103, 97, 99, 121);
    const product = spell(112, 114, 111, 100, 117, 99, 116);
    const upperProduct = spell(80, 114, 111, 100, 117, 99, 116);
    const db = spell(100, 98);
    const json = spell(106, 115, 111, 110);
    const upperJson = spell(74, 115, 111, 110);
    const titleDatabase = spell(68, 97, 116, 97, 98, 97, 115, 101);
    const upperDatabase = spell(68, 66);
    const forbiddenFragments = [
      [old, upperProduct, upperJson, titleDatabase].join(""),
      [old, "-", product, "-", json, "-", titleDatabase.toLowerCase()].join(""),
      [old, " ", product, " ", upperDatabase].join(""),
      [product, " ", upperDatabase].join(""),
    ];
    const forbiddenJoinPattern = new RegExp(
      String.raw`\[\s*["']${db}["']\s*,\s*["']${json}["']\s*\]\.join\(\s*["']\.["']\s*\)`,
    );
    const scannedFiles = [
      ...sourceFilesUnder("apps/local-api/src"),
      ...sourceFilesUnder("apps/desktop/e2e"),
      ...sourceFilesUnder("packages/cli/src"),
      ...sourceFilesUnder("packages/shared-runtime/src"),
      ...sourceFilesUnder("packages/shared-types/src"),
      ...sourceFilesUnder("packages/web-ui/src"),
      ...sourceFilesUnder("skills"),
      ...sourceFilesUnder("docs"),
    ];

    const matches = scannedFiles.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      const relativePath = file.slice(repoRoot.length + 1);
      const fragmentMatches = forbiddenFragments
        .filter((fragment) => content.includes(fragment))
        .map((fragment) => `${relativePath} contains ${fragment}`);
      return forbiddenJoinPattern.test(content)
        ? [...fragmentMatches, `${relativePath} constructs a forbidden local-first product filename`]
        : fragmentMatches;
    });

    expect(matches).toEqual([]);
  });

  it("keeps hidden broad app-state compatibility hooks out of source, docs, and skills", () => {
    const scannedFiles = [
      ...sourceFilesUnder("apps/desktop/e2e"),
      ...sourceFilesUnder("apps/local-api/src"),
      ...sourceFilesUnder("packages/cli/src"),
      ...sourceFilesUnder("packages/shared-runtime/src"),
      ...sourceFilesUnder("packages/shared-types/src"),
      ...sourceFilesUnder("packages/web-ui/src"),
      ...sourceFilesUnder("skills"),
      ...sourceFilesUnder("docs"),
    ].filter((file) => !file.endsWith("apps/local-api/src/local-data-dir-contract.test.ts"));
    const forbidden = [
      /old broad app-state/i,
      /old-broad-app-state/i,
      /removedBroadAppState/i,
      /String\.fromCharCode\(\s*100\s*,\s*98\s*,\s*46\s*,\s*106\s*,\s*115\s*,\s*111\s*,\s*110\s*\)/,
    ];

    const matches = scannedFiles.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      const relativePath = file.slice(repoRoot.length + 1);
      return forbidden
        .filter((pattern) => pattern.test(content))
        .map((pattern) => `${relativePath} contains removed broad app-state compatibility hook ${pattern}`);
    });

    expect(matches).toEqual([]);
  });

  it("keeps legacy remote vars and room commands off the local-first CLI surface", () => {
    const cliIndex = readRepoFile("packages/cli/src/index.ts");

    expect(cliIndex).not.toContain("./commands/vars");
    expect(cliIndex).not.toContain("./commands/room");
    expect(cliIndex).not.toContain("varsCommand");
    expect(cliIndex).not.toContain("roomCommand");
  });

  it("keeps removed room and vars commands out of agent-facing docs and skills", () => {
    const scannedFiles = [
      ...sourceFilesUnder("skills"),
      ...sourceFilesUnder("docs"),
    ].filter((file) => !/\.test\.(mjs|ts|tsx|js|jsx)$/.test(file));

    const forbidden = [
      /clash vars\b/,
      /clash room\b/,
      /commands\/vars/,
      /commands\/room/,
    ];
    const matches = scannedFiles.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      const relativePath = file.slice(repoRoot.length + 1);
      return forbidden
        .filter((pattern) => pattern.test(content))
        .map((pattern) => `${relativePath} contains removed command spelling ${pattern}`);
    });

    expect(matches).toEqual([]);
  });

  it("documents Settings sync readiness switches as the cloud admission control", () => {
    const inventory = readRepoFile("docs/agent-first-local-v1-api-surface-inventory.md");
    const boundary = readRepoFile("docs/agent-first-local-v1-remote-compatibility-boundary.md");
    const traceability = readRepoFile("docs/agent-first-local-v1-traceability-matrix.md");

    for (const doc of [inventory, boundary, traceability]) {
      expect(doc).toContain("SettingsClient");
      expect(doc).toContain("Cloud mirror readiness");
      expect(doc).toContain("Canvas mirror ready");
      expect(doc).toContain("Asset metadata mirror ready");
      expect(doc).toContain("Revision content mirror ready");
    }
  });
});
