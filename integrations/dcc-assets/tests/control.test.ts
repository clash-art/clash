import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("native Python execution returns output and preserves partial-change evidence on failure", () => {
  const result = spawnSync(
    process.env.PYTHON ?? "python3",
    [
      "-S",
      "-c",
      `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, "../shared"))})
from native import execute_python
scene = {}
value = execute_python("scene['name'] = 'new'; print('updated'); result = scene['name']", {'scene': scene})
try:
    execute_python("scene['name'] = 'partial'; raise RuntimeError('operation failed')", {'scene': scene})
except Exception as error:
    failure = str(error)
print(json.dumps(dict(value=value, scene=scene, failure=failure)))
`,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const value = JSON.parse(result.stdout);
  assert.equal(value.value.result, "new");
  assert.match(value.value.stdout, /updated/);
  assert.equal(value.scene.name, "partial");
  assert.match(value.failure, /operation failed/);
  assert.match(value.failure, /inspect/i);
});

test("native control authenticates, isolates workspace sessions and does not execute a replay twice", () => {
  const root = mkdtempSync(join(tmpdir(), "clash-dcc-control-"));
  try {
    const result = spawnSync(
      process.env.PYTHON ?? "python3",
      [
        "-S",
        "-c",
        `
import json, socket, sys, time
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, "../shared"))})
from control import ControlServer
root = Path(${JSON.stringify(root)})
calls = []
def handler(action, params):
    calls.append(action)
    return {'scene': params.get('name')}
server = ControlServer('blender', root, handler, discovery_root=root / 'discovery')
record = json.loads(server.record_path.read_text())
def invoke(request):
    peer = socket.create_connection(('127.0.0.1', record['port']))
    peer.setblocking(False)
    peer.sendall((json.dumps(request) + '\\n').encode())
    response = b''
    for _ in range(200):
        server.poll()
        try: response += peer.recv(65536)
        except BlockingIOError: pass
        if b'\\n' in response: break
        time.sleep(.001)
    peer.close()
    return json.loads(response)
base = {'id':'request-one', 'token':record['token'], 'sessionId':record['sessionId'],
        'action':'scene', 'params':{'name':'Shot 01'}}
denied = invoke(dict(base, token='wrong'))
first = invoke(base)
replay = invoke(base)
changed = invoke(dict(base, params={'name':'Shot 02'}))
other = invoke(dict(base, id='second', sessionId='old-session'))
server.close()
print(json.dumps(dict(denied=denied, first=first, replay=replay, changed=changed,
    other=other, calls=calls, removed=not server.record_path.exists())))
`,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const value = JSON.parse(result.stdout);
    assert.equal(value.denied.ok, false);
    assert.deepEqual(value.first.value, { scene: "Shot 01" });
    assert.deepEqual(value.replay, value.first);
    assert.equal(value.changed.ok, false);
    assert.equal(value.other.ok, false);
    assert.deepEqual(value.calls, ["scene"]);
    assert.equal(value.removed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
