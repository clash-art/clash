export const PROJECT_WORKSPACE_PREPARE_FAILED =
  "PROJECT_WORKSPACE_PREPARE_FAILED" as const;

/**
 * A project exists in the Host metadata store, but its agent workspace could
 * not be prepared. Callers surface this code and retry lazily on the next
 * session spawn instead of leaving an untracked directory or a silent gap.
 */
export class ProjectWorkspacePrepareError extends Error {
  readonly code = PROJECT_WORKSPACE_PREPARE_FAILED;

  constructor(
    readonly projectId: string,
    readonly step: string,
    cause: unknown,
  ) {
    super(
      `Project workspace preparation failed (${step}) for ${projectId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ProjectWorkspacePrepareError";
  }
}
