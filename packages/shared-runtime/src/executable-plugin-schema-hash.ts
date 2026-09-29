import { createHash } from "node:crypto";
import type {
  ExecutablePluginManifest,
  ExecutablePluginCardDocument,
  ExecutablePluginProviderDocument,
  ExecutablePluginModelBindingDocument,
  ExecutablePluginGeneratorDocument,
  ExecutablePluginViewDocument,
} from "@clash/shared-types";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function executablePluginSchemaHash(
  manifest: ExecutablePluginManifest,
  cards: Record<string, ExecutablePluginCardDocument>,
  providers: Record<string, ExecutablePluginProviderDocument> = {},
  modelBindings: Record<string, ExecutablePluginModelBindingDocument> = {},
  generators: Record<string, ExecutablePluginGeneratorDocument> = {},
  views: Record<string, ExecutablePluginViewDocument> = {},
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        apiVersion: manifest.apiVersion,
        id: manifest.id,
        version: manifest.version,
        contributes: manifest.contributes,
        cards,
        providers,
        modelBindings,
        generators,
        views,
      }),
    )
    .digest("hex")}`;
}
