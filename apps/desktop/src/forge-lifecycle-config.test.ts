import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceMatches } from "../../../packages/gui/test-support/source-match.js";
import { describe, expect, it } from "vitest";

import rendererConfigExport, {
  resolveDesktopRendererCacheDir,
} from "../vite.renderer.config";

interface DesktopPackage {
  main?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const desktopRoot = new URL("..", import.meta.url);

describe("Desktop shell lifecycle ownership", () => {
  it("lets Electron Forge own the development process lifecycle", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("package.json", desktopRoot), "utf8"),
    ) as DesktopPackage;

    expect(manifest.scripts?.dev).toBe("electron-forge start");
    expect(manifest.devDependencies?.["@electron-forge/cli"]).toBe("7.11.2");
    expect(manifest.devDependencies?.["@electron-forge/plugin-vite"]).toBe(
      "7.11.2",
    );
    expect(manifest.devDependencies).not.toHaveProperty("electron-vite");
    expect(manifest.main).toBe("dist/main.cjs");
    expect(manifest.scripts?.start).toBe(
      "electron . --desktop-static-renderer",
    );
    expect(existsSync(new URL("forge.config.ts", desktopRoot))).toBe(true);
    expect(existsSync(new URL("src/dev.ts", desktopRoot))).toBe(false);
  });

  it("assigns main, preload, and renderer watchers to the Forge Vite plugin", () => {
    const forgeConfigPath = new URL("forge.config.ts", desktopRoot);
    expect(existsSync(forgeConfigPath)).toBe(true);

    const source = readFileSync(forgeConfigPath, "utf8");
    expect(
      sourceMatches(source, /new\s+VitePlugin\s*\(\s*\{[\s\S]*?build\s*:/),
    ).toBe(true);
    expect(source).toContain('entry: "src/main.ts"');
    expect(source).toContain('config: "vite.main.config.ts"');
    expect(source).toContain('entry: "src/preload.ts"');
    expect(source).toContain('config: "vite.preload.config.ts"');
    expect(source).toContain('name: "main_window"');
    expect(source).toContain('config: "vite.renderer.config.ts"');
  });

  it("keeps release packaging separate from the development supervisor", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("package.json", desktopRoot), "utf8"),
    ) as DesktopPackage;

    expect(manifest.scripts?.build).toBe(
      "vite build --config vite.main.config.ts && vite build --config vite.preload.config.ts && vite build --config vite.renderer.config.ts",
    );
    for (const script of ["pack:dir", "pack:dmg", "pack:win", "pack:linux"]) {
      expect(manifest.scripts?.[script]).toContain("electron-builder");
    }
  });

  it("builds and packages one Desktop-owned renderer artifact", () => {
    const rendererConfig = readFileSync(
      new URL("vite.renderer.config.ts", desktopRoot),
      "utf8",
    );
    const builderConfig = readFileSync(
      new URL("electron-builder.yml", desktopRoot),
      "utf8",
    );

    expect(rendererConfig).toContain(
      'resolve(desktopRoot, ".vite/renderer/main_window")',
    );
    expect(rendererConfig).toContain(
      'process.env.CLASH_WEB_E2E_NO_CLOUDFLARE = "1"',
    );
    expect(builderConfig).toContain("from: .vite/renderer/main_window");
    expect(builderConfig).not.toContain("from: ../web/dist/client");
  });

  it("keeps the shared-types Zod graph inside the main bundle", () => {
    const mainConfig = readFileSync(
      new URL("vite.main.config.ts", desktopRoot),
      "utf8",
    );

    expect(mainConfig).toContain('noExternal: ["zod", "zod-to-json-schema"]');
  });

  it("uses Forge's renderer URL contract instead of a runner-specific compatibility path", () => {
    const runtimeSource = readFileSync(
      new URL("src/controller/runtime.ts", desktopRoot),
      "utf8",
    );

    expect(runtimeSource).toContain("MAIN_WINDOW_VITE_DEV_SERVER_URL");
    expect(runtimeSource).not.toContain("ELECTRON_RENDERER_URL");
  });

  it("does not silently serve a stale production renderer during development", () => {
    const runtimeSource = readFileSync(
      new URL("src/controller/runtime.ts", desktopRoot),
      "utf8",
    );
    const runtimeContractSource = readFileSync(
      new URL("src/runtime.ts", desktopRoot),
      "utf8",
    );

    expect(runtimeSource).toContain("resolveDesktopRendererUrl");
    expect(runtimeContractSource).toContain(
      "Desktop development requires MAIN_WINDOW_VITE_DEV_SERVER_URL",
    );
  });

  it("isolates Desktop optimized dependencies from the standalone web cache", () => {
    const desktopPath = fileURLToPath(desktopRoot);
    const webPath = fileURLToPath(new URL("../../web/", import.meta.url));
    const cacheDir = resolveDesktopRendererCacheDir(desktopPath);

    expect(relative(desktopPath, cacheDir).startsWith("..")).toBe(false);
    expect(relative(webPath, cacheDir).startsWith("..")).toBe(true);
  });

  it("uses the next available renderer port when the preferred port is occupied", async () => {
    const config = await rendererConfigExport({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.server?.port).toBe(3001);
    expect(config.server?.strictPort).toBe(false);
  });
});
