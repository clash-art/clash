// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceClient } from "@clash/shared-types";
import { colorForUserId, type Peer } from "../hooks/usePresenceAwareness";
import CursorOverlay from "./CursorOverlay";
import PeerSelectionRing from "./PeerSelectionRing";
import PresenceBar, { PresenceSessions } from "./PresenceBar";
import { fireEvent } from "@testing-library/react";

vi.mock("@xyflow/react", () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

afterEach(cleanup);

const agentBadges = (root: ParentNode) =>
  root.querySelectorAll("[data-presence-agent-badge]");
const background = (element: Element | null | undefined) =>
  (element as HTMLElement).style.background;

// One user, two connections: a second window and an agent acting for them.
const human: Peer = {
  clientId: "window",
  userId: "ann",
  kind: "human",
  userName: "Ann Lee",
  color: colorForUserId("ann"),
  cursor: { x: 10, y: 20 },
  selectedNodeIds: ["node"],
};
const agent: Peer = { ...human, clientId: "agent", kind: "agent" };

describe("presence identity", () => {
  it("draws an agent cursor as its user's cursor plus the agent badge", () => {
    const { container } = render(<CursorOverlay peers={[human, agent]} />);
    const humanCursor = container.querySelector('[data-peer-cursor="window"]')!;
    const agentCursor = container.querySelector('[data-peer-cursor="agent"]')!;

    expect(humanCursor.textContent).toBe("Ann Lee");
    expect(agentCursor.textContent).toBe("Ann Lee · Agent");
    expect(agentBadges(humanCursor)).toHaveLength(0);
    expect(agentBadges(agentCursor)).toHaveLength(1);
    const badge = agentBadges(agentCursor)[0];
    expect(badge.classList.contains("rounded-full")).toBe(false);
    expect(
      Array.from(badge.classList).some((name) => name.startsWith("ring-")),
    ).toBe(false);
    expect(badge.classList.contains("bg-warm-surface")).toBe(false);
    expect(badge.classList.contains("shadow-sm")).toBe(false);
    expect(
      badge.classList.contains("drop-shadow-[0_0_1px_rgba(0,0,0,0.45)]"),
    ).toBe(true);

    const label = (cursor: Element) =>
      cursor.querySelector('[data-slot="badge"][data-presence-kind]');
    expect(background(label(agentCursor))).toBe(background(label(humanCursor)));
    const mark = agentBadges(agentCursor)[0].querySelector(
      '[data-slot="clash-agent-avatar"]',
    )!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("data-agent-motion-state")).toBe("idle");
    fireEvent.pointerMove(agentBadges(agentCursor)[0], {
      clientX: 100,
      clientY: 100,
    });
    expect(mark.getAttribute("data-agent-motion-tracking")).toBe("false");
    expect(agentCursor.querySelector("svg")?.getAttribute("fill")).toBe(
      humanCursor.querySelector("svg")?.getAttribute("fill"),
    );
  });

  it("labels a selection ring per session, marking only the agent", () => {
    const { container } = render(<PeerSelectionRing peers={[human, agent]} />);
    const labels = container.querySelectorAll('[data-slot="badge"]');

    expect(Array.from(labels, (label) => label.textContent)).toEqual([
      "Ann Lee",
      "Ann Lee · Agent",
    ]);
    expect(labels[0].querySelector("svg")).toBeNull();
    expect(
      labels[1].querySelector('[data-slot="clash-agent-avatar"]'),
    ).not.toBeNull();
    expect(background(labels[1])).toBe(background(labels[0]));
  });

  it("groups a user’s sessions into one avatar with the shared agent badge", () => {
    const clients: PresenceClient[] = [
      {
        id: "window",
        clientType: "browser",
        kind: "human",
        userId: "ann",
        name: "Ann Lee",
      },
      {
        id: "agent",
        clientType: "cli",
        kind: "agent",
        userId: "ann",
        name: "Ann Lee",
      },
    ];
    const { container } = render(<PresenceBar clients={clients} />);
    expect(container.querySelectorAll("[data-presence-kind]")).toHaveLength(1);
    expect(screen.getByLabelText("Ann Lee · 2 sessions")).toBeTruthy();
    expect(agentBadges(container)).toHaveLength(1);
    expect(
      agentBadges(container)[0].querySelector(
        '[data-slot="clash-agent-avatar"]',
      ),
    ).not.toBeNull();

    const rows = render(<PresenceSessions sessions={clients} />);
    const mark = rows.container.querySelector(
      '[data-slot="clash-agent-avatar"]',
    );
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.getAttribute("data-agent-motion-state")).toBe("idle");
  });
});
