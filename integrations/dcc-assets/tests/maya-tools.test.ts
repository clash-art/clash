import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("Maya tool adapter discovers upstream contracts, validates before execution and preserves literal arguments", () => {
  const run = spawnSync(
    "python3",
    [
      "-S",
      "-c",
      `
import sys, types, json
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, "../shared"))})
from maya_tools import catalog, invoke
root = ${JSON.stringify(resolve(import.meta.dirname, "../maya/clash_assets_maya/mayatools"))}
scene = {'selection': []}
cmds = types.ModuleType('maya.cmds')
def select(name=None, **kw):
    scene['selection'] = [] if kw.get('clear') else [name]
cmds.select = select
maya = types.ModuleType('maya'); maya.cmds = cmds
sys.modules['maya'] = maya; sys.modules['maya.cmds'] = cmds
entries = catalog(root)
assert next(t for t in entries if t['name'] == 'select_object')['inputSchema']['required'] == ['object_name']
assert next(t for t in entries if t['name'] == 'scene_new')['inputSchema']['properties']['force']['default'] is False
literal = "模型'\\\\name\\n;raise Exception()"
value = invoke(root, 'select_object', {'object_name': literal})
assert scene['selection'] == [literal]
for args in ({}, {'object_name': 3}, {'object_name':'x', 'extra':True}):
    try: invoke(root, 'select_object', args)
    except (ValueError, TypeError): pass
    else: raise AssertionError('invalid arguments accepted')
assert scene['selection'] == [literal]
try: invoke(root, '../select_object', {})
except ValueError: pass
else: raise AssertionError('unknown tool accepted')
invoke(root, 'clear_selection_list', {})
assert scene['selection'] == []
print(json.dumps(value))
`,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(run.status, 0, run.stderr);
});

test("packaged create_object accepts JSON numeric vectors and handles Maya light names as scalars", () => {
  const run = spawnSync(
    "python3",
    [
      "-S",
      "-c",
      `
import sys, types
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, "../shared"))})
from maya_tools import invoke
root = ${JSON.stringify(resolve(import.meta.dirname, "../maya/clash_assets_maya/mayatools"))}
objects = {}
cmds = types.ModuleType('maya.cmds')
def light(name):
    objects[name] = {}
    return name + 'Shape'
def set_attr(path, *values, **kw):
    node, attr = path.split('.')
    objects[node][attr] = values
cmds.pointLight = light
cmds.listRelatives = lambda name, **kw: [name.removesuffix('Shape')]
cmds.setAttr = set_attr
maya = types.ModuleType('maya'); maya.cmds = cmds
sys.modules['maya'] = maya; sys.modules['maya.cmds'] = cmds
value = invoke(root, 'create_object', {'name':'KeyLight', 'object_type':'pointLight', 'translate':[1,2,3]})
assert objects['KeyLight']['translate'] == (1.0,2.0,3.0)
assert value['result']['name'] == 'KeyLight'
assert value['result']['shape'] == 'KeyLightShape'
`,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(run.status, 0, run.stderr);
});
