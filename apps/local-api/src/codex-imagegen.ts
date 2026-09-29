import { execFile } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";

import type { ExecutablePluginAssetHandle } from "@clash/shared-types";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function isCompletePng(bytes: Buffer): boolean {
  return (
    bytes.byteLength >= PNG_SIGNATURE.byteLength + PNG_IEND.byteLength &&
    bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) &&
    bytes.subarray(-PNG_IEND.byteLength).equals(PNG_IEND)
  );
}

export interface CodexImageGeneratorInput {
  prompt: string;
  aspectRatio: string;
  references: Array<{
    asset: ExecutablePluginAssetHandle;
    mediaType?: string;
    bytes: Uint8Array;
  }>;
}

export interface CodexImageGeneratorOutput {
  mediaType: "image/png";
  bytes: Uint8Array;
}

interface CodexExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  completionPath: string;
}

interface CodexStatusExecOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}

export interface CodexImageGeneratorOptions {
  codexPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: (
    file: string,
    args: string[],
    options: CodexExecOptions,
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface CodexImageGeneratorPreflightOptions
  extends CodexImageGeneratorOptions {
  statusTimeoutMs?: number;
  statusExec?: (
    file: string,
    args: string[],
    options: CodexStatusExecOptions,
  ) => Promise<{ stdout: string; stderr: string }>;
}

export type CodexImageGeneratorPreflightResult =
  | {
      available: true;
      codexPath: string;
      generate: ReturnType<typeof createCodexImageGenerator>;
    }
  | {
      available: false;
      reason: "cli-not-found" | "not-logged-in" | "login-check-failed";
    };

function executableNames() {
  return process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex"]
    : ["codex"];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexCli(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.CODEX_BIN) {
    const configured = resolve(env.CODEX_BIN);
    return isExecutableFile(configured) ? configured : null;
  }
  const candidates =
    process.platform === "darwin"
      ? [
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          "/Applications/Codex.app/Contents/Resources/codex",
        ]
      : [];
  const installed = candidates.find((candidate) => isExecutableFile(candidate));
  if (installed) return installed;
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames()) {
      const candidate = resolve(directory, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function defaultStatusExec(
  file: string,
  args: string[],
  options: CodexStatusExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(
      file,
      args,
      {
        ...options,
        encoding: "utf8" as const,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectRun(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolveRun({ stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

function failedLoginStatusReason(
  error: unknown,
): "not-logged-in" | "login-check-failed" {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === 1
  ) {
    return "not-logged-in";
  }
  return "login-check-failed";
}

/**
 * Resolve and authenticate Codex once at Host startup.
 *
 * The returned generator is pinned to the validated absolute executable path. Failures are
 * deliberately data, not startup errors: Codex ImageGen is an optional local capability.
 */
export async function preflightCodexImageGenerator(
  options: CodexImageGeneratorPreflightOptions = {},
): Promise<CodexImageGeneratorPreflightResult> {
  const environment = options.env ?? process.env;
  const codexPath = options.codexPath
    ? resolveCodexCli({ ...environment, CODEX_BIN: options.codexPath })
    : resolveCodexCli(environment);
  if (!codexPath) return { available: false, reason: "cli-not-found" };

  const statusExec = options.statusExec ?? defaultStatusExec;
  try {
    await statusExec(codexPath, ["login", "status"], {
      env: environment,
      timeout: options.statusTimeoutMs ?? 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    return { available: false, reason: failedLoginStatusReason(error) };
  }

  return {
    available: true,
    codexPath,
    generate: createCodexImageGenerator({
      codexPath,
      env: environment,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.exec ? { exec: options.exec } : {}),
    }),
  };
}

function referenceExtension(
  mediaType: string | undefined,
  asset: ExecutablePluginAssetHandle,
) {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  if (mediaType === "image/heic") return ".heic";
  const uriExtension = extname(asset.uri).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".heic"].includes(uriExtension)
    ? uriExtension
    : ".png";
}

function codexPrompt(
  input: CodexImageGeneratorInput,
  outputPath: string,
): string {
  const referenceGuidance =
    input.references.length > 0
      ? `Use the ${input.references.length} attached image(s) as reference or edit inputs, following the user's request.`
      : "Create a new image from the user's request.";
  return [
    "Use Codex's built-in imagegen skill and the built-in image_gen tool.",
    "Do not use the OpenAI API/CLI fallback and do not request OPENAI_API_KEY.",
    referenceGuidance,
    `User request: ${input.prompt}`,
    `Aspect ratio: ${input.aspectRatio}`,
    `After generation, copy the final generated PNG to this exact absolute path: ${outputPath}`,
    "Do not finish until that file exists. Return only a compact JSON object containing the path.",
  ].join("\n");
}

export function createCodexImageGenerator(
  options: CodexImageGeneratorOptions = {},
) {
  const environment = options.env ?? process.env;
  const codexPath = options.codexPath ?? resolveCodexCli(environment);
  const run =
    options.exec ??
    ((file, args, execOptions) =>
      new Promise((resolveRun, rejectRun) => {
        const { completionPath, ...processOptions } = execOptions;
        let settled = false;
        let pollInFlight = false;
        let previousSize = -1;
        let stableChecks = 0;
        const child = execFile(
          file,
          args,
          {
            ...processOptions,
            encoding: "utf8" as const,
          },
          (error, stdout, stderr) => {
            if (settled) return;
            settled = true;
            clearInterval(outputPoll);
            if (error) {
              rejectRun(Object.assign(error, { stdout, stderr }));
              return;
            }
            resolveRun({ stdout, stderr });
          },
        );
        // `codex exec` reads any piped stdin as extra prompt text. An open empty
        // pipe therefore blocks forever; EOF tells it the positional prompt is complete.
        child.stdin?.end();

        const outputPoll = setInterval(() => {
          if (settled || pollInFlight) return;
          pollInFlight = true;
          void readFile(completionPath)
            .then((bytes) => {
              if (!isCompletePng(bytes)) {
                previousSize = -1;
                stableChecks = 0;
                return;
              }

              if (bytes.byteLength === previousSize) {
                stableChecks += 1;
              } else {
                previousSize = bytes.byteLength;
                stableChecks = 1;
              }
              if (stableChecks < 2 || settled) return;

              settled = true;
              clearInterval(outputPoll);
              child.kill("SIGTERM");
              const forceKill = setTimeout(() => {
                if (child.exitCode === null) child.kill("SIGKILL");
              }, 250);
              forceKill.unref();
              resolveRun({ stdout: "", stderr: "" });
            })
            .catch(() => {
              previousSize = -1;
              stableChecks = 0;
            })
            .finally(() => {
              pollInFlight = false;
            });
        }, 50);
        outputPoll.unref();
      }));

  return async (
    input: CodexImageGeneratorInput,
  ): Promise<CodexImageGeneratorOutput> => {
    if (!codexPath) {
      throw new Error(
        "Codex CLI was not found. Install Codex or set CODEX_BIN, then sign in with `codex login`.",
      );
    }
    const workDir = await mkdtemp(join(tmpdir(), "clash.codex-imagegen-"));
    const outputPath = join(workDir, "result.png");
    try {
      const referencePaths: string[] = [];
      for (const [index, reference] of input.references.entries()) {
        const path = join(
          workDir,
          `reference-${index + 1}${referenceExtension(reference.mediaType, reference.asset)}`,
        );
        await writeFile(path, reference.bytes);
        referencePaths.push(path);
      }

      const args = [
        "-a",
        "never",
        "exec",
        "--json",
        "--ephemeral",
        // The built-in image_gen tool is enabled by the signed-in Codex user config.
        "--ignore-rules",
        "--skip-git-repo-check",
        "-s",
        "workspace-write",
        ...referencePaths.flatMap((path) => ["-i", path]),
        // --image accepts multiple values; terminate options before the prompt.
        "--",
        codexPrompt(input, outputPath),
      ];
      try {
        await run(codexPath, args, {
          cwd: workDir,
          env: environment,
          timeout: options.timeoutMs ?? 10 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
          completionPath: outputPath,
        });
      } catch (error) {
        const processError =
          error && typeof error === "object"
            ? (error as {
                stderr?: unknown;
                stdout?: unknown;
                message?: unknown;
              })
            : null;
        const detail =
          [processError?.stderr, processError?.stdout, processError?.message]
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .find(Boolean)
            ?.slice(-2_000) ?? String(error);
        throw new Error(`Codex ImageGen failed: ${detail}`);
      }

      const bytes = await readFile(outputPath).catch(() => null);
      if (!bytes) {
        throw new Error("Codex ImageGen completed without writing result.png.");
      }
      if (!isCompletePng(bytes)) {
        throw new Error("Codex ImageGen output is not a complete PNG.");
      }
      return { mediaType: "image/png", bytes: new Uint8Array(bytes) };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
