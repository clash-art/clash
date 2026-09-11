import { existsSync, readFileSync, statSync } from "node:fs";
import { sourceMatches } from "../../../packages/gui/test-support/source-match.js";
import { describe, expect, it } from "vitest";

interface DesktopPackage {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface RootPackage {
  scripts?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
}

function dependencyMajor(versionRange: string): number {
  const match = versionRange.match(/\d+/);
  return match ? Number(match[0]) : Number.NaN;
}

describe("desktop Electron runtime", () => {
  it("tracks a current Electron major for macOS desktop shell fixes", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as DesktopPackage;
    expect(
      dependencyMajor(manifest.devDependencies?.electron ?? ""),
    ).toBeGreaterThanOrEqual(42);
  });

  it("has a macOS DMG packaging target for first desktop ship", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as DesktopPackage;
    const builderConfig = readFileSync(
      new URL("../electron-builder.yml", import.meta.url),
      "utf8",
    );
    const dmgScript = manifest.scripts?.["pack:dmg"] ?? "";
    expect(dmgScript).toContain("electron-builder");
    expect(dmgScript).toContain("--publish never");
    expect(builderConfig).toMatch(/^publish:\s+null$/m);
    expect(builderConfig).toMatch(/^\s+icon:\s+build\/icon\.icns$/m);
    expect(builderConfig).toMatch(/target:\n(?:\s+-\s+\w+\n)*\s+-\s+dmg/m);
  });

  it("defines deterministic installers for macOS, Windows, and Linux", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as DesktopPackage;
    const rootManifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as RootPackage;
    const builderConfig = readFileSync(
      new URL("../electron-builder.yml", import.meta.url),
      "utf8",
    );
    const workspaceConfig = readFileSync(
      new URL("../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );

    expect(manifest.scripts ?? {}).toHaveProperty("pack:mac");
    expect(manifest.scripts ?? {}).toHaveProperty("pack:mac:arm64");
    expect(manifest.scripts ?? {}).toHaveProperty("pack:mac:x64");
    expect(manifest.scripts ?? {}).toHaveProperty("pack:win");
    expect(manifest.scripts ?? {}).toHaveProperty("pack:linux");
    expect(manifest.scripts?.["pack:mac:arm64"] ?? "").toContain(
      "--mac dmg --arm64",
    );
    expect(manifest.scripts?.["pack:mac:x64"] ?? "").toContain(
      "--mac dmg --x64",
    );
    expect(manifest.scripts?.["pack:mac"] ?? "").toContain("pack:mac:arm64");
    expect(manifest.scripts?.["pack:win"] ?? "").toContain("--win nsis --x64");
    expect(manifest.scripts?.["pack:linux"] ?? "").toContain(
      "--linux AppImage --x64",
    );
    expect(manifest.dependencies ?? {}).not.toHaveProperty("@remotion/bundler");
    expect(manifest.devDependencies?.["@remotion/bundler"]).toBe("4.0.507");
    expect(manifest.devDependencies?.["@clash/render-server"]).toBe(
      "workspace:*",
    );
    expect(manifest.devDependencies?.clash).toBe("workspace:*");
    expect(manifest.scripts?.["prepare:pack"] ?? "").not.toContain("--filter");
    expect(rootManifest.scripts?.["prepare:desktop-pack"] ?? "").toContain(
      "turbo run build",
    );
    expect(rootManifest.scripts?.["prepare:desktop-pack"] ?? "").toContain(
      "pnpm --filter @clash/desktop prepare:pack",
    );
    const desktopPrepare =
      rootManifest.scripts?.["prepare:desktop-pack"] ?? "";
    const bundledPluginBuild = desktopPrepare.indexOf(
      'turbo run build --filter="@clash-plugin/*"',
    );
    const hostBuild = desktopPrepare.indexOf(
      "turbo run build --filter=clash --filter=@clash/desktop",
    );
    expect(bundledPluginBuild).toBeGreaterThan(-1);
    expect(hostBuild).toBeGreaterThan(bundledPluginBuild);
    for (const script of [
      "pack:dir",
      "pack:dmg",
      "pack:desktop:mac:arm64",
      "pack:desktop:mac:x64",
      "pack:desktop:win",
      "pack:desktop:linux",
    ]) {
      const packageScript = script.startsWith("pack:desktop:")
        ? manifest.scripts?.[script.replace("pack:desktop:", "pack:")]
        : manifest.scripts?.[script];
      expect(packageScript ?? "").toContain(
        "pnpm --dir ../.. prepare:desktop-pack",
      );
    }
    for (const script of [
      "pack:desktop:dir",
      "pack:desktop:dmg",
      "pack:desktop:mac:arm64",
      "pack:desktop:mac:x64",
      "pack:desktop:win",
      "pack:desktop:linux",
    ]) {
      expect(rootManifest.scripts?.[script] ?? "").not.toContain(
        "pnpm prepare:desktop-pack",
      );
    }
    expect(manifest.devDependencies?.["electron-builder"]).toBe("26.15.3");
    expect(rootManifest.pnpm?.overrides?.["@electron/get"]).toBe("5.0.0");
    expect(builderConfig).toContain(
      "artifactName: Clash-Desktop-macOS-${arch}.${ext}",
    );
    expect(builderConfig).toContain(
      "artifactName: Clash-Desktop-Windows-${arch}.${ext}",
    );
    expect(builderConfig).toContain(
      "artifactName: Clash-Desktop-Linux-x64.${ext}",
    );
    expect(builderConfig).toContain(
      "from: build/clash-runtime/node_modules",
    );
    expect(builderConfig).toContain("to: clash-runtime/node_modules");
    expect(builderConfig).toMatch(
      /^win:\n(?:(?!^[A-Za-z]).*\n)*? {2}executableName: clash$/m,
    );
    expect(builderConfig).toMatch(
      /^linux:\n(?:(?!^[A-Za-z]).*\n)*? {2}executableName: clash$/m,
    );
    expect(builderConfig).toContain(
      'x64ArchFiles: "**/node_modules/{@anthropic-ai/claude-agent-sdk-*,@esbuild/*,@remotion/compositor-*}/**"',
    );
    expect(builderConfig).toContain(
      "afterPack: scripts/prune-packaged-architectures.ts",
    );
    expect(workspaceConfig).toMatch(
      /supportedArchitectures:\n\s+cpu:\s+\[arm64, x64\]/,
    );
    expect(builderConfig).toContain(
      '"!node_modules/@anthropic-ai/claude-agent-sdk-{linux,win32}-*/**"',
    );
    expect(builderConfig).toContain(
      '"!node_modules/@remotion/compositor-{linux,win32}-*/**"',
    );
    expect(builderConfig).toContain(
      '"!node_modules/@anthropic-ai/claude-agent-sdk-{darwin,linux}-*/**"',
    );
    expect(builderConfig).toContain(
      '"!node_modules/@remotion/compositor-{darwin,linux}-*/**"',
    );
    expect(builderConfig).toContain(
      '"!node_modules/@anthropic-ai/claude-agent-sdk-{darwin-*,win32-*,linux-arm64,linux-arm64-musl}/**"',
    );
    expect(builderConfig).toContain(
      '"!node_modules/@remotion/compositor-{darwin-*,win32-*,linux-arm64-*}/**"',
    );
  });

  it("packages all desktop targets and promotes the same assets to a rolling release", () => {
    const release = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(release).toContain("package-desktop:");
    expect(release).toContain("macos-latest");
    expect(release).toContain("platform: macOS-arm64");
    expect(release).toContain("platform: macOS-x64");
    expect(release).toContain(
      "apps/desktop/release/Clash-Desktop-macOS-arm64.dmg",
    );
    expect(release).toContain(
      "apps/desktop/release/Clash-Desktop-macOS-x64.dmg",
    );
    expect(release).toContain("windows-latest");
    expect(release).toContain("ubuntu-latest");
    expect(
      sourceMatches(release, /uses:\s*actions\/upload-artifact@v\d+\b/),
    ).toBe(true);
    expect(release).toContain("Clash-Desktop-${{ matrix.platform }}");
    expect(release).toContain("pnpm run ${{ matrix.script }}");
    expect(release).toContain("script: pack:desktop:mac:arm64");
    expect(release).toContain("publish-desktop-preview:");
    expect(
      sourceMatches(release, /uses:\s*actions\/download-artifact@v\d+\b/),
    ).toBe(true);
    expect(release).toContain("gh release upload desktop-preview");
  });

  it("gives the desktop renderer enough heap on packaging runners", () => {
    const release = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const heapLimit = release.match(
      /NODE_OPTIONS:\s*["']?--max-old-space-size=(\d+)["']?/,
    )?.[1];

    expect(Number(heapLimit)).toBeGreaterThanOrEqual(4096);
  });

  it("runs repository automation on Node 24 based action releases", () => {
    const ci = readFileSync(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const release = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const publishBeta = readFileSync(
      new URL("../../../.github/workflows/publish-beta.yml", import.meta.url),
      "utf8",
    );

    for (const workflow of [ci, release, publishBeta]) {
      expect(
        sourceMatches(workflow, /uses:\s*actions\/checkout@v7\b/),
      ).toBe(true);
      expect(
        sourceMatches(workflow, /uses:\s*pnpm\/action-setup@v6\b/),
      ).toBe(true);
      expect(
        sourceMatches(workflow, /uses:\s*actions\/setup-node@v7\b/),
      ).toBe(true);
    }
    expect(
      sourceMatches(release, /uses:\s*actions\/upload-artifact@v7\b/),
    ).toBe(true);
    expect(
      sourceMatches(release, /uses:\s*actions\/download-artifact@v8\b/),
    ).toBe(true);
  });

  it("checks out the pinned OpenMA common source before clean desktop packaging", () => {
    const release = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const commonCheckout = release.indexOf(
      "git clone --filter=blob:none https://github.com/openma-ai/openma-common.git ../openma-common",
    );
    const commonRevision = release.indexOf(
      "git -C ../openma-common checkout 00358ff9c1e4a694171f5617a4715602c61433e7",
    );
    const commonInstallCommand =
      "pnpm --dir ../openma-common install --frozen-lockfile";
    const commonInstall = release.indexOf(commonInstallCommand);
    const install = release.indexOf("pnpm install --frozen-lockfile");

    expect(commonCheckout).toBeGreaterThan(-1);
    expect(commonRevision).toBeGreaterThan(commonCheckout);
    expect(release).toContain(`run: ${commonInstallCommand}\n`);
    expect(release).not.toContain(`${commonInstallCommand} --prod`);
    expect(commonInstall).toBeGreaterThan(commonRevision);
    expect(install).toBeGreaterThan(commonInstall);
  });

  it("keeps self-hosted ACP runtimes out of immutable desktop resources", () => {
    const builderConfig = readFileSync(
      new URL("../electron-builder.yml", import.meta.url),
      "utf8",
    );

    expect(builderConfig).not.toMatch(/\bbuild\/acp-(?:bin|node)\b/);
  });

  it("packages the local-model Python SDK as an unpacked desktop resource", () => {
    const builderConfig = readFileSync(
      new URL("../electron-builder.yml", import.meta.url),
      "utf8",
    );

    expect(builderConfig).toMatch(
      /-\s+from:\s+\.\.\/\.\.\/packages\/clash-sdk\/python\n\s+to:\s+clash-sdk\/python/m,
    );
    expect(builderConfig).toMatch(/-\s+"clash_sdk\/\*\*\/\*"/m);
    expect(builderConfig).toContain('- "!**/__pycache__/**"');
    expect(builderConfig).toContain('- "!**/*.py[cod]"');
  });

  it("ships a Clash desktop app icon instead of the Electron default", () => {
    const iconUrl = new URL("../build/icon.icns", import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
    expect(statSync(iconUrl).size).toBeGreaterThan(10_000);
    expect(readFileSync(iconUrl).subarray(0, 4).toString("ascii")).toBe("icns");
  });

  it("uses a full-size centered desktop icon source", () => {
    const iconSvg = readFileSync(
      new URL("../build/icon.svg", import.meta.url),
      "utf8",
    );

    expect(iconSvg).toContain('viewBox="0 0 1024 1024"');
    expect(iconSvg).toContain('rx="216"');
    expect(iconSvg).toContain(
      "translate(512 512) scale(0.86) translate(-636 -601)",
    );
  });

  it("injects the desktop runtime mode into the renderer", () => {
    const preload = readFileSync(
      new URL("./preload.ts", import.meta.url),
      "utf8",
    );

    expect(preload).toMatch(/mode:\s*runtimeConfig\.mode/);
    expect(preload).toMatch(/capabilities:\s*runtimeConfig\.capabilities/);
  });
});
