import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function findRepoRoot(startDirectory: string): string {
  let directory = resolve(startDirectory);

  while (!existsSync(`${directory}/pnpm-workspace.yaml`)) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not find repository root");
    }
    directory = parent;
  }

  return directory;
}

const repoRoot = findRepoRoot(process.cwd());

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".remotion-bundle",
  ".tmp",
  ".turbo",
  ".vercel",
  ".venv",
  ".vite",
  ".vitepress",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "output",
  "release",
  // Installable plugins commit their built MCP/App artifacts for Codex to launch.
  "runtime",
]);

function collectJavaScriptSourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      if (ignoredDirectories.has(entry)) return [];
      // Local acceptance/render outputs are not maintained application source.
      if (directory === repoRoot && entry === "artifacts") return [];

      const path = `${directory}/${entry}`;
      const stat = statSync(path);
      if (stat.isDirectory()) {
        return collectJavaScriptSourceFiles(path);
      }

      if (entry.endsWith(".js") || entry.endsWith(".jsx")) {
        return [relative(repoRoot, path)];
      }

      return [];
    })
    .sort();
}

type WorkspacePackage = {
  directory: string;
  manifest: {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
};

function collectWorkspacePackages(directory: string): WorkspacePackage[] {
  return readdirSync(directory).flatMap((entry) => {
    if (ignoredDirectories.has(entry)) return [];
    const path = resolve(directory, entry);
    if (!statSync(path).isDirectory()) return [];
    const manifestPath = resolve(path, "package.json");
    if (existsSync(manifestPath)) {
      return [
        {
          directory: path,
          manifest: JSON.parse(
            readFileSync(manifestPath, "utf8"),
          ) as WorkspacePackage["manifest"],
        },
      ];
    }
    return collectWorkspacePackages(path);
  });
}

function collectTypeScriptSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (ignoredDirectories.has(entry)) return [];
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return collectTypeScriptSources(path);
    return /\.(?:cts|mts|mjs|ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const workspacePackages = ["apps", "packages", "plugins"].flatMap((directory) =>
  collectWorkspacePackages(resolve(repoRoot, directory)),
);

function importedModules(source: string): string[] {
  const imports: string[] = [];
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteral(node)) imports.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      add(node.moduleSpecifier);
    else if (ts.isExternalModuleReference(node)) add(node.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

// Repository-wide filesystem walks can overlap with package tests and type-checkers in CI.
const REPOSITORY_SCAN_TIMEOUT_MS = 30_000;

describe("repository conventions", () => {
  it("counts real imports without interpreting fixture strings or comments as dependencies", () => {
    const source = [
      'import { real } from "@clash/real";',
      'export { other } from "../other";',
      'const lazy = import("@clash/lazy");',
      'type T = import("@clash/types").T;',
      'const required = require("@clash/required");',
      '// import { fake } from "@clash/comment";',
      'const example = `import { fake } from "@clash/example";`;',
    ].join("\n");
    expect(importedModules(source)).toEqual([
      "@clash/real",
      "../other",
      "@clash/lazy",
      "@clash/types",
      "@clash/required",
    ]);
  });
  it(
    "keeps source files in TypeScript, not JavaScript",
    () => {
      expect(collectJavaScriptSourceFiles(repoRoot)).toEqual([]);
    },
    REPOSITORY_SCAN_TIMEOUT_MS,
  );

  it(
    "declares every directly imported workspace package",
    () => {
      const workspaceNames = new Set(
        workspacePackages.map(({ manifest }) => manifest.name),
      );
      const missing = workspacePackages.flatMap(({ directory, manifest }) => {
        const declared = new Set(
          Object.keys({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.optionalDependencies,
            ...manifest.peerDependencies,
          }),
        );
        return collectTypeScriptSources(directory).flatMap((sourcePath) => {
          const source = readFileSync(sourcePath, "utf8");
          const imports = importedModules(source);
          const packageImports = imports
            .map((specifier) =>
              /^(@clash(?:-plugin)?\/[A-Za-z0-9._-]+|clash)(?:\/|$)/.exec(
                specifier,
              ),
            )
            .filter((match) => match !== null);
          const missingPackageImports = [...packageImports].flatMap((match) => {
            const dependency = match[1];
            if (
              dependency === manifest.name ||
              !workspaceNames.has(dependency) ||
              declared.has(dependency)
            ) {
              return [];
            }
            return [
              {
                package: manifest.name,
                file: relative(repoRoot, sourcePath),
                dependency,
              },
            ];
          });
          const relativeImports = imports.filter((specifier) =>
            specifier.startsWith("../"),
          );
          const missingRelativeImports = relativeImports.flatMap(
            (specifier) => {
              const target = resolve(dirname(sourcePath), specifier);
              const owner = workspacePackages.find(
                ({ directory: candidate }) =>
                  target === candidate || target.startsWith(`${candidate}/`),
              );
              if (
                !owner ||
                owner.manifest.name === manifest.name ||
                declared.has(owner.manifest.name)
              ) {
                return [];
              }
              return [
                {
                  package: manifest.name,
                  file: relative(repoRoot, sourcePath),
                  dependency: owner.manifest.name,
                },
              ];
            },
          );
          return [...missingPackageImports, ...missingRelativeImports];
        });
      });

      expect(missing).toEqual([]);
    },
    REPOSITORY_SCAN_TIMEOUT_MS,
  );

  it("keeps cross-workspace orchestration in the root package", () => {
    const crossWorkspaceScripts = workspacePackages.flatMap(({ manifest }) =>
      Object.entries(manifest.scripts ?? {}).flatMap(([name, command]) =>
        /(?:npm\s+--prefix|pnpm\s+--(?:dir|filter)|turbo\s+run)/.test(command)
          ? [{ package: manifest.name, script: name, command }]
          : [],
      ),
    );

    expect(crossWorkspaceScripts).toEqual([]);
  });
});
