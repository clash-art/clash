import {
  ProjectMetadataSchema,
  type ProjectMetadata,
} from "@clash/shared-types";

export interface ProjectMetadataStore {
  read(): Promise<ProjectMetadata | null>;
  write(metadata: ProjectMetadata): Promise<void>;
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
        await options.remote.push(local);
        return { status: "pushed", metadata: local };
      }

      if (!local || !remote) {
        throw new Error("Project metadata sync reached an invalid state");
      }

      const winner = compareMetadata(local, remote);
      if (winner === "equal") return { status: "noop" };
      if (winner === "local" || winner === "conflict-local") {
        await options.remote.push(local);
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
