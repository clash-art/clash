// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("./SettingsSurface", () => ({
  readLastSettingsSection: () => "agents",
  writeLastSettingsSection: vi.fn(),
  SettingsSurface: ({ active, onActiveChange, onExpand }: { active: string; onActiveChange: (section: string) => void; onExpand?: () => void }) => (
    <div><span>{active}</span><button onClick={() => onActiveChange("skills")}>Skills</button><button onClick={onExpand}>Expand</button></div>
  ),
}));
afterEach(cleanup);
it("expands the current category without resetting to the initial category", () => {
  const onExpand = vi.fn();
  render(<SettingsDialog open initialSection="models" onClose={() => undefined} onExpand={onExpand} />);
  fireEvent.click(screen.getByRole("button", { name: "Skills" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(onExpand).toHaveBeenCalledWith("skills");
});
