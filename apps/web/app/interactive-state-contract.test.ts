// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sourceContains, sourceMatches } from "@clash/gui/test-support/source-match";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const readRepoFile = (path: string) =>
  readFileSync(resolve(repoRoot, path), "utf8");

describe("interactive state styling contract", () => {
  it("does not treat expanded/open as menu focus highlight", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(
      sourceMatches(
        css,
        /\.app-select-focus:is\(\[data-highlighted\],\s*\[data-selected="true"\],\s*:focus-visible\)/,
      ),
    ).toBe(true);
    expect(css).not.toMatch(
      /\.app-select-focus:is\([\s\S]{0,180}\[data-state="open"\]/,
    );
  });

  it("keeps sidebar row actions unhighlighted while a menu is open", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(
      sourceMatches(
        css,
        /\.sidebar-row-action:hover,\s*\.sidebar-row-action:focus-visible/,
      ),
    ).toBe(true);
    expect(css).not.toMatch(/\.sidebar-row-action\[data-state="open"\]/);
  });

  it("does not paint canvas toolbar dropdown open state as selected", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(css).not.toMatch(
      /\.clash-canvas-toolbar-surface[\s\S]{0,400}\[data-state="open"\][\s\S]{0,120}--select-item-selected/,
    );
  });

  it("keeps select submenu triggers off the open-state hover fill", () => {
    const selectSource = readRepoFile(
      "packages/gui/src/components/ui/select.tsx",
    );

    expect(selectSource).not.toContain("data-[state=open]:bg");
  });

  it("documents shared interactive surface tokens in globals", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(css).toContain(".app-interactive-surface {");
    expect(css).toContain(".app-interactive-selected,");
    expect(sourceContains(css, ":focus:not(:focus-visible)")).toBe(true);
  });

  it("documents tab contract tokens and mouse-focus reset", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(css).toContain("--app-tab-selected-bg");
    expect(css).toContain(".app-tab-trigger-rest");
    expect(css).toContain("[role=\"tab\"]:focus:not(:focus-visible):not([aria-selected=\"true\"])");
  });

  it("uses a single inset tab focus ring that survives overflow clipping", () => {
    const css = readRepoFile("apps/web/app/globals.css");

    expect(sourceContains(css, "--app-tab-focus-width:")).toBe(true);
    expect(sourceMatches(
      css,
      /\.app-tab-trigger:focus-visible[\s\S]{0,220}outline-offset:\s*calc\(-1 \* var\(--app-tab-focus-width\)\)/,
    )).toBe(true);
    expect(css).not.toMatch(
      /\.app-tab-trigger:focus-visible[\s\S]{0,160}box-shadow:\s*0 0 0 1px var\(--app-tab-focus-ring\)/,
    );
  });
});
