import { LoroDoc } from "loro-crdt";
import { projectSyncContent } from "@clash/shared-types/project-sync-content";
import type { Resource } from "@clash/shared-types/assets";
import type { AssetDeliveryCapabilityClaims } from "@clash/asset-sdk/delivery";
import {
  contentHash,
  createContentReferenceResolver,
  documentLocator,
  type ContentReferenceIndex,
  type ContentRoomPort,
  type ProjectContentReferences,
} from "@clash/asset-sdk/upload-service";
import type { Env } from "../config";
import {
  ProjectContentConflictError,
  createD1ContentReferenceIndex,
  createD1ProjectAccessAuthorizer,
  createD1ProjectContentAdmission,
  createDurableObjectContentRoomPort,
  createR2ResourceRegistry,
  createCapabilityResolver,
  resourceLocator,
} from "./project-content-cloud";

export {
  ProjectContentConflictError,
  contentHash,
  documentLocator,
  resourceLocator,
};

export interface ProjectContentPorts {
  /** Both issuance and capability consumption check current admission/deletion. */
  authorize(input: {
    projectId: string;
    localReplicaId: string;
    userId?: string;
    tenantId?: string;
  }): Promise<{ tenantId: string } | null>;
  /** Project-level access for owner preview reads and chunked imports. */
  authorizeProject?(input: {
    projectId: string;
    tenantId: string;
    ownerId?: string;
  }): Promise<boolean>;
  /** Content-reference index (issue #130). Preferred over any room lookup. */
  index?: ContentReferenceIndex;
  /** Room-computed references + `content.published` notify (index-miss fallback). */
  room?: ContentRoomPort;
  /** Legacy/test adapter: full Loro snapshot, decoded here. Used only when
   * neither `index` nor `room.references` is supplied. */
  snapshot?(projectId: string): Promise<Uint8Array>;
  resource(
    tenantId: string,
    resourceId: string,
    claim?: Resource,
  ): Promise<Resource | null>;
}

export async function projectContentReferences(
  ports: Pick<ProjectContentPorts, "snapshot" | "room">,
  projectId: string,
): Promise<ProjectContentReferences> {
  if (ports.room?.references) return ports.room.references(projectId);
  if (!ports.snapshot) throw new Error("No project content reference source");
  const doc = new LoroDoc();
  try {
    doc.import(await ports.snapshot(projectId));
    return projectSyncContent(doc);
  } finally {
    doc.free();
  }
}

const EMPTY_INDEX: ContentReferenceIndex = {
  async document() {
    return undefined;
  },
  async resource() {
    return undefined;
  },
};

/** Index-first reference lookup with the room (or legacy snapshot) as fallback. */
export function projectContentResolverFor(ports: ProjectContentPorts) {
  const room: ContentRoomPort = {
    ...ports.room,
    references: (projectId) => projectContentReferences(ports, projectId),
  };
  return createContentReferenceResolver(
    ports.index ?? EMPTY_INDEX,
    ports.room?.references || ports.snapshot ? room : undefined,
  );
}

export function createCloudProjectContentPorts(env: Env): ProjectContentPorts {
  return {
    authorize: createD1ProjectContentAdmission(env.DB as never).authorize,
    authorizeProject: createD1ProjectAccessAuthorizer(env.DB as never),
    index: createD1ContentReferenceIndex(env.DB as never),
    room: createDurableObjectContentRoomPort(env.ROOM as never),
    resource: createR2ResourceRegistry(env.R2_BUCKET as never),
  };
}

export function createProjectContentResolver(
  portsFor: (env: Env) => ProjectContentPorts = createCloudProjectContentPorts,
) {
  return createCapabilityResolver(portsFor, projectContentResolverFor) as (
    claims: AssetDeliveryCapabilityClaims,
    env: Env,
  ) => ReturnType<ReturnType<typeof createCapabilityResolver>>;
}
