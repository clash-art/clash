// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { sourceContains } from "@clash/gui/test-support/source-match";

import {
  Tab,
  TabList,
  TabProvider,
  appTabTriggerClassName,
} from "./tabs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const globalsCss = readFileSync(
  resolve(repoRoot, "apps/web/app/globals.css"),
  "utf8",
);

function TabSwitchHarness({ initialId = "a" }: { initialId?: string }) {
  const [selectedId, setSelectedId] = useState(initialId);
  return (
    <TabProvider
      selectedId={selectedId}
      setSelectedId={(id) => {
        if (typeof id === "string") setSelectedId(id);
      }}
    >
      <TabList aria-label="Example tabs">
        <Tab
          id="a"
          className={appTabTriggerClassName({
            selected: selectedId === "a",
            className: "px-3 py-1",
          })}
        >
          Alpha
        </Tab>
        <Tab
          id="b"
          className={appTabTriggerClassName({
            selected: selectedId === "b",
            className: "px-3 py-1",
          })}
        >
          Beta
        </Tab>
      </TabList>
    </TabProvider>
  );
}

function isSelectedTab(element: HTMLElement): boolean {
  return element.className.includes("app-tab-trigger-selected");
}

function isRestTab(element: HTMLElement): boolean {
  return element.className.includes("app-tab-trigger-rest");
}

afterEach(() => {
  cleanup();
});

describe("tab selection styling", () => {
  it("ships distinct hover, selected, and focus-visible rules in globals", () => {
    expect(sourceContains(globalsCss, ".app-tab-trigger-selected:hover")).toBe(
      true,
    );
    expect(sourceContains(globalsCss, "--app-tab-hover-bg:")).toBe(true);
    expect(sourceContains(globalsCss, "--app-tab-focus-ring:")).toBe(true);
    expect(globalsCss).toContain(".app-tab-trigger:focus-visible");
    expect(globalsCss).not.toMatch(
      /--app-tab-hover-bg:\s*var\(--app-tab-selected-bg\)/,
    );
  });

  it("leaves only the selected tab highlighted after mouse switch and pointer leave", () => {
    render(<TabSwitchHarness />);

    const alpha = screen.getByRole("tab", { name: "Alpha" });
    const beta = screen.getByRole("tab", { name: "Beta" });

    fireEvent.click(beta);
    fireEvent.mouseOut(beta);
    fireEvent.mouseLeave(document.body);

    expect(alpha.getAttribute("aria-selected")).toBe("false");
    expect(beta.getAttribute("aria-selected")).toBe("true");
    expect(isSelectedTab(alpha)).toBe(false);
    expect(isRestTab(alpha)).toBe(true);
    expect(isSelectedTab(beta)).toBe(true);
  });

  it("keeps selected styling while hovering an inactive tab", () => {
    render(<TabSwitchHarness initialId="a" />);

    const alpha = screen.getByRole("tab", { name: "Alpha" });
    const beta = screen.getByRole("tab", { name: "Beta" });

    fireEvent.mouseOver(beta);

    expect(isSelectedTab(alpha)).toBe(true);
    expect(isRestTab(beta)).toBe(true);
    expect(beta.getAttribute("aria-selected")).toBe("false");
  });

  it("wires focus-visible outline utilities on tab triggers", () => {
    render(<TabSwitchHarness initialId="a" />);

    const beta = screen.getByRole("tab", { name: "Beta" });
    expect(beta.className).toContain("focus-visible:outline");
    expect(beta.className).toContain("--app-tab-focus-ring");
  });
});
