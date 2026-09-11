import { join } from "node:path";

/**
 * The projectable entity registry.
 *
 * Every agent-editable entity in Clash is the same interaction: learn the DSL,
 * pull the projection, edit it with native file tools, apply it back under CAS.
 * Only three facts differ per kind -- where the file lives, what it is called,
 * and which contract describes it. Those facts belong in this table, not in a
 * new command per entity.
 *
 * These projections cover existing Canvas and Timeline contracts. Native
 * Documents use their Host-declared projection format through documents commands.
 */

/**
 * Where a projection's content comes from.
 *
 * This is the part a declaration cannot invent: the host owns how an entity is
 * read and written, and it owns the CAS rule over that entity. A plugin picks an
 * existing source shape; it does not supply its own read/write or stale check.
 */
export type ProjectionSource =
  | {
      readonly from: "canvas-node";
      readonly nodeType: string;
      readonly field: "content";
    }
  | {
      readonly from: "host-entity";
      readonly entity: "timeline" | "director-stage";
    };

export interface ProjectionKind {
  /** Stable kind id used as a `--kind` parameter value. */
  readonly kind: string;
  /** Human-facing description for `projection kinds`. */
  readonly description: string;
  /** Directory, relative to the workspace root, holding the projections. */
  readonly directory: readonly string[];
  /** Suffix appended to the entity id, including the extension. */
  readonly suffix: string;
  /** What the id in `--id` refers to. */
  readonly idKind: "canvas-node" | "timeline" | "director-stage" | "asset";
  /** Canvas node type this projection round-trips, for canvas-node kinds. */
  readonly nodeType?: string;
  /** Host-owned binding for reads, writes, and CAS. */
  readonly source: ProjectionSource;
  /**
   * How an agent learns the DSL. `contract` means a machine-readable schema is
   * published; `format` means the file is a plain well-known format.
   */
  readonly dsl:
    | { readonly source: "contract"; readonly command: string }
    | { readonly source: "format"; readonly format: string };
}

const KINDS: readonly ProjectionKind[] = [
  {
    kind: "timeline",
    description: "Project Timeline DSL",
    directory: ["timelines"],
    suffix: ".timeline.yaml",
    idKind: "timeline",
    source: { from: "host-entity", entity: "timeline" },
    dsl: { source: "contract", command: "clash timeline schema" },
  },
  {
    kind: "stage",
    description: "Director Stage scene",
    directory: ["director-stages"],
    suffix: ".director-stage.json",
    idKind: "director-stage",
    source: { from: "host-entity", entity: "director-stage" },
    dsl: {
      source: "contract",
      command: "clash projection schema --kind stage",
    },
  },
  {
    kind: "text",
    description: "Canvas text node body",
    directory: ["projections", "text"],
    suffix: ".md",
    idKind: "canvas-node",
    nodeType: "text",
    source: { from: "canvas-node", nodeType: "text", field: "content" },
    dsl: { source: "format", format: "markdown" },
  },
  {
    kind: "component",
    description: "Canvas remotion-component source",
    directory: ["projections", "components"],
    suffix: ".tsx",
    idKind: "canvas-node",
    nodeType: "remotion-component",
    source: {
      from: "canvas-node",
      nodeType: "remotion-component",
      field: "content",
    },
    dsl: { source: "format", format: "remotion-tsx" },
  },
];

export function listProjectionKinds(): readonly ProjectionKind[] {
  return KINDS;
}

export function getProjectionKind(kind: string): ProjectionKind {
  if (kind.startsWith("metadata:"))
    throw new Error(
      "METADATA_WRITE_RETIRED: Use clash assets documents create, pull and apply; legacy metadata remains readable through assets metadata get.",
    );
  const found = KINDS.find((entry) => entry.kind === kind);
  if (!found) {
    throw new Error(
      `Unknown projection kind: ${kind}. Declared kinds: ${KINDS.map((entry) => entry.kind).join(", ")}.`,
    );
  }
  return found;
}

/** Slug rules are shared so one entity never gets two projection paths. */
export function projectionFileSlug(entityId: string): string {
  const slug = entityId
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!slug) throw new Error(`Entity id ${entityId} has no usable file slug.`);
  return slug;
}

export function projectionFilePath(options: {
  cwd: string;
  kind: string;
  entityId: string;
}): string {
  const declared = getProjectionKind(options.kind);
  return join(
    options.cwd,
    ...declared.directory,
    `${projectionFileSlug(options.entityId)}${declared.suffix}`,
  );
}

/** Which declared kind owns a projection path, if any. */
export function projectionKindForPath(
  relativePath: string,
): ProjectionKind | undefined {
  const normalized = relativePath.split("\\").join("/");
  return KINDS.find((entry) => {
    const prefix = `${entry.directory.join("/")}/`;
    return normalized.startsWith(prefix) && normalized.endsWith(entry.suffix);
  });
}

/**
 * The observation ledger key for a projection kind.
 *
 * Bookkeeping follows the entity, not the transport. A canvas node read through
 * `canvas get`, `text pull`, or `projection pull` records the same key, so a
 * write through any of them invalidates the others' reads. Booking per transport
 * would let a caller dodge a stale check by switching commands.
 */
export function projectionObservationEntityKind(kind: string): string {
  const source = getProjectionKind(kind).source;
  switch (source.from) {
    case "canvas-node":
      return "canvas-node";
    case "host-entity":
      return source.entity;
  }
}
