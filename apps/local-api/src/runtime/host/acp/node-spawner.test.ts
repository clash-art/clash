import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { NodeSpawner } from "@openma/common/acp-runtime/node-spawner";

const require = createRequire(import.meta.url);
const tsxLoader = (() => {
  try {
    return require.resolve("tsx");
  } catch {
    return createRequire(new URL("../../../../package.json", import.meta.url)).resolve("tsx");
  }
})();

async function waitForGone(pid: number, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} was still alive`);
}

async function readFirstStdoutLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  try {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline).trim();
    }
    return "";
  } finally {
    reader.releaseLock();
  }
}

describe("NodeSpawner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  it("keeps child stderr as diagnostics without mirroring it by default", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const diagnostics: string[] = [];
    try {
      const spawner = new NodeSpawner();
      const handle = await spawner.spawn({
        command: process.execPath,
        args: ["-e", "console.error('child noise')"],
        onDiagnosticLine: (line) => diagnostics.push(line),
      });

      await handle.exited;
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(diagnostics).toContain("child noise");
      expect(writeSpy.mock.calls.some(([chunk]) => String(chunk).includes("[acp.child]"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  posixIt("kills the whole child process group instead of orphaning grandchildren", async () => {
    const spawner = new NodeSpawner();
    const script = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
console.log(grandchild.pid);
setInterval(() => {}, 1000);
`;

    const handle = await spawner.spawn({
      command: process.execPath,
      args: ["-e", script],
    });
    const grandchildPid = Number(await readFirstStdoutLine(handle.stdout));

    expect(Number.isInteger(grandchildPid)).toBe(true);

    await handle.kill("SIGTERM");
    await waitForGone(grandchildPid);
  });

  posixIt("escalates to SIGKILL when a child process group ignores SIGTERM", async () => {
    const spawner = new NodeSpawner();
    const handle = await spawner.spawn({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)",
      ],
    });
    const childPid = Number(await readFirstStdoutLine(handle.stdout));
    expect(Number.isInteger(childPid)).toBe(true);

    try {
      const stopped = await Promise.race([
        handle.kill("SIGTERM").then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
      ]);
      expect(stopped).toBe(true);
      await waitForGone(childPid);
    } finally {
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await handle.exited;
    }
  }, 5_000);

  posixIt("cleans up the child process group when the host process exits", async () => {
    const pidFile = join(tmpdir(), `clash-node-spawner-grandchild-${process.pid}-${Date.now()}.txt`);
    const spawnerUrl = import.meta.resolve("@openma/common/acp-runtime/node-spawner");
    const parentScript = `
const { writeFile } = await import("node:fs/promises");
const { NodeSpawner } = await import(${JSON.stringify(spawnerUrl)});
async function readFirstLine(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return "";
    chunks.push(value);
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const newline = text.indexOf("\\n");
    if (newline >= 0) return text.slice(0, newline).trim();
  }
}
const script = ${JSON.stringify(`
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(grandchild.pid);
setInterval(() => {}, 1000);
`)};
const spawner = new NodeSpawner();
const handle = await spawner.spawn({ command: process.execPath, args: ["-e", script] });
const grandchildPid = await readFirstLine(handle.stdout);
await writeFile(${JSON.stringify(pidFile)}, grandchildPid, "utf8");
process.exit(0);
`;

    const parent = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", parentScript], {
      cwd: join(import.meta.dirname, "../../../.."),
      stdio: "ignore",
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("parent process did not exit")), 3000);
      parent.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`parent exited with ${code}`));
      });
      parent.once("error", reject);
    });

    const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await waitForGone(grandchildPid);
  });

  posixIt("cleans up the child process group when the host is interrupted", async () => {
    const pidFile = join(tmpdir(), `clash-node-spawner-sigint-${process.pid}-${Date.now()}.txt`);
    const spawnerUrl = import.meta.resolve("@openma/common/acp-runtime/node-spawner");
    const parentScript = `
const { writeFile } = await import("node:fs/promises");
const { NodeSpawner } = await import(${JSON.stringify(spawnerUrl)});
async function readFirstLine(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return "";
    chunks.push(value);
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const newline = text.indexOf("\\n");
    if (newline >= 0) return text.slice(0, newline).trim();
  }
}
const script = ${JSON.stringify(`
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(process.pid + ":" + grandchild.pid);
setInterval(() => {}, 1000);
`)};
const spawner = new NodeSpawner();
const handle = await spawner.spawn({ command: process.execPath, args: ["-e", script] });
await writeFile(${JSON.stringify(pidFile)}, await readFirstLine(handle.stdout), "utf8");
setInterval(() => {}, 1000);
`;

    const parent = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", parentScript], {
      cwd: join(import.meta.dirname, "../../../.."),
      stdio: "ignore",
    });

    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try {
          const [child, grandchild] = (await readFile(pidFile, "utf8")).trim().split(":").map(Number);
          childPid = child;
          grandchildPid = grandchild;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      expect(Number.isInteger(childPid)).toBe(true);
      expect(Number.isInteger(grandchildPid)).toBe(true);

      parent.kill("SIGINT");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("parent process did not exit after SIGINT")), 3000);
        parent.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        parent.once("error", reject);
      });

      await waitForGone(grandchildPid!);
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(-childPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});
