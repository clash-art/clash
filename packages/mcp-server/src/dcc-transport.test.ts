import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDccGateway } from "./dcc";

test("MCP transport discovers the native Python plugin and does not retry an unacknowledged mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clash dcc 场景-"));
  const discoveryRoot = join(root, "discovery");
  const child = spawn(
    process.env.PYTHON ?? "python3",
    [
      "-S",
      "-u",
      "-c",
      `
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from control import ControlServer
counter = 0
def handle(action, params):
    global counter
    counter += 1
    if action == 'execute': time.sleep(.3)
    return {'action': action, 'name': params.get('name'), 'counter': counter}
server = ControlServer('blender', Path(sys.argv[2]), handle, discovery_root=Path(sys.argv[3]))
print('ready', flush=True)
while True:
    server.poll()
    time.sleep(.002)
`,
      resolve(import.meta.dirname, "../../../integrations/dcc-assets/shared"),
      root,
      discoveryRoot,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    child.kill();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((ready, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Native test process did not start")),
      10000,
    );
    child.stdout.once("data", () => {
      clearTimeout(timeout);
      ready();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Native process exited: ${code}`));
    });
  });
  const gateway = createDccGateway({ discoveryRoot });
  const scene = await gateway.invoke("scene", {
    app: "blender",
    cwd: root,
    name: "材质 A",
  });
  assert.deepEqual(scene, { action: "scene", name: "材质 A", counter: 1 });
  const short = createDccGateway({ discoveryRoot, timeoutMs: 30 });
  await assert.rejects(
    short.invoke("execute", { app: "blender", cwd: root, code: "mutation" }),
    /DCC_RESULT_UNKNOWN/,
  );
  const after = await gateway.invoke("scene", { app: "blender", cwd: root });
  assert.equal(after.counter, 3);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    gateway.invoke(
      "execute",
      { app: "blender", cwd: root, code: "mutation" },
      cancelled.signal,
    ),
    /before execution/,
  );
  const final = await gateway.invoke("scene", { app: "blender", cwd: root });
  assert.equal(final.counter, 4);
});
