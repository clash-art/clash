import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

describe("Codex ImageGen kernel adapter", () => {
  it("disables the adapter without probing login when the configured CLI path is invalid", async () => {
    const { preflightCodexImageGenerator } = await import("./codex-imagegen");
    const root = await mkdtemp(join(tmpdir(), "clash-codex-missing-"));
    const statusExec = vi.fn();

    await expect(
      preflightCodexImageGenerator({
        codexPath: join(root, "missing-codex"),
        statusExec,
      }),
    ).resolves.toEqual({ available: false, reason: "cli-not-found" });
    expect(statusExec).not.toHaveBeenCalled();

    await rm(root, { recursive: true, force: true });
  });

  it("disables the adapter when Codex reports that the user is not logged in", async () => {
    const { preflightCodexImageGenerator } = await import("./codex-imagegen");
    const root = await mkdtemp(join(tmpdir(), "clash-codex-logged-out-"));
    const fakeCodex = join(root, "codex");
    await writeFile(fakeCodex, "#!/bin/sh\n");
    await chmod(fakeCodex, 0o755);
    const statusExec = vi.fn(async () => {
      throw Object.assign(new Error("Not logged in"), { code: 1 });
    });

    await expect(
      preflightCodexImageGenerator({
        codexPath: fakeCodex,
        statusExec,
      }),
    ).resolves.toEqual({ available: false, reason: "not-logged-in" });
    expect(statusExec).toHaveBeenCalledWith(
      fakeCodex,
      ["login", "status"],
      expect.objectContaining({ timeout: 5_000 }),
    );

    await rm(root, { recursive: true, force: true });
  });

  it("pins the validated absolute CLI path after a successful login preflight", async () => {
    const { preflightCodexImageGenerator } = await import("./codex-imagegen");
    const root = await mkdtemp(join(tmpdir(), "clash-codex-ready-"));
    const fakeCodex = join(root, "codex");
    await writeFile(fakeCodex, "#!/bin/sh\n");
    await chmod(fakeCodex, 0o755);
    const statusExec = vi.fn(async () => ({
      stdout: "Logged in using ChatGPT\n",
      stderr: "",
    }));

    const result = await preflightCodexImageGenerator({
      codexPath: relative(process.cwd(), fakeCodex),
      statusExec,
    });

    expect(result).toMatchObject({
      available: true,
      codexPath: fakeCodex,
    });
    if (result.available) expect(result.generate).toBeTypeOf("function");

    await rm(root, { recursive: true, force: true });
  });

  it("closes login-status stdin and bounds a stuck CLI probe", async () => {
    const { preflightCodexImageGenerator } = await import("./codex-imagegen");
    const root = await mkdtemp(join(tmpdir(), "clash-codex-status-process-"));
    const readyCodex = join(root, "ready-codex");
    await writeFile(
      readyCodex,
      [
        "#!/bin/sh",
        '[ "$1:$2" = "login:status" ] || exit 2',
        "while IFS= read -r line; do :; done",
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(readyCodex, 0o755);

    await expect(
      preflightCodexImageGenerator({
        codexPath: readyCodex,
        statusTimeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ available: true, codexPath: readyCodex });

    const stuckCodex = join(root, "stuck-codex");
    await writeFile(stuckCodex, "#!/bin/sh\nexec sleep 5\n");
    await chmod(stuckCodex, 0o755);
    await expect(
      preflightCodexImageGenerator({
        codexPath: stuckCodex,
        statusTimeoutMs: 50,
      }),
    ).resolves.toEqual({
      available: false,
      reason: "login-check-failed",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("resolves a configured relative executable path so it survives a cwd change", async () => {
    const { resolveCodexCli } = await import("./codex-imagegen");
    const binDir = await mkdtemp(join(tmpdir(), "clash-codex-path-"));
    await writeFile(join(binDir, "codex"), "#!/bin/sh\n");
    await chmod(join(binDir, "codex"), 0o755);

    const resolved = resolveCodexCli({
      CODEX_BIN: relative(process.cwd(), join(binDir, "codex")),
      PATH: "",
    });

    expect(resolved).not.toBeNull();
    expect(isAbsolute(resolved!)).toBe(true);
    await rm(binDir, { recursive: true, force: true });
  });

  it("invokes the signed-in Codex CLI with references and returns a validated PNG", async () => {
    const module = await import("./codex-imagegen").catch(() => ({}));
    const createGenerator = (module as Record<string, unknown>)
      .createCodexImageGenerator as
      | ((options: Record<string, unknown>) => (input: unknown) => Promise<any>)
      | undefined;
    expect(createGenerator).toBeTypeOf("function");
    if (!createGenerator) return;

    const exec = vi.fn(
      async (file: string, args: string[], options: { cwd: string }) => {
        expect(file).toBe("/usr/local/bin/codex");
        expect(args).toEqual(
          expect.arrayContaining([
            "-a",
            "never",
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-rules",
            "-s",
            "workspace-write",
            "-i",
          ]),
        );
        expect(args).not.toContain("--ignore-user-config");
        expect(args.filter((value) => value === "-i")).toHaveLength(1);
        expect(args.at(-2)).toBe("--");
        expect(args.at(-1)).toContain("Aspect ratio: 16:9");
        await writeFile(
          `${options.cwd}/result.png`,
          Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
            0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
          ]),
        );
        return { stdout: '{"type":"turn.completed"}\n', stderr: "" };
      },
    );
    const generate = createGenerator({
      codexPath: "/usr/local/bin/codex",
      exec,
    });

    await expect(
      generate({
        prompt: "A paper-cut moon",
        aspectRatio: "16:9",
        references: [
          {
            asset: {
              assetId: "reference-1",
              uri: "clash-asset://reference-1",
              kind: "image",
              mediaType: "image/png",
            },
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    ).resolves.toEqual({
      mediaType: "image/png",
      bytes: new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]),
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("closes the Codex child stdin instead of waiting for additional prompt input", async () => {
    const { createCodexImageGenerator } = await import("./codex-imagegen");
    const binDir = await mkdtemp(join(tmpdir(), "clash-codex-stdin-"));
    const fakeCodex = join(binDir, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        "while IFS= read -r line; do :; done",
        "printf '\\211PNG\\r\\n\\032\\n\\000\\000\\000\\000IEND\\256B\\140\\202' > result.png",
        "",
      ].join("\n"),
    );
    await chmod(fakeCodex, 0o755);

    const generate = createCodexImageGenerator({
      codexPath: fakeCodex,
      timeoutMs: 1_000,
    });
    await expect(
      generate({
        prompt: "A paper-cut moon",
        aspectRatio: "1:1",
        references: [],
      }),
    ).resolves.toMatchObject({ mediaType: "image/png" });

    await rm(binDir, { recursive: true, force: true });
  });

  it("finishes when result.png is stable even if the Codex process stays open", async () => {
    const { createCodexImageGenerator } = await import("./codex-imagegen");
    const binDir = await mkdtemp(join(tmpdir(), "clash-codex-output-ready-"));
    const fakeCodex = join(binDir, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        "printf '\\211PNG\\r\\n\\032\\n\\000\\000\\000\\000IEND\\256B\\140\\202' > result.png",
        "sleep 5",
        "",
      ].join("\n"),
    );
    await chmod(fakeCodex, 0o755);

    const generate = createCodexImageGenerator({
      codexPath: fakeCodex,
      timeoutMs: 1_500,
    });

    await expect(
      generate({
        prompt: "A paper-cut moon",
        aspectRatio: "1:1",
        references: [],
      }),
    ).resolves.toMatchObject({ mediaType: "image/png" });

    await rm(binDir, { recursive: true, force: true });
  });

  it("does not finish while result.png is only partially written", async () => {
    const { createCodexImageGenerator } = await import("./codex-imagegen");
    const binDir = await mkdtemp(join(tmpdir(), "clash-codex-partial-output-"));
    const fakeCodex = join(binDir, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        "printf '\\211PNG\\r\\n\\032\\n' > result.png",
        "sleep 0.3",
        "printf '\\000\\000\\000\\000IEND\\256B\\140\\202' >> result.png",
        "sleep 5",
        "",
      ].join("\n"),
    );
    await chmod(fakeCodex, 0o755);

    const generate = createCodexImageGenerator({
      codexPath: fakeCodex,
      timeoutMs: 1_000,
    });

    await expect(
      generate({
        prompt: "A paper-cut moon",
        aspectRatio: "1:1",
        references: [],
      }),
    ).resolves.toEqual({
      mediaType: "image/png",
      bytes: new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]),
    });

    await rm(binDir, { recursive: true, force: true });
  });
});
