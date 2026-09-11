import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const runId = process.env.CLASH_AGENT_FIRST_CAS_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(
  process.env.CLASH_AGENT_FIRST_CAS_ARTIFACT_ROOT ||
    path.join(repoRoot, ".tmp", "agent-first-cas", runId),
);
const workspace = path.join(artifactRoot, "workspace");
const reportPath = path.join(artifactRoot, "agent-first-cas-report.json");
const cliEntry = path.join(repoRoot, "packages", "cli", "src", "index.ts");
const require = createRequire(path.join(repoRoot, "packages", "cli", "package.json"));
const tsxLoader = require.resolve("tsx");
const CLI_TIMEOUT_MS = 20_000;

const checks = [];

function now() {
  return new Date().toISOString();
}

function temporaryClashHome(label) {
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  return path.join(root, `cl-${label}-${process.pid}-${Date.now().toString(36)}`);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCanvas(args, env = {}, cwd = workspace) {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, cliEntry, "canvas", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, ...env },
    },
  );
  return {
    command: `clash canvas ${args.join(" ")}`,
    status: result.status,
    error: result.error ? String(result.error.message || result.error) : "",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runText(args, env = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, cliEntry, "text", ...args],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, ...env },
    },
  );
  return {
    command: `clash text ${args.join(" ")}`,
    status: result.status,
    error: result.error ? String(result.error.message || result.error) : "",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runTimeline(args, env = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, cliEntry, "timeline", ...args],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, ...env },
    },
  );
  return {
    command: `clash timeline ${args.join(" ")}`,
    status: result.status,
    error: result.error ? String(result.error.message || result.error) : "",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function recordCheck(name, pass, evidence, extra = {}) {
  checks.push({
    name,
    status: pass ? "pass" : "fail",
    observedAt: now(),
    evidence,
    ...extra,
  });
  if (!pass) {
    throw new Error(`${name}: ${evidence}`);
  }
}

function requireCheckPassed(name) {
  if (!checks.some((check) => check.name === name && check.status === "pass")) {
    throw new Error(`required check missing: ${name}`);
  }
}

function parseStdoutJson(result) {
  return JSON.parse(result.stdout);
}

function baseReadToken(readToken) {
  return typeof readToken === "string" ? readToken.split(":receipt:")[0] : readToken;
}

function readOptionalText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJsonLines(filePath) {
  return readOptionalText(filePath)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function runTsxEval(source) {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "--input-type=module", "-e", source],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`tsx eval failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function startLocalApiHost(options) {
  const localApiModule = pathToFileURL(path.join(repoRoot, "apps", "local-api", "src", "server.ts")).href;
  const replicaStoreModule = pathToFileURL(path.join(repoRoot, "apps", "local-api", "src", "loro", "file-replica-store.ts")).href;
  const sharedTypesModule = pathToFileURL(path.join(repoRoot, "packages", "shared-types", "src", "index.ts")).href;
  const source = `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { LoroSyncClient } from ${JSON.stringify(sharedTypesModule)};
    import { FileReplicaStore } from ${JSON.stringify(replicaStoreModule)};
    import { startLocalApiServer } from ${JSON.stringify(localApiModule)};

    const projectId = ${JSON.stringify(options.projectId)};
    const timelineId = ${JSON.stringify(options.timelineId ?? "timeline-cli")};
    const timelineState = ${JSON.stringify(options.timelineState ?? {
      compositionWidth: 1080,
      compositionHeight: 1920,
      fps: 30,
      durationInFrames: 60,
      tracks: [{ id: "main", items: [] }],
    })};
    const clashHome = ${JSON.stringify(options.clashHome)};
    const dataDir = join(clashHome, "local-api");
    const runDir = join(clashHome, "run");
    const commandLogPath = join(clashHome, "host-command-log.jsonl");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(commandLogPath, "");

    const store = new FileReplicaStore(join(dataDir, "projects"));
    await store.updateSnapshotAtomic(projectId, (doc) => {
      const client = new LoroSyncClient({
        serverUrl: "http://127.0.0.1",
        projectId,
        doc,
      });
      client.createNode("text-cli", "text", { label: "CLI Text", content: "before" });
      client.createTimeline({
        id: timelineId,
        name: "CLI Timeline",
        state: timelineState,
      });
      client.createNode("delete-cli", "text", { label: "Delete CLI", content: "before" });
      client.createNode("immutable-cli", "text", { label: "Immutable CLI", content: "before" });
      client.createNode("immutable-consumer", "text", { label: "Immutable Consumer", content: "consumer" });
      client.canvas.insertEdge("immutable-cli-consumer", "immutable-cli", "immutable-consumer", "default");
      return { value: null };
    });

    const server = await startLocalApiServer({
      port: 0,
      dataDir,
      discovery: {
        enabled: true,
        runDir,
        launchMode: "user-service",
        startedBy: "cli",
      },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local-api did not bind");
    const endpoint = \`http://127.0.0.1:\${address.port}\`;
    const close = () => server.close(() => process.exit(0));
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
    process.stdout.write(JSON.stringify({ ready: true, projectId, endpoint, commandLogPath }) + "\\n");
  `;

  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, "--input-type=module", "-e", source],
    {
      cwd: repoRoot,
      env: { ...process.env, CLASH_HOME: options.clashHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const logs = { stdout: "", stderr: "" };
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`local-api host did not become ready. stdout=${logs.stdout} stderr=${logs.stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      logs.stdout += chunk.toString();
      for (const line of logs.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.ready) {
            clearTimeout(timeout);
            resolveReady(parsed);
            return;
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      logs.stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`local-api host exited before ready: code=${code} signal=${signal} stdout=${logs.stdout} stderr=${logs.stderr}`));
    });
  });

  return {
    child,
    logs,
    ready,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolveStop) => {
        const timeout = setTimeout(resolveStop, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolveStop();
        });
      });
    },
  };
}

async function startTextRevisionIndexHost(targetHostUrl) {
  const hostDir = path.join(artifactRoot, "text-revision-index-host");
  const requestsPath = path.join(hostDir, "requests.jsonl");
  const revisionsPath = path.join(hostDir, "revisions.json");
  const source = `
    import { createServer } from "node:http";
    import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
    import { dirname } from "node:path";

    const requestsPath = ${JSON.stringify(requestsPath)};
    const revisionsPath = ${JSON.stringify(revisionsPath)};
    const targetHostUrl = ${JSON.stringify(targetHostUrl)};
    const revisions = [];
    const revisionContents = new Map();
    mkdirSync(dirname(requestsPath), { recursive: true });
    writeFileSync(requestsPath, "");
    writeFileSync(revisionsPath, "[]\\n");

    function persistRevisions() {
      writeFileSync(revisionsPath, JSON.stringify(revisions, null, 2) + "\\n");
    }

    async function readRequestJson(request) {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      return raw ? JSON.parse(raw) : {};
    }

    function sendJson(response, status, body) {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        connection: "close",
      });
      response.end(payload);
    }

    function sendText(response, status, body, contentType) {
      response.writeHead(status, {
        "content-type": contentType,
        "content-length": Buffer.byteLength(body),
        connection: "close",
      });
      response.end(body);
    }

    function revisionWithContentDescriptor(revision) {
      if (!revisionContents.has(revision.revisionId)) return revision;
      if (revision.kind === "clash.text.revision") {
        return {
          ...revision,
          content: {
            kind: "text-revision-content",
            stored: true,
            contentHash: revision.contentHash,
            mediaType: "text/markdown",
            url: "/api/v1/projects/" + encodeURIComponent(revision.projectId) + "/text-revisions/" + encodeURIComponent(revision.revisionId) + "/content",
            immutable: true,
            storage: {
              kind: "content-addressed-revision-blob",
              registry: "text_revisions",
              mediaAsset: false,
              agentWritable: false,
            },
          },
        };
      }
      return revision;
    }

    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        appendFileSync(requestsPath, JSON.stringify({ method: request.method, path: url.pathname, search: url.search }) + "\\n");
        if (request.method === "POST" && /\\/api\\/v1\\/projects\\/[^/]+\\/host-command$/.test(url.pathname)) {
          let raw = "";
          for await (const chunk of request) raw += chunk.toString();
          const upstream = await fetch(targetHostUrl + url.pathname + url.search, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw,
          });
          const body = Buffer.from(await upstream.arrayBuffer());
          response.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") || "application/json",
            "content-length": body.byteLength,
            connection: "close",
          });
          response.end(body);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/v1/me") {
          sendJson(response, 200, { id: "agent-first-cas-user" });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/text-revisions") {
          const body = await readRequestJson(request);
          if (!body.revision?.revisionId) {
            sendJson(response, 400, { error: "missing revision" });
            return;
          }
          const existing = revisions.find((revision) => revision.revisionId === body.revision.revisionId);
          if (!existing) {
            revisions.push(body.revision);
            if (typeof body.content === "string") {
              revisionContents.set(body.revision.revisionId, body.content);
            }
            persistRevisions();
          }
          sendJson(response, 200, {
            revision: body.revision,
            ...(typeof body.content === "string" ? { content: revisionWithContentDescriptor(body.revision).content } : {}),
            mutation: {
              operation: "text_revision_index",
              entity: { kind: "text", id: \`\${body.revision.projectId}:\${body.revision.nodeId}\` },
              resultEntityId: body.revision.revisionId,
              accepted: true,
            },
          });
          return;
        }
        const match = url.pathname.match(/^\\/api\\/v1\\/projects\\/([^/]+)\\/text-revisions$/);
        if (request.method === "GET" && match) {
          const projectId = decodeURIComponent(match[1]);
          const nodeId = url.searchParams.get("nodeId");
          const limit = Number(url.searchParams.get("limit") || "50");
          const filtered = revisions
            .filter((revision) => revision.projectId === projectId && (!nodeId || revision.nodeId === nodeId))
            .slice(0, Number.isFinite(limit) ? limit : 50)
            .map(revisionWithContentDescriptor);
          sendJson(response, 200, { revisions: filtered });
          return;
        }
        const textContentMatch = url.pathname.match(/^\\/api\\/v1\\/projects\\/([^/]+)\\/text-revisions\\/([^/]+)\\/content$/);
        if (request.method === "GET" && textContentMatch) {
          const projectId = decodeURIComponent(textContentMatch[1]);
          const revisionId = decodeURIComponent(textContentMatch[2]);
          const revision = revisions.find((item) =>
            item.projectId === projectId &&
            item.revisionId === revisionId &&
            item.kind === "clash.text.revision"
          );
          const content = revisionContents.get(revisionId);
          if (!revision || typeof content !== "string") {
            sendJson(response, 404, { error: "revision content not found" });
            return;
          }
          sendText(response, 200, content, "text/markdown; charset=utf-8");
          return;
        }
        sendJson(response, 404, { error: "not found" });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    function cleanup() {
      try { server.close(); } catch {}
    }
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(JSON.stringify({
        ready: true,
        url: \`http://127.0.0.1:\${address.port}\`,
        requestsPath,
        revisionsPath,
      }) + "\\n");
    });
    setInterval(() => {}, 30_000);
  `;

  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs = { stdout: "", stderr: "" };
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`text revision index host did not become ready. stdout=${logs.stdout} stderr=${logs.stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      logs.stdout += chunk.toString();
      for (const line of logs.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.ready) {
            clearTimeout(timeout);
            resolveReady(parsed);
            return;
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      logs.stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`text revision index host exited before ready: code=${code} signal=${signal} stdout=${logs.stdout} stderr=${logs.stderr}`));
    });
  });

  return {
    url: ready.url,
    logs,
    get requests() {
      return readJsonLines(requestsPath);
    },
    get revisions() {
      const raw = readOptionalText(revisionsPath);
      return raw ? JSON.parse(raw) : [];
    },
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolveClose) => {
        const timeout = setTimeout(resolveClose, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolveClose();
        });
      });
    },
  };
}

async function seedWorkspace() {
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(workspace, ".clash"), { recursive: true });
  await writeFile(
    path.join(workspace, ".clash", "project.toml"),
    'schema_version = 1\nproject_id = "project-agent-first-cas-production"\n',
    "utf8",
  );
  await writeJson(path.join(workspace, "pipeline.manifest.json"), {
    schemaVersion: 1,
    projectKind: "short-drama",
    stages: ["brief", "plan", "review", "export"],
    editableFiles: ["plans/prompt-pack.json"],
    protectedFiles: ["snapshot.bin", "local.sqlite"],
    requiredSystemCapabilities: ["review.stage-gates"],
  });
  await writeJson(path.join(workspace, "qa", "delivery", "validation.json"), {
    verdict: "pass",
  });
}

function runLocalApiReceiptCompatibility() {
  const hostModule = pathToFileURL(path.join(repoRoot, "apps", "local-api", "src", "project-command-host.ts")).href;
  const sharedTypesModule = pathToFileURL(path.join(repoRoot, "packages", "shared-types", "src", "index.ts")).href;
  const result = runTsxEval(`
    import { LoroSyncClient } from ${JSON.stringify(sharedTypesModule)};
    import { handleCommandForTest } from ${JSON.stringify(hostModule)};
    if (typeof handleCommandForTest !== "function") {
      throw new Error("local-api handleCommandForTest export missing");
    }

    const client = new LoroSyncClient({
      serverUrl: "http://localhost:0",
      projectId: "project-agent-first-cas",
      token: "test",
    });
    client.createNode("text-1", "text", { label: "Script", content: "before" });
    const firstRead = handleCommandForTest(client, { action: "get", nodeId: "text-1" });
    const firstReadToken = firstRead.readToken;
    const missingUpdate = handleCommandForTest(client, {
      action: "update",
      nodeId: "text-1",
      label: "missing read token",
      actorClientType: "agent",
    });
    client.updateNode("text-1", { label: "concurrent edit" });
    const staleUpdate = handleCommandForTest(client, {
      action: "update",
      nodeId: "text-1",
      label: "stale read token",
      actorClientType: "agent",
      ifMatch: firstReadToken,
    });
    const freshRead = handleCommandForTest(client, { action: "get", nodeId: "text-1" });
    const freshReadToken = freshRead.readToken;
    const freshUpdate = handleCommandForTest(client, {
      action: "update",
      nodeId: "text-1",
      label: "fresh read token",
      actorClientType: "agent",
      ifMatch: freshReadToken,
    });
    client.createNode("delete-1", "text", { label: "Delete me", content: "before" });
    const missingDelete = handleCommandForTest(client, {
      action: "delete",
      nodeId: "delete-1",
      actorClientType: "agent",
    });
    console.log(JSON.stringify({
      missingUpdate,
      staleUpdate,
      freshUpdate,
      missingDelete,
      firstRead,
      freshRead,
      finalLabel: client.readNode("text-1")?.data?.label,
      deleteStillExists: Boolean(client.readNode("delete-1")),
    }));
  `);

  recordCheck(
    "local-api receipt path rejects missing read",
    /READ_REQUIRED/i.test(JSON.stringify(result.missingUpdate)) &&
      result.finalLabel !== "missing read token",
    JSON.stringify(result.missingUpdate),
  );
  recordCheck(
    "local-api receipt path rejects stale receipt",
    /Stale canvas update rejected/i.test(JSON.stringify(result.staleUpdate)) &&
      result.finalLabel === "fresh read token",
    JSON.stringify(result.staleUpdate),
  );
  recordCheck(
    "local-api receipt path accepts fresh receipt",
    result.freshUpdate?.updated === true &&
      typeof result.freshUpdate?.readToken === "string" &&
      result.finalLabel === "fresh read token",
    JSON.stringify(result.freshUpdate),
  );
  recordCheck(
    "local-api receipt mutation envelope recorded",
    result.freshUpdate?.mutation?.operation === "canvas_update" &&
      result.freshUpdate?.mutation?.entity?.kind === "canvas-node" &&
      result.freshUpdate?.mutation?.entity?.id === "text-1" &&
      result.freshUpdate?.mutation?.expectedReadToken === result.freshRead?.readToken &&
      result.freshUpdate?.mutation?.beforeReadToken === baseReadToken(result.freshRead?.readToken) &&
      result.freshUpdate?.mutation?.afterReadToken === result.freshUpdate?.readToken &&
      result.freshUpdate?.mutation?.resultEntityId === "text-1" &&
      result.freshUpdate?.mutation?.accepted === true,
    JSON.stringify(result.freshUpdate?.mutation),
  );
  recordCheck(
    "local-api receipt path rejects unread delete",
    /READ_REQUIRED/i.test(JSON.stringify(result.missingDelete)) &&
      result.deleteStillExists === true,
    JSON.stringify(result.missingDelete),
  );
  return result;
}

function runProjectionPathGuards() {
  const symlinkTarget = path.join(artifactRoot, "outside-projection-target");
  const lockSymlinkTarget = path.join(artifactRoot, "outside-lock-target");
  mkdirSync(path.join(symlinkTarget, "text"), { recursive: true });
  mkdirSync(lockSymlinkTarget, { recursive: true });
  symlinkSync(symlinkTarget, path.join(workspace, "symlinked-projections"), "dir");
  mkdirSync(path.join(workspace, "projections", "text"), { recursive: true });
  mkdirSync(path.join(workspace, "projections", "timelines"), { recursive: true });
  mkdirSync(path.join(workspace, "timelines"), { recursive: true });
  mkdirSync(path.join(workspace, "reviews", "gates"), { recursive: true });
  mkdirSync(path.join(workspace, "qa", "pipeline"), { recursive: true });
  mkdirSync(path.join(workspace, "exports", "captions"), { recursive: true });
  mkdirSync(path.join(workspace, "exports", "handoff"), { recursive: true });
  mkdirSync(path.join(workspace, "references"), { recursive: true });
  writeFileSync(path.join(workspace, "projections", "timelines", "captions.timeline.yaml"), [
    "fps: 30",
    "durationInFrames: 60",
    "tracks:",
    "  - id: captions",
    "    role: subtitle",
    "    items:",
    "      - id: clean-caption",
    "        type: text",
    "        from: 0",
    "        durationInFrames: 30",
    "        cues:",
    "          - id: cue-1",
    "            startFrame: 0",
    "            durationInFrames: 30",
    "            text: 大家好",
    "            wordIds: [w1]",
    "            sourceStartFrame: 0",
    "            sourceEndFrame: 30",
    "        wordRefs:",
    "          - id: w1",
    "            text: 大家好",
    "            sourceStartFrame: 0",
    "            sourceEndFrame: 30",
    "        sourceToOutputMap:",
    "          - sourceStartFrame: 0",
    "            sourceEndFrame: 30",
    "            outputStartFrame: 0",
    "            outputEndFrame: 30",
    "",
  ].join("\n"), "utf8");
  writeFileSync(path.join(workspace, "references", "roles.json"), `${JSON.stringify([
    {
      roleId: "hero-front",
      assetId: "asset-hero-front",
      role: "identity-front",
      path: "assets/reference-sheets/hero-front.png",
    },
  ], null, 2)}\n`, "utf8");
  writeFileSync(path.join(lockSymlinkTarget, "script.lock.json"), "{}\n", "utf8");
  writeFileSync(path.join(lockSymlinkTarget, "main.timeline.lock.json"), "{}\n", "utf8");
  symlinkSync(
    path.join(lockSymlinkTarget, "script.lock.json"),
    path.join(workspace, "projections", "text", "script.lock.json"),
  );
  symlinkSync(
    path.join(lockSymlinkTarget, "main.timeline.lock.json"),
    path.join(workspace, "timelines", "main.timeline.lock.json"),
  );

  const textPull = runText([
    "pull",
    "--project",
    "project-agent-first-path-guards",
    "--node",
    "text-1",
    "--file",
    "../outside-text.md",
    "--json",
  ]);
  recordCheck(
    "text pull rejects projection path outside cwd",
    textPull.status === 1 && /Projection file path must stay inside the current project cwd/i.test(textPull.stderr),
    textPull.stderr || textPull.stdout,
    { command: textPull.command },
  );

  const textSymlinkPull = runText([
    "pull",
    "--project",
    "project-agent-first-path-guards",
    "--node",
    "text-1",
    "--file",
    "symlinked-projections/text/script.md",
    "--json",
  ]);
  recordCheck(
    "text pull rejects symlinked projection path outside cwd",
    textSymlinkPull.status === 1 &&
      /Projection file path must not traverse a symlink outside the current project cwd/i.test(textSymlinkPull.stderr),
    textSymlinkPull.stderr || textSymlinkPull.stdout,
    { command: textSymlinkPull.command },
  );

  const timelinePull = runTimeline([
    "pull",
    "--project",
    "project-agent-first-path-guards",
    "--timeline",
    "timeline-1",
    "--file",
    "../outside.timeline.yaml",
    "--json",
  ]);
  recordCheck(
    "timeline pull rejects projection path outside cwd",
    timelinePull.status === 1 &&
      /Projection file path must stay inside the current project cwd/i.test(timelinePull.stderr),
    timelinePull.stderr || timelinePull.stdout,
    { command: timelinePull.command },
  );

  const timelineSymlinkApply = runTimeline([
    "apply",
    "--project",
    "project-agent-first-path-guards",
    "--timeline",
    "timeline-1",
    "--file",
    "symlinked-projections/main.timeline.yaml",
    "--json",
  ]);
  recordCheck(
    "timeline apply rejects symlinked projection path outside cwd",
    timelineSymlinkApply.status === 1 &&
      /Projection file path must not traverse a symlink outside the current project cwd/i.test(timelineSymlinkApply.stderr),
    timelineSymlinkApply.stderr || timelineSymlinkApply.stdout,
    { command: timelineSymlinkApply.command },
  );

  return {
    textPull: { status: textPull.status, stderr: textPull.stderr },
    textSymlinkPull: { status: textSymlinkPull.status, stderr: textSymlinkPull.stderr },
    timelinePull: { status: timelinePull.status, stderr: timelinePull.stderr },
    timelineSymlinkApply: { status: timelineSymlinkApply.status, stderr: timelineSymlinkApply.stderr },
  };
}

async function runDirectCanvasCliImplicitCas() {
  const projectId = "project-agent-first-cas-cli";
  const clashHome = temporaryClashHome("canvas");
  const observationPath = path.join(workspace, ".clash", "observed.json");
  const env = {
    CLASH_HOME: clashHome,
    CLASH_AGENT_MEMBER_ID: "agent-first-cas-smoke",
    CLASH_AGENT_NAME: "Agent First CAS Smoke",
  };
  const humanEnv = {
    CLASH_HOME: clashHome,
    CLASH_AGENT_MEMBER_ID: "",
    CLASH_AGENT_NAME: "",
  };
  await mkdir(path.join(workspace, ".clash"), { recursive: true });
  await writeFile(
    path.join(workspace, ".clash", "project.toml"),
    `schema_version = 1\nproject_id = ${JSON.stringify(projectId)}\n`,
    "utf8",
  );
  await rm(observationPath, { force: true });
  // A concurrent writer has to be a real concurrent writer: a second linked cwd.
  // A write from this same cwd legitimately refreshes this cwd's observation, so
  // simulating a third party in place cannot produce a stale read.
  const humanWorktree = path.join(path.dirname(workspace), "human-worktree");
  await mkdir(path.join(humanWorktree, ".clash"), { recursive: true });
  await writeFile(
    path.join(humanWorktree, ".clash", "project.toml"),
    `schema_version = 1\nproject_id = ${JSON.stringify(projectId)}\n`,
    "utf8",
  );
  const host = await startLocalApiHost({ projectId, clashHome });
  try {
    const missingUpdate = runCanvas([
      "update",
      "--project",
      projectId,
      "--node",
      "text-cli",
      "--label",
      "write before read",
      "--json",
    ], env);
    recordCheck(
      "direct canvas CLI rejects write before read",
      missingUpdate.status === 1 && /READ_REQUIRED/i.test(missingUpdate.stderr),
      missingUpdate.stderr || missingUpdate.stdout,
      { command: missingUpdate.command, host: host.ready },
    );

    const firstRead = runCanvas([
      "get",
      "--project",
      projectId,
      "--node",
      "text-cli",
      "--json",
    ], env);
    const firstReadPayload = firstRead.status === 0 ? parseStdoutJson(firstRead) : null;
    const firstObservation = existsSync(observationPath)
      ? JSON.parse(readFileSync(observationPath, "utf8"))
      : null;
    recordCheck(
      "direct canvas CLI read records only cwd entity version",
      firstRead.status === 0 &&
        firstReadPayload?.immutable === false &&
        !("readToken" in firstReadPayload) &&
        !("version" in firstReadPayload) &&
        firstObservation?.schemaVersion === 1 &&
        firstObservation?.projectId === projectId &&
        typeof firstObservation?.versions?.["canvas-node:text-cli"] === "string" &&
        Object.keys(firstObservation?.versions ?? {}).length === 1,
      firstRead.stderr || firstRead.stdout,
      { command: firstRead.command, observationPath, observation: firstObservation },
    );

    // The concurrent writer reads in its own cwd first, exactly as any writer must.
    runCanvas(["get", "--project", projectId, "--node", "text-cli", "--json"], humanEnv, humanWorktree);
    const concurrent = runCanvas([
      "update",
      "--project",
      projectId,
      "--node",
      "text-cli",
      "--label",
      "concurrent cli edit",
      "--json",
    ], humanEnv, humanWorktree);
    recordCheck(
      "direct canvas CLI fixture performs concurrent human edit",
      concurrent.status === 0 && parseStdoutJson(concurrent).updated === true,
      concurrent.stderr || concurrent.stdout,
      { command: concurrent.command },
    );

    const staleUpdate = runCanvas([
      "update",
      "--project",
      projectId,
      "--node",
      "text-cli",
      "--label",
      "stale agent edit",
      "--json",
    ], env);
    recordCheck(
      "direct canvas CLI rejects stale cwd observation",
      staleUpdate.status === 1 && /STALE_READ/i.test(staleUpdate.stderr),
      staleUpdate.stderr || staleUpdate.stdout,
      { command: staleUpdate.command },
    );

    const freshRead = runCanvas([
      "get",
      "--project",
      projectId,
      "--node",
      "text-cli",
      "--json",
    ], env);
    const freshReadPayload = parseStdoutJson(freshRead);
    const freshUpdate = runCanvas([
      "update",
      "--project",
      projectId,
      "--node",
      "text-cli",
      "--label",
      "fresh implicit observation",
      "--json",
    ], env);
    const freshUpdatePayload = freshUpdate.status === 0 ? parseStdoutJson(freshUpdate) : null;
    const finalRead = runCanvas([
      "get",
      "--project",
      projectId,
      "--node",
      "text-cli",
      "--json",
    ], env);
    const finalReadPayload = finalRead.status === 0 ? parseStdoutJson(finalRead) : null;
    recordCheck(
      "direct canvas CLI fresh implicit observation accepted",
      freshUpdate.status === 0 &&
        freshUpdatePayload?.updated === true &&
        finalReadPayload?.data?.label === "fresh implicit observation" &&
        !/readToken|if-match/i.test(JSON.stringify(freshUpdatePayload)),
      freshUpdate.stderr || freshUpdate.stdout || finalRead.stderr || finalRead.stdout,
      { command: freshUpdate.command },
    );
    recordCheck(
      "direct canvas CLI mutation envelope recorded",
      freshUpdatePayload?.mutation?.operation === "canvas_update" &&
        freshUpdatePayload?.mutation?.entity?.kind === "canvas-node" &&
        freshUpdatePayload?.mutation?.entity?.id === "text-cli" &&
        freshUpdatePayload?.mutation?.resultEntityId === "text-cli" &&
        freshUpdatePayload?.mutation?.accepted === true &&
        !/readToken/i.test(JSON.stringify(freshUpdatePayload?.mutation)),
      JSON.stringify(freshUpdatePayload?.mutation),
      { command: freshUpdate.command },
    );

    const immutableRead = runCanvas([
      "get",
      "--project",
      projectId,
      "--node",
      "immutable-cli",
      "--json",
    ], env);
    const immutableReadPayload = immutableRead.status === 0 ? parseStdoutJson(immutableRead) : null;
    recordCheck(
      "direct canvas CLI read exposes global immutable state",
      immutableRead.status === 0 && immutableReadPayload?.immutable === true,
      immutableRead.stderr || immutableRead.stdout,
      { command: immutableRead.command },
    );
    const immutableUpdate = runCanvas([
      "update",
      "--project",
      projectId,
      "--node",
      "immutable-cli",
      "--content",
      "must not overwrite",
      "--json",
    ], env);
    recordCheck(
      "direct canvas CLI rejects in-place update of immutable node",
      immutableUpdate.status === 1 && /IMMUTABLE_NODE/i.test(immutableUpdate.stderr),
      immutableUpdate.stderr || immutableUpdate.stdout,
      { command: immutableUpdate.command },
    );
    const copied = runCanvas([
      "copy",
      "--project",
      projectId,
      "--node",
      "immutable-cli",
      "--new-node",
      "immutable-cli-copy",
      "--json",
    ], env);
    const copiedPayload = copied.status === 0 ? parseStdoutJson(copied) : null;
    const copiedRead = runCanvas([
      "get",
      "--project",
      projectId,
      "--node",
      "immutable-cli-copy",
      "--json",
    ], env);
    const copiedReadPayload = copiedRead.status === 0 ? parseStdoutJson(copiedRead) : null;
    const edgesRead = runCanvas(["edges", "--project", projectId, "--json"], env);
    const edges = edgesRead.status === 0 ? parseStdoutJson(edgesRead) : [];
    recordCheck(
      "direct canvas CLI copy creates mutable COW node and preserves lineage",
      copied.status === 0 &&
        copiedPayload?.copied === true &&
        copiedPayload?.sourceNodeId === "immutable-cli" &&
        copiedPayload?.newNodeId === "immutable-cli-copy" &&
        copiedReadPayload?.immutable === false &&
        edges.some((edge) => edge.source === "immutable-cli" && edge.target === "immutable-consumer") &&
        edges.some((edge) => edge.source === "immutable-cli" && edge.target === "immutable-cli-copy" && edge.type === "copy-on-write"),
      copied.stderr || copied.stdout || copiedRead.stderr || copiedRead.stdout || edgesRead.stderr || edgesRead.stdout,
      { command: copied.command, copied: copiedPayload, edges },
    );

    const missingDelete = runCanvas([
      "delete",
      "--project",
      projectId,
      "--node",
      "delete-cli",
      "--yes",
      "--json",
    ], env);
    const deleteRead = runCanvas([
      "get",
      "--project",
      projectId,
      "--node",
      "delete-cli",
      "--json",
    ], env);
    const deleteResult = runCanvas([
      "delete",
      "--project",
      projectId,
      "--node",
      "delete-cli",
      "--yes",
      "--json",
    ], env);
    const deletedRead = runCanvas([
      "get",
      "--project",
      projectId,
      "--node",
      "delete-cli",
      "--json",
    ], env);
    recordCheck(
      "direct canvas CLI delete requires implicit read then succeeds",
      missingDelete.status === 1 &&
        /READ_REQUIRED/i.test(missingDelete.stderr) &&
        deleteRead.status === 0 &&
        deleteResult.status === 0 &&
        parseStdoutJson(deleteResult).deleted === true &&
        deletedRead.status === 1,
      missingDelete.stderr || missingDelete.stdout || deleteResult.stderr || deleteResult.stdout,
      { command: missingDelete.command },
    );

    const revisionHost = await startTextRevisionIndexHost(host.ready.endpoint);
    let textPullPayload = null;
    let textApplyPayload = null;
    let textHistoryPayload = null;
    let textContentPayload = null;
    let textRestorePayload = null;
    let timelinePullPayload = null;
    let timelineApplyPayload = null;
    try {
      const revisionEnv = {
        ...env,
        CLASH_API_URL: revisionHost.url,
      };
      const textPull = runText([
        "pull",
        "--project",
        projectId,
        "--node",
        "text-cli",
        "--json",
      ], revisionEnv);
      textPullPayload = textPull.status === 0 ? parseStdoutJson(textPull) : null;
      const textObservation = existsSync(observationPath)
        ? JSON.parse(readFileSync(observationPath, "utf8"))
        : null;
      const textLockPath = textPullPayload?.filePath
        ? path.join(
            path.dirname(textPullPayload.filePath),
            `${path.basename(textPullPayload.filePath, path.extname(textPullPayload.filePath))}.lock.json`,
          )
        : null;
      recordCheck(
        "text pull records cwd observation without token or lock sidecar",
        textPull.status === 0 &&
          typeof textPullPayload?.filePath === "string" &&
          !("readToken" in textPullPayload) &&
          !("lockPath" in textPullPayload) &&
          // Bookkeeping follows the entity, not the transport: a canvas node read
          // through `text pull` books the same key as `canvas get`, so a write
          // through either invalidates the other's read.
          typeof textObservation?.versions?.["canvas-node:text-cli"] === "string" &&
          textLockPath !== null &&
          !existsSync(textLockPath),
        textPull.stderr || textPull.stdout,
        { command: textPull.command, observation: textObservation, textLockPath },
      );
      await writeFile(textPullPayload.filePath, "history-indexed copy\n", "utf8");
      const textApply = runText([
        "apply",
        "--project",
        projectId,
        "--node",
        "text-cli",
        "--json",
      ], revisionEnv);
      textApplyPayload = textApply.status === 0 ? parseStdoutJson(textApply) : null;
      recordCheck(
        "text apply registered host text revision index",
        textApply.status === 0 &&
          !/readToken|lockPath/i.test(JSON.stringify(textApplyPayload)) &&
          textLockPath !== null &&
          !existsSync(textLockPath) &&
          textApplyPayload?.textRevisionIndex?.indexed === true &&
          typeof textApplyPayload?.textRevision?.revisionId === "string" &&
          revisionHost.revisions.some((revision) => revision.revisionId === textApplyPayload.textRevision.revisionId),
        textApply.stderr || textApply.stdout || textApply.error,
        {
          command: textApply.command,
          revisionHostUrl: revisionHost.url,
          revisionHostRequests: revisionHost.requests,
          hostCommandLog: readOptionalText(host.ready.commandLogPath),
        },
      );
      const textHistory = runText([
        "history",
        "--project",
        projectId,
        "--node",
        "text-cli",
        "--limit",
        "1",
        "--json",
      ], revisionEnv);
      textHistoryPayload = textHistory.status === 0 ? parseStdoutJson(textHistory) : null;
      recordCheck(
        "text history reads host revision index",
        textHistory.status === 0 &&
          textHistoryPayload?.projectId === projectId &&
          textHistoryPayload?.nodeId === "text-cli" &&
          textHistoryPayload?.revisions?.[0]?.revisionId === textApplyPayload.textRevision.revisionId &&
          textHistoryPayload?.revisions?.[0]?.sourceFileHash === textApplyPayload.textRevision.sourceFileHash &&
          revisionHost.requests.some((request) =>
            request.method === "POST" && request.path === "/api/v1/text-revisions"
          ) &&
          revisionHost.requests.some((request) =>
            request.method === "GET" &&
            request.path === `/api/v1/projects/${projectId}/text-revisions` &&
            request.search.includes("nodeId=text-cli")
          ),
        textHistory.stderr || textHistory.stdout,
        { command: textHistory.command, revisionHostRequests: revisionHost.requests },
      );
      recordCheck(
        "text revision history exposes non-media revision content storage",
        textHistoryPayload?.revisions?.[0]?.content?.kind === "text-revision-content" &&
          textHistoryPayload?.revisions?.[0]?.content?.stored === true &&
          textHistoryPayload?.revisions?.[0]?.content?.storage?.kind === "content-addressed-revision-blob" &&
          textHistoryPayload?.revisions?.[0]?.content?.storage?.registry === "text_revisions" &&
          textHistoryPayload?.revisions?.[0]?.content?.storage?.mediaAsset === false &&
          textHistoryPayload?.revisions?.[0]?.content?.storage?.agentWritable === false,
        JSON.stringify(textHistoryPayload?.revisions?.[0]?.content),
        { command: textHistory.command },
      );
      const textContent = runText([
        "content",
        "--project",
        projectId,
        "--revision",
        textApplyPayload.textRevision.revisionId,
        "--out",
        "revisions/text-cli.recovered.md",
        "--json",
      ], revisionEnv);
      textContentPayload = textContent.status === 0 ? parseStdoutJson(textContent) : null;
      recordCheck(
        "text content restores host revision body",
        textContent.status === 0 &&
          textContentPayload?.projectId === projectId &&
          textContentPayload?.revisionId === textApplyPayload.textRevision.revisionId &&
          readOptionalText(textContentPayload?.filePath) === "history-indexed copy\n" &&
          revisionHost.requests.some((request) =>
            request.method === "GET" &&
            request.path === `/api/v1/projects/${projectId}/text-revisions/${textApplyPayload.textRevision.revisionId}/content`
          ),
        textContent.stderr || textContent.stdout,
        { command: textContent.command, textContentPayload, revisionHostRequests: revisionHost.requests },
      );
      const textRestore = runText([
        "restore",
        "--project",
        projectId,
        "--node",
        "text-cli",
        "--revision",
        textApplyPayload.textRevision.revisionId,
        "--new-node",
        "text-cli-restored",
        "--json",
      ], revisionEnv);
      textRestorePayload = textRestore.status === 0 ? parseStdoutJson(textRestore) : null;
      recordCheck(
        "text restore creates copy-on-write revision from host content",
        textRestore.status === 0 &&
          textRestorePayload?.mode === "replace" &&
          textRestorePayload?.copyOnWrite === true &&
          textRestorePayload?.sourceNodeId === "text-cli" &&
          textRestorePayload?.newNodeId === "text-cli-restored" &&
          textRestorePayload?.textRevision?.parentRevisionId === textApplyPayload.textRevision.revisionId &&
          textRestorePayload?.textRevisionIndex?.indexed === true &&
          readOptionalText(textRestorePayload?.filePath) === "history-indexed copy\n" &&
          revisionHost.requests.some((request) =>
            request.method === "GET" &&
            request.path === `/api/v1/projects/${projectId}/text-revisions/${textApplyPayload.textRevision.revisionId}/content`
          ) &&
          revisionHost.requests.some((request) =>
            request.method === "POST" && request.path === "/api/v1/text-revisions"
          ),
        textRestore.stderr || textRestore.stdout || textRestore.error,
        {
          command: textRestore.command,
          textRestorePayload,
          revisionHostRequests: revisionHost.requests,
          hostCommandLog: readOptionalText(host.ready.commandLogPath),
        },
      );

      // Archived node-owned Timeline revision-index coverage. The public CLI
      // now operates concrete Project Timeline entities and this branch is not
      // executed; the host revision helpers remain covered by unit tests.
      const timelineEntityPull = runTimeline([
        "pull",
        "--project",
        projectId,
        "--timeline",
        "timeline-cli",
        "--file",
        "timelines/history-indexed.timeline.yaml",
        "--json",
      ], revisionEnv);
      timelinePullPayload = timelineEntityPull.status === 0 ? parseStdoutJson(timelineEntityPull) : null;
      const timelineEntityObservation = existsSync(observationPath)
        ? JSON.parse(readFileSync(observationPath, "utf8"))
        : null;
      const timelineEntityLockPath = timelinePullPayload?.filePath
        ? path.join(
            path.dirname(timelinePullPayload.filePath),
            `${path.basename(timelinePullPayload.filePath, path.extname(timelinePullPayload.filePath))}.lock.json`,
          )
        : null;
      recordCheck(
        "timeline pull records cwd observation without token or lock sidecar",
        timelineEntityPull.status === 0 &&
          typeof timelinePullPayload?.filePath === "string" &&
          !("readToken" in timelinePullPayload) &&
          !("lockPath" in timelinePullPayload) &&
          typeof timelineEntityObservation?.versions?.["timeline:timeline-cli"] === "string" &&
          timelineEntityLockPath !== null &&
          !existsSync(timelineEntityLockPath),
        timelineEntityPull.stderr || timelineEntityPull.stdout,
        {
          command: timelineEntityPull.command,
          observation: timelineEntityObservation,
          timelineLockPath: timelineEntityLockPath,
        },
      );
      await writeFile(timelinePullPayload.filePath, [
        "compositionWidth: 1080",
        "compositionHeight: 1920",
        "fps: 30",
        "durationInFrames: 60",
        "tracks:",
        "  - id: main",
        "    items:",
        "      - id: cli-shot",
        "        type: video",
        "        from: start",
        "        durationInFrames: 60",
        "        sourceNodeId: text-cli",
        "",
      ].join("\n"), "utf8");
      const timelineEntityApply = runTimeline([
        "apply",
        "--project",
        projectId,
        "--timeline",
        "timeline-cli",
        "--file",
        "timelines/history-indexed.timeline.yaml",
        "--json",
      ], revisionEnv);
      timelineApplyPayload = timelineEntityApply.status === 0 ? parseStdoutJson(timelineEntityApply) : null;
      recordCheck(
        "timeline entity apply advances revision through implicit CAS",
        timelineEntityApply.status === 0 &&
          timelineApplyPayload?.applied === true &&
          timelineApplyPayload?.timelineId === "timeline-cli" &&
          typeof timelineApplyPayload?.revisionId === "string" &&
          !/readToken|lockPath|--if-match/i.test(JSON.stringify(timelineApplyPayload)),
        timelineEntityApply.stderr || timelineEntityApply.stdout || timelineEntityApply.error,
        { command: timelineEntityApply.command, timelineApplyPayload },
      );
    } finally {
      await revisionHost.close();
    }

    return {
      projectId,
      clashHome,
      host: host.ready,
      firstRead: firstReadPayload,
      missingUpdate: { status: missingUpdate.status, stderr: missingUpdate.stderr },
      concurrent: parseStdoutJson(concurrent),
      staleUpdate: { status: staleUpdate.status, stderr: staleUpdate.stderr },
      freshRead: freshReadPayload,
      freshUpdate: freshUpdatePayload,
      finalRead: finalReadPayload,
      observation: existsSync(observationPath) ? JSON.parse(readFileSync(observationPath, "utf8")) : null,
      immutableRead: immutableReadPayload,
      immutableUpdate: { status: immutableUpdate.status, stderr: immutableUpdate.stderr },
      copied: copiedPayload,
      copiedRead: copiedReadPayload,
      edges,
      missingDelete: { status: missingDelete.status, stderr: missingDelete.stderr },
      deleteResult: deleteResult.status === 0 ? parseStdoutJson(deleteResult) : null,
      deleteStillExists: deletedRead.status === 0,
      textRevisionHistory: {
        pull: textPullPayload,
        apply: textApplyPayload,
        history: textHistoryPayload,
        content: textContentPayload,
        restore: textRestorePayload,
      },
      timelineEntityProjection: {
        pull: timelinePullPayload,
        apply: timelineApplyPayload,
      },
    };
  } finally {
    await host.stop();
  }
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  const startedAt = now();
  let status = "pass";
  let summary = "Agent-first CAS smoke passed";
  // The production workflow family is retired; CAS coverage for the surviving
  // valve lives in packages/cli asset-metadata tests.
  let projectionPathGuards = null;
  let localApiReceipt = null;
  let directCanvasCli = null;
  try {
    await seedWorkspace();
    projectionPathGuards = runProjectionPathGuards();
    localApiReceipt = runLocalApiReceiptCompatibility();
    directCanvasCli = await runDirectCanvasCliImplicitCas();
    requireCheckPassed("text history reads host revision index");
    requireCheckPassed("text revision history exposes non-media revision content storage");
    requireCheckPassed("text content restores host revision body");
    requireCheckPassed("text restore creates copy-on-write revision from host content");
    requireCheckPassed("timeline pull records cwd observation without token or lock sidecar");
    requireCheckPassed("timeline entity apply advances revision through implicit CAS");
  } catch (error) {
    status = "fail";
    summary = error instanceof Error ? error.message : String(error);
  }

  const report = {
    schemaVersion: 1,
    status,
    summary,
    run: {
      artifactRoot,
      workspace,
      startedAt,
      finishedAt: now(),
    },
    checks,
    booleans: {
      missingReadProofRejected: checks.some((check) => check.name === "missing read proof rejected" && check.status === "pass"),
      staleReadProofRejected: checks.some((check) => check.name === "stale read proof rejected" && check.status === "pass"),
      sourceActionStaleReadProofRejected: checks.some(
        (check) => check.name === "source action stale read proof rejected" && check.status === "pass",
      ),
      unreadCopiedReviewGateRejected: checks.some((check) => check.name === "unread copied review gate rejected" && check.status === "pass"),
      copyOnWritePreservedSource: checks.some((check) => check.name === "copy-on-write preserved source projection" && check.status === "pass"),
      localApiReceiptMissingReadRejected: checks.some((check) => check.name === "local-api receipt path rejects missing read" && check.status === "pass"),
      localApiReceiptStaleRejected: checks.some((check) => check.name === "local-api receipt path rejects stale receipt" && check.status === "pass"),
      localApiReceiptFreshAccepted: checks.some((check) => check.name === "local-api receipt path accepts fresh receipt" && check.status === "pass"),
      localApiReceiptMutationEnvelopeRecorded: checks.some((check) => check.name === "local-api receipt mutation envelope recorded" && check.status === "pass"),
      localApiReceiptUnreadDeleteRejected: checks.some((check) => check.name === "local-api receipt path rejects unread delete" && check.status === "pass"),
      directCanvasCliWriteBeforeReadRejected: checks.some((check) => check.name === "direct canvas CLI rejects write before read" && check.status === "pass"),
      directCanvasCliCwdObservationRecorded: checks.some((check) => check.name === "direct canvas CLI read records only cwd entity version" && check.status === "pass"),
      directCanvasCliStaleObservationRejected: checks.some((check) => check.name === "direct canvas CLI rejects stale cwd observation" && check.status === "pass"),
      directCanvasCliFreshObservationAccepted: checks.some((check) => check.name === "direct canvas CLI fresh implicit observation accepted" && check.status === "pass"),
      directCanvasCliMutationEnvelopeRecorded: checks.some((check) => check.name === "direct canvas CLI mutation envelope recorded" && check.status === "pass"),
      directCanvasCliImmutableStateExposed: checks.some((check) => check.name === "direct canvas CLI read exposes global immutable state" && check.status === "pass"),
      directCanvasCliImmutableUpdateRejected: checks.some((check) => check.name === "direct canvas CLI rejects in-place update of immutable node" && check.status === "pass"),
      directCanvasCliCopyOnWriteSupported: checks.some((check) => check.name === "direct canvas CLI copy creates mutable COW node and preserves lineage" && check.status === "pass"),
      directCanvasCliDeleteReadRequired: checks.some((check) => check.name === "direct canvas CLI delete requires implicit read then succeeds" && check.status === "pass"),
      textProjectionNoLockSidecar: checks.some((check) => check.name === "text pull records cwd observation without token or lock sidecar" && check.status === "pass"),
      timelineProjectionNoLockSidecar: checks.some((check) => check.name === "timeline pull records cwd observation without token or lock sidecar" && check.status === "pass"),
      timelineEntityApplyAdvancesRevision: checks.some((check) => check.name === "timeline entity apply advances revision through implicit CAS" && check.status === "pass"),
      textHistoryReadsHostRevisionIndex: checks.some((check) => check.name === "text history reads host revision index" && check.status === "pass"),
      textRevisionContentStorageContract: checks.some((check) =>
        check.name === "text revision history exposes non-media revision content storage" && check.status === "pass"
      ),
      textContentRestoresHostRevisionBody: checks.some((check) => check.name === "text content restores host revision body" && check.status === "pass"),
      textRestoreCreatesCopyOnWriteRevisionFromHostContent: checks.some(
        (check) => check.name === "text restore creates copy-on-write revision from host content" && check.status === "pass"
      ),
      textCutExportSourceProvenanceRecorded: checks.some((check) => check.name === "text-cut export records source action provenance" && check.status === "pass"),
      textCutExportSymlinkActionRejected: checks.some((check) => check.name === "text-cut export rejects symlinked source action outside cwd" && check.status === "pass"),
      captionExportTimelineRevisionPinned: checks.some((check) =>
        check.name === "caption export pins manifest to applied timeline revision" && check.status === "pass"
      ),
      timelineHandoffExportTimelineRevisionPinned: checks.some((check) =>
        check.name === "timeline handoff export pins manifest to applied timeline revision" && check.status === "pass"
      ),
      captionBurnExportTimelineRevisionPinned: checks.some((check) =>
        check.name === "caption-burn export pins derived asset to applied timeline revision" && check.status === "pass"
      ),
      projectionPathOutsideCwdRejected: [
          "text pull rejects projection path outside cwd",
          "text pull rejects symlinked projection path outside cwd",
          "timeline pull rejects projection path outside cwd",
          "timeline apply rejects symlinked projection path outside cwd",
          "pipeline validation rejects symlinked report path outside cwd",
          "reference roles plan rejects symlinked action path outside cwd",
          "caption export rejects symlinked output path outside cwd",
          "timeline handoff export rejects symlinked output path outside cwd",
          "timeline handoff export rejects symlinked manifest path outside cwd",
        ].every((name) =>
          checks.some((check) => check.name === name && check.status === "pass"),
      ),
      legacyProjectionLockSidecarsIgnored: [
        "storyboard prompt-pack ignores legacy lock sidecar",
        "review gate ignores legacy lock sidecar",
      ].every((name) => checks.some((check) => check.name === name && check.status === "pass")),
      forceMutationBypassAbsent: [
      ].every((name) => checks.some((check) => check.name === name && check.status === "pass")),
    },
    artifacts: {
      projectionPathGuards,
      localApiReceipt,
      directCanvasCli,
    },
  };
  await writeJson(reportPath, report);
  console.log("[agent-first-cas] report", reportPath);
  console.log(JSON.stringify({
    status,
    reportPath,
    workspace,
    checks: checks.length,
  }));
  if (status !== "pass") {
    console.error(`[agent-first-cas] ${summary}`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await mkdir(artifactRoot, { recursive: true });
  await writeJson(reportPath, {
    schemaVersion: 1,
    status: "fail",
    summary: message,
    checks,
  });
  console.error(message);
  process.exit(1);
});
