import type { Env } from "../config";

/** The accountable user for a Project's hosted execution; owner-only by admission. */
export async function hostedProjectOwnerId(
  env: Pick<Env, "DB">,
  projectId: string,
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT owner_id FROM project WHERE id = ?",
  )
    .bind(projectId)
    .first<{ owner_id: string }>();
  if (!row?.owner_id) {
    throw new Error(`Project ${projectId} has no owner for hosted execution.`);
  }
  return row.owner_id;
}
