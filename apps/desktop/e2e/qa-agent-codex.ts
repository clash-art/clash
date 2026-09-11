import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateStubRuntimeReport } from "./qa-agent-report-validation.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const schemaSourcePath = path.join(__dirname, "qa-agent-report.schema.json");

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function resolveCodexBin() {
  return process.env.CLASH_QA_CODEX_BIN || "codex";
}

function resolveRunId() {
  return process.env.CLASH_QA_AGENT_RUN_ID || timestampForPath();
}

function buildPrompt({
  artifactRoot,
  eventsPath,
  reportPath,
  repoRoot,
  schemaPath,
  targetRuntime,
}) {
  const artifactHome = path.join(artifactRoot, "home");
  const localDataDir = path.join(artifactRoot, "local-api-data");
  const screenshotDir = path.join(artifactRoot, "screenshots");
  const commandLogDir = path.join(artifactRoot, "command-logs");
  const smokeLogPath = path.join(commandLogDir, "desktop-path-smoke.log");
  const timelineArtifactRoot = path.join(artifactRoot, "short-drama-timeline");
  const timelineLogPath = path.join(commandLogDir, "short-drama-timeline-smoke.log");
  const timelineReportPath = path.join(timelineArtifactRoot, "short-drama-timeline-report.json");
  const createdTimelinePath = path.join(timelineArtifactRoot, "timeline", "created", "short-drama-timeline.json");
  const restoredTimelinePath = path.join(timelineArtifactRoot, "timeline", "restored", "short-drama-timeline.json");
  const agentFirstCasArtifactRoot = path.join(artifactRoot, "agent-first-cas");
  const agentFirstCasLogPath = path.join(commandLogDir, "agent-first-cas-smoke.log");
  const agentFirstCasReportPath = path.join(agentFirstCasArtifactRoot, "agent-first-cas-report.json");
  const projectWorkspaceCliArtifactRoot = path.join(artifactRoot, "project-workspace-cli");
  const projectWorkspaceCliLogPath = path.join(commandLogDir, "project-workspace-cli-smoke.log");
  const projectWorkspaceCliReportPath = path.join(
    projectWorkspaceCliArtifactRoot,
    "project-workspace-cli-report.json",
  );
  const shortDramaScenarioPath = path.join(repoRoot, ".tmp", "qa-scenarios", "short-drama-timeline-scenario.json");
  const pnpmBin = process.env.CLASH_QA_PNPM_BIN || "/opt/homebrew/bin/pnpm";
  const pathCommand = targetRuntime === "real-codex-acp"
    ? `PATH=/opt/homebrew/bin:${path.join(repoRoot, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin CLASH_E2E_REAL_CODEX=1 CLASH_E2E_REAL_CODEX_CAPTURE_DIR=${JSON.stringify(screenshotDir)} CLASH_E2E_REAL_CODEX_DATA_DIR=${JSON.stringify(localDataDir)} ${JSON.stringify(pnpmBin)} --filter @clash/desktop test:startup:real-codex > ${JSON.stringify(smokeLogPath)} 2>&1`
    : `PATH=/opt/homebrew/bin:${path.join(repoRoot, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin CLASH_DESKTOP_AGENT_BROWSER_CAPTURE_DIR=${JSON.stringify(screenshotDir)} CLASH_DESKTOP_AGENT_BROWSER_DATA_DIR=${JSON.stringify(localDataDir)} ${JSON.stringify(pnpmBin)} --filter @clash/desktop test:e2e:agent-browser > ${JSON.stringify(smokeLogPath)} 2>&1`;
  const timelineCommand = `PATH=/opt/homebrew/bin:${path.join(repoRoot, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin CLASH_SHORT_DRAMA_TIMELINE_ARTIFACT_ROOT=${JSON.stringify(timelineArtifactRoot)} CLASH_SHORT_DRAMA_SCENARIO_PATH=${JSON.stringify(shortDramaScenarioPath)} ${JSON.stringify(pnpmBin)} --filter @clash/desktop test:e2e:short-drama-timeline > ${JSON.stringify(timelineLogPath)} 2>&1`;
  const agentFirstCasCommand = `PATH=/opt/homebrew/bin:${path.join(repoRoot, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin CLASH_AGENT_FIRST_CAS_ARTIFACT_ROOT=${JSON.stringify(agentFirstCasArtifactRoot)} ${JSON.stringify(pnpmBin)} --filter @clash/desktop test:e2e:agent-first-cas > ${JSON.stringify(agentFirstCasLogPath)} 2>&1`;
  const projectWorkspaceCliCommand = `PATH=/opt/homebrew/bin:${path.join(repoRoot, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin CLASH_PROJECT_WORKSPACE_ARTIFACT_ROOT=${JSON.stringify(projectWorkspaceCliArtifactRoot)} ${JSON.stringify(pnpmBin)} --filter @clash/desktop test:e2e:project-workspace-cli > ${JSON.stringify(projectWorkspaceCliLogPath)} 2>&1`;

  return `You are a black-box QA agent for Clash desktop.

Use the local Codex subscription through this Codex CLI run. Do not ask for API keys.

Paths:
- Repo root under test: ${repoRoot}
- QA artifact root: ${artifactRoot}
- Required final report path: ${reportPath}
- Required JSON schema path: ${schemaPath}
- Codex event log path from the outer harness: ${eventsPath}
- Artifact-local HOME directory if a future command needs it: ${artifactHome}
- Artifact-local local API data dir when possible: ${localDataDir}
- Screenshot dir: ${screenshotDir}
- Command log dir: ${commandLogDir}
- Primary command log: ${smokeLogPath}
- Short-drama scenario path: ${shortDramaScenarioPath}
- Timeline artifact root: ${timelineArtifactRoot}
- Timeline command log: ${timelineLogPath}
- Timeline report path: ${timelineReportPath}
- Created timeline path: ${createdTimelinePath}
- Restored timeline path: ${restoredTimelinePath}
- Agent-first CAS artifact root: ${agentFirstCasArtifactRoot}
- Agent-first CAS command log: ${agentFirstCasLogPath}
- Agent-first CAS report path: ${agentFirstCasReportPath}
- Project workspace CLI artifact root: ${projectWorkspaceCliArtifactRoot}
- Project workspace CLI command log: ${projectWorkspaceCliLogPath}
- Project workspace CLI report path: ${projectWorkspaceCliReportPath}

Target runtime: ${targetRuntime}

Rules:
- Do not edit source files.
- Do not read skill files.
- Do not do broad source review.
- Do not launch an installed app.
- Run the exact primary command below first. It launches the development Electron app and drives it with agent-browser.
- Run the exact timeline command below second. It creates and restores a deterministic short-drama timeline artifact from the scenario path.
- Run the exact CAS command below third. It verifies implicit read-before-write rejection, stale-write rejection, copy-on-write, text revision, and Timeline entity apply behavior through public CLI commands.
- Run the exact Project workspace CLI command below fourth. It exercises project.toml, multiple Canvases, concrete Timeline ownership, native file apply, stale/forged observations, restart recovery, and public-output redaction.
- After all commands exit, inspect only the command logs, screenshots, files under ${localDataDir}/projects, ${timelineReportPath}, ${createdTimelinePath}, ${restoredTimelinePath}, ${agentFirstCasReportPath}, and ${projectWorkspaceCliReportPath}.
- The stub primary log emits structured [desktop-agent-browser] history and [desktop-agent-browser] project status JSON. Use those records for exact session and path observations.
- Do not invent or normalize session IDs. Copy history.sessions[].id and restoredSession.id exactly, with their apiPath, storagePath, and cwdPath values.
- Convert every structured project status record into paths.projectStatuses. Do not read snapshot.bin or edit SQLite directly.
- If the command fails, still produce the schema report with status "fail" or "blocked" and include the log path.

Primary command:
\`\`\`bash
${pathCommand}
\`\`\`

Timeline command:
\`\`\`bash
${timelineCommand}
\`\`\`

Agent-first CAS command:
\`\`\`bash
${agentFirstCasCommand}
\`\`\`

Project workspace CLI command:
\`\`\`bash
${projectWorkspaceCliCommand}
\`\`\`

Required QA flow:
1. Use the primary command's UI run as the black-box interaction evidence.
2. Record the created project id, URL path, visible label if any, storage path, and agent cwd path if one exists.
3. Record every created runtime session id, visible label/title, API path, transcript/storage path if any, and cwd path if one exists.
4. Record every project status observation from the primary command log. The real Codex target must include runtimeRoot and protectedPaths evidence from local-api project status.
5. Record the created timeline path from the timeline command report and JSON file.
6. Record the restored timeline path from the timeline command report and JSON file.
7. Record CAS evidence from ${agentFirstCasReportPath}.
8. Record Project/Canvas/Timeline CLI evidence from ${projectWorkspaceCliReportPath}.
9. Record restored/history project paths and restored/history session paths from the session-history phase in the command output and screenshots.
10. Verify path stability: a restored/history session for the same project should not silently move to a different project cwd. If sessions are DB rows rather than directories, say that explicitly and set storagePath to local-api session/message evidence while cwdPath remains null or the project cwd depending on the runtime.

Path report requirements:
- paths.createdProjects must contain every project created by this QA run.
- paths.createdSessions must contain every session created by this QA run.
- paths.createdTimelines must contain the created short-drama timeline JSON path.
- paths.projectStatuses must contain every project status object emitted by the primary command log. For each entry, set source to "api" or "log", statusCommand to the HTTP status URL or null, fill the flat root fields (projectStore, projectWorkspaceRoot, draftsRoot, projectionsRoot, sessionsRoot, assetLinksRoot, runtimeRoot), set snapshotPath to projectStatus.loro.snapshotPath, updatesLogPath to projectStatus.loro.updatesLogPath, and include protectedPaths/editablePaths exactly from status.
- paths.restoredProjects must contain the project path observed after reload/history/resume.
- paths.restoredSessions must contain every resumed/restored session path observation.
- paths.restoredTimelines must contain the restored short-drama timeline JSON path.
- Each path observation must include kind, phase, id, observedAt, source, evidence, urlPath, storagePath, cwdPath, apiPath, and visibleLabel.
- Timeline observations must use kind "timeline", source "filesystem", storagePath set to the corresponding timeline JSON path, visibleLabel set to the scenario title if available, and urlPath/apiPath/cwdPath null unless the command report proves otherwise.
- Use null only when the concept truly has no path, and explain why in evidence or paths.notes.
- For targetRuntime=stub-acp, the mock ACP path may not spawn an agent cwd. If so, cwdPath should be null and paths.notes must say that this target verifies UI/session storage paths, while CLASH_QA_AGENT_TARGET=real-codex-acp verifies actual spawned agent cwd.
- For targetRuntime=real-codex-acp, paths.projectStatuses must have at least one entry and at least one entry must prove runtimeRoot is inside protectedPaths.

CAS report requirements:
- cas.reportPath must be ${agentFirstCasReportPath}.
- cas.logPath must be ${agentFirstCasLogPath}.
- Every boolean required by the cas object schema must be true and must match the same key in the CAS report's booleans object.
- cas.evidence must cite the smoke report checks and the commands that failed or passed.

Project workspace CLI report requirements:
- workspaceCli.reportPath must be ${projectWorkspaceCliReportPath}.
- workspaceCli.logPath must be ${projectWorkspaceCliLogPath}.
- Every boolean required by the workspaceCli object schema must be true and must be justified by the corresponding named check in the Project workspace CLI report.
- workspaceCli.evidence must cite the report checks for project.toml identity, local operation without cloud credentials, Canvas isolation, Timeline entity apply/ownership, stale and forged write rejection, owner-only observations, daemon restart recovery, public-output redaction, and canonical SQLite metadata storage.

Environment used by the primary command:
- PATH=/opt/homebrew/bin:${path.join(repoRoot, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin
- CLASH_LOCAL_DATA_DIR=${localDataDir}
- CLASH_DESKTOP_CAPTURE_DIR=${screenshotDir}
- AGENT_BROWSER_SCREENSHOT_DIR=${screenshotDir}

Return only JSON that matches the schema.`;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`QA report is missing ${name}`);
  }
}

const CAS_BOOLEAN_KEYS = [
  "missingReadProofRejected",
  "staleReadProofRejected",
  "sourceActionStaleReadProofRejected",
  "copyOnWritePreservedSource",
  "directCanvasCliWriteBeforeReadRejected",
  "directCanvasCliCwdObservationRecorded",
  "directCanvasCliStaleObservationRejected",
  "directCanvasCliFreshObservationAccepted",
  "directCanvasCliMutationEnvelopeRecorded",
  "directCanvasCliImmutableUpdateRejected",
  "directCanvasCliCopyOnWriteSupported",
  "directCanvasCliDeleteReadRequired",
  "textProjectionNoLockSidecar",
  "timelineProjectionNoLockSidecar",
  "timelineEntityApplyAdvancesRevision",
  "textHistoryReadsHostRevisionIndex",
  "textRevisionContentStorageContract",
  "textContentRestoresHostRevisionBody",
  "textRestoreCreatesCopyOnWriteRevisionFromHostContent",
  "textCutExportSourceProvenanceRecorded",
  "textCutExportSymlinkActionRejected",
  "projectionPathOutsideCwdRejected",
  "legacyProjectionLockSidecarsIgnored",
  "forceMutationBypassAbsent",
];

const WORKSPACE_CLI_CHECKS = {
  projectMarkerPreservesSpecialId: "project marker preserves special project id",
  localWithoutCloudCredentials: "local Project CLI works without cloud credentials",
  sharedLocalApiHostDiscovered: "CLI discovers the shared local-api host",
  mainCanvasPresent: "fresh project exposes main Canvas",
  canvasCreateRefreshesObservation: "Canvas create refreshes implicit observation",
  unknownCanvasRejected: "unknown Canvas is rejected",
  canvasNodeCreationSucceeds: "Canvas-scoped node creation returns an id",
  canvasScopesStayIsolated: "Canvas node scopes stay isolated",
  nativeTimelineApplyUsesEntityCas: "native Timeline file edit applies through entity CAS",
  timelineAttachOwnsOneAction: "Timeline attach moves identity under one Canvas Action",
  timelineActionResolvesProjectState: "Canvas-scoped Timeline Action resolves Project Timeline state",
  timelineCopyCreatesNewIdentities: "cross-Canvas Timeline copy creates new identities",
  timelineDetachReturnsToProjectRoot: "Timeline detach returns the same Timeline to Project root",
  timelineOwnershipListAccurate: "Timeline ownership list distinguishes standalone and Canvas-owned copies",
  staleTimelineApplyRejected: "stale Timeline apply is rejected",
  forgedObservationRejected: "forged semantic observation cannot authorize a write",
  observationOwnerOnly: "cwd observation is owner-only",
  daemonRestartRecoversProjectState: "daemon restart recovers all Project Timelines from the local replica",
  recoveredTimelineActionKeepsCanvas: "recovered Timeline Action stays on its owning Canvas",
  publicOutputHidesObservations: "public CLI output hides internal observations",
  canonicalSqliteStore: "canonical project metadata uses SQLite",
};

function validateReportShape(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("QA report is not a JSON object");
  }
  if (report.schemaVersion !== 1) {
    throw new Error("QA report schemaVersion must be 1");
  }
  requiredString(report.status, "status");
  requiredString(report.summary, "summary");
  if (!report.paths || typeof report.paths !== "object") {
    throw new Error("QA report is missing paths");
  }
  if (!report.cas || typeof report.cas !== "object" || Array.isArray(report.cas)) {
    throw new Error("QA report is missing cas evidence");
  }
  if (!report.workspaceCli || typeof report.workspaceCli !== "object" || Array.isArray(report.workspaceCli)) {
    throw new Error("QA report is missing Project workspace CLI evidence");
  }
  for (const key of [
    "createdProjects",
    "createdSessions",
    "createdTimelines",
    "projectStatuses",
    "restoredProjects",
    "restoredSessions",
    "restoredTimelines",
  ]) {
    if (!Array.isArray(report.paths[key])) {
      throw new Error(`QA report paths.${key} must be an array`);
    }
  }
}

async function validateCasEvidence(report) {
  const cas = report?.cas;
  requiredString(cas?.reportPath, "cas.reportPath");
  requiredString(cas?.logPath, "cas.logPath");
  requiredString(cas?.evidence, "cas.evidence");
  const smoke = JSON.parse(await readFile(cas.reportPath, "utf8"));
  if (smoke.status !== "pass") {
    throw new Error(`CAS smoke report status ${smoke.status ?? "missing"}`);
  }
  for (const key of CAS_BOOLEAN_KEYS) {
    if (cas?.[key] !== true) {
      throw new Error(`QA report cas.${key} must be true`);
    }
    if (smoke.booleans?.[key] !== true) {
      throw new Error(`CAS smoke report booleans.${key} must be true`);
    }
  }
}

async function validateWorkspaceCliEvidence(report) {
  const workspaceCli = report?.workspaceCli;
  requiredString(workspaceCli?.reportPath, "workspaceCli.reportPath");
  requiredString(workspaceCli?.logPath, "workspaceCli.logPath");
  requiredString(workspaceCli?.evidence, "workspaceCli.evidence");
  const smoke = JSON.parse(await readFile(workspaceCli.reportPath, "utf8"));
  if (smoke.kind !== "clash.project-workspace-cli-e2e") {
    throw new Error(`Project workspace CLI report kind ${smoke.kind ?? "missing"}`);
  }
  if (smoke.status !== "pass" || smoke.summary?.failures !== 0) {
    throw new Error(`Project workspace CLI report status ${smoke.status ?? "missing"}`);
  }
  const checks = new Map((smoke.checks ?? []).map((check) => [check?.name, check?.status]));
  for (const [key, checkName] of Object.entries(WORKSPACE_CLI_CHECKS)) {
    if (workspaceCli?.[key] !== true) {
      throw new Error(`QA report workspaceCli.${key} must be true`);
    }
    if (checks.get(checkName) !== "pass") {
      throw new Error(`Project workspace CLI report check did not pass: ${checkName}`);
    }
  }
}

function pathObservations(report) {
  const paths = report?.paths ?? {};
  return [
    ...(paths.createdProjects ?? []),
    ...(paths.createdSessions ?? []),
    ...(paths.createdTimelines ?? []),
    ...(paths.restoredProjects ?? []),
    ...(paths.restoredSessions ?? []),
    ...(paths.restoredTimelines ?? []),
  ];
}

function projectStatusObservations(report) {
  return report?.paths?.projectStatuses ?? [];
}

function validateTargetRuntimeReport(report, targetRuntime) {
  if (targetRuntime === "stub-acp") {
    validateStubRuntimeReport(report);
    return;
  }
  if (targetRuntime !== "real-codex-acp") return;
  if (report.run?.targetRuntime !== "real-codex-acp") {
    throw new Error(`Real Codex QA report has targetRuntime ${report.run?.targetRuntime ?? "missing"}`);
  }
  const sessionCwdPaths = pathObservations(report)
    .filter((entry) => entry?.kind === "session" && typeof entry.cwdPath === "string")
    .map((entry) => entry.cwdPath);
  if (sessionCwdPaths.length === 0) {
    throw new Error("Real Codex QA report must include at least one session cwdPath");
  }
  if (!sessionCwdPaths.some((cwdPath) => cwdPath.includes("/.clash/projects/"))) {
    throw new Error(
      `Real Codex QA session cwdPath must point at a managed project workspace: ${sessionCwdPaths.join(", ")}`,
    );
  }
  const projectStatuses = projectStatusObservations(report);
  if (projectStatuses.length === 0) {
    throw new Error("Real Codex QA report must include at least one paths.projectStatuses entry");
  }
  const hasProtectedRuntime = projectStatuses.some((entry) =>
    typeof entry?.runtimeRoot === "string" &&
      entry.runtimeRoot.length > 0 &&
      Array.isArray(entry.protectedPaths) &&
      entry.protectedPaths.includes(entry.runtimeRoot)
  );
  if (!hasProtectedRuntime) {
    throw new Error("Real Codex QA project status must prove runtimeRoot is protected");
  }
}

async function parseAndValidateReport(reportPath) {
  const raw = await readFile(reportPath, "utf8");
  const report = JSON.parse(raw);
  validateReportShape(report);
  await validateCasEvidence(report);
  await validateWorkspaceCliEvidence(report);
  return report;
}

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildCodexArgs({ artifactRoot, profile, reportPath, schemaPath }) {
  const args = [
    "exec",
    "--cd",
    artifactRoot,
    "--add-dir",
    repoRoot,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "danger-full-access",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    reportPath,
    "--json",
  ];
  if (profile) args.splice(1, 0, "--profile", profile);
  args.push("-");
  return args;
}

async function runCodex({ args, codexBin, prompt, reportPath, stderrPath, stdoutPath }) {
  await writeFile(stdoutPath, "");
  await writeFile(stderrPath, "");

  const child = spawn(codexBin, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:${path.join(repoRoot, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.end(prompt);
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    void appendFile(stdoutPath, chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    void appendFile(stderrPath, chunk);
  });

  return new Promise((resolve) => {
    let settled = false;
    let passReportSeenAt = 0;
    const timeoutMs = readPositiveIntEnv("CLASH_QA_CODEX_TIMEOUT_MS", 10 * 60 * 1000);
    const passReportExitMs = readPositiveIntEnv("CLASH_QA_CODEX_PASS_REPORT_EXIT_MS", 15 * 1000);

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(reportPoll);
      resolve(result);
    };

    const stopChild = () => {
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    };

    const timeout = setTimeout(() => {
      stopChild();
      settle({ code: null, signal: "timeout" });
    }, timeoutMs);
    timeout.unref();

    const reportPoll = setInterval(async () => {
      try {
        const report = await parseAndValidateReport(reportPath);
        if (report.status !== "pass") return;
        if (passReportSeenAt === 0) {
          passReportSeenAt = Date.now();
          return;
        }
        if (Date.now() - passReportSeenAt >= passReportExitMs) {
          stopChild();
          settle({ code: 0, signal: "pass-report-watchdog", timedOutAfterReport: true });
        }
      } catch {
        passReportSeenAt = 0;
      }
    }, 1000);
    reportPoll.unref();

    child.on("close", (code, signal) => settle({ code, signal }));
  });
}

async function main() {
  const runId = resolveRunId();
  const artifactRoot = path.resolve(
    process.env.CLASH_QA_AGENT_ARTIFACT_ROOT ||
      path.join(repoRoot, ".tmp", "qa-agent-codex", runId),
  );
  const schemaPath = path.join(artifactRoot, "qa-agent-report.schema.json");
  const promptPath = path.join(artifactRoot, "qa-agent-prompt.md");
  const reportPath = path.join(artifactRoot, "qa-report.json");
  const eventsPath = path.join(artifactRoot, "codex-events.jsonl");
  const stderrPath = path.join(artifactRoot, "codex-stderr.log");
  const targetRuntime = process.env.CLASH_QA_AGENT_TARGET || "stub-acp";
  const codexBin = resolveCodexBin();
  const profile = process.env.CLASH_QA_CODEX_PROFILE;

  await mkdir(artifactRoot, { recursive: true });
  await mkdir(path.join(artifactRoot, "screenshots"), { recursive: true });
  await mkdir(path.join(artifactRoot, "command-logs"), { recursive: true });
  await mkdir(path.join(artifactRoot, "home"), { recursive: true });
  await copyFile(schemaSourcePath, schemaPath);

  const prompt = buildPrompt({
    artifactRoot,
    eventsPath,
    reportPath,
    repoRoot,
    schemaPath,
    targetRuntime,
  });
  await writeFile(promptPath, prompt);

  const args = buildCodexArgs({ artifactRoot, profile, reportPath, schemaPath });
  await writeFile(
    path.join(artifactRoot, "codex-command.txt"),
    [codexBin, ...args].join(" ") + "\n",
  );

  console.log(`[qa-agent-codex] artifact root ${artifactRoot}`);
  console.log(`[qa-agent-codex] prompt ${promptPath}`);
  console.log(`[qa-agent-codex] report ${reportPath}`);

  const result = await runCodex({
    args,
    codexBin,
    prompt,
    reportPath,
    stderrPath,
    stdoutPath: eventsPath,
  });
  if (result.timedOutAfterReport) {
    console.warn("[qa-agent-codex] codex process stopped after pass report watchdog");
  }
  if (result.code !== 0) {
    throw new Error(`codex exec exited ${result.code ?? result.signal}`);
  }

  const report = await parseAndValidateReport(reportPath);
  if (report.status !== "pass") {
    console.error("[qa-agent-codex] report failed", JSON.stringify({
      status: report.status,
      artifactRoot,
      reportPath,
    }));
    throw new Error(`QA report status ${report.status}; see ${reportPath}`);
  }
  validateTargetRuntimeReport(report, targetRuntime);
  console.log("[qa-agent-codex] ok", JSON.stringify({
    status: report.status,
    artifactRoot,
    reportPath,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
