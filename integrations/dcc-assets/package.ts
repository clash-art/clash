import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = import.meta.dirname;
const output = resolve(process.argv[2] ?? join(root, "dist"));
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "clash-dcc-package-"));
try {
  for (const app of ["blender", "maya"] as const) {
    const stage = join(temporary, app);
    const packageName =
      app === "blender" ? "clash_assets" : "clash_assets_maya";
    const target = join(stage, app === "maya" ? "scripts" : "", packageName);
    mkdirSync(target, { recursive: true });
    cpSync(
      join(root, app, packageName, "__init__.py"),
      join(target, "__init__.py"),
    );
    for (const module of ["bridge", "control", "native"]) {
      cpSync(join(root, `shared/${module}.py`), join(target, `${module}.py`));
    }
    cpSync(join(root, "README.md"), join(stage, "README.md"));
    if (app === "maya") {
      cpSync(join(root, "shared/maya_tools.py"), join(target, "maya_tools.py"));
      cpSync(
        join(root, "maya/clash_assets_maya/mayatools"),
        join(target, "mayatools"),
        {
          recursive: true,
          filter: (source) =>
            !source.includes("__pycache__") && !source.endsWith(".pyc"),
        },
      );
      writeFileSync(
        join(stage, "ClashMaterials.mod"),
        "+ ClashMaterials 0.1.0 .\n",
      );
    }
    const archive = join(output, `clash-${app}.zip`);
    const result = spawnSync(
      process.env.PYTHON ?? "python3",
      [
        "-S",
        "-c",
        `
import ast, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file():
            if file.suffix == '.py':
                ast.parse(file.read_text(encoding='utf-8'), filename=str(file))
            archive.write(file, file.relative_to(root).as_posix())
`,
        stage,
        archive,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || String(result.error));
    console.log(archive);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
