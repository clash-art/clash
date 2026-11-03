// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createAgentUIStore, type AgentUIStore } from "@openma/common/agent-ui";
import { decodeAcpSessionUpdate } from "@openma/common/protocol/acp";
import {
  createOpenMAEvent,
  type OpenMAEvent,
} from "@openma/common/session-events/openma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./UserMessage", () => ({
  UserMessage: ({ content }: { content: string }) => (
    <div data-testid="clash-inline-prompt">{content}</div>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "copilot.status.interrupted") return "已中断";
      if (key === "copilot.turn.copyAnswer") return "复制回答";
      if (key === "copilot.turn.answerCopied") return "已复制";
      if (key === "copilot.turn.continueInNewChat") return "在新对话中继续";
      return key;
    },
  }),
}));

import { RuntimeSessionTimeline } from "./RuntimeSessionTimeline";

function dispatch(
  store: AgentUIStore,
  eventId: string,
  type: string,
  data: unknown,
  turnId = "turn-1",
): void {
  store.dispatch(
    createOpenMAEvent({
      event_id: eventId,
      type,
      session_id: store.getState().sessionId,
      turn_id: turnId,
      source: { kind: "harness", harness: "codex-acp" },
      occurred_at: `2026-08-27T00:00:0${store.getState().seenEventIds[eventId] ? 2 : 1}.000Z`,
      data,
    }) as OpenMAEvent,
  );
}

function completedCodexTurn(): AgentUIStore {
  const store = createAgentUIStore("session-codex");
  dispatch(store, "user", "user.message", {
    message_id: "user-1",
    text: "hi",
  });
  dispatch(store, "running", "session.running", {});
  dispatch(store, "thought", "agent.thinking", {
    message_id: "thought-1",
    text: "Preparing simple hello response",
  });
  dispatch(store, "answer", "agent.message_chunk", {
    message_id: "answer-1",
    text: "Hi! What can I help you with?",
    phase: "final_answer",
  });
  dispatch(store, "complete", "turn.completed", {});
  return store;
}

describe("RuntimeSessionTimeline", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollTo = vi.fn();
  });

  it("shows thought elapsed time from the event clock", () => {
    const store = createAgentUIStore("session-timing");
    for (const [id, type, time, data] of [
      ["start", "session.running", "01", {}],
      [
        "thought",
        "agent.thinking",
        "02",
        { message_id: "thought", text: "Plan" },
      ],
      [
        "answer",
        "agent.message_chunk",
        "07",
        { text: "Done", phase: "final_answer" },
      ],
      ["end", "turn.completed", "10", {}],
    ] as const) {
      store.dispatch(
        createOpenMAEvent({
          event_id: id,
          type,
          session_id: "session-timing",
          turn_id: "turn-1",
          source: { kind: "harness", harness: "codex-acp" },
          occurred_at: `2026-09-09T00:00:${time}.000Z`,
          data,
        }) as OpenMAEvent,
      );
    }
    render(
      <RuntimeSessionTimeline
        store={store}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));
    expect(screen.getByRole("button", { name: "已思考 5 秒" })).toBeVisible();
  });

  it("uses the upstream live thought fallback and keeps Markdown in the thought body", () => {
    const store = createAgentUIStore("session-markdown");
    dispatch(store, "user", "user.message", {
      message_id: "user",
      text: "Inspect",
    });
    dispatch(store, "running", "session.running", {});
    dispatch(store, "tool", "tool.started", {
      tool_call_id: "tool",
      name: "read",
      title: "Read file",
    });
    dispatch(store, "thought", "agent.thinking", {
      message_id: "thought",
      text: "**Searching ALL_TOOLS**",
    });
    const { container } = render(
      <RuntimeSessionTimeline
        store={store}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );
    const thoughtRows = [
      ...container.querySelectorAll<HTMLElement>('[data-thought-block="true"]'),
    ];
    expect(thoughtRows.length).toBeGreaterThan(0);
    const liveRow = thoughtRows.find(
      (row) => row.getAttribute("data-thought-live") === "true",
    );
    expect(liveRow).toBeTruthy();
    const trigger = liveRow!.querySelector<HTMLElement>(
      "[data-chat-turn-disclosure-trigger]",
    );
    // 0.11 projects a live thought as the fallback label; Markdown belongs to
    // the body it owns, not to the summary row.
    expect(trigger).toHaveTextContent("正在思考");
    expect(trigger).not.toHaveTextContent("**");
    const body = liveRow!.querySelector<HTMLElement>(
      '[data-thought-stream-body="true"]',
    );
    expect(body).toHaveAttribute("hidden");
    fireEvent.click(trigger!);
    expect(body).not.toHaveAttribute("hidden");
    expect(body?.querySelector("strong")).toHaveTextContent(
      "Searching ALL_TOOLS",
    );
  });

  it("shows restored text immediately instead of replaying it as new tokens", () => {
    const store = createAgentUIStore("restored-session");
    dispatch(store, "user", "user.message", { text: "Continue" });
    dispatch(store, "running", "session.running", {});
    dispatch(store, "answer", "agent.message_chunk", {
      text: "Already received history",
      phase: "final_answer",
    });
    const { container, unmount } = render(
      <RuntimeSessionTimeline
        store={store}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );
    expect(
      container.querySelector('[data-agent-ui-streaming-markdown="assistant"]'),
    ).toHaveTextContent("Already received history");
    unmount();
  });

  it("opts the Clash side panel into the shared compact density", () => {
    render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const surface = document.querySelector<HTMLElement>(
      '[data-chat-surface="main"]',
    );
    expect(surface).toHaveAttribute("data-chat-density", "compact");
    expect(document.querySelector("[data-turn-id]")?.className).toContain(
      "!mb-6 !space-y-3",
    );
  });

  it("does not stack the host height animation on the shared process disclosure", () => {
    render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const processDisclosure = document.querySelector(".reasoning-collapse");
    expect(processDisclosure).toBeTruthy();
    expect(processDisclosure).not.toHaveClass("clash-collapsible-content");
  });

  it("renders Backchat-compatible time and copy after a completed turn", () => {
    render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const turn = document.querySelector('[data-turn-id="turn-1"]');
    expect(turn?.querySelector("[data-turn-footer='true']")).toBeTruthy();
    expect(
      turn?.querySelector("[data-turn-timestamp='2026-08-27T00:00:01.000Z']"),
    ).toBeTruthy();
    expect(
      turn
        ?.querySelector("[data-turn-copy-action='true']")
        ?.getAttribute("aria-label"),
    ).toBe("复制回答");
  });

  it("offers fork only on the latest completed turn when the host enables it", () => {
    const store = createAgentUIStore("session-two-turns");
    for (const [index, turnId] of ["turn-old", "turn-latest"].entries()) {
      dispatch(
        store,
        `user-${turnId}`,
        "user.message",
        {
          message_id: `user-${turnId}`,
          text: `Prompt ${index + 1}`,
        },
        turnId,
      );
      dispatch(store, `running-${turnId}`, "session.running", {}, turnId);
      dispatch(
        store,
        `answer-${turnId}`,
        "agent.message_chunk",
        {
          message_id: `answer-${turnId}`,
          text: `Answer ${index + 1}`,
          phase: "final_answer",
        },
        turnId,
      );
      dispatch(store, `complete-${turnId}`, "turn.completed", {}, turnId);
    }
    const onFork = vi.fn();

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
        onFork={onFork}
      />,
    );

    const forkActions = document.querySelectorAll(
      "[data-turn-fork-action='true']",
    );
    expect(forkActions).toHaveLength(1);
    expect(
      forkActions[0]?.closest("[data-turn-id]")?.getAttribute("data-turn-id"),
    ).toBe("turn-latest");

    fireEvent.click(forkActions[0]!);
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it("forks each completed turn at its own assistant message when supported", () => {
    const store = createAgentUIStore("session-two-turns");
    for (const [index, turnId] of ["turn-old", "turn-latest"].entries()) {
      dispatch(
        store,
        `user-${turnId}`,
        "user.message",
        {
          message_id: `user-${turnId}`,
          text: `Prompt ${index + 1}`,
        },
        turnId,
      );
      dispatch(store, `running-${turnId}`, "session.running", {}, turnId);
      dispatch(
        store,
        `answer-${turnId}`,
        "agent.message_chunk",
        {
          message_id: `answer-${turnId}`,
          text: `Answer ${index + 1}`,
          phase: "final_answer",
        },
        turnId,
      );
      dispatch(store, `complete-${turnId}`, "turn.completed", {}, turnId);
    }
    const onFork = vi.fn();

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
        onForkAtMessage={onFork}
      />,
    );

    const forkActions = document.querySelectorAll(
      "[data-turn-fork-action='true']",
    );
    expect(forkActions).toHaveLength(2);
    expect(
      forkActions[0]?.closest("[data-turn-id]")?.getAttribute("data-turn-id"),
    ).toBe("turn-old");

    fireEvent.click(forkActions[0]!);
    expect(onFork).toHaveBeenCalledWith({ messageId: "answer-turn-old", messageText: "Answer 1", messageOccurrence: 1 });
  });

  it("withholds fork while another turn is active", () => {
    const store = completedCodexTurn();
    dispatch(
      store,
      "user-active",
      "user.message",
      {
        message_id: "user-active",
        text: "Follow up",
      },
      "turn-active",
    );
    dispatch(store, "running-active", "session.running", {}, "turn-active");

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
        onFork={() => undefined}
      />,
    );

    expect(document.querySelector("[data-turn-fork-action='true']")).toBeNull();
  });

  it("keeps the animated Clash persona at the left of the running disclosure", () => {
    const store = createAgentUIStore("session-running-persona");
    dispatch(store, "user-running-persona", "user.message", {
      message_id: "user-running-persona",
      text: "Keep working",
    });
    dispatch(store, "running-persona", "session.running", {});

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const disclosure = screen.getByRole("button", { name: /正在工作/ });
    const persona = disclosure.querySelector(
      '[data-session-process-avatar="true"]',
    );
    expect(persona).toBeTruthy();
    expect(disclosure.firstElementChild).toBe(persona);
    expect(
      persona?.querySelector('[data-agent-motion-state="working"]'),
    ).toBeTruthy();
  });

  it("keeps the idle Clash persona at the left of a completed disclosure", () => {
    render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const disclosure = screen.getByRole("button", { name: /已工作/ });
    const persona = disclosure.querySelector(
      '[data-session-process-avatar="true"]',
    );
    expect(persona).toBeTruthy();
    expect(disclosure.firstElementChild).toBe(persona);
    expect(
      persona?.querySelector('[data-agent-motion-state="idle"]'),
    ).toBeTruthy();
  });

  it("lets the completed process persona follow movement across the timeline surface", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });

    render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const surface = screen.getByTestId("runtime-session-timeline");
    const persona = surface.querySelector<HTMLElement>(
      '[data-agent-motion-state="idle"]',
    );
    expect(persona).toBeTruthy();
    vi.spyOn(persona!, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 120,
      bottom: 120,
      width: 20,
      height: 20,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerMove(surface, {
      clientX: 220,
      clientY: 120,
      pointerType: "mouse",
    });

    expect(persona).toHaveAttribute("data-agent-motion-tracking", "true");
    expect(persona?.style.getPropertyValue("--clash-agent-eye-x")).not.toBe(
      "0px",
    );
  });

  it("keeps a cancelled process collapsed with one localized inline status", () => {
    const store = createAgentUIStore("session-cancelled-process");
    dispatch(store, "user-cancelled", "user.message", {
      message_id: "user-cancelled",
      text: "Inspect the canvas",
    });
    dispatch(store, "running-cancelled", "session.running", {});
    dispatch(store, "thought-cancelled", "agent.thinking", {
      message_id: "thought-cancelled",
      text: "Inspecting",
    });
    dispatch(store, "cancelled", "turn.cancelled", {});

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const turn = document.querySelector(
      '[data-session-turn-status="cancelled"]',
    );
    const disclosure = screen.getByRole("button", {
      name: /已中断.*已工作/,
    });
    expect(turn).toBeTruthy();
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(
      disclosure.querySelector('[data-agent-motion-state="idle"]'),
    ).toBeTruthy();
    expect(
      turn?.querySelector('[data-session-turn-status-message="cancelled"]'),
    ).toBeNull();
    expect(screen.getAllByText("已中断")).toHaveLength(1);
  });

  it("keeps Codex thought state and reveals it through Backchat disclosures", () => {
    const store = completedCodexTurn();
    expect(store.getState().turns["turn-1"]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "thinking",
          text: "Preparing simple hello response",
        }),
      ]),
    );

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
        slots={{
          beforeComposer: <div data-testid="before-composer" />,
          composer: <div data-testid="common-composer" />,
          afterComposer: <div data-testid="after-composer" />,
        }}
      />,
    );

    const surface = document.querySelector('[data-chat-surface="main"]');
    const composer = surface?.querySelector('[data-chat-column="composer"]');
    expect(surface).toBeTruthy();
    expect(surface?.querySelector('[data-chat-column="turns"]')).toBeTruthy();
    expect(composer).toBeTruthy();
    expect(composer?.children[0]).toHaveAttribute(
      "data-testid",
      "before-composer",
    );
    expect(composer?.children[1]).toHaveAttribute(
      "data-testid",
      "common-composer",
    );
    expect(composer?.children[2]).toHaveAttribute(
      "data-testid",
      "after-composer",
    );
    expect(screen.getByText("Hi! What can I help you with?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByText("Preparing simple hello response")).toBeVisible();
    expect(document.querySelector('[data-thought-block="true"]')).toBeTruthy();
  });

  it("keeps Clash inline capabilities inside the Backchat timeline", () => {
    const store = createAgentUIStore("session-clash");
    dispatch(store, "user", "user.message", {
      message_id: "user-1",
      text: "Inspect it",
    });
    dispatch(store, "running", "session.running", {});
    dispatch(store, "commentary", "agent.message_chunk", {
      message_id: "commentary-1",
      text: "I am checking the runtime.",
      phase: "commentary",
    });
    dispatch(store, "thought", "agent.thinking", {
      message_id: "thought-1",
      text: "Checking the runtime",
    });
    dispatch(store, "tool", "tool.started", {
      tool_call_id: "tool-clash",
      kind: "read",
      status: "in_progress",
      title: "Read runtime.ts",
    });
    dispatch(store, "answer", "agent.message_chunk", {
      message_id: "answer-1",
      text: "Done",
      phase: "final_answer",
    });
    dispatch(store, "complete", "turn.completed", {});

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    expect(screen.getByTestId("runtime-session-timeline")).toHaveAttribute(
      "data-renderer",
      "backchat",
    );
    expect(
      document.querySelector('[data-backchat-session-timeline="true"]'),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-session-process-avatar="true"] [data-agent-motion-state="idle"]',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("clash-inline-prompt")).toHaveTextContent(
      "Inspect it",
    );
    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));
    const activityGroup = document.querySelector(
      '[data-collapsible-event-count="2"]',
    );
    expect(activityGroup).toBeTruthy();
    fireEvent.click(activityGroup!.querySelector("button")!);
    expect(screen.getByTestId("acp-tool-row")).toHaveTextContent(
      "Read runtime.ts",
    );
    expect(
      document.querySelector('[data-assistant-section="process"]'),
    ).toHaveTextContent("I am checking the runtime.");
    expect(
      document.querySelector('[data-assistant-section="answer"]'),
    ).toHaveTextContent("Done");
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByText("Checking the runtime")).toBeVisible();
    expect(
      document.querySelector('[data-testid="acp-message-list"]'),
    ).toBeNull();
  });

  it("folds consecutive completed tools into the Backchat activity sequence", () => {
    const store = createAgentUIStore("session-tools");
    dispatch(store, "user", "user.message", {
      message_id: "user-tools",
      text: "Inspect the canvas",
    });
    dispatch(store, "running", "session.running", {});
    for (const [index, title] of [
      "Read file",
      "Workspace Init",
      "Canvas",
      "Canvas 12 items",
    ].entries()) {
      const toolCallId = `tool-${index + 1}`;
      dispatch(store, `${toolCallId}:start`, "tool.started", {
        tool_call_id: toolCallId,
        kind: "read",
        status: "in_progress",
        title,
      });
      dispatch(store, `${toolCallId}:complete`, "tool.completed", {
        tool_call_id: toolCallId,
        kind: "read",
        status: "completed",
        title,
      });
    }
    dispatch(store, "answer", "agent.message_chunk", {
      message_id: "answer-tools",
      text: "Done",
      phase: "final_answer",
    });
    dispatch(store, "complete", "turn.completed", {});

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));
    const group = document.querySelector('[data-tool-group-size="4"]');
    expect(group).toBeTruthy();
    expect(screen.getAllByTestId("acp-tool-row")).toHaveLength(4);
    const groupBody = group?.querySelector<HTMLElement>(":scope > div");
    expect(groupBody).toHaveAttribute("hidden");
    expect(groupBody).toHaveAttribute("inert");

    const trigger = group?.querySelector("button");
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger!);
    expect(groupBody).not.toHaveAttribute("hidden");
    expect(groupBody).not.toHaveAttribute("inert");
    expect(screen.getAllByTestId("acp-tool-row")).toHaveLength(4);
  });

  it("keeps completed tool rows available under the thinking fallback while streaming", () => {
    const store = createAgentUIStore("session-live-tail-tool");
    dispatch(store, "user-live-tail", "user.message", {
      message_id: "user-live-tail",
      text: "Search the project",
    });
    dispatch(store, "running-live-tail", "session.running", {});
    for (const [index, title] of [
      "components",
      "renderer",
      "dialog",
    ].entries()) {
      const toolCallId = `search-${index + 1}`;
      dispatch(store, `${toolCallId}:start`, "tool.started", {
        tool_call_id: toolCallId,
        kind: "search",
        status: "in_progress",
        title,
      });
      dispatch(store, `${toolCallId}:complete`, "tool.completed", {
        tool_call_id: toolCallId,
        kind: "search",
        status: "completed",
        title,
      });
    }

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const group = document.querySelector('[data-tool-group-size="3"]');
    const trigger = group?.querySelector<HTMLElement>(":scope > button");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // openma 0.12+: completed tool group while turn still streams shows the
    // thinking fallback on the group trigger (not a fake live "搜索中").
    expect(trigger).toHaveTextContent("正在思考");

    fireEvent.click(trigger!);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const rows = screen.getAllByTestId("acp-tool-row");
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)).toHaveTextContent("已搜索");
    expect(rows.at(-1)).not.toHaveClass("animate-pulse");
  });

  it("uses the Backchat live renderer for the running turn tail", () => {
    const store = createAgentUIStore("session-live-answer");
    dispatch(store, "user-live-answer", "user.message", {
      message_id: "user-live-answer",
      text: "Answer directly",
    });
    dispatch(store, "running-live-answer", "session.running", {});
    dispatch(store, "answer-live-answer", "agent.message", {
      message_id: "answer-live-answer",
      text: "Visible answer",
      phase: "final_answer",
    });

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    expect(
      document.querySelector('[data-agent-ui-streaming-markdown="assistant"]'),
    ).toBeTruthy();
  });

  it("does not render a work disclosure for a pure answer", () => {
    const store = createAgentUIStore("session-pure-answer");
    dispatch(store, "user-pure-answer", "user.message", {
      message_id: "user-pure-answer",
      text: "Answer directly",
    });
    dispatch(store, "running-pure-answer", "session.running", {});
    dispatch(store, "answer-pure-answer", "agent.message_chunk", {
      message_id: "answer-pure-answer",
      text: "Visible answer",
      phase: "final_answer",
    });
    dispatch(store, "complete-pure-answer", "turn.completed", {});

    render(
      <RuntimeSessionTimeline
        store={store}
        agentId="codex-acp"
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    expect(screen.getByText("Visible answer")).toBeVisible();
    expect(screen.queryByRole("button", { name: /已工作/ })).toBeNull();
  });

  it("collapses the process strip when a watched turn completes (Backchat homage)", () => {
    const store = createAgentUIStore("session-process-open");
    dispatch(store, "user-process", "user.message", {
      message_id: "user-process",
      text: "Inspect the files",
    });
    dispatch(store, "running-process", "session.running", {});
    dispatch(store, "thought-process", "agent.thinking", {
      message_id: "thought-process",
      text: "Checking files",
    });

    render(
      <RuntimeSessionTimeline
        store={store}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const runningActivity = document.querySelector<HTMLElement>(
      '[data-session-process-state="running"] [data-session-process-activity="true"]',
    );
    expect(runningActivity).toBeTruthy();
    expect(runningActivity).not.toHaveAttribute("hidden");

    act(() => {
      dispatch(store, "complete-process", "turn.completed", {});
    });

    const stoppedProcess = document.querySelector<HTMLElement>(
      '[data-session-process-state="complete"]',
    );
    expect(stoppedProcess).toBeTruthy();
    // collapseProcessOnComplete: process header stays; body closes via Collapsible.
    const processHeader = screen.getByRole("button", { name: /已工作/ });
    expect(processHeader).toHaveAttribute("aria-expanded", "false");
    const collapse = stoppedProcess?.querySelector(".reasoning-collapse");
    expect(collapse).toHaveAttribute("data-state", "closed");
    expect(
      stoppedProcess?.querySelector('[data-session-process-activity="true"]'),
    ).toBeTruthy();
  });

  it("wires AgentUITurnView without a host max-width override on the turn root", () => {
    const { container } = render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );
    const turn = container.querySelector("[data-turn-id]");
    expect(turn).toBeTruthy();
    // Parent chat-turn-frame owns max-w-3xl; turn root must not !max-w-3xl.
    expect(turn?.className ?? "").not.toMatch(/max-w-3xl/);
  });

  it("does not mount a collapsed history process body until opened", () => {
    render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const process = document.querySelector<HTMLElement>(
      '[data-session-process-state="complete"]',
    );
    expect(process).toBeTruthy();
    expect(
      process?.querySelector('[data-session-process-activity="true"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));

    expect(
      document.querySelector('[data-session-process-activity="true"]'),
    ).toBeTruthy();
  });

  it("reserves the footer slot while running and fades it in when watched to completion", () => {
    const store = createAgentUIStore("session-footer-live");
    dispatch(store, "user-footer", "user.message", {
      message_id: "user-footer",
      text: "Finish the task",
    });
    dispatch(store, "running-footer", "session.running", {});

    render(
      <RuntimeSessionTimeline
        store={store}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    const reserved = document.querySelector<HTMLElement>(
      "[data-session-turn-footer-slot]",
    );
    expect(reserved).toHaveAttribute(
      "data-session-turn-footer-slot",
      "reserved",
    );
    expect(reserved?.querySelector("[data-turn-footer='true']")).toBeNull();

    act(() => {
      dispatch(store, "complete-footer", "turn.completed", {});
    });

    const entering = document.querySelector<HTMLElement>(
      "[data-session-turn-footer-slot]",
    );
    expect(entering).toHaveAttribute(
      "data-session-turn-footer-slot",
      "entering",
    );
    expect(entering?.querySelector("[data-turn-footer='true']")).toBeTruthy();
  });

  it("renders a history footer settled instead of entering", () => {
    render(
      <RuntimeSessionTimeline
        store={completedCodexTurn()}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    expect(
      document.querySelector("[data-session-turn-footer-slot]"),
    ).toHaveAttribute("data-session-turn-footer-slot", "settled");
  });

  it("concatenates ACP message chunk deltas exactly through the Clash store path", () => {
    const store = createAgentUIStore("session-acp-fidelity");
    dispatch(store, "user-acp-fidelity", "user.message", {
      message_id: "user-acp-fidelity",
      text: "Print the number",
    });
    dispatch(store, "running-acp-fidelity", "session.running", {});

    const expected = "#104\n\n\n\n";
    for (const [index, text] of ["#10", "4", "\n\n", "\n\n"].entries()) {
      const decoded = decodeAcpSessionUpdate(
        "session-acp-fidelity",
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "answer-acp-fidelity",
          content: { type: "text", text },
        },
        {
          eventId: `acp-fidelity-${index}`,
          occurredAt: `2026-09-09T00:00:0${index + 1}.000Z`,
          turnId: "turn-1",
        },
      );
      store.dispatch(decoded.event);
    }

    const answer = store
      .getState()
      .turns["turn-1"]?.items.find(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.text.length > 0,
      );
    expect(answer?.kind === "message" ? answer.text : undefined).toBe(expected);

    dispatch(store, "complete-acp-fidelity", "turn.completed", {});
    const { container } = render(
      <RuntimeSessionTimeline
        store={store}
        mentionableNodes={[]}
        clashEntities={[]}
      />,
    );

    expect(
      container.querySelector('[data-session-turn-answer="true"]'),
    ).toHaveTextContent("#104");
  });
});
