import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CommandResult = {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
};

type Check = {
  name: string;
  status: "pass" | "fail";
  evidence: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runId = process.env.CLASH_PROJECT_WORKSPACE_RUN_ID ??
  new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(
  process.env.CLASH_PROJECT_WORKSPACE_ARTIFACT_ROOT ??
    path.join(repoRoot, ".tmp", "project-workspace-cli", runId),
);
const workspace = path.join(artifactRoot, "workspace");
const reportPath = path.join(artifactRoot, "project-workspace-cli-report.json");
const cliEntry = path.join(repoRoot, "plugins", "clash", "runtime", "dispatcher.js");
const clashHome = process.env.CLASH_PROJECT_WORKSPACE_CLASH_HOME ??
  path.join("/tmp", `clash-pw-${randomUUID().slice(0, 8)}`);
const projectId = "qa/project with spaces";
const { CLASH_API_URL: _ambientApiUrl, ...baseEnv } = process.env;
const agentEnv = {
  ...baseEnv,
  CLASH_AGENT_MEMBER_ID: "qa-codex-agent",
  CLASH_AGENT_NAME: "QA Codex Agent",
  CLASH_USER_ID: "qa-local-user",
  CLASH_HOME: clashHome,
};

const checks: Check[] = [];
const commands: CommandResult[] = [];

function check(name: string, condition: unknown, evidence: string): void {
  const status = condition ? "pass" : "fail";
  checks.push({ name, status, evidence });
  if (!condition) throw new Error(`${name}: ${evidence}`);
}

function parseJson<T>(result: CommandResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`Invalid JSON from ${result.command}: ${String(error)}\n${result.stdout}\n${result.stderr}`);
  }
}

async function runCli(
  args: string[],
  options: {
    expectStatus?: number;
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: options.cwd ?? workspace,
      env: { ...agentEnv, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timeout: clash ${args.join(" ")}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (status) => {
      clearTimeout(timeout);
      resolve({
        command: `clash ${args.join(" ")}`,
        status,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
  commands.push(result);
  const expected = options.expectStatus ?? 0;
  if (result.status !== expected) {
    throw new Error(
      `${result.command} exited ${result.status}, expected ${expected}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return result;
}

type HostRecord = {
  endpoint: string;
  hostId: string;
  pid: number;
  protocolVersion: number;
};

const hostRecordPath = path.join(clashHome, "run", "host.json");

async function readHostRecord(): Promise<HostRecord> {
  return JSON.parse(await readFile(hostRecordPath, "utf8")) as HostRecord;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopHost(record: HostRecord | null): Promise<void> {
  if (!record || !processExists(record.pid)) return;
  process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 100 && processExists(record.pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processExists(record.pid)) {
    throw new Error(`local-api host ${record.pid} did not stop`);
  }
}

function timelineYaml(assetId: string, label: string): string {
  return `compositionWidth: 1080
compositionHeight: 1920
fps: 30
durationInFrames: 60
tracks:
  - id: video
    name: Video
    items:
      - id: shot-1
        type: image
        from: 0
        durationInFrames: 60
        assetId: ${assetId}
        label: ${label}
`;
}

async function main(): Promise<void> {
  await rm(artifactRoot, { recursive: true, force: true });
  await rm(clashHome, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(clashHome, { recursive: true, mode: 0o700 });

  let host: HostRecord | null = null;
  try {
    const rootHelp = await runCli(["--help"]);
    check(
      "root help presents cloud authentication as optional",
      /Start with the task/i.test(rootHelp.stdout) &&
        /Local commands need no cloud login/i.test(rootHelp.stdout) &&
        /Optional cloud sync:/i.test(rootHelp.stdout) &&
        /clash auth login/i.test(rootHelp.stdout) &&
        !/Setup:\s*\n\s*1\. clash auth login/i.test(rootHelp.stdout) &&
        !/clash host start/i.test(rootHelp.stdout),
      rootHelp.stdout,
    );

    const initialized = parseJson<{ projectId: string; markerPath: string }>(
      await runCli(["init", "--project", projectId, "--json"]),
    );
    check("project marker preserves special project id", initialized.projectId === projectId, initialized.markerPath);
    const projectStatus = parseJson<{
      storage: {
        workspace: { root: string };
        canonicalReplica: {
          metadata: { path: string };
          projectState: { snapshotPath: string };
          mediaAssets: { path: string };
        };
      };
    }>(await runCli(["project", "status", "--json"]));
    check(
      "project status maps editable roots to the marker cwd and canonical state to CLASH_HOME",
      projectStatus.storage.workspace.root === workspace &&
        projectStatus.storage.canonicalReplica.metadata.path.startsWith(clashHome) &&
        projectStatus.storage.canonicalReplica.projectState.snapshotPath.startsWith(clashHome) &&
        projectStatus.storage.canonicalReplica.mediaAssets.path.startsWith(clashHome),
      JSON.stringify(projectStatus.storage),
    );
    check(
      "canonical project metadata uses SQLite",
      path.basename(projectStatus.storage.canonicalReplica.metadata.path) === "local.sqlite",
      projectStatus.storage.canonicalReplica.metadata.path,
    );

    host = await readHostRecord();
    check(
      "CLI discovers the shared local-api host",
      host.endpoint.startsWith("http://127.0.0.1:") &&
        host.protocolVersion > 0 &&
        processExists(host.pid),
      JSON.stringify(host),
    );

    const initialCanvases = parseJson<Array<{ id: string }>>(
      await runCli(["canvases", "list", "--json"]),
    );
    check(
      "local Project CLI works without cloud credentials",
      !("CLASH_API_KEY" in agentEnv) && Array.isArray(initialCanvases),
      JSON.stringify({ apiKeyConfigured: "CLASH_API_KEY" in agentEnv, initialCanvases }),
    );
    check("fresh project has no phantom Canvas before its first write", initialCanvases.length === 0, JSON.stringify(initialCanvases));
    await runCli([
      "canvas", "add", "--type", "text", "--label", "Main seed",
      "--content", "seed", "--json",
    ]);
    const materializedCanvases = parseJson<Array<{ id: string }>>(
      await runCli(["canvases", "list", "--json"]),
    );
    check(
      "the first default Canvas write materializes main",
      materializedCanvases.map((canvas) => canvas.id).join(",") === "main",
      JSON.stringify(materializedCanvases),
    );

    await runCli(["canvases", "create", "--id", "shots", "--name", "Shots", "--json"]);
    const renamed = parseJson<{ id: string; name: string }>(
      await runCli(["canvases", "rename", "--canvas", "shots", "--name", "Selects", "--json"]),
    );
    check("Canvas create refreshes implicit observation", renamed.name === "Selects", JSON.stringify(renamed));

    const unknownCanvas = await runCli(
      ["canvas", "list", "--canvas", "typo", "--json"],
      { expectStatus: 1 },
    );
    check("unknown Canvas is rejected", /Canvas typo not found/i.test(unknownCanvas.stderr), unknownCanvas.stderr);

    const createdNode = parseJson<{ node_id: string }>(
      await runCli([
        "canvas", "add", "--canvas", "shots", "--type", "text",
        "--label", "Shot script", "--content", "Opening shot", "--json",
      ]),
    );
    check("Canvas-scoped node creation returns an id", Boolean(createdNode.node_id), JSON.stringify(createdNode));
    const shotsNodes = parseJson<Array<{ id: string }>>(
      await runCli(["canvas", "list", "--canvas", "shots", "--json"]),
    );
    const mainNodes = parseJson<Array<{ id: string }>>(
      await runCli(["canvas", "list", "--canvas", "main", "--json"]),
    );
    check("Canvas node scopes stay isolated", shotsNodes.some((node) => node.id === createdNode.node_id) && !mainNodes.some((node) => node.id === createdNode.node_id), JSON.stringify({ shotsNodes, mainNodes }));

    const fixturePath = path.join(workspace, "timeline-fixture.png");
    await writeFile(fixturePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64",
    ));
    const imported = parseJson<{ assetId: string }>(await runCli([
      "assets", "import", "--file", fixturePath, "--kind", "image", "--no-link", "--json",
    ]));
    check("Timeline fixture is a published Project Asset", Boolean(imported.assetId), JSON.stringify(imported));
    await runCli(["timeline", "create", "--id", "episode-1", "--name", "Episode 1", "--json"]);
    const pulled = parseJson<{ filePath: string; timelineId: string }>(
      await runCli(["timeline", "pull", "--timeline", "episode-1", "--json"]),
    );
    await writeFile(pulled.filePath, timelineYaml(imported.assetId, "opening"), "utf8");
    const applied = parseJson<{ applied: boolean; timelineId: string; revisionId: string }>(
      await runCli(["timeline", "apply", "--timeline", "episode-1", "--json"]),
    );
    check("native Timeline file edit applies through entity CAS", applied.applied && applied.timelineId === "episode-1", JSON.stringify(applied));

    const persistedTimelines = parseJson<Array<{ id: string; revisionId: string }>>(
      await runCli(["timeline", "list", "--json"]),
    );
    check(
      "Project Timeline readback exposes the applied host revision",
      persistedTimelines.some((timeline) =>
        timeline.id === "episode-1" && timeline.revisionId === applied.revisionId
      ),
      JSON.stringify({ applied, persistedTimelines }),
    );

    const attached = parseJson<{ owner: { kind: string; canvasId?: string; actionNodeId?: string } }>(
      await runCli([
        "timeline", "attach", "--timeline", "episode-1", "--canvas", "shots",
        "--node", "timeline-action-1", "--json",
      ]),
    );
    check("Timeline attach moves identity under one Canvas Action", attached.owner.kind === "canvas-action" && attached.owner.canvasId === "shots", JSON.stringify(attached));

    const attachedAction = parseJson<{ id: string; canvas_id: string; data?: { timelineId?: string } }>(
      await runCli(["canvas", "get", "--canvas", "shots", "--node", "timeline-action-1", "--json"]),
    );
    check(
      "Canvas-scoped Timeline Action resolves Project Timeline state",
      attachedAction.canvas_id === "shots" && attachedAction.data?.timelineId === "episode-1",
      JSON.stringify(attachedAction),
    );

    const copied = parseJson<{ id: string; owner: { kind: string; canvasId?: string; actionNodeId?: string } }>(
      await runCli([
        "timeline", "copy", "--timeline", "episode-1", "--canvas", "main",
        "--new-timeline", "episode-1-copy", "--new-node", "timeline-action-copy", "--json",
      ]),
    );
    check("cross-Canvas Timeline copy creates new identities", copied.id === "episode-1-copy" && copied.owner.actionNodeId === "timeline-action-copy", JSON.stringify(copied));

    const detached = parseJson<{ owner: { kind: string } }>(
      await runCli(["timeline", "detach", "--timeline", "episode-1", "--json"]),
    );
    check("Timeline detach returns the same Timeline to Project root", detached.owner.kind === "project", JSON.stringify(detached));

    const afterOwnership = parseJson<Array<{ id: string; owner: { kind: string; canvasId?: string } }>>(
      await runCli(["timeline", "list", "--json"]),
    );
    check(
      "Timeline ownership list distinguishes standalone and Canvas-owned copies",
      afterOwnership.some((timeline) => timeline.id === "episode-1" && timeline.owner.kind === "project") &&
        afterOwnership.some((timeline) => timeline.id === "episode-1-copy" && timeline.owner.canvasId === "main"),
      JSON.stringify(afterOwnership),
    );

    await runCli(["timeline", "pull", "--timeline", "episode-1", "--json"]);
    const concurrentWorkspace = path.join(artifactRoot, "concurrent-workspace");
    await mkdir(concurrentWorkspace, { recursive: true });
    await runCli(["init", "--project", projectId, "--json"], {
      cwd: concurrentWorkspace,
    });
    const concurrentPull = parseJson<{ filePath: string }>(
      await runCli(["timeline", "pull", "--timeline", "episode-1", "--json"], {
        cwd: concurrentWorkspace,
      }),
    );
    await writeFile(
      concurrentPull.filePath,
      timelineYaml(imported.assetId, "concurrent edit"),
      "utf8",
    );
    await runCli(["timeline", "apply", "--timeline", "episode-1", "--json"], {
      cwd: concurrentWorkspace,
    });
    await writeFile(pulled.filePath, timelineYaml(imported.assetId, "stale edit"), "utf8");
    const stale = await runCli(
      ["timeline", "apply", "--timeline", "episode-1", "--json"],
      { expectStatus: 1 },
    );
    check("stale Timeline apply is rejected", /STALE_READ|Stale|changed after/i.test(stale.stderr), stale.stderr);

    await runCli(["timeline", "pull", "--timeline", "episode-1", "--json"]);
    await writeFile(pulled.filePath, timelineYaml(imported.assetId, "fresh edit"), "utf8");
    await runCli(["timeline", "apply", "--timeline", "episode-1", "--json"]);

    const observationPath = path.join(workspace, ".clash", "observed.json");
    const observation = JSON.parse(await readFile(observationPath, "utf8")) as {
      versions: Record<string, string>;
    };
    const observationKey = "timeline:episode-1";
    const baseVersion = observation.versions[observationKey]?.split(":receipt:")[0];
    observation.versions[observationKey] = `${baseVersion}:receipt:forged`;
    await writeFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    await chmod(observationPath, 0o600);
    const forged = await runCli(
      ["timeline", "apply", "--timeline", "episode-1", "--json"],
      { expectStatus: 1 },
    );
    check("forged semantic observation cannot authorize a write", /Invalid Timeline apply read receipt/i.test(forged.stderr), forged.stderr);
    await runCli(["timeline", "pull", "--timeline", "episode-1", "--json"]);

    const observationMode = (await stat(observationPath)).mode & 0o777;
    check("cwd observation is owner-only", observationMode === 0o600, observationMode.toString(8));

    const stoppedHost = host;
    await stopHost(stoppedHost);
    host = null;
    const recovered = parseJson<Array<{ id: string }>>(
      await runCli(["timeline", "list", "--json"]),
    );
    host = await readHostRecord();
    check(
      "daemon restart recovers all Project Timelines from the local replica",
      recovered.map((timeline) => timeline.id).sort().join(",") === "episode-1,episode-1-copy" &&
        host.hostId !== stoppedHost.hostId &&
        processExists(host.pid),
      JSON.stringify({ recovered, stoppedHost, restartedHost: host }),
    );
    const recoveredCopyNode = parseJson<{ id: string; canvas_id: string }>(
      await runCli(["canvas", "get", "--canvas", "main", "--node", "timeline-action-copy", "--json"]),
    );
    check("recovered Timeline Action stays on its owning Canvas", recoveredCopyNode.canvas_id === "main", JSON.stringify(recoveredCopyNode));

    const forbiddenPublicFields = commands.filter((command) =>
      /:receipt:|"readToken"|"observedVersion"|--if-match/.test(`${command.stdout}\n${command.stderr}`)
    );
    check("public CLI output hides internal observations", forbiddenPublicFields.length === 0, forbiddenPublicFields.map((command) => command.command).join(", "));

    const report = {
      schemaVersion: 1,
      kind: "clash.project-workspace-cli-e2e",
      status: "pass",
      runId,
      projectId,
      paths: {
        artifactRoot,
        workspace,
        clashHome,
        marker: initialized.markerPath,
        observation: observationPath,
        timelineProjection: pulled.filePath,
        hostRecord: hostRecordPath,
        endpoint: host.endpoint,
      },
      summary: {
        checks: checks.length,
        commands: commands.length,
        failures: 0,
      },
      checks,
      commands,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ status: "pass", reportPath, checks: checks.length, commands: commands.length })}\n`);
  } catch (error) {
    const report = {
      schemaVersion: 1,
      kind: "clash.project-workspace-cli-e2e",
      status: "fail",
      runId,
      projectId,
      paths: { artifactRoot, workspace, clashHome },
      summary: {
        checks: checks.length,
        commands: commands.length,
        failures: 1,
      },
      checks,
      commands,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    await stopHost(host).catch(() => undefined);
  }
}

await main();
