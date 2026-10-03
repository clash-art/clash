// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  Tab,
  TabList,
  TabProvider,
  appTabTriggerClassName,
} from "./tabs";

const tabContractCss = `
  :root {
    --app-tab-hover-bg: rgb(237, 237, 237);
    --app-tab-selected-bg: rgb(220, 233, 247);
    --app-tab-selected-fg: rgb(30, 41, 59);
  }
  .app-tab-trigger-rest { background: transparent; }
  .app-tab-trigger-rest:hover:not([aria-disabled="true"]) {
    background: var(--app-tab-hover-bg);
  }
  .app-tab-trigger-selected {
    background: var(--app-tab-selected-bg);
    color: var(--app-tab-selected-fg);
  }
  .app-tab-trigger-rest:focus:not(:focus-visible) {
    background: transparent;
    box-shadow: none;
  }
`;

function injectTabContractStyles() {
  const style = document.createElement("style");
  style.textContent = tabContractCss;
  document.head.appendChild(style);
  return () => style.remove();
}

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

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("style").forEach((node) => node.remove());
});

function isSelectedTab(element: HTMLElement): boolean {
  return element.className.includes("app-tab-trigger-selected");
}

describe("tab selection styling", () => {
  it("leaves only the selected tab highlighted after mouse switch and pointer leave", () => {
    injectTabContractStyles();
    render(<TabSwitchHarness />);

    const alpha = screen.getByRole("tab", { name: "Alpha" });
    const beta = screen.getByRole("tab", { name: "Beta" });

    expect(alpha.getAttribute("aria-selected")).toBe("true");
    expect(isSelectedTab(alpha)).toBe(true);
    expect(isSelectedTab(beta)).toBe(false);

    fireEvent.click(beta);
    fireEvent.mouseOut(beta);
    fireEvent.mouseLeave(document.body);

    expect(alpha.getAttribute("aria-selected")).toBe("false");
    expect(beta.getAttribute("aria-selected")).toBe("true");
    expect(isSelectedTab(alpha)).toBe(false);
    expect(isSelectedTab(beta)).toBe(true);
  });

  it("does not keep hover fill on inactive tabs after click blur", () => {
    injectTabContractStyles();
    render(<TabSwitchHarness initialId="a" />);

    const alpha = screen.getByRole("tab", { name: "Alpha" });
    const beta = screen.getByRole("tab", { name: "Beta" });

    fireEvent.mouseOver(alpha);
    fireEvent.click(beta);
    fireEvent.mouseOut(alpha);
    fireEvent.mouseOut(beta);

    expect(isSelectedTab(alpha)).toBe(false);
    expect(isSelectedTab(beta)).toBe(true);
    expect(alpha.className).toContain("app-tab-trigger-rest");
  });
});
