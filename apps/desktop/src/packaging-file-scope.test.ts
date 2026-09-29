import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { getConfig } = require("app-builder-lib/out/util/config/config.js");
const { getMainFileMatchers } = require("app-builder-lib/out/fileMatcher.js");

it("excludes previous releases and development files when packaging to an external output directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-package-scope-"));
  try {
    const appDir = join(root, "desktop");
    const payloads = [
      "dist/main.cjs", "dist/preload.cjs", "package.json",
      "release/old.dmg", "release/mac-arm64/Clash.app/Contents/Resources/app.asar",
      ".vite/cache/main_window/deps/cache.js", ".vite/renderer/main_window/index.html",
      "src/private.ts", "e2e/fixture.ts",
    ];
    for (const path of payloads) {
      await mkdir(resolve(appDir, path, ".."), { recursive: true });
      await writeFile(join(appDir, path), "fixture");
    }
    const config = await getConfig(resolve(import.meta.dirname, ".."), "electron-builder.yml", null);
    const matchers = getMainFileMatchers(appDir, join(root, "out/app"), (value: string) => value,
      config.mac, { info: { config, projectDir: appDir, buildResourcesDir: "build", debugLogger: { isEnabled: false } } },
      join(root, "out"), false);
    const filters = matchers.map((matcher: { createFilter(): (path: string, metadata: Awaited<ReturnType<typeof stat>>) => boolean }) => matcher.createFilter());
    const included: string[] = [];
    for (const path of payloads) {
      const fullPath = join(appDir, path);
      const metadata = await stat(fullPath);
      if (filters.some((filter: (path: string, metadata: Awaited<ReturnType<typeof stat>>) => boolean) => filter(fullPath, metadata))) included.push(path);
    }
    expect(included).toEqual(["dist/main.cjs", "dist/preload.cjs", "package.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
