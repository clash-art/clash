import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourceContains } from "@clash/gui/test-support/source-match";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const readRepoFile = (path: string) =>
  readFileSync(resolve(repoRoot, path), "utf8");

describe("application theme contract", () => {
  it("ships a shared theme controller instead of relying on orphan dark classes", () => {
    expect(
      existsSync(resolve(repoRoot, "packages/web-ui/src/lib/theme.ts")),
    ).toBe(true);
    expect(
      existsSync(
        resolve(repoRoot, "packages/web-ui/src/components/ThemeProvider.tsx"),
      ),
    ).toBe(true);

    const main = readRepoFile("apps/web/app/main.tsx");
    expect(main).toContain("<ThemeProvider>");
  });

  it("sets the persisted or system appearance before the application paints", () => {
    const html = readRepoFile("apps/web/index.html");

    expect(html).toContain('name="color-scheme"');
    expect(html).toContain("clash.appearance");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('classList.toggle("dark"');
  });

  it("persists and applies a contrast-safe custom accent before first paint", () => {
    const html = readRepoFile("apps/web/index.html");
    const theme = readRepoFile("packages/web-ui/src/lib/theme.ts");

    expect(theme).toContain("ACCENT_STORAGE_KEY");
    expect(theme).toContain("normalizeAccentColor");
    expect(theme).toContain("resolveAccentForeground");
    expect(theme).toContain("applyAccentColor");
    expect(html).toContain("clash.accent");
    expect(html).toContain("--clash-accent");
    expect(html).toContain("--clash-accent-foreground");
  });

  it("maps warm surfaces to theme-aware semantic variables", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(css).toContain("--color-warm-page: var(--clash-warm-page)");
    expect(css).toContain("--color-warm-surface: var(--clash-warm-surface)");
    expect(css).toContain("--color-warm-muted: var(--clash-warm-muted)");
    expect(css).toContain("--color-warm-hover: var(--clash-warm-hover)");
    expect(css).toContain("--color-warm-border: var(--clash-warm-border)");
    expect(css).toMatch(/\.dark\s*\{[\s\S]*--clash-warm-page:/);
    expect(css).toContain("color-scheme: light");
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain("--color-brand: var(--clash-accent)");
    expect(css).toContain(
      "--color-brand-foreground: var(--clash-accent-foreground)",
    );
  });

  it("centralizes content hierarchy and transient overlays as semantic tokens", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(css).toContain("--clash-content-primary:");
    expect(css).toContain("--clash-content-secondary:");
    expect(css).toContain("--clash-content-muted:");
    expect(css).toContain("--clash-content-disabled:");
    expect(css).toContain("--clash-overlay-surface:");
    expect(css).toContain("--clash-overlay-border:");
    expect(css).toContain("--clash-overlay-shadow:");
    expect(css).toContain(
      "--color-content-primary: var(--clash-content-primary)",
    );
    expect(css).toContain(
      "--color-content-secondary: var(--clash-content-secondary)",
    );
    expect(css).toContain("--color-content-muted: var(--clash-content-muted)");
    expect(css).toContain(
      "--color-content-disabled: var(--clash-content-disabled)",
    );
    expect(css).toContain(
      "--color-overlay-surface: var(--clash-overlay-surface)",
    );
    expect(css).toContain(
      "--color-overlay-border: var(--clash-overlay-border)",
    );
    expect(css).toContain("--shadow-overlay: var(--clash-overlay-shadow)");
    expect(css).toContain(
      "--clash-floating-panel-background: var(--clash-overlay-surface)",
    );
    expect(css).toContain(
      "--clash-floating-panel-border: var(--clash-overlay-border)",
    );
    expect(css).toContain(
      "--clash-floating-panel-shadow: var(--clash-overlay-shadow)",
    );
    expect(css).toContain(
      "--clash-timeline-text-secondary: var(--clash-content-secondary)",
    );
    expect(css).toContain(
      "--clash-timeline-text-tertiary: var(--clash-content-muted)",
    );
    expect(css).toContain(
      "--clash-timeline-text-disabled: var(--clash-content-disabled)",
    );
  });

  it("tokenizes timeline material colors for a neutral dark palette", () => {
    const css = readRepoFile("apps/web/app/globals.css");
    const styles = readRepoFile(
      "packages/remotion-ui/src/components/timeline/styles.ts",
    );

    for (const material of [
      "video",
      "audio",
      "image",
      "text",
      "effect",
      "overlay",
      "solid",
    ]) {
      expect(css).toContain(`--clash-timeline-item-${material}:`);
      expect(css).toContain(`--clash-timeline-item-${material}-foreground:`);
      expect(styles).toContain(`var(--clash-timeline-item-${material},`);
      expect(styles).toContain(
        `var(--clash-timeline-item-${material}-foreground,`,
      );
    }

    expect(css).toMatch(
      /\.dark\s*\{[\s\S]*--clash-timeline-item-text: #2d2d2d/,
    );
    expect(css).toContain("--clash-timeline-audio-waveform:");
    expect(styles).toContain("var(--clash-timeline-audio-waveform,");
  });

  it("keeps the empty-project guide on theme-aware surfaces", () => {
    const css = readRepoFile("apps/web/app/globals.css");
    const guideCanvas = css.match(
      /\.clash-projects-empty-canvas\s*\{([\s\S]*?)\}/,
    )?.[1];
    const guideNode = css.match(
      /\.clash-projects-empty-node\s*\{([\s\S]*?)\}/,
    )?.[1];

    expect(guideCanvas).toContain("var(--clash-overlay-surface)");
    expect(guideCanvas).toContain("var(--clash-overlay-border)");
    expect(guideCanvas).not.toContain("rgba(255, 254, 253");
    expect(guideNode).toContain("var(--clash-warm-surface)");
    expect(guideNode).toContain("var(--clash-warm-border)");
    expect(css).toMatch(
      /\.clash-projects-empty-node strong\s*\{[\s\S]*color:\s*var\(--clash-content-primary\)/,
    );
  });

  it("keeps shared popup primitives on centralized theme-aware surfaces", () => {
    const css = readRepoFile("apps/web/app/globals.css");
    const primitivePaths = [
      "packages/gui/src/components/ui/dropdown-menu.tsx",
      "packages/gui/src/components/ui/popover.tsx",
      "packages/gui/src/components/ui/context-menu.tsx",
      "packages/gui/src/components/ui/searchable-select.tsx",
      "packages/gui/src/components/ui/select.tsx",
    ];

    // Popups paint from one of the shared surfaces: the select surface class,
    // the popover token, or the overlay token. None may carry its own chrome.
    for (const path of primitivePaths) {
      const source = readRepoFile(path);
      expect(source, path).toMatch(
        /\b(?:app-select-content|bg-popover|bg-overlay-surface)\b/,
      );
      expect(source, path).not.toContain("rgba(35,31,25");
      expect(source, path).not.toContain("dark:shadow-");
    }

    const selectSurface = css.match(/\.app-select-content\s*\{([\s\S]*?)\}/)?.[1];
    expect(selectSurface).toMatch(/background:\s*var\(--/);
    expect(selectSurface).toMatch(/border:[^;]*var\(--/);
    expect(selectSurface).toMatch(/box-shadow:\s*var\(--/);
    expect(css).toMatch(/\.dark\s*\{[\s\S]*?--popover:/);
  });

  it("keeps editor surfaces from falling back to literal light chrome", () => {
    const forbiddenBySurface = [
      {
        path: "packages/remotion-ui/src/components/TranscriptEditor.tsx",
        tokens: [
          "bg-white",
          "bg-[#fbfaf8]",
          "border-stone-200",
          "bg-stone-100",
          "#ff6b50",
          "#d65540",
          "#ffe4dc",
          "#e85f47",
          "#c94f3a",
          "#ff8a72",
        ],
      },
      {
        path: "packages/web-ui/src/components/ScopedAssetPicker.tsx",
        tokens: [
          "bg-[#f8f7f5]",
          "bg-white/90",
          "bg-white/55",
          "border-stone-300",
        ],
      },
      {
        path: "packages/remotion-ui/src/components/PropertiesPanel.tsx",
        tokens: ["bg-white"],
      },
      {
        path: "packages/web-ui/src/components/ProjectEditor.tsx",
        tokens: ["bg-white/90", "hover:bg-white"],
      },
      {
        path: "packages/web-ui/src/components/nodes/ActionBadge.tsx",
        tokens: [
          'overlayClassName="bg-white/80"',
          "bg-white/60",
          "hover:bg-white",
          "border-slate-300",
        ],
      },
      {
        path: "packages/web-ui/src/components/VideoClipperContext.tsx",
        tokens: ["hover:bg-slate-50"],
      },
      {
        path: "packages/web-ui/src/components/GlobalAssetsClient.tsx",
        tokens: ["bg-white/20", "hover:bg-white/45"],
      },
      {
        path: "packages/web-ui/src/components/SettingsClient.tsx",
        tokens: [
          "sticky top-0 z-40 bg-white/80",
          "rounded-lg border border-rose-200 bg-white",
          '? "bg-white text-brand',
          "hover:bg-white/70",
        ],
      },
      {
        path: "packages/web-ui/src/components/ProjectWorkspaceSurfaces.tsx",
        tokens: ["rgba(255,255,255,0.96)"],
      },
      {
        path: "packages/remotion-ui/src/components/InteractiveCanvas.tsx",
        tokens: ['stroke="#FF6B50"', 'fill="#ffffff"'],
      },
      {
        path: "packages/remotion-ui/src/components/timeline/PrimaryTranscriptWordbar.tsx",
        tokens: [
          "#e7e2dc",
          "rgba(241, 239, 236, 0.96)",
          "#ffe4dc",
          "rgba(255, 254, 253, 0.94)",
        ],
      },
      {
        path: "packages/remotion-ui/src/components/timeline/TimelineItem.tsx",
        tokens: ["background: '#fffefd'"],
      },
      {
        path: "packages/remotion-ui/src/components/timeline/TimelineControls.tsx",
        tokens: ["border: 2px solid #fff"],
      },
      {
        path: "packages/web-ui/src/components/ImageEditorContext.tsx",
        tokens: ["hover:bg-slate-50", "border-slate-300", "border-emerald-"],
      },
      {
        path: "apps/web/app/routes/__canvas-perf.tsx",
        tokens: ["bg-white/90"],
      },
      {
        path: "packages/web-ui/src/components/ui/button.tsx",
        tokens: ["border border-red-200 bg-white"],
      },
      {
        path: "packages/web-ui/src/components/ChatbotCopilot.tsx",
        tokens: ["border-amber-300 bg-white"],
      },
      {
        path: "packages/web-ui/src/components/copilot/SessionHarnessUpdateBanner.tsx",
        tokens: ["bg-[#fff8f4]"],
      },
    ] as const;

    for (const { path, tokens } of forbiddenBySurface) {
      const source = readRepoFile(path);
      for (const token of tokens) {
        expect(source, `${path} still contains ${token}`).not.toContain(token);
      }
    }
  });

  it("keeps secondary editor dialogs and asset surfaces on semantic dark tokens", () => {
    const forbiddenBySurface = [
      {
        path: "packages/web-ui/src/components/VideoClipperContext.tsx",
        tokens: [
          "text-base font-semibold text-slate-800",
          "hover:bg-slate-100",
          "text-2xl font-mono text-slate-800",
          "text-base font-mono text-slate-800",
          "text-red-600 bg-red-50 border border-red-200",
        ],
      },
      {
        path: "packages/web-ui/src/components/GlobalAssetsClient.tsx",
        tokens: ["bg-stone-100 text-stone-400", "font-semibold text-slate-900"],
      },
      {
        path: "packages/web-ui/src/components/ProjectWorkspaceSurfaces.tsx",
        tokens: [
          "font-medium text-slate-700",
          "font-semibold text-stone-600",
          "overflow-hidden bg-stone-100",
          "text-stone-500 hover:bg-warm-muted hover:text-slate-950",
        ],
      },
      {
        path: "packages/web-ui/src/components/ProjectWorkspaceNavigator.tsx",
        tokens: [
          "aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-stone-100",
          "font-semibold text-slate-900",
        ],
      },
      {
        path: "packages/web-ui/src/components/ProjectEditor.tsx",
        tokens: [
          "text-stone-600 transition-colors hover:bg-warm-muted hover:text-slate-950",
          '"bg-brand/[0.08] text-slate-950"',
          '"text-stone-600 hover:bg-warm-muted hover:text-slate-950"',
          "bg-warm-surface text-stone-400 shadow-sm hover:bg-warm-muted hover:text-slate-900",
          "bg-transparent text-stone-500 hover:text-slate-950",
          "text-slate-300 cursor-not-allowed",
        ],
      },
      {
        path: "packages/web-ui/src/components/UserControls.tsx",
        tokens: ["hover:bg-stone-200/70", "hover:text-stone-950"],
      },
      {
        path: "packages/web-ui/src/components/copilot/NodeProposalCard.tsx",
        tokens: [
          "font-semibold text-slate-800",
          "text-slate-700 hover:bg-warm-muted",
        ],
      },
      {
        path: "packages/remotion-ui/src/components/Editor.tsx",
        tokens: [
          "bg-warm-surface/95 px-2.5 py-1.5 text-xs font-medium text-slate-800",
          "bg-transparent text-stone-500 transition-colors hover:bg-warm-muted hover:text-slate-950",
        ],
      },
      {
        path: "packages/remotion-ui/src/components/CaptionWorkspace.tsx",
        tokens: ["text-stone-", "text-slate-"],
      },
      {
        path: "packages/web-ui/src/components/nodes/DirectorStageNode.tsx",
        tokens: [
          "text-[#5f9eff]",
          "font-semibold text-slate-800",
          "font-medium text-emerald-700",
        ],
      },
      {
        path: "packages/web-ui/src/components/nodes/TextNode.tsx",
        tokens: ["prose-headings:text-slate-900", "prose-p:text-slate-700"],
      },
      {
        path: "packages/web-ui/src/components/nodes/PromptNode.tsx",
        tokens: ["prose-headings:text-slate-900", "prose-p:text-slate-700"],
      },
      {
        path: "packages/web-ui/src/components/nodes/VideoClipperNode.tsx",
        tokens: ["aspect-video bg-stone-100"],
      },
      {
        path: "packages/web-ui/src/components/nodes/ImageEditorNode.tsx",
        tokens: ["aspect-video bg-stone-100"],
      },
      {
        path: "packages/web-ui/src/components/nodes/BuildPlanDialog.tsx",
        tokens: [
          "font-bold text-slate-900",
          "hover:text-slate-950",
          "font-medium text-slate-800 truncate",
          "bg-amber-50 border border-amber-200",
        ],
      },
      {
        path: "packages/web-ui/src/components/nodes/CloneTrajectoryDialog.tsx",
        tokens: [
          "font-bold text-slate-900",
          "hover:text-slate-950",
          '<strong className="text-slate-900">',
        ],
      },
      {
        path: "packages/web-ui/src/components/nodes/AudioNode.tsx",
        tokens: [
          "font-bold text-slate-900",
          "hover:text-slate-900",
          "bg-slate-200 flex",
          '"bg-slate-900" : "bg-slate-200',
          "bg-slate-900 text-white",
        ],
      },
      {
        path: "packages/web-ui/src/components/nodes/ActionBadge.tsx",
        tokens: ['<span className="font-medium text-stone-800">'],
      },
    ] as const;

    for (const { path, tokens } of forbiddenBySurface) {
      const source = readRepoFile(path);
      for (const token of tokens) {
        expect(source, `${path} still contains ${token}`).not.toContain(token);
      }
    }
  });

  it("uses neutral gray dark surfaces and a theme-aware launcher mark", () => {
    const css = readRepoFile("apps/web/app/globals.css");
    const topNavigation = readRepoFile(
      "packages/web-ui/src/components/TopNavigation.tsx",
    );
    const dark = css.match(/\n\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    for (const name of ["page", "surface", "muted", "hover", "border"]) {
      const value = dark.match(
        new RegExp(`--clash-warm-${name}:\\s*#([0-9a-f]{6})\\b`, "i"),
      )?.[1];
      expect(value, `--clash-warm-${name}`).toBeDefined();
      const [red, green, blue] = value!.match(/../g)!;
      expect(green, `--clash-warm-${name}`).toBe(red);
      expect(blue, `--clash-warm-${name}`).toBe(red);
    }
    // The launcher avatar inherits its ink from the theme instead of a
    // dark-only literal override.
    expect(css).toMatch(
      /\.clash-agent-motion\s*\{[^}]*color:\s*var\(--clash-agent-avatar-ink\)/,
    );
    expect(css).not.toMatch(/\.dark \.clash-copilot-launcher/);
    expect(sourceContains(topNavigation, 'name="markDark"')).toBe(true);
    expect(topNavigation).not.toContain("dark:grayscale");
  });

  it("keeps project preview placeholders on theme-aware surfaces when media thumbnails are unavailable", () => {
    const css = readRepoFile("apps/web/app/globals.css");
    const card = readRepoFile("packages/web-ui/src/components/ProjectCard.tsx");

    for (const className of [
      "clash-project-card-frame",
      "clash-project-card-empty",
    ]) {
      expect(card, className).toContain(className);
      const rule = css.match(
        new RegExp(`\\.${className}\\s*\\{([\\s\\S]*?)\\}`),
      )?.[1];
      expect(rule, className).toMatch(/background:\s*var\(--/);
    }
    expect(css).not.toContain(".clash-project-card-asset-fallback::after");
    expect(css).not.toContain(".clash-project-card-empty::after");
  });

  it("keeps authentication copy and the brand mark readable in dark mode", () => {
    const login = readRepoFile("apps/web/app/routes/login.tsx");
    const brandAsset = readRepoFile(
      "packages/web-ui/src/components/BrandAsset.tsx",
    );

    // Copy follows semantic tokens, so no literal palette text colour may
    // pin it to one appearance.
    expect(login).toContain("text-foreground");
    expect(login).not.toMatch(
      /\btext-(?:slate|neutral|gray|zinc|stone|black|white)\b/,
    );
    expect(sourceContains(login, 'name="mark"')).toBe(true);
    expect(sourceContains(login, 'name="markDark"')).toBe(true);
    expect(brandAsset).toContain("/brand/logo-mark-dark.svg");
    expect(
      existsSync(
        resolve(repoRoot, "apps/web/public/brand/logo-mark-dark.svg"),
      ),
    ).toBe(true);
  });

  it("exposes Appearance as a real persisted settings section", () => {
    const surface = readRepoFile(
      "packages/web-ui/src/components/SettingsSurface.tsx",
    );
    const client = readRepoFile(
      "packages/web-ui/src/components/SettingsClient.tsx",
    );

    expect(sourceContains(surface, "id: 'appearance'")).toBe(true);
    expect(sourceContains(client, "| 'appearance'")).toBe(true);
    expect(client).toContain("<AppearanceSection />");
  });

  it("keeps the desktop chrome and editing shell on semantic surfaces", () => {
    const topNavigation = readRepoFile(
      "packages/web-ui/src/components/TopNavigation.tsx",
    );
    const editor = readRepoFile(
      "packages/remotion-ui/src/components/Editor.tsx",
    );

    expect(topNavigation).not.toContain("border-[#e1ddd5]");
    expect(topNavigation).not.toContain("bg-[#f0eee9]");
    expect(editor).not.toMatch(/\bbg-white\b/);
    expect(editor).not.toContain("bg-[#ebe7e1]");
  });
});
