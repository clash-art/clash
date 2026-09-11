function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`QA report ${name} must be an array`);
  return value;
}

function validateStubSessionPath(entry, name) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`QA report ${name} must contain session observations`);
  }
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    throw new Error(`QA report ${name} is missing a session id`);
  }
  if (/^stub-acp-session-/i.test(entry.id)) {
    throw new Error(`QA report ${name} contains placeholder session id ${entry.id}`);
  }
  if (
    typeof entry.apiPath !== "string" ||
    !entry.apiPath.includes(`/api/v1/local-sessions/${encodeURIComponent(entry.id)}/messages`)
  ) {
    throw new Error(`QA report ${name} must include the session messages API path for ${entry.id}`);
  }
  if (typeof entry.storagePath !== "string" || !entry.storagePath.endsWith("/local.sqlite")) {
    throw new Error(`QA report ${name} must identify local.sqlite session storage for ${entry.id}`);
  }
  if (entry.cwdPath !== null) {
    throw new Error(`Stub ACP session ${entry.id} must have cwdPath null`);
  }
}

export function validateStubRuntimeReport(report) {
  const paths = report?.paths ?? {};
  const createdSessions = requireArray(paths.createdSessions, "paths.createdSessions");
  const restoredSessions = requireArray(paths.restoredSessions, "paths.restoredSessions");
  const projectStatuses = requireArray(paths.projectStatuses, "paths.projectStatuses");
  if (createdSessions.length < 2) {
    throw new Error("Stub QA report must include both created sessions");
  }
  if (restoredSessions.length < 1) {
    throw new Error("Stub QA report must include at least one restored session");
  }
  createdSessions.forEach((entry, index) =>
    validateStubSessionPath(entry, `paths.createdSessions[${index}]`));
  restoredSessions.forEach((entry, index) =>
    validateStubSessionPath(entry, `paths.restoredSessions[${index}]`));

  const createdIds = new Set(createdSessions.map((entry) => entry.id));
  for (const entry of restoredSessions) {
    if (!createdIds.has(entry.id)) {
      throw new Error(`Restored stub session ${entry.id} was not observed during creation`);
    }
  }
  if (projectStatuses.length < 1) {
    throw new Error("Stub QA report must include the primary project status path contract");
  }
  const hasProtectedRuntime = projectStatuses.some((entry) =>
    typeof entry?.runtimeRoot === "string" &&
    Array.isArray(entry?.protectedPaths) &&
    entry.protectedPaths.includes(entry.runtimeRoot));
  if (!hasProtectedRuntime) {
    throw new Error("Stub QA project status must prove runtimeRoot is protected");
  }
}
