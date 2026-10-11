#!/usr/bin/env node
// Acceptance smoke for a self-contained Clash archive. It imports only Node
// built-ins so the archive's own Node can run it on a machine without Node:
//
//   <root>/node/bin/node smoke-self-contained.ts --root <root> --require-no-system-node
//
// `--container <image> --archive <tgz>` wraps that in a fresh container, where
// the archive is unpacked and `command -v node` is asserted to fail first.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const windows = process.platform === "win32";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke failed: ${message}`);
}

const pass = (message: string) => console.log(`ok - ${message}`);

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Every `node` an unqualified lookup could find on PATH. */
function systemNodes(env: NodeJS.ProcessEnv): string[] {
  const names = windows ? ["node.exe", "node.cmd", "node.bat"] : ["node"];
  return (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)))
    .filter((candidate) => existsSync(candidate));
}

/**
 * A Host that dies before readiness reports only "exited before becoming
 * ready"; what killed it is in the logs it left under its CLASH_HOME.
 */
async function printHostLogs(home: string): Promise<void> {
  const logs = join(home, "logs");
  const files = (await readdir(logs, { recursive: true }).catch(() => [] as string[])).sort();
  if (files.length === 0) console.error(`--- no Host logs under ${logs}`);
  for (const file of files) {
    const path = join(logs, file);
    if (!(await stat(path)).isFile()) continue;
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    console.error(`--- ${path} (last ${Math.min(lines.length, 80)} of ${lines.length} line(s))`);
    console.error(lines.slice(-80).join("\n"));
  }
}

async function runContainer(image: string, archive: string): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  const engine = process.env.CLASH_CONTAINER_ENGINE ?? "docker";
  const inner = [
    "set -eu",
    'if command -v node >/dev/null 2>&1; then echo "smoke failed: the image has node on PATH" >&2; exit 1; fi',
    'echo "ok - image has no node on PATH"',
    "mkdir /opt/clash",
    "tar -xzf /artifact/archive.tgz -C /opt/clash",
    "exec /opt/clash/package/node/bin/node /smoke/smoke-self-contained.ts --root /opt/clash/package --require-no-system-node",
  ].join("\n");
  const child = spawn(engine, [
    "run", "--rm", "--network", "none",
    "--volume", `${resolve(archive)}:/artifact/archive.tgz:ro`,
    "--volume", `${dirname(script)}:/smoke:ro`,
    image, "sh", "-c", inner,
  ], { stdio: "inherit" });
  const code = await new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("close", done);
  });
  check(code === 0, `container smoke exited ${code}`);
}

type Manifest = {
  package: { version: string };
  platform: string;
  arch: string;
  launcher: string;
  node: { version: string; path: string; sha256: string };
  media: Record<"ffmpeg" | "ffprobe", { path: string; sha256: string }>;
};

async function runSmoke(root: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, "self-contained.json"), "utf8")) as Manifest;
  const bundledNode = join(root, ...manifest.node.path.split("/"));
  const launcher = join(root, ...manifest.launcher.split("/"));
  // macOS caps Unix socket paths near 104 bytes; its per-user temp directory is too deep.
  // Canonical like `root`: the CLI and Host see their cwd as a real path.
  const scratch = realpathSync.native(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "clash-smoke-")));
  const hosts: string[] = [];
  let reportFailures = true;
  // Nothing below may reach a Node other than the bundled one.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !name.startsWith("CLASH_") && !name.startsWith("NODE_") && !name.startsWith("npm_"))),
    CLASH_PROFILE: "prod",
  };
  const clash = async (home: string, cwd: string, args: string[]) => {
    const options = { cwd, env: { ...env, CLASH_HOME: home }, maxBuffer: 16 * 1024 * 1024 };
    // A .cmd launcher has to go through the command interpreter.
    try {
      const { stdout } = windows
        ? await execute(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", launcher, ...args], options)
        : await execute(launcher, args, options);
      return stdout;
    } catch (error) {
      if (reportFailures) {
        console.error(`--- clash ${args.join(" ")} failed (exit ${(error as { code?: unknown }).code})`);
        await printHostLogs(home).catch((failure) => console.error(`--- reading Host logs failed: ${failure}`));
      }
      throw error;
    }
  };
  try {
    check(process.platform === manifest.platform && process.arch === manifest.arch,
      `archive targets ${manifest.platform}-${manifest.arch}, not ${process.platform}-${process.arch}`);
    // process.execPath is a real path, while macOS /tmp is a symlink and Windows temp may be an 8.3 name.
    check(realpathSync.native(process.execPath) === realpathSync.native(bundledNode),
      `smoke must run on the bundled Node ${bundledNode}, not ${process.execPath}`);
    check(process.version === `v${manifest.node.version}`, `bundled Node reports ${process.version}`);
    check((await sha256(bundledNode)) === manifest.node.sha256, "bundled Node differs from its manifest digest");
    pass(`bundled Node ${process.version} matches the manifest digest`);
    if (process.argv.includes("--require-no-system-node")) {
      const found = systemNodes(env);
      check(found.length === 0, `PATH still resolves a system node: ${found.join(", ")}`);
      pass("no node is resolvable on PATH");
    }

    check((await clash(join(scratch, "home-version"), scratch, ["--version"])).trim() === manifest.package.version, "--version mismatch");
    check((await clash(join(scratch, "home-version"), scratch, ["--help"])).includes("workspace"), "--help lacks the workspace command");
    pass(`launcher reports version ${manifest.package.version} and help`);

    // Media binaries: version, then a real encode and probe.
    const ffmpeg = join(root, ...manifest.media.ffmpeg.path.split("/"));
    const ffprobe = join(root, ...manifest.media.ffprobe.path.split("/"));
    for (const [tool, path, digest] of [["ffmpeg", ffmpeg, manifest.media.ffmpeg.sha256], ["ffprobe", ffprobe, manifest.media.ffprobe.sha256]] as const) {
      check((await sha256(path)) === digest, `${tool} differs from its manifest digest`);
      const { stdout } = await execute(path, ["-version"], { env });
      check(stdout.startsWith(`${tool} version`), `${tool} -version printed ${stdout.slice(0, 40)}`);
      pass(stdout.split("\n")[0]!.trim());
    }
    const sourceWorkspace = join(scratch, "source");
    await mkdir(sourceWorkspace);
    const image = join(sourceWorkspace, "frame.png");
    const clip = join(scratch, "clip.mp4");
    await execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5", "-frames:v", "1", image], { env });
    await execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5", "-t", "1", "-c:v", "mpeg4", clip], { env });
    const probed = JSON.parse((await execute(ffprobe, ["-v", "error", "-show_streams", "-of", "json", clip], { env })).stdout) as {
      streams: Array<{ codec_name?: string; width?: number; height?: number }>;
    };
    check(probed.streams[0]?.codec_name === "mpeg4" && probed.streams[0].width === 64 && probed.streams[0].height === 48,
      `ffprobe read ${JSON.stringify(probed.streams[0])}`);
    pass("ffmpeg encoded and ffprobe read a 64x48 mpeg4 clip");

    // Workspace round trip across two independent Hosts.
    const homeA = join(scratch, "home-a");
    const homeB = join(scratch, "home-b");
    hosts.push(homeA, homeB);
    const initialized = JSON.parse(await clash(homeA, sourceWorkspace, ["init", "--json"])) as { projectId: string };
    const imported = JSON.parse(await clash(homeA, sourceWorkspace, ["assets", "import", "--file", image, "--json"])) as {
      registration?: { metadata?: { width?: number; height?: number } };
    };
    check(imported.registration?.metadata?.width === 64 && imported.registration.metadata.height === 48,
      "asset import did not read the image dimensions");
    const bundle = join(scratch, "bundle");
    const exported = JSON.parse(await clash(homeA, sourceWorkspace, ["workspace", "export", "--out", bundle, "--json"])) as { bundleDigest: string };
    const inspected = JSON.parse(await clash(homeA, scratch, ["workspace", "inspect", bundle, "--json"])) as { valid: boolean };
    check(inspected.valid === true, "exported bundle failed offline inspection");
    const targetWorkspace = join(scratch, "target");
    const restored = JSON.parse(await clash(homeB, scratch, ["workspace", "import", bundle, "--into", targetWorkspace, "--json"])) as {
      status: string; bundleDigest: string; projectId: string;
    };
    check(restored.status === "committed" && restored.bundleDigest === exported.bundleDigest && restored.projectId === initialized.projectId,
      `workspace import returned ${JSON.stringify(restored)}`);
    check((await sha256(join(targetWorkspace, "frame.png"))) === (await sha256(image)), "imported workspace file differs");
    const listed = JSON.parse(await clash(homeB, targetWorkspace, ["ls", "--json"])) as { countsByKind: { image: number } };
    check(listed.countsByKind.image === 1, "imported Host does not list the image asset");
    const secondBundle = join(scratch, "bundle-again");
    await clash(homeB, targetWorkspace, ["workspace", "export", "--out", secondBundle, "--json"]);
    const objects = async (path: string) => (await readdir(join(path, "objects", "sha256"))).sort().join(",");
    check((await objects(bundle)) === (await objects(secondBundle)), "re-exported bundle carries different asset objects");
    pass(`workspace export -> import -> export preserved bundle ${exported.bundleDigest.slice(0, 12)} and its asset objects`);

    // stdio MCP, launched the way the package's own .mcp.json declares it.
    const declared = (JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: { clash: { command: string; args: string[]; env?: Record<string, string> } };
    }).mcpServers.clash;
    const tools = await mcpToolNames(declared, root, { ...env, ...declared.env, CLASH_HOME: homeA });
    check(tools.length > 0, "MCP tools/list returned no tools");
    pass(`MCP initialize and tools/list returned ${tools.length} tool(s): ${tools.slice(0, 5).join(", ")}`);
    console.log("self-contained smoke passed");
  } finally {
    // A home that never started a Host fails `host status` by design.
    reportFailures = false;
    for (const home of hosts) {
      try {
        const status = JSON.parse(await clash(home, scratch, ["host", "status", "--json"])) as { pid?: number };
        if (status.pid) process.kill(status.pid);
      } catch {
        // No Host was started for this home.
      }
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

async function mcpToolNames(
  server: { command: string; args: string[] },
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const child = spawn(server.command, server.args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  const responses = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let buffered = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (typeof message.id === "number") responses.get(message.id)?.(message);
    }
  });
  const exited = new Promise<never>((_, fail) => {
    child.once("error", fail);
    child.once("close", (code) => fail(new Error(`MCP runtime exited ${code} before answering`)));
  });
  exited.catch(() => undefined);
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const request = (id: number, method: string, params: object) => {
    const answered = new Promise<{ result?: unknown; error?: unknown }>((done) => responses.set(id, done));
    send({ id, method, params });
    const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`MCP ${method} timed out`)), 120_000).unref());
    return Promise.race([answered, exited, timeout]);
  };
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clash-self-contained-smoke", version: "1" },
    });
    check(!initialized.error && (initialized.result as { serverInfo?: unknown }).serverInfo, `MCP initialize failed: ${JSON.stringify(initialized.error)}`);
    send({ method: "notifications/initialized" });
    const listed = await request(2, "tools/list", {});
    check(!listed.error, `MCP tools/list failed: ${JSON.stringify(listed.error)}`);
    return (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

const container = option("--container");
if (container) {
  const archive = option("--archive");
  check(archive && basename(archive).endsWith(".tgz"), "--container needs --archive <self-contained .tgz>");
  await runContainer(container, archive);
} else {
  const root = option("--root");
  check(root, "pass --root <unpacked package directory>");
  // The launcher resolves its own root physically (`pwd -P`); compare like with like.
  await runSmoke(realpathSync.native(resolve(root)));
}
