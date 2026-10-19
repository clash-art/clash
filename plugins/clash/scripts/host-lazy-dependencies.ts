import type { Metafile } from "esbuild";

/**
 * Host dependencies that are imported on first use instead of during Host startup.
 *
 * Each one is loaded through a single-flight `createHostLazyModule` loader in apps/local-api. In
 * the CJS bundle esbuild defers a module's evaluation only while every path to it from the entry
 * is a dynamic `import()`; one static import anywhere in the eager graph puts its evaluation back
 * on the single startup event-loop block before the Host listens.
 */
export const LAZY_HOST_DEPENDENCIES: readonly string[] = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "sharp",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-trace-otlp-proto",
];

function packageOf(input: string): string | undefined {
  const marker = input.lastIndexOf("node_modules/");
  if (marker < 0) return undefined;
  const [scope, name] = input.slice(marker + "node_modules/".length).split("/");
  return scope?.startsWith("@") ? `${scope}/${name}` : scope;
}

/**
 * Fails the build when a lazily imported Host dependency is reachable from the entry through
 * static imports, naming the import chain that made it eager again.
 */
export function assertLazyHostDependenciesStayLazy(
  metafile: Pick<Metafile, "inputs">,
  entrySuffix: string,
  dependencies: readonly string[] = LAZY_HOST_DEPENDENCIES,
): void {
  const entry = Object.keys(metafile.inputs).find((input) =>
    input.endsWith(entrySuffix),
  );
  if (!entry) throw new Error(`Host entry ${entrySuffix} is not in the bundle metafile`);
  const lazy = new Set(dependencies);
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const violations = new Map<string, string[]>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependency = packageOf(current);
    if (dependency && lazy.has(dependency) && !violations.has(dependency)) {
      const chain: string[] = [];
      for (let at: string | null = current; at; at = parent.get(at) ?? null) chain.unshift(at);
      violations.set(dependency, chain);
    }
    for (const imported of metafile.inputs[current]?.imports ?? []) {
      if (imported.external || imported.kind === "dynamic-import") continue;
      if (parent.has(imported.path)) continue;
      parent.set(imported.path, current);
      queue.push(imported.path);
    }
  }
  if (violations.size > 0) {
    throw new Error(
      "Lazily imported Host dependencies are statically reachable from the Host entry and would be evaluated at startup:\n" +
        [...violations]
          .map(([dependency, chain]) => `${dependency}: ${chain.join(" -> ")}`)
          .join("\n"),
    );
  }
}
