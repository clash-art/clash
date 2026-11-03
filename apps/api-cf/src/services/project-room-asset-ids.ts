/**
 * Project Asset ids of a Project, read from its ProjectRoom (`assets-list`,
 * the same Project Loro authority the hosted Asset routes use). Project cards
 * count these: synced and hosted-generated media are Project Assets, never
 * legacy D1 Asset rows. Kept free of Loro and ORM imports so the lean metadata
 * Worker can use it.
 */
export interface ProjectRoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string): Promise<Response> };
}

export class ProjectRoomAssetListError extends Error {
  readonly code = "PROJECT_ROOM_ASSET_LIST_FAILED";
  constructor(readonly status: number) {
    super(`Project room Asset list failed (${status})`);
    this.name = "ProjectRoomAssetListError";
  }
}

export async function readProjectRoomAssetIds(
  room: ProjectRoomNamespace,
  projectId: string,
): Promise<string[]> {
  const response = await room.get(room.idFromName(projectId)).fetch(
    new Request(
      `http://internal/loro/${encodeURIComponent(projectId)}/assets-list`,
      {
        method: "GET",
        headers: {
          "x-internal-loro": "true",
          "x-loro-project-id": projectId,
        },
      },
    ),
  );
  if (!response.ok) throw new ProjectRoomAssetListError(response.status);
  const body = (await response.json()) as { assets?: Array<{ id?: unknown }> };
  return (body.assets ?? []).flatMap((entry) =>
    typeof entry?.id === "string" ? [entry.id] : [],
  );
}
