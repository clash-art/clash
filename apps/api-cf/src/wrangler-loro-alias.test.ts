import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * loro-crdt's default export condition resolves to a wasm-URL build
 * (`new URL("./loro_wasm_bg.wasm", import.meta.url)`), which Wrangler's
 * esbuild bundle cannot load — the Worker crashes at startup. The `base64`
 * entry instead compiles wasm at runtime, which workerd rejects with
 * "Wasm code generation disallowed by embedder". The `bundler` entry statically
 * imports its `.wasm` (bundled as a CompiledWasm module) but instantiates it
 * with a top-level `await`, which hangs lazily imported module graphs (#161).
 * The Worker shim uses the `web` entry and instantiates the precompiled module
 * synchronously.
 *
 * Rather than rewriting every source import, wrangler.toml carries one
 * central `[alias]` mapping. This test parses that table.
 */
function parseAliasTable(toml: string): Record<string, string> {
  const lines = toml.split("\n");
  const alias: Record<string, string> = {};
  let inAlias = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("[")) {
      inAlias = line === "[alias]";
      continue;
    }
    if (!inAlias) continue;
    const match = /^(?:"([^"]+)"|([A-Za-z0-9_.\-]+))\s*=\s*"([^"]*)"/.exec(line);
    if (match) alias[match[1] ?? match[2]] = match[3];
  }
  return alias;
}

describe("apps/api-cf/wrangler.toml [alias]", () => {
  const toml = readFileSync(resolve(__dirname, "../wrangler.toml"), "utf8");
  const alias = parseAliasTable(toml);

  it("maps the bare loro-crdt specifier to the synchronous Worker shim", () => {
    expect(alias["loro-crdt"]).toBe("./src/loro/loro-crdt-workerd.ts");
    const shim = readFileSync(
      resolve(__dirname, "loro/loro-crdt-workerd-init.ts"),
      "utf8",
    );
    expect(shim).toMatch(/\binitSync\(/);
    expect(shim).not.toMatch(/\bawait\b/);
  });

  it("declares a CompiledWasm rule so the shim's .wasm import loads", () => {
    const rules = toml
      .split(/^\[\[rules\]\]\s*$/m)
      .slice(1)
      .map((block) => block.split(/^\[/m)[0]);
    const compiled = rules.filter((block) =>
      /^\s*type\s*=\s*"CompiledWasm"\s*$/m.test(block),
    );
    expect(compiled.length).toBe(1);
    expect(compiled[0]).toMatch(/globs\s*=\s*\[[^\]]*"\*\*\/\*\.wasm"/);
    expect(compiled[0]).toMatch(/fallthrough\s*=\s*true/);
  });
});
