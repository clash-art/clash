import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { ProviderExecutionError as RootProviderError } from "@clash/action-sdk";
import {
  ProviderExecutionError,
  executableFailureFromThrown,
  providerHttpError,
} from "@clash/action-sdk/executable-failure";

it("keeps the published narrow entry and Node root on the same error implementation", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(__dirname, "../../action-sdk/package.json"), "utf8"),
  );
  // Node export resolution validates the public subpath, independently of the source aliases.
  expect(import.meta.resolve("@clash/action-sdk/executable-failure")).toBe(
    new URL(
      manifest.exports["./executable-failure"].import,
      new URL("../../action-sdk/package.json", import.meta.url),
    ).href,
  );
  const error = providerHttpError({
    status: 429,
    message: "busy",
    operation: "submit",
  });
  expect(error).toBeInstanceOf(RootProviderError);
  expect(RootProviderError).toBe(ProviderExecutionError);
  expect(executableFailureFromThrown(error, "submit")).toBe(error.failure);
});

it("bundles portable providers from source and executes failures without Node globals", async () => {
  const result = await build({
    absWorkingDir: resolve(__dirname, "../../.."),
    stdin: {
      resolveDir: resolve(__dirname, "../../.."),
      contents: `
        import { ProviderExecutionError, executableFailureFromThrown } from '@clash/action-sdk/executable-failure';
        import { minimaxPoll } from './packages/shared-runtime/src/minimax-executor.ts';
        import { getPikaMediaJob } from './packages/shared-runtime/src/pika-media.ts';
        import { pollBflFlux3VideoOnce } from './packages/shared-runtime/src/bfl-video.ts';
        import { getGeminiOmniInteraction } from './packages/shared-runtime/src/gemini-omni.ts';
        export async function check() {
          const options = { apiKey: 'fixture-only', fetch };
          const calls = [
            () => minimaxPoll({ ...options, state: { taskId: 'accepted-task' } }),
            () => getPikaMediaJob({ ...options, jobId: 'accepted-task' }),
            () => pollBflFlux3VideoOnce(options, { requestId: 'accepted-task', pollingUrl: 'https://provider.invalid/poll' }),
            () => getGeminiOmniInteraction({ ...options, interactionId: 'accepted-task' }),
          ];
          return Promise.all(calls.map(async call => {
            try { await call(); throw new Error('expected fixture HTTP failure'); }
            catch (error) {
              if (!(error instanceof ProviderExecutionError)) throw error;
              return executableFailureFromThrown(error, 'poll');
            }
          }));
        }
      `,
    },
    tsconfig: "tsconfig.source.json",
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "portableProviders",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  for (const input of Object.keys(result.metafile!.inputs)) {
    expect(input).not.toMatch(/^node:/);
    if (!input.includes("node_modules"))
      expect(input).not.toMatch(/\/(dist|runtime)\//);
  }
  const calls: unknown[] = [];
  const sandbox = {
    fetch: async (url: unknown) => {
      calls.push(url);
      return new Response(
        JSON.stringify({ message: "temporarily unavailable" }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    },
  };
  const failures = await runInNewContext(
    `${result.outputFiles[0]!.text}\nportableProviders.check()`,
    sandbox,
  );
  expect(calls).not.toEqual([]);
  for (const failure of failures) {
    expect(failure).toMatchObject({
      requestState: "accepted",
      retryable: true,
      providerCode: "HTTP_503",
    });
  }
});
