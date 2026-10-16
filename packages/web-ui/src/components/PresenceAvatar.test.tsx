// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceClient } from "@clash/shared-types";
import { colorForUserId, type Peer } from "../hooks/usePresenceAwareness";
import CursorOverlay from "./CursorOverlay";
import PeerSelectionRing from "./PeerSelectionRing";
import PresenceBar from "./PresenceBar";

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

    const label = (cursor: Element) =>
      cursor.querySelector('[data-slot="badge"][data-presence-kind]');
    expect(background(label(agentCursor))).toBe(background(label(humanCursor)));
    expect(background(agentBadges(agentCursor)[0])).toBe(
      background(label(humanCursor)),
    );
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
    expect(labels[1].querySelector("svg")).not.toBeNull();
    expect(background(labels[1])).toBe(background(labels[0]));
  });

  it("stacks every session of a user with the same avatar, badging the agent", () => {
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
    const [humanAvatar, agentAvatar] = Array.from(
      container.querySelectorAll("[data-presence-kind]"),
    );

    expect(screen.getByLabelText("Ann Lee")).toBeTruthy();
    expect(screen.getByLabelText("Ann Lee · Agent")).toBeTruthy();
    expect(agentBadges(humanAvatar)).toHaveLength(0);
    expect(agentBadges(agentAvatar)).toHaveLength(1);

    const fallback = (avatar: Element) =>
      avatar.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback(agentAvatar)?.textContent).toBe("AL");
    expect(fallback(agentAvatar)?.textContent).toBe(
      fallback(humanAvatar)?.textContent,
    );
    expect(background(fallback(agentAvatar))).toBe(
      background(fallback(humanAvatar)),
    );
  });
});
