import {
  ProjectMetadataSchema,
  type ProjectMetadata,
} from "@clash/shared-types";

/** The remote rejected a push because a newer metadata write already won. */
export class ProjectMetadataStaleError extends Error {
  constructor(readonly metadata: ProjectMetadata) {
    super("Project metadata is stale");
    this.name = "ProjectMetadataStaleError";
  }
}

export interface ProjectMetadataStore {
  read(): Promise<ProjectMetadata | null>;
  write(metadata: ProjectMetadata): Promise<void>;
  /**
   * True while the local copy is a placeholder nobody authored (for example a
   * workspace marker registered under its directory name). A placeholder may
   * seed an empty remote, but it never competes with existing remote metadata.
   */
  isProvisional?(): Promise<boolean>;
}

export interface ProjectMetadataSyncRemote {
  pull(): Promise<ProjectMetadata | null>;
  push(metadata: ProjectMetadata): Promise<void>;
}

export type ProjectMetadataSyncResult =
  | { status: "disabled" }
  | { status: "noop" }
  | { status: "pushed"; metadata: ProjectMetadata }
  | { status: "pulled"; metadata: ProjectMetadata }
  | {
      status: "conflict";
      winner: "local" | "remote";
      metadata: ProjectMetadata;
    };

export interface ProjectMetadataReplicatorOptions {
  /** Explicit capability gate. The default is disabled. */
  enabled?: boolean;
  local: ProjectMetadataStore;
  remote: ProjectMetadataSyncRemote;
}

function canonicalMetadata(metadata: ProjectMetadata): string {
  // Sort keys before comparing equal-timestamp writes. JSON property order is
  // not part of the metadata contract, so insertion order must not make the
  // tie-breaker differ between replicas.
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(metadata).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function compareMetadata(
  local: ProjectMetadata,
  remote: ProjectMetadata,
): "local" | "remote" | "equal" | "conflict-local" | "conflict-remote" {
  const localValue = Date.parse(local.updatedAt);
  const remoteValue = Date.parse(remote.updatedAt);
  if (localValue > remoteValue) return "local";
  if (remoteValue > localValue) return "remote";

  const localCanonical = canonicalMetadata(local);
  const remoteCanonical = canonicalMetadata(remote);
  if (localCanonical === remoteCanonical) return "equal";
  // Wall clocks can tie (or be skewed). A stable tie-breaker prevents two
  // replicas from endlessly overwriting one another after a reconnect.
  return localCanonical > remoteCanonical
    ? "conflict-local"
    : "conflict-remote";
}

export function createProjectMetadataReplicator(
  options: ProjectMetadataReplicatorOptions,
) {
  async function push(
    metadata: ProjectMetadata,
  ): Promise<ProjectMetadataSyncResult | null> {
    try {
      await options.remote.push(metadata);
      return null;
    } catch (error) {
      if (!(error instanceof ProjectMetadataStaleError)) throw error;
      const current = ProjectMetadataSchema.parse(error.metadata);
      await options.local.write(current);
      return { status: "pulled", metadata: current };
    }
  }

  return {
    async sync(): Promise<ProjectMetadataSyncResult> {
      if (options.enabled !== true) return { status: "disabled" };

      const localRaw = await options.local.read();
      const remoteRaw = await options.remote.pull();
      const local = localRaw ? ProjectMetadataSchema.parse(localRaw) : null;
      const remote = remoteRaw ? ProjectMetadataSchema.parse(remoteRaw) : null;

      if (!local && !remote) return { status: "noop" };
      if (!local && remote) {
        await options.local.write(remote);
        return { status: "pulled", metadata: remote };
      }
      if (local && !remote) {
        const stale = await push(local);
        if (stale) return stale;
        return { status: "pushed", metadata: local };
      }

      if (!local || !remote) {
        throw new Error("Project metadata sync reached an invalid state");
      }

      const winner = compareMetadata(local, remote);
      if (winner === "equal") return { status: "noop" };
      // A placeholder's fresh updatedAt records when this replica joined, not
      // an edit. Letting it enter last-writer-wins would rename the Project
      // for every other replica.
      if ((await options.local.isProvisional?.()) === true) {
        await options.local.write(remote);
        return { status: "pulled", metadata: remote };
      }
      if (winner === "local" || winner === "conflict-local") {
        const stale = await push(local);
        if (stale) return stale;
        return {
          ...(winner === "conflict-local"
            ? { status: "conflict" as const, winner: "local" as const }
            : { status: "pushed" as const }),
          metadata: local,
        };
      }

      await options.local.write(remote);
      return {
        ...(winner === "conflict-remote"
          ? { status: "conflict" as const, winner: "remote" as const }
          : { status: "pulled" as const }),
        metadata: remote,
      };
    },
  };
}
