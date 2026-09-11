import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";

import {
  createQualityReviewResult,
  QualityJudgeResponseSchema,
} from "./quality-review";
import type {
  ArtifactEvidence,
  CodexQualityReviewer,
  QualityReviewRequest,
  QualityReviewResult,
} from "./types";

const FORBIDDEN_REVIEWER_ARGS = new Set([
  "-m",
  "--model",
  "--oss",
  "--local-provider",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "-i",
  "--image",
  "--output-schema",
  "--output-last-message",
  "--dangerously-bypass-approvals-and-sandbox",
]);

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);

export function codexQualityJudgeSupportsRequest(
  request: QualityReviewRequest,
): boolean {
  const artifactsById = new Map(
    request.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  return request.criteria.every((criterion) =>
    criterion.evidenceArtifactIds.every(
      (artifactId) => artifactsById.get(artifactId)?.kind === "image",
    ),
  );
}

export function sanitizeQualityReviewerEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (/^CLASH_/iu.test(key)) delete environment[key];
  }
  if (environment.PATH !== undefined) {
    environment.PATH = environment.PATH.split(delimiter)
      .filter((entry) => entry && !entry.includes("node_modules/.bin"))
      .join(delimiter);
  }
  return environment;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

function assertReviewerArgs(args: string[]): void {
  for (const argument of args) {
    const flag = argument.split("=", 1)[0]!;
    if (FORBIDDEN_REVIEWER_ARGS.has(flag)) {
      throw new Error(
        `Codex quality reviewer argument '${flag}' would override the locked read-only invocation`,
      );
    }
  }
}

export function buildCodexQualityJudgeInvocation(input: {
  reviewer: CodexQualityReviewer;
  workingDirectory: string;
  outputSchemaPath: string;
  outputResponsePath: string;
  imagePaths: string[];
  prompt: string;
}): { command: string; args: string[] } {
  if (input.reviewer.provider !== "openai" || !input.reviewer.model.trim()) {
    throw new Error(
      "Codex quality review requires explicit provider=openai and an explicit model",
    );
  }
  const reviewerArgs = input.reviewer.args ?? [];
  assertReviewerArgs(reviewerArgs);
  const args = [
    "exec",
    input.prompt,
    ...reviewerArgs,
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.remote_plugin=false",
    "-c",
    "features.recommended_plugins=false",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    input.reviewer.model,
    "--output-schema",
    input.outputSchemaPath,
    "--output-last-message",
    input.outputResponsePath,
    "--cd",
    input.workingDirectory,
  ];
  for (const imagePath of input.imagePaths) {
    args.push("--image", imagePath);
  }
  return { command: input.reviewer.command ?? "codex", args };
}

export function renderQualityJudgePrompt(
  request: QualityReviewRequest,
): string {
  const criteria = request.criteria
    .map(
      (criterion) =>
        `- ${criterion.id} (weight ${criterion.weight}): ${criterion.description}`,
    )
    .join("\n");
  const artifacts = request.artifacts
    .map(
      (artifact) =>
        `- ${artifact.id} (${artifact.kind}, ${artifact.bytes} bytes, sha256 ${artifact.sha256})`,
    )
    .join("\n");
  return `You are an independent content-effect judge. Judge semantic and creative effectiveness, not merely file validity. Use only the attached images and the public evidence below. Do not invoke tools, commands, MCP servers, Clash, or the filesystem. Return only JSON matching the supplied output schema.

Benchmark: ${request.benchmarkId}
Request SHA-256: ${request.requestSha256}
Objective: ${request.objective}
Pass threshold: ${request.passThreshold}/100

Exact criteria:
${criteria}

Bound artifact evidence (attached images follow this identity set):
${artifacts}

Score every criterion from 0 to 100 and give a concise evidence-based rationale. Preserve every criterion id exactly and in the listed order. Do not infer that technical validity implies semantic quality.`;
}

function assertToolFreeCodexEvents(rawEvents: string): void {
  for (const [index, line] of rawEvents.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `Codex quality reviewer emitted invalid JSONL at event ${index + 1}`,
      );
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(
        `Codex quality reviewer emitted an invalid event at ${index + 1}`,
      );
    }
    const record = event as { type?: unknown; item?: unknown };
    if (record.type === "error" || record.type === "turn.failed") {
      throw new Error("Codex quality reviewer lifecycle failed");
    }
    if (
      (record.type === "item.started" || record.type === "item.completed") &&
      record.item &&
      typeof record.item === "object" &&
      !Array.isArray(record.item)
    ) {
      const itemType = (record.item as { type?: unknown }).type;
      if (
        typeof itemType === "string" &&
        (TOOL_ITEM_TYPES.has(itemType) ||
          (itemType !== "reasoning" &&
            itemType !== "agent_message" &&
            itemType !== "error"))
      ) {
        throw new Error(
          `The read-only evidence judge attempted a tool operation (${itemType})`,
        );
      }
    }
  }
}

export function parseCodexQualityJudgeResponse(input: {
  request: QualityReviewRequest;
  reviewer: CodexQualityReviewer;
  adapterVersion: string;
  prompt: string;
  rawResponse: string;
  rawEvents: string;
}): QualityReviewResult {
  assertToolFreeCodexEvents(input.rawEvents);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawResponse) as unknown;
  } catch {
    throw new Error("Codex quality reviewer response is not valid JSON");
  }
  const response = QualityJudgeResponseSchema.parse(parsed);
  return createQualityReviewResult({
    request: input.request,
    reviewer: {
      kind: "codex",
      provider: input.reviewer.provider,
      model: input.reviewer.model,
      adapterVersion: input.adapterVersion,
    },
    response,
    prompt: input.prompt,
    rawResponse: input.rawResponse,
  });
}

function qualityJudgeOutputSchema(request: QualityReviewRequest): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "criteria", "overallRationale"],
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      criteria: {
        type: "array",
        minItems: request.criteria.length,
        maxItems: request.criteria.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "score", "rationale"],
          properties: {
            id: {
              type: "string",
              enum: request.criteria.map(({ id }) => id),
            },
            score: { type: "number", minimum: 0, maximum: 100 },
            rationale: { type: "string", minLength: 1 },
          },
        },
      },
      overallRationale: { type: "string", minLength: 1 },
    },
  };
}

async function runProcess(input: {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(input.command, input.args, {
      env: input.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectProcess(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        rejectProcess(new Error("Codex quality reviewer timed out"));
        return;
      }
      resolveProcess({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function verifiedImagePaths(input: {
  request: QualityReviewRequest;
  evidence: ArtifactEvidence[];
  workspace: string;
}): Promise<string[]> {
  const canonicalWorkspace = await realpath(input.workspace);
  const evidenceById = new Map(
    input.evidence.map((artifact) => [artifact.id, artifact]),
  );
  const images: string[] = [];
  for (const binding of input.request.artifacts) {
    if (binding.kind !== "image") continue;
    const evidence = evidenceById.get(binding.id);
    if (
      !evidence ||
      evidence.kind !== binding.kind ||
      evidence.bytes !== binding.bytes ||
      evidence.sha256 !== binding.sha256
    ) {
      throw new Error(
        `Quality judge image '${binding.id}' does not match evaluated artifact evidence`,
      );
    }
    const path = join(canonicalWorkspace, evidence.path);
    const pathInfo = await lstat(path);
    const canonicalPath = await realpath(path);
    const canonicalInfo = await stat(canonicalPath);
    if (
      !isInside(canonicalWorkspace, canonicalPath) ||
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      !canonicalInfo.isFile() ||
      pathInfo.nlink !== 1 ||
      canonicalInfo.size !== binding.bytes ||
      (await hashFile(canonicalPath)) !== binding.sha256
    ) {
      throw new Error(
        `Quality judge image '${binding.id}' failed exact SHA-256 readback`,
      );
    }
    images.push(canonicalPath);
  }
  return images;
}

function reviewerEnvironment(
  reviewer: CodexQualityReviewer,
): NodeJS.ProcessEnv {
  const combined =
    reviewer.inheritEnv === false
      ? { ...(reviewer.env ?? {}) }
      : { ...process.env, ...(reviewer.env ?? {}) };
  return sanitizeQualityReviewerEnvironment(combined);
}

export async function runCodexQualityJudge(input: {
  reviewer: CodexQualityReviewer;
  request: QualityReviewRequest;
  evidence: ArtifactEvidence[];
  workspace: string;
  caseRoot: string;
}): Promise<QualityReviewResult | undefined> {
  if (!codexQualityJudgeSupportsRequest(input.request)) return undefined;
  const imagePaths = await verifiedImagePaths(input);
  if (imagePaths.length === 0) return undefined;

  const privateRoot = join(input.caseRoot, "quality-review-private");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const outputSchemaPath = join(privateRoot, "output-schema.json");
  const outputResponsePath = join(privateRoot, "response.json");
  const eventsPath = join(privateRoot, "events.jsonl");
  const stderrPath = join(privateRoot, "stderr.log");
  await writeFile(
    outputSchemaPath,
    `${JSON.stringify(qualityJudgeOutputSchema(input.request), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const prompt = renderQualityJudgePrompt(input.request);
  const invocation = buildCodexQualityJudgeInvocation({
    reviewer: input.reviewer,
    workingDirectory: privateRoot,
    outputSchemaPath,
    outputResponsePath,
    imagePaths,
    prompt,
  });
  const environment = reviewerEnvironment(input.reviewer);
  const version = await runProcess({
    command: invocation.command,
    args: ["--version"],
    environment,
    timeoutMs: 10_000,
  });
  const adapterVersion = version.stdout.trim();
  if (
    version.exitCode !== 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._:+@-]{0,199}$/u.test(adapterVersion)
  ) {
    throw new Error("Codex quality reviewer version could not be verified");
  }
  const run = await runProcess({
    command: invocation.command,
    args: invocation.args,
    environment,
    timeoutMs: input.reviewer.timeoutMs ?? 5 * 60_000,
  });
  await Promise.all([
    writeFile(eventsPath, run.stdout, { encoding: "utf8", mode: 0o600 }),
    writeFile(stderrPath, run.stderr, { encoding: "utf8", mode: 0o600 }),
  ]);
  if (run.exitCode !== 0) {
    throw new Error(
      `Codex quality reviewer failed (stderr sha256 ${sha256(run.stderr)})`,
    );
  }
  const rawResponse = await readFile(outputResponsePath, "utf8");
  return parseCodexQualityJudgeResponse({
    request: input.request,
    reviewer: input.reviewer,
    adapterVersion,
    prompt,
    rawResponse,
    rawEvents: run.stdout,
  });
}
