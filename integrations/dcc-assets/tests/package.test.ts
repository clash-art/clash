import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("both install archives include their native entry point and an importable shared bridge", () => {
  const directory = mkdtempSync(join(tmpdir(), "clash-addon-pack-"));
  try {
    const pack = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../package.ts"), directory],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(pack.status, 0, pack.stderr || String(pack.error));
    const inspect = spawnSync(
      process.env.PYTHON ?? "python3",
      [
        "-S",
        "-c",
        `
import ast, sys, zipfile
from pathlib import Path
root = Path(sys.argv[1])
for filename, entry in [('clash-blender.zip', 'clash_assets'), ('clash-maya.zip', 'scripts/clash_assets_maya')]:
    with zipfile.ZipFile(root / filename) as archive:
        archive.getinfo(entry + '/__init__.py')
        for module, symbol in [('bridge', 'AssetBridge'), ('control', 'ControlServer'), ('native', 'execute_python')]:
            source = archive.read(entry + '/' + module + '.py').decode()
            namespace = {'__name__': module}
            exec(compile(source, module + '.py', 'exec'), namespace)
            assert callable(namespace[symbol])
        for name in archive.namelist():
            if name.endswith('.py'):
                ast.parse(archive.read(name).decode(), filename=name)
        if filename == 'clash-maya.zip':
            archive.getinfo(entry + '/mayatools/LICENSE')
            archive.getinfo(entry + '/mayatools/UPSTREAM.md')
            extracted = root / 'maya-extracted'
            archive.extractall(extracted)
            sys.path.insert(0, str(extracted / entry))
            from maya_tools import catalog, invoke
            tools_root = extracted / entry / 'mayatools'
            assert any(tool['name'] == 'create_object' for tool in catalog(tools_root))
            try:
                invoke(tools_root, 'generate_scene', {})
            except ValueError:
                pass
            else:
                raise AssertionError('Broken upstream scene generator must not be advertised')
`,
        directory,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(inspect.status, 0, inspect.stderr || String(inspect.error));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
