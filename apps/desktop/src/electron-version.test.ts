import { existsSync, readFileSync, statSync } from "node:fs";
import {
  sourceContains,
  sourceMatches,
} from "../../../packages/gui/test-support/source-match.js";
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
    expect(builderConfig).toContain("provider: github");
    expect(builderConfig).toContain("owner: clash-art");
    expect(builderConfig).toContain("repo: clash");
    expect(builderConfig).toMatch(/^\s+icon:\s+build\/icon\.icns$/m);
    expect(builderConfig).toMatch(/target:\n(?:\s+-\s+\w+\n)*\s+-\s+dmg/m);
    expect(builderConfig).toContain("- zip");
    expect(manifest.dependencies?.["electron-updater"]).toBeTruthy();
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
      "--mac dmg zip --arm64",
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
    const desktopPrepare = rootManifest.scripts?.["prepare:desktop-pack"] ?? "";
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
      expect(packageScript ?? "").not.toContain(
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
      expect(rootManifest.scripts?.[script] ?? "").toContain(
        "pnpm prepare:desktop-pack",
      );
    }
    expect(manifest.devDependencies?.["electron-builder"]).toBe("^26.17.0");
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
    expect(builderConfig).toContain("from: build/clash-runtime/node_modules");
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
    const packaging = readFileSync(
      new URL(
        "../../../.github/workflows/package-desktop.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(release).toContain("package-desktop:");
    expect(
      sourceMatches(
        release,
        /uses:\s*\.\/\.github\/workflows\/package-desktop\.yml/,
      ),
    ).toBe(true);
    expect(packaging).toContain("macos-latest");
    expect(packaging).toContain("platform: macOS-arm64");
    expect(packaging).toContain("platform: macOS-x64");
    expect(packaging).toContain(
      "apps/desktop/release/Clash-Desktop-macOS-arm64.dmg",
    );
    expect(packaging).toContain(
      "apps/desktop/release/Clash-Desktop-macOS-x64.dmg",
    );
    expect(packaging).toContain("windows-latest");
    expect(packaging).toContain("ubuntu-latest");
    expect(
      sourceMatches(packaging, /uses:\s*actions\/upload-artifact@v\d+\b/),
    ).toBe(true);
    expect(packaging).toContain("Clash-Desktop-${{ matrix.platform }}");
    expect(packaging).toContain("pnpm run ${{ matrix.script }}");
    expect(packaging).toContain("script: pack:desktop:mac:arm64");
    expect(packaging).toContain("CSC_IDENTITY_AUTO_DISCOVERY=true");
    expect(packaging).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
    expect(packaging).toContain("CSC_FOR_PULL_REQUEST=true");
    expect(packaging).toContain("MAC_CSC_LINK");
    expect(packaging).toContain("CLASH_DESKTOP_MAC_SIGN_MODE=developer-id");
    expect(packaging).toContain("packaged-binary-sanity.ts");
    expect(release).toContain("publish-desktop-preview:");
    expect(
      sourceMatches(release, /uses:\s*actions\/download-artifact@v\d+\b/),
    ).toBe(true);
    expect(release).toContain("gh release upload desktop-preview");
    expect(release).toContain("environment: desktop-preview-acceptance");
  });

  it("gives the desktop renderer enough heap on packaging runners", () => {
    const packaging = readFileSync(
      new URL(
        "../../../.github/workflows/package-desktop.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const heapLimit = packaging.match(
      /NODE_OPTIONS:\s*["']?--max-old-space-size=(\d+)["']?/,
    )?.[1];

    expect(Number(heapLimit)).toBeGreaterThanOrEqual(4096);
  });

  it("runs repository automation on Node 24 based action releases", () => {
    const workspaceSetup = readFileSync(
      new URL(
        "../../../.github/actions/setup-workspace/action.yml",
        import.meta.url,
      ),
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
    const ci = readFileSync(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const packaging = readFileSync(
      new URL(
        "../../../.github/workflows/package-desktop.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(
      sourceMatches(workspaceSetup, /uses:\s*pnpm\/action-setup@v6\b/),
    ).toBe(true);
    expect(
      sourceMatches(workspaceSetup, /uses:\s*actions\/setup-node@v7\b/),
    ).toBe(true);
    for (const workflow of [ci, publishBeta, packaging]) {
      expect(sourceMatches(workflow, /uses:\s*actions\/checkout@v7\b/)).toBe(
        true,
      );
      expect(
        sourceMatches(
          workflow,
          /uses:\s*\.\/\.github\/actions\/setup-workspace\b/,
        ),
      ).toBe(true);
      expect(workflow.indexOf("actions/checkout@v7")).toBeLessThan(
        workflow.indexOf("./.github/actions/setup-workspace"),
      );
    }
    expect(sourceMatches(publishBeta, /uses:\s*actions\/setup-node@v7\b/)).toBe(
      true,
    );
    expect(
      sourceMatches(packaging, /uses:\s*actions\/upload-artifact@v7\b/),
    ).toBe(true);
    expect(
      sourceMatches(release, /uses:\s*actions\/download-artifact@v8\b/),
    ).toBe(true);
  });

  it("installs published OpenMA common from the v0.7.9 git tag", () => {
    const pin = /github:openma-ai\/openma-common#v0\.7\.9/;
    for (const relativePath of [
      "../../../package.json",
      "../../../apps/local-api/package.json",
      "../../../apps/desktop/package.json",
      "../../../packages/web-ui/package.json",
      "../../../apps/web/package.json",
    ]) {
      const manifest = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(sourceMatches(manifest, pin)).toBe(true);
    }
  });

  it("checks out the pinned OpenMA common release without running its suite", () => {
    const commonSetup = readFileSync(
      new URL(
        "../../../.github/actions/setup-common/action.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const workspaceSetup = readFileSync(
      new URL(
        "../../../.github/actions/setup-workspace/action.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const packageCheck = readFileSync(
      new URL("../../../.github/workflows/package-check.yml", import.meta.url),
      "utf8",
    );

    const pin = readFileSync(
      new URL("../../../.github/actions/setup-common/pin.env", import.meta.url),
      "utf8",
    );
    expect(pin).toContain(
      "OPENMA_COMMON_SHA=afc628e5d624cc1aa61625185a1348bb87f32c05",
    );
    expect(pin).toContain("OPENMA_COMMON_TAG=v0.7.9");
    expect(pin).toContain("OPENMA_COMMON_TARBALL_SHA256=\n");
    expect(pin).toContain("OPENMA_COMMON_TARBALL_URL=\n");
    expect(commonSetup).toContain(".github/actions/setup-common/pin.env");
    expect(commonSetup).not.toContain(
      "b3ddd9fbddae0d6cdd8e68d8b900823373497728",
    );
    expect(
      sourceMatches(
        commonSetup,
        /git clone .*https:\/\/github\.com\/openma-ai\/openma-common\.git/,
      ),
    ).toBe(true);
    expect(sourceMatches(commonSetup, /checkout --detach/)).toBe(true);
    expect(commonSetup).toContain("core.autocrlf=false");
    expect(commonSetup).toContain("verify-openma-prebuilt.ts");
    expect(
      sourceContains(
        commonSetup,
        'pnpm --dir "${dest}" install --frozen-lockfile',
      ),
    ).toBe(true);
    expect(commonSetup).not.toContain("typecheck");
    expect(commonSetup).not.toMatch(/pnpm[^\n]*\b(build|verify|test)\b/);
    expect(commonSetup).not.toContain("setup-uv");
    expect(commonSetup).not.toContain("openssl-req-leaf");
    expect(
      sourceMatches(
        workspaceSetup,
        /uses:\s*\.\/\.github\/actions\/setup-common\b/,
      ),
    ).toBe(true);
    expect(
      workspaceSetup.indexOf("pnpm install --frozen-lockfile"),
    ).toBeGreaterThan(
      workspaceSetup.indexOf("uses: ./.github/actions/setup-common"),
    );
    expect(packageCheck).toContain("workflow_dispatch:");
    expect(packageCheck).toContain("ci:package");
    expect(packageCheck).toContain("secrets: inherit");
    expect(packageCheck).not.toContain("NPM_TOKEN");
  });

  it("keeps self-hosted ACP runtimes out of immutable desktop resources", () => {
    const builderConfig = readFileSync(
      new URL("../electron-builder.yml", import.meta.url),
      "utf8",
    );

    expect(builderConfig).not.toMatch(/\bbuild\/acp-(?:bin|node)\b/);
  });

  it("configures macOS hardened signing and notarization for Developer ID CI", () => {
    const builderConfig = readFileSync(
      new URL("../electron-builder.yml", import.meta.url),
      "utf8",
    );
    const release = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(builderConfig).toContain("appId: app.clash.video");
    expect(builderConfig).not.toContain("dev.openma.backchat");
    expect(builderConfig).toContain("hardenedRuntime: true");
    expect(builderConfig).toContain("entitlements: build/entitlements.mac.plist");
    expect(builderConfig).toContain("notarize: true");
    expect(builderConfig).not.toContain('identity: "-"');
    expect(release).toContain("secrets: inherit");
    expect(
      readFileSync(
        new URL("../../../.github/workflows/package-check.yml", import.meta.url),
        "utf8",
      ),
    ).toContain("secrets: inherit");
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
