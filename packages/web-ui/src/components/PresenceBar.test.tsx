// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PresenceClient } from "@clash/shared-types";
import PresenceBar, {
  groupPresenceClients,
  PresenceSessions,
} from "./PresenceBar";
import { visiblePresenceClients } from "../lib/presenceVisibility";

afterEach(cleanup);
const human: PresenceClient = {
  id: "window",
  userId: "ann",
  name: "Ann Lee",
  kind: "human",
  clientType: "browser",
  device: "Chrome · macOS",
};
const host: PresenceClient = {
  ...human,
  id: "host",
  kind: "agent",
  clientType: "cli",
  device: "Clash Host · studio",
};

it("hides self, groups other windows and agents, and deduplicates connection ids", () => {
  const other = { ...human, id: "other" };
  expect(
    groupPresenceClients(
      visiblePresenceClients([human, other, host, host], human.id),
    ),
  ).toEqual([[other, host]]);
});

it("shows per-session device and kind with icons and a legacy window fallback", () => {
  const { container } = render(
    <PresenceSessions
      sessions={[human, host, { ...human, id: "legacy", device: undefined }]}
    />,
  );
  expect(screen.getByText("Ann Lee")).toBeTruthy();
  expect(screen.getByText("Chrome · macOS · Human")).toBeTruthy();
  expect(screen.getByText("Clash Host · studio · Agent")).toBeTruthy();
  expect(screen.getByText("Another window · Human")).toBeTruthy();
  expect(container.querySelectorAll("svg")).toHaveLength(3);
});

it("overflows by people rather than sessions and exposes hidden people on keyboard focus", async () => {
  const others = ["Bea", "Cam", "Dee", "Eli", "Flo"].map((name) => ({
    ...human,
    id: name,
    userId: name,
    name,
  }));
  render(<PresenceBar clients={[human, host, ...others]} />);
  expect(screen.getByLabelText("Ann Lee · 2 sessions")).toBeTruthy();
  expect(screen.queryByLabelText("Eli · 1 session")).toBeNull();
  const overflow = screen.getByLabelText("2 more participants: Eli, Flo");
  expect(overflow.tabIndex).toBe(0);
  await act(async () => {
    overflow.focus();
  });
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("Eli");
  expect(tooltip.textContent).toContain("Flo");
});
