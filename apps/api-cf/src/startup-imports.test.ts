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

/** Static value imports (`import x from`, `export … from`), not `import type`. */
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
  return specs;
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
});
