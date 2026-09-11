import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const runId =
  process.env.CLASH_AGENT_FIRST_LOCAL_V1_RUN_ID ||
  new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(
  process.env.CLASH_AGENT_FIRST_LOCAL_V1_ARTIFACT_ROOT ||
    path.join(repoRoot, ".tmp", "agent-first-local-v1-gate", runId),
);
const reportPath = path.join(
  artifactRoot,
  "agent-first-local-v1-gate-report.json",
);
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const suiteDefinitions = [
  {
    id: "short-drama-timeline",
    command: [process.execPath, "e2e/short-drama-timeline-smoke.ts"],
    minChecks: 4,
    requiredChecks: [
      "created timeline JSON validates",
      "restored timeline JSON validates",
      "9:16 composition is preserved",
      "video/image/audio/text tracks are present",
    ],
    validate: validateShortDramaReport,
  },
  {
    id: "agent-first-cas",
    command: [process.execPath, "e2e/agent-first-cas-smoke.ts"],
    schemaVersion: 1,
    minChecks: 52,
    requiredBooleans: [
      "directCanvasCliWriteBeforeReadRejected",
      "directCanvasCliCwdObservationRecorded",
      "directCanvasCliStaleObservationRejected",
      "directCanvasCliFreshObservationAccepted",
      "directCanvasCliMutationEnvelopeRecorded",
      "directCanvasCliImmutableStateExposed",
      "directCanvasCliImmutableUpdateRejected",
      "directCanvasCliCopyOnWriteSupported",
      "directCanvasCliDeleteReadRequired",
      "textProjectionNoLockSidecar",
      "timelineProjectionNoLockSidecar",
      "timelineEntityApplyAdvancesRevision",
      "legacyProjectionLockSidecarsIgnored",
      "textRestoreCreatesCopyOnWriteRevisionFromHostContent",
      "captionExportTimelineRevisionPinned",
      "timelineHandoffExportTimelineRevisionPinned",
      "captionBurnExportTimelineRevisionPinned",
      "projectionPathOutsideCwdRejected",
      "forceMutationBypassAbsent",
    ],
  },
  {
    id: "project-workspace-cli",
    command: [
      pnpmBin,
      "--filter",
      "@clash/desktop",
      "test:e2e:project-workspace-cli",
    ],
    schemaVersion: 1,
    minChecks: 21,
    requiredChecks: [
      "project marker preserves special project id",
      "local Project CLI works without cloud credentials",
      "Canvas node scopes stay isolated",
      "native Timeline file edit applies through entity CAS",
      "Timeline attach moves identity under one Canvas Action",
      "cross-Canvas Timeline copy creates new identities",
      "stale Timeline apply is rejected",
      "forged semantic observation cannot authorize a write",
      "cwd observation is owner-only",
      "daemon restart recovers all Project Timelines from the local replica",
      "public CLI output hides internal observations",
      "canonical project metadata uses SQLite",
    ],
  },
  {
    id: "storage-doctor-repair",
    command: [process.execPath, "e2e/storage-doctor-repair-smoke.ts"],
    schemaVersion: 1,
    minChecks: 70,
    requiredChecks: [
      "doctor before repair does not expose obsolete marker compatibility",
      "local project status is not web-openable or shared",
      "local project room surface is removed from local-first status",
      "local project action gates require sync before web or sharing",
      "local project sync policy keeps cloud admission disabled and private runtime data local",
      "machine-local config is a SQLite table, not agent-editable JSON sidecars",
      "no obsolete local JSON database sidecars exist in workspace or local home",
      "text revisions and Timeline Loro history have distinct storage authority",
      "local sqlite core metadata, provider auth tables, and projection indexes exist after repair",
      "project marker rejects removed collaboration fields",
      "cloud-sync pending action gates block web and sharing until required mirrors are ready",
      "cloud-sync ready state keeps the same local replica and opens product gates",
      "project status can recover project store after marker workspace deletion",
    ],
  },
];

function now() {
  return new Date().toISOString();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function selectedSuites() {
  const raw = process.env.CLASH_AGENT_FIRST_LOCAL_V1_SUITES;
  if (!raw) return suiteDefinitions;
  const requested = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const suites = suiteDefinitions.filter((suite) => requested.has(suite.id));
  const unknown = [...requested].filter(
    (id) => !suiteDefinitions.some((suite) => suite.id === id),
  );
  if (unknown.length > 0)
    throw new Error(
      `Unknown agent-first local v1 suite(s): ${unknown.join(", ")}`,
    );
  if (suites.length === 0)
    throw new Error("No agent-first local v1 suites selected");
  return suites;
}

function runSuiteCommand(suite) {
  return new Promise((resolve) => {
    const [cmd, ...args] = suite.command;
    const child = spawn(cmd, args, {
      cwd: desktopDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      resolve({
        command: suite.command.join(" "),
        status: null,
        stdout,
        stderr: `${stderr}${error.stack ?? error.message}`,
      });
    });
    child.on("close", (status) => {
      resolve({
        command: suite.command.join(" "),
        status,
        stdout,
        stderr,
      });
    });
  });
}

function extractReportPath(suite, stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (typeof parsed.reportPath === "string") return parsed.reportPath;
    } catch {
      // Keep scanning for non-JSON status lines.
    }
  }

  const escapedId = suite.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`\\[${escapedId}\\] report\\s+(.+)`);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(marker);
    if (match) return match[1].trim();
  }
  throw new Error(`Could not find report path in ${suite.id} output`);
}

async function readReport(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

function checkNames(report) {
  return new Set(
    (report.checks ?? [])
      .map((check) => (typeof check === "string" ? check : check?.name))
      .filter(Boolean),
  );
}

function failedChecks(report) {
  return (report.checks ?? []).filter(
    (check) =>
      typeof check === "object" && check?.status && check.status !== "pass",
  );
}

function requireReportBasics(suite, report) {
  if (
    suite.schemaVersion != null &&
    report.schemaVersion !== suite.schemaVersion
  ) {
    throw new Error(
      `${suite.id} report schemaVersion=${report.schemaVersion}, expected ${suite.schemaVersion}`,
    );
  }
  if (report.status !== "pass") {
    throw new Error(`${suite.id} report status=${report.status ?? "missing"}`);
  }
  if (!Array.isArray(report.checks) || report.checks.length < suite.minChecks) {
    throw new Error(
      `${suite.id} report has ${report.checks?.length ?? 0} checks, expected at least ${suite.minChecks}`,
    );
  }
  const failed = failedChecks(report);
  if (failed.length > 0) {
    throw new Error(
      `${suite.id} report contains failed checks: ${failed.map((check) => check.name).join(", ")}`,
    );
  }
}

function requireCheckNames(suite, report) {
  const names = checkNames(report);
  const missing = (suite.requiredChecks ?? []).filter(
    (name) => !names.has(name),
  );
  if (missing.length > 0)
    throw new Error(
      `${suite.id} report is missing required checks: ${missing.join(", ")}`,
    );
}

function requireBooleans(suite, report) {
  const booleans = report.booleans ?? {};
  const missing = (suite.requiredBooleans ?? []).filter(
    (name) => booleans[name] !== true,
  );
  if (missing.length > 0)
    throw new Error(
      `${suite.id} report has false/missing booleans: ${missing.join(", ")}`,
    );
}

function validateShortDramaReport(suite, report) {
  requireReportBasics(suite, report);
  requireCheckNames(suite, report);
  if (report.trackCount < 3)
    throw new Error(`${suite.id} report trackCount=${report.trackCount}`);
  if (report.itemCount <= 0)
    throw new Error(`${suite.id} report itemCount=${report.itemCount}`);
  if (report.durationInFrames <= 0)
    throw new Error(
      `${suite.id} report durationInFrames=${report.durationInFrames}`,
    );
}

async function runSuite(suite) {
  const startedAt = now();
  console.log(`[agent-first-local-v1-gate] start ${suite.id}`);
  const result = await runSuiteCommand(suite);
  const finishedAt = now();
  if (result.status !== 0) {
    throw Object.assign(new Error(`${suite.id} exited ${result.status}`), {
      result,
      startedAt,
      finishedAt,
    });
  }
  const reportFile = path.resolve(
    desktopDir,
    extractReportPath(suite, result.stdout),
  );
  const report = await readReport(reportFile);
  if (suite.validate) {
    suite.validate(suite, report);
  } else {
    requireReportBasics(suite, report);
    requireCheckNames(suite, report);
    requireBooleans(suite, report);
  }
  const suiteSummary = {
    id: suite.id,
    status: "pass",
    command: result.command,
    startedAt,
    finishedAt,
    reportPath: reportFile,
    checks: report.checks.length,
  };
  console.log(
    `[agent-first-local-v1-gate] pass ${suite.id} checks=${suiteSummary.checks}`,
  );
  return suiteSummary;
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  const startedAt = now();
  const suites = selectedSuites();
  const results = [];
  for (const suite of suites) {
    results.push(await runSuite(suite));
  }
  const report = {
    schemaVersion: 1,
    status: "pass",
    summary:
      "Agent-first local v1 gate passed required black-box report contracts.",
    run: {
      artifactRoot,
      startedAt,
      finishedAt: now(),
      selectedSuites: suites.map((suite) => suite.id),
    },
    suites: results,
  };
  await writeJson(reportPath, report);
  console.log("[agent-first-local-v1-gate] report", reportPath);
  console.log(
    JSON.stringify({ status: "pass", reportPath, suites: results.length }),
  );
}

main().catch(async (error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  const result = error?.result;
  await writeJson(reportPath, {
    schemaVersion: 1,
    status: "fail",
    summary: message,
    failedCommand: result
      ? {
          command: result.command,
          status: result.status,
          stdout: result.stdout.slice(-4000),
          stderr: result.stderr.slice(-4000),
        }
      : null,
  });
  console.error(message);
  process.exit(1);
});
