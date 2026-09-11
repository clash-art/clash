// @vitest-environment jsdom
import { memo } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Peer } from "../hooks/usePresenceAwareness";
import {
  PresenceAwarenessProvider,
  usePeersSelectingNode,
  useAllPeers,
  usePeerName,
} from "./PresenceAwarenessContext";

afterEach(cleanup);
const peer: Peer = {
  userId: "alice",
  userName: "Alice",
  color: "red",
  selectedNodeIds: ["chosen"],
  cursor: { x: 0, y: 0 },
};

describe("presence subscriptions", () => {
  it("does not render unselected cards when a peer moves, but updates selected cards and cursors", () => {
    const renders = new Map<string, number>();
    const Card = memo(function Card({ id }: { id: string }) {
      const peers = usePeersSelectingNode(id);
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return (
        <output data-testid={id}>
          {peers.map((p) => `${p.userName}:${p.cursor?.x}`).join(",")}
        </output>
      );
    });
    const Cursor = memo(function Cursor() {
      return (
        <output data-testid="cursor">{useAllPeers()[0]?.cursor?.x}</output>
      );
    });
    const children = (
      <>
        <Card id="chosen" />
        <Card id="unrelated" />
        <Cursor />
      </>
    );
    const view = render(
      <PresenceAwarenessProvider peers={[peer]}>
        {children}
      </PresenceAwarenessProvider>,
    );
    const before = renders.get("unrelated");
    view.rerender(
      <PresenceAwarenessProvider peers={[{ ...peer, cursor: { x: 40, y: 5 } }]}>
        {children}
      </PresenceAwarenessProvider>,
    );
    expect(renders.get("unrelated")).toBe(before);
    expect(screen.getByTestId("chosen").textContent).toBe("Alice:40");
    expect(screen.getByTestId("cursor").textContent).toBe("40");
  });

  it("moves peer selection between cards and removes it on disconnect", () => {
    const Card = memo(function Card({ id }: { id: string }) {
      return (
        <output data-testid={id}>
          {usePeersSelectingNode(id)
            .map((p) => p.userName)
            .join(",")}
        </output>
      );
    });
    const children = (
      <>
        <Card id="chosen" />
        <Card id="other" />
      </>
    );
    const view = render(
      <PresenceAwarenessProvider peers={[peer]}>
        {children}
      </PresenceAwarenessProvider>,
    );
    view.rerender(
      <PresenceAwarenessProvider
        peers={[{ ...peer, userName: "Alicia", selectedNodeIds: ["other"] }]}
      >
        {children}
      </PresenceAwarenessProvider>,
    );
    expect(screen.getByTestId("chosen").textContent).toBe("");
    expect(screen.getByTestId("other").textContent).toBe("Alicia");
    view.rerender(
      <PresenceAwarenessProvider peers={[]}>
        {children}
      </PresenceAwarenessProvider>,
    );
    expect(screen.getByTestId("other").textContent).toBe("");
  });
});

it("keeps attribution stable on cursor movement and updates it on rename/disconnect", () => {
  let renders = 0;
  const Name = memo(function Name() {
    renders += 1;
    return (
      <output data-testid="name">{usePeerName("alice") ?? "offline"}</output>
    );
  });
  const children = <Name />;
  const view = render(
    <PresenceAwarenessProvider peers={[peer]}>
      {children}
    </PresenceAwarenessProvider>,
  );
  const before = renders;
  view.rerender(
    <PresenceAwarenessProvider peers={[{ ...peer, cursor: { x: 50, y: 0 } }]}>
      {children}
    </PresenceAwarenessProvider>,
  );
  expect(renders).toBe(before);
  view.rerender(
    <PresenceAwarenessProvider peers={[{ ...peer, userName: "Alicia" }]}>
      {children}
    </PresenceAwarenessProvider>,
  );
  expect(screen.getByTestId("name").textContent).toBe("Alicia");
  view.rerender(
    <PresenceAwarenessProvider peers={[]}>
      {children}
    </PresenceAwarenessProvider>,
  );
  expect(screen.getByTestId("name").textContent).toBe("offline");
});

it("keeps unrelated cards quiet across repeated broadcasts on a large canvas", () => {
  const renders = new Map<string, number>();
  const Card = memo(function Card({ id }: { id: string }) {
    const selecting = usePeersSelectingNode(id);
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return <span>{selecting[0]?.userName}</span>;
  });
  const nodeIds = [
    "chosen",
    ...Array.from({ length: 999 }, (_, index) => `card-${index}`),
  ];
  const children = nodeIds.map((id) => <Card key={id} id={id} />);
  const view = render(
    <PresenceAwarenessProvider peers={[peer]}>
      {children}
    </PresenceAwarenessProvider>,
  );
  const before = new Map(renders);
  for (const x of [10, 20, 30]) {
    view.rerender(
      <PresenceAwarenessProvider peers={[{ ...peer, cursor: { x, y: 0 } }]}>
        {children}
      </PresenceAwarenessProvider>,
    );
  }
  for (const id of nodeIds.filter((id) => id !== "chosen")) {
    expect(renders.get(id)).toBe(before.get(id));
  }
  expect(renders.get("chosen")).toBeGreaterThan(before.get("chosen")!);
});
