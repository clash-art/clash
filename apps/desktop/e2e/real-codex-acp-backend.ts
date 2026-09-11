import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assistantTextFromEvents,
  diagnosticTextFromEvents,
} from "./real-codex-transcript.ts";

if (process.env.CLASH_E2E_REAL_CODEX !== "1") {
  throw new Error("Refusing to run the real Codex ACP backend smoke without CLASH_E2E_REAL_CODEX=1");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const runRoot = path.join(repoRoot, ".tmp", "real-codex-acp-backend");
const projectCwd = path.join(runRoot, "project");
const transcriptFile = path.join(runRoot, "transcript.json");
const acpBinDir = process.env.CLASH_ACP_BIN_DIR ?? path.join(desktopDir, "build", "acp-bin");
const codexHome = process.env.CLASH_REAL_CODEX_HOME ?? path.join("/private/tmp", `clash-real-codex-home-${process.pid}`);
const sourceCodexDir = path.join(process.env.HOME ?? "", ".codex");
const tempCodexDir = path.join(codexHome, ".codex");
const codexHomeFiles = ["auth.json", "config.toml", "installation_id", "models_cache.json"];

function isToolEvent(event) {
  const encoded = JSON.stringify(event);
  return /tool[_-]?call|execute|shell|command|pwd/i.test(encoded);
}

function hasProjectPath(text) {
  return text.includes(projectCwd);
}

function looksLikeNetworkFailure(diagnostics) {
  return diagnostics.some((line) =>
    /failed to lookup address|nodename nor servname|error sending request|backend-api\/codex\/responses|Falling back from WebSockets/i.test(line),
  );
}

function redactSensitiveText(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/("?(?:access|refresh|id)_?token"?\s*[:=]\s*)"[^"]+"/gi, "$1\"[redacted]\"")
    .replace(/("?(?:authorization|cookie)"?\s*[:=]\s*)"[^"]+"/gi, "$1\"[redacted]\"");
}

function redactForTranscript(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactForTranscript);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        /token|authorization|cookie/i.test(key) ? "[redacted]" : redactForTranscript(nested),
      ]),
    );
  }
  return value;
}

async function copyCodexAuthContext() {
  await rm(codexHome, { recursive: true, force: true });
  await mkdir(tempCodexDir, { recursive: true });
  for (const file of codexHomeFiles) {
    const source = path.join(sourceCodexDir, file);
    try {
      await access(source);
      await cp(source, path.join(tempCodexDir, file), { force: true });
    } catch {
      // API-key based runs do not need local Codex auth files.
    }
  }
}

async function main() {
  const { AcpRuntimeImpl, NodeSpawner, detect } = await import(
    pathToFileURL(path.join(repoRoot, "packages", "cli", "dist", "acp-runtime.mjs")).href
  );

  await rm(runRoot, { recursive: true, force: true });
  await mkdir(path.join(projectCwd, ".clash"), { recursive: true });
  await copyCodexAuthContext();
  await writeFile(
    path.join(projectCwd, ".clash", "project.toml"),
    [
      "schema_version = 1",
      'project_id = "local_real_codex_backend_smoke"',
      'store = "managed"',
      "",
    ].join("\n"),
    "utf8",
  );

  const agent = await detect("codex-acp", {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLASH_ACP_BIN_DIR: acpBinDir,
    },
  });
  if (!agent) {
    throw new Error(`Built-in codex-acp was not detected in ${acpBinDir}`);
  }

  const diagnostics = [];
  const runtime = new AcpRuntimeImpl(new NodeSpawner());
  const session = await runtime.start({
    agent: {
      ...agent.spec,
      cwd: projectCwd,
      env: {
        ...(agent.spec.env ?? {}),
        HOME: codexHome,
      },
      onDiagnosticLine: (line) => diagnostics.push(line),
    },
    perTurnTimeoutMs: Number(process.env.CLASH_REAL_CODEX_TURN_TIMEOUT_MS ?? 240000),
    idleTimeoutMs: 0,
  });

  const events = [];
  const prompt = "Run `pwd` with your shell tool, then answer with only the absolute path.";
  try {
    for await (const event of session.prompt(prompt)) {
      events.push(event);
    }
  } finally {
    await session.dispose();
  }

  const assistantText = assistantTextFromEvents(events);
  const diagnosticText = diagnosticTextFromEvents(events);
  const transcript = {
    agentCommand: agent.spec.command,
    acpSessionId: session.acpSessionId,
    projectCwd,
    prompt,
    diagnostics: redactForTranscript(diagnostics),
    events: redactForTranscript(events),
    assistantText: redactSensitiveText(assistantText),
    diagnosticText: redactSensitiveText(diagnosticText),
  };
  await writeFile(transcriptFile, JSON.stringify(transcript, null, 2), "utf8");

  const toolEvents = events.filter(isToolEvent);
  const promptComplete = events.find((event) => event?.type === "promptComplete");
  const promptError = events.find((event) => event?.type === "promptError");
  const evidenceText = `${assistantText}\n${JSON.stringify(events)}`;

  if (promptError) {
    if (looksLikeNetworkFailure(diagnostics)) {
      throw new Error(
        `Codex ACP reached the real transport but the network request failed in this environment.\n` +
          `Prompt error: ${JSON.stringify(promptError)}\n` +
          `Transcript: ${transcriptFile}`,
      );
    }
    throw new Error(`Codex ACP prompt failed: ${JSON.stringify(promptError)}\nTranscript: ${transcriptFile}`);
  }
  if (!promptComplete) {
    throw new Error(`Codex ACP prompt did not complete\nTranscript: ${transcriptFile}`);
  }
  if (toolEvents.length === 0) {
    throw new Error(`Codex ACP did not emit a visible tool/shell event for pwd\nTranscript: ${transcriptFile}`);
  }
  if (!hasProjectPath(evidenceText)) {
    throw new Error(`Codex ACP final/tool output did not include expected cwd ${projectCwd}\nTranscript: ${transcriptFile}`);
  }

  console.log("[real-codex-acp-backend] ok", JSON.stringify({
    acpSessionId: session.acpSessionId,
    projectCwd,
    transcriptFile,
    toolEventCount: toolEvents.length,
    diagnosticCount: diagnostics.length,
    assistantText: assistantText.slice(0, 500),
  }));

  if (process.env.CLASH_REAL_CODEX_KEEP_HOME !== "1") {
    await rm(codexHome, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  if (process.env.CLASH_REAL_CODEX_KEEP_HOME !== "1") {
    await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
