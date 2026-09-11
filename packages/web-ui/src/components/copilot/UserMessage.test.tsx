// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserMessage } from "./UserMessage";
import { MediaViewerProvider } from "../MediaViewerContext";

vi.mock("./AgentAnnotationBlock", () => ({
  AgentAnnotationTray: ({
    annotations,
  }: {
    annotations: Array<{ id: string }>;
  }) => (
    <div data-testid="submitted-annotation-gui">
      {annotations.length} annotation
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UserMessage", () => {
  it("does not render host-injected context in a replayed user message", () => {
    render(<UserMessage content={[
      "[Clash host context — supplied by the application, not written by the user]",
      'Session binding: {"projectId":"private-project"}',
      "[/Clash host context]",
      "看看我打开了",
    ].join("\n")} />);
    expect(screen.getByText("看看我打开了")).toBeTruthy();
    expect(screen.queryByText(/private-project|Clash host context/)).toBeNull();
  });

  it("uses the compact workspace message surface instead of a floating card", () => {
    const { container } = render(<UserMessage content="hi" />);
    const bubble = container.querySelector(".clash-user-message-bubble");
    const message = container.querySelector<HTMLElement>(
      '[data-chat-user-message="true"]',
    );

    expect(bubble).toBeTruthy();
    expect(message).toBeTruthy();
    expect(message?.style.maxWidth).toBe(
      "min(34rem, var(--chat-user-message-max-width, 72%))",
    );
    expect(bubble).toHaveAttribute("data-chat-typography", "body");
    expect(bubble?.className).not.toContain("shadow-sm");
    expect(bubble?.className).not.toContain("rounded-[18px]");
  });

  it("does not sign an object-store key embedded in a legacy mention thumbnail", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: "https://signed.clash.test/private.webp",
            exp: Math.floor(Date.now() / 1000) + 3_600,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const { container } = render(
      <MediaViewerProvider>
        <UserMessage
          content="@[Private](node:image-1)"
          mentionNodes={[
            {
              id: "image-1",
              type: "image",
              label: "Private",
              thumbnail: "projects/project-1/private.webp",
            },
          ]}
        />
      </MediaViewerProvider>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders only the submitted annotation GUI when a message has annotations", () => {
    render(
      <UserMessage
        content={[
          '<!-- clash-workspace-context {"version":1,"projectId":"project-1"} -->',
          '<!-- clash-agent-annotations {"version":1,"kind":"clash-agent-annotations","annotations":[{"id":"annotation-1","kind":"agent-annotation","note":"Move this earlier.","target":{"projectId":"project-1","surface":"canvas","surfaceId":"main","surfaceLabel":"Main","objectId":"node-1","objectType":"canvas-image","objectLabel":"Hero still","objectPath":"canvases/main/nodes/node-1","capabilities":["read","modify"]}}]} -->',
          "Make this feel more cinematic.",
        ].join("\n")}
      />,
    );

    expect(screen.queryByText("Make this feel more cinematic.")).toBeNull();
    expect(screen.getByTestId("submitted-annotation-gui").textContent).toBe(
      "1 annotation",
    );
    expect(screen.queryByText(/clash-agent-annotations/)).toBeNull();
    expect(screen.queryByText(/clash-workspace-context/)).toBeNull();
  });
});
