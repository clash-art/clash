/**
 * Startup CPU guard (#142). Worker startup evaluates every statically
 * imported module. Better Auth (+kysely, ~1.7 MB) must load on first use via
 * `import()` (services/auth-loader.ts); a static import of it from Worker
 * source silently puts ~20 ms back on every cold start.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = __dirname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !path.includes("test-support")
      ? [path]
      : [];
  });
}

/** Static value imports (`import x from`, `export … from`, `import "x"`), not `import type`. */
function staticImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  const re =
    /^\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/gms;
  for (const m of text.matchAll(re)) {
    // `import { type A, type B } from` is type-only too.
    const clause = m[1].replace(/\s+/g, " ");
    if (/^\{(\s*type\s+[\w$]+\s*(as\s+[\w$]+\s*)?,?)+\s*\}$/.test(clause))
      continue;
    specs.push(m[2]);
  }
  for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm))
    specs.push(m[1]);
  return specs;
}

const REPO = resolve(SRC, "../../..");
const WORKSPACE_PATHS = (
  JSON.parse(
    readFileSync(join(REPO, "tsconfig.source.json"), "utf8"),
  ) as { compilerOptions: { paths: Record<string, string[]> } }
).compilerOptions.paths;

function existing(path: string): string | undefined {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    join(path, "index.ts"),
    path.replace(/\.js$/, ".ts"),
  ];
  return candidates.find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Repo source for a relative or workspace (`@clash/*`) specifier; undefined for packages. */
function resolveSource(spec: string, from: string): string | undefined {
  if (spec.startsWith(".")) return existing(resolve(dirname(from), spec));
  const exact = WORKSPACE_PATHS[spec]?.[0];
  if (exact) return existing(join(REPO, exact));
  const wildcard = Object.keys(WORKSPACE_PATHS)
    .filter((key) => key.endsWith("/*") && spec.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  if (!wildcard) return undefined;
  const target = WORKSPACE_PATHS[wildcard][0].replace(
    "*",
    spec.slice(wildcard.length - 1),
  );
  return existing(join(REPO, target.replace(/\.ts$/, "")));
}

/** Every module Worker startup evaluates: static imports only, across workspace packages. */
function eagerGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    for (const spec of staticImports(file)) {
      const source = resolveSource(spec, file);
      if (source) visit(source);
      else if (!spec.startsWith(".")) packages.add(spec);
      else throw new Error(`Unresolved import ${spec} in ${file}`);
    }
  };
  visit(entry);
  return { files, packages };
}

/** Modules that must load on first use: Ajv (`new Function`), Generator product logic, plugin JSON. */
function lazyOnlyOffenders(graph: ReturnType<typeof eagerGraph>): string[] {
  return [
    ...[...graph.packages].filter((spec) => /^ajv(\/|$)/.test(spec)),
    ...[...graph.files]
      .map((file) => relative(REPO, file))
      .filter(
        (file) =>
          /^plugins\/.*\.json$/.test(file) ||
          file === "packages/shared-runtime/src/timeline-generator-product.ts" ||
          file === "packages/shared-runtime/src/generator-contract.ts" ||
          file ===
            "packages/shared-runtime/src/cloud-project-host/project-assets.ts" ||
          file.startsWith("apps/api-cf/src/generated/") ||
          file.startsWith("apps/api-cf/src/services/cloud-plugin-") ||
          file.startsWith("packages/shared-runtime/src/cloud-project-host/") ||
          file === "apps/api-cf/src/agents/project-room-host-command.ts" ||
          file.startsWith("apps/api-cf/src/services/project-asset-room") ||
          file.startsWith("apps/api-cf/src/routes/v1/project-assets"),
      ),
  ];
}

describe("Worker startup import graph", () => {
  it("never statically imports Better Auth outside src/auth.ts", () => {
    const offenders = sources(SRC).flatMap((file) => {
      const rel = relative(SRC, file);
      if (rel === "auth.ts") return [];
      return staticImports(file)
        .filter(
          (s) =>
            /^(better-auth|@better-auth\/)/.test(s) ||
            (s.startsWith(".") &&
              resolve(dirname(file), s) === join(SRC, "auth")),
        )
        .map((s) => `${rel} -> ${s}`);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps Ajv, Generator product logic, generated validators and plugin JSON out of startup", () => {
    const startup = eagerGraph(join(SRC, "index.ts"));
    expect(startup.files.has(join(SRC, "app.ts"))).toBe(true);
    expect(lazyOnlyOffenders(startup)).toEqual([]);
  });

  it("keeps the Timeline Host command adapter out of ProjectRoom's cold start", () => {
    const room = eagerGraph(join(SRC, "agents/project-room.ts"));
    expect(lazyOnlyOffenders(room)).toEqual([]);
    const adapter = eagerGraph(join(SRC, "agents/project-room-host-command.ts"));
    expect(lazyOnlyOffenders(adapter)).toContain(
      "packages/shared-runtime/src/cloud-project-host/timeline-commands.ts",
    );
  });

  it("keeps Loro and the Project Asset module out of the upload Worker", () => {
    const upload = eagerGraph(join(SRC, "upload-worker.ts"));
    expect(
      [...upload.packages].filter((spec) => /^loro-crdt(\/|$)/.test(spec)),
    ).toEqual([]);
    const files = [...upload.files].map((file) => relative(REPO, file));
    expect(files).not.toContain(
      "packages/shared-runtime/src/cloud-project-host/project-assets.ts",
    );
    expect(files).not.toContain(
      "apps/api-cf/src/services/project-asset-room.ts",
    );
  });

  it("would detect those modules: the catalog service reaches all of them", () => {
    const catalog = eagerGraph(join(SRC, "services/cloud-plugin-catalog.ts"));
    const offenders = lazyOnlyOffenders(catalog);
    for (const expected of [
      "ajv",
      "plugins/remotion/manifest.json",
      "apps/api-cf/src/generated/cloud-plugin-validators.js",
      "packages/shared-runtime/src/generator-contract.ts",
    ])
      expect(offenders).toContain(expected);
  });
});
