import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const bridgeRoot = resolve(import.meta.dirname, "../shared");

// The process boundary is a CLI fixture; filesystem transfers run for real.
function runPython(body: string) {
  const root = mkdtempSync(join(tmpdir(), "clash dcc 测试 "));
  const cli = join(root, "fixture-cli.ts");
  writeFileSync(
    cli,
    `#!${process.execPath}\n` +
      `
import { appendFileSync, mkdirSync, symlinkSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (process.env.FAIL_CLI) { console.error('Host unavailable'); process.exit(1); }
if (process.env.BAD_JSON) { console.log('not json'); process.exit(0); }
if (args[1] === 'list') console.log(JSON.stringify({assets: [
  {id:'ready', name:'图像', kind:'image', status:'ready', lifecycle:{state:'active'}},
  {id:'pending', kind:'image', status:'uploading', lifecycle:{state:'active'}},
  {id:'deleted', kind:'image', status:'ready', lifecycle:{state:'trashed'}}
]}));
else if (args[1] === 'link') {
  const folder = process.env.TEST_ROOT + '/links';
  mkdirSync(folder, {recursive: true});
  const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'source.png';
  const linkPath = folder + '/' + name;
  // Existing CLI createAssetLink rejects overwrites, including an existing symlink.
  symlinkSync(process.env.SOURCE, linkPath);
  console.log(JSON.stringify({linkPath, sourcePath: process.env.SOURCE}));
}
else if (args[1] === 'import') console.log(JSON.stringify({assetId:args[args.indexOf('--asset-id')+1]}));
else process.exit(2);
`,
    { mode: 0o755 },
  );
  const source = join(root, "source.png");
  writeFileSync(source, "original bytes");
  const calls = join(root, "calls.jsonl");
  try {
    const result = spawnSync(
      process.env.PYTHON ?? "python3",
      [
        "-S",
        "-c",
        `
import json, os, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(bridgeRoot)})
from bridge import AssetBridge, BridgeError
root = Path(os.environ['TEST_ROOT']).resolve()
client = AssetBridge(str(root), os.environ['CLI'])
${body}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_ROOT: root,
          CLI: cli,
          SOURCE: source,
          CALLS: calls,
        },
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return {
      value: JSON.parse(result.stdout),
      calls: readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("lists only active ready assets using the marker-selected working directory", () => {
  const { value, calls } = runPython("print(json.dumps(client.list_assets()))");
  assert.deepEqual(
    value.map((a: { id: string }) => a.id),
    ["ready"],
  );
  assert.deepEqual(calls[0].args, ["assets", "list", "--json"]);
  assert.match(calls[0].cwd, /clash dcc 测试 /);
});

test("receives independent copies without overwriting an earlier local edit", () => {
  const { value } = runPython(`
first = client.receive_asset('asset/../../escape')
assert first.suffix == '.png'
first.write_text('edited locally')
second = client.receive_asset('asset/../../escape')
print(json.dumps(dict(first=first.read_text(), second=second.read_text(),
  source=Path(os.environ['SOURCE']).read_text(), distinct=first != second,
  confined=first.is_relative_to(root / 'assets' / 'dcc') and second.is_relative_to(root / 'assets' / 'dcc'))))
`);
  assert.deepEqual(value, {
    first: "edited locally",
    second: "original bytes",
    source: "original bytes",
    distinct: true,
    confined: true,
  });
});

test("retains a stable upload identity for retry after an unknown CLI result", () => {
  const { value, calls } = runPython(`
os.environ['FAIL_CLI'] = '1'
try:
    client.send_file(os.environ['SOURCE'])
except BridgeError as error:
    failure = str(error)
del os.environ['FAIL_CLI']
result = client.send_file(os.environ['SOURCE'])
print(json.dumps(dict(result=result, failure=failure)))
`);
  const ids = calls.map((c) => c.args[c.args.indexOf("--asset-id") + 1]);
  assert.equal(ids[0], ids[1]);
  assert.equal(value.result.assetId, ids[0]);
  assert.match(value.failure, /Host unavailable/);
  assert.ok(calls[0].args.includes("--no-link"));
});

test("changed bytes get a new identity even if a previous upload was interrupted", () => {
  const { calls } = runPython(`
os.environ['FAIL_CLI'] = '1'
try: client.send_file(os.environ['SOURCE'])
except BridgeError: pass
del os.environ['FAIL_CLI']
Path(os.environ['SOURCE']).write_text('new bytes')
print(json.dumps(client.send_file(os.environ['SOURCE'])))
`);
  const ids = calls.map((c) => c.args[c.args.indexOf("--asset-id") + 1]);
  assert.notEqual(ids[0], ids[1]);
});

test("malformed CLI output is an actionable error", () => {
  const { value } = runPython(`
os.environ['BAD_JSON'] = '1'
try: client.list_assets()
except BridgeError as error: print(json.dumps(str(error)))
`);
  assert.match(value, /JSON/);
});
