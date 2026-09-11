// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChatbotCopilot from "./ChatbotCopilot";
import { AppFeedbackProvider } from "./AppFeedback";
import type {
  Runtime,
  UseClashRuntimeReturn,
} from "@clash/web-ui/hooks/useClashRuntime";
import type { ByoMessage } from "@clash/web-ui/lib/acpEvents";
import { createAgentUIStore, type AgentUIStore } from "@openma/common/agent-ui";
import { decodeAcpSessionUpdate } from "@openma/common/protocol/acp";
import {
  createOpenMAEvent,
  type OpenMAEvent,
} from "@openma/common/session-events/openma";
import {
  serializeAgentAnnotationPromptBlock,
  type AgentAnnotationDraft,
} from "@clash/shared-types";

const mocks = vi.hoisted(() => ({
  useClashRuntime: vi.fn(),
  useAgentCopilot: vi.fn(),
  useIsBelowLg: vi.fn(() => false),
}));

vi.mock("@clash/web-ui/hooks/useClashRuntime", () => ({
  useClashRuntime: mocks.useClashRuntime,
}));

vi.mock("@clash/web-ui/hooks/useAgentCopilot", () => ({
  useAgentCopilot: mocks.useAgentCopilot,
}));

vi.mock("./copilot/AcpInlineRenderers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./copilot/AcpInlineRenderers")>();
  return {
    ...actual,
    AcpAssistantTextInline: ({ text }: { text: string }) => (
      <div data-testid="clash-inline-assistant">{text}</div>
    ),
    AcpToolInline: ({ tool }: { tool: { id: string } }) => (
      <div data-testid="clash-inline-tool" data-tool-call-id={tool.id} />
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "copilot.panel.label") return "AI Copilot";
      if (key === "copilot.panel.collapse") return "Collapse AI Copilot";
      if (key === "copilot.follow.start") return "Follow agent actions";
      if (key === "copilot.follow.stop") return "Stop following agent";
      if (key === "copilot.header.newSession") return "New session";
      if (key === "copilot.header.newChat") return "New chat";
      if (key === "copilot.header.history") return "Session history";
      if (key === "copilot.history.title") return "Session history";
      if (key === "copilot.history.empty") return "No history yet";
      if (key === "copilot.history.delete") return "Delete session";
      if (key === "copilot.history.active") return "Active";
      if (key === "copilot.history.archived") return "Archived";
      if (key === "copilot.history.archive") return "Archive session";
      if (key === "copilot.history.restore") return "Restore session";
      if (key === "copilot.history.fork") return "Fork session";
      if (key === "copilot.history.rename") return "Rename session";
      if (key === "copilot.history.renameLabel")
        return `Rename ${values?.title ?? "session"}`;
      if (key === "copilot.history.deletePermanently")
        return "Delete permanently";
      if (key === "copilot.history.confirmDelete")
        return "Confirm permanent delete";
      if (key === "copilot.history.deleteConfirm")
        return "This cannot be undone.";
      if (key === "copilot.history.cancel") return "Cancel";
      if (key === "copilot.turn.copyAnswer") return "Copy answer";
      if (key === "copilot.turn.answerCopied") return "Copied";
      if (key === "copilot.turn.continueInNewChat")
        return "Continue in new chat";
      if (key === "copilot.history.actions")
        return `Session actions for ${values?.title ?? "session"}`;
      if (key === "copilot.history.close") return "Close session history";
      if (key === "copilot.history.fallbackTitle")
        return `Session ${values?.index ?? ""}`;
      if (key === "copilot.header.runOn")
        return "Run on (Cloud / local runtime)";
      if (key === "copilot.sessionConfig.label")
        return "Session runtime, harness, and model";
      if (key === "copilot.sessionConfig.runtime") return "Runtime";
      if (key === "copilot.sessionConfig.harness") return "Harness";
      if (key === "copilot.sessionConfig.model") return "Model";
      if (key === "copilot.sessionConfig.local") return "Local";
      if (key === "copilot.sessionConfig.cloud") return "Cloud";
      if (key === "copilot.sessionConfig.cloudSoon") return "Coming soon";
      if (key === "copilot.runtime.menuTitle") return "Run on";
      if (key === "copilot.runtime.cloud.label") return "Cloud Agent";
      if (key === "copilot.runtime.cloud.sub") return "Coming soon";
      if (key === "copilot.runtime.machinesHeader") return "My machines";
      if (key === "copilot.runtime.machineSub_online")
        return `online · ${values?.count ?? 0} agent`;
      if (key === "copilot.runtime.addMachine.label")
        return "Connect daemon...";
      if (key === "copilot.runtime.addMachine.sub")
        return "Install or reconnect a persistent local runtime";
      if (key === "copilot.status.connecting")
        return "Connecting to runtime...";
      if (key === "copilot.status.interrupted") return "Interrupted";
      if (key === "copilot.status.streaming") return "Streaming";
      if (key === "copilot.status.thinking") return "Thinking";
      if (key === "copilot.status.reconnecting")
        return `Reconnecting ${values?.attempt ?? 0}/${values?.maxAttempts ?? 0}`;
      if (key === "copilot.status.switchingTransport")
        return "Switching transport";
      if (key === "copilot.status.workedForSeconds")
        return `Worked for ${values?.count ?? 0}s`;
      if (key === "copilot.status.workedForMinutes")
        return `Worked for ${values?.count ?? 0}m`;
      if (key === "copilot.status.creativeThinking")
        return ["Letting it simmer"];
      if (key === "copilot.status.creativeStreaming")
        return ["Putting it into words"];
      if (key === "copilot.status.readyWhenYouAre") return "Ready when you are";
      if (key === "copilot.status.desktopLocalStarting")
        return "Connecting to the local agent on this Mac...";
      if (key === "copilot.status.desktopLocalRequired")
        return "Start the local agent on this Mac.";
      if (key === "copilot.status.localAgentReady")
        return "Local agent connected. Send a message to start.";
      if (key === "copilot.status.localRuntimeRequired")
        return "Select or connect a local runtime to chat. Cloud Agent is coming soon.";
      if (key === "copilot.status.desktopLocalSetupRequired")
        return "Local agent needs setup on this Mac.";
      if (key === "copilot.status.agentHarnessRequiredTitle")
        return "Set up a local agent";
      if (key === "copilot.status.agentHarnessRequired")
        return "Install or enable an agent harness before starting a project chat.";
      if (key === "copilot.actions.openAgents") return "Open Agents";
      if (key === "copilot.errors.warningPrefix") return "Warning";
      if (key === "copilot.slash.noCommands")
        return "This agent has no slash commands.";
      return key;
    },
  }),
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const filteredMotionProps = new Set([
    "animate",
    "exit",
    "initial",
    "layoutId",
    "transition",
    "whileHover",
    "whileTap",
  ]);
  const createMotionComponent = (tag: string) =>
    React.forwardRef<
      HTMLElement,
      { children?: ReactNode } & Record<string, unknown>
    >(({ children, ...props }, ref) => {
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (!filteredMotionProps.has(key)) next[key] = value;
      }
      return React.createElement(
        tag,
        { ...next, ref } as React.HTMLAttributes<HTMLElement>,
        children as ReactNode,
      );
    });
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => (
      <>{children}</>
    ),
    MotionConfig: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => createMotionComponent(tag),
      },
    ),
  };
});

vi.mock("@clash/web-ui/lib/hooks/useMediaQuery", () => ({
  useIsBelowLg: mocks.useIsBelowLg,
}));

vi.mock("./copilot/ChatInput", () => ({
  ChatInput: ({
    input,
    onInputChange,
    error,
    disabled,
    isProcessing,
    onSubmit,
    toolbarAccessory,
    rightToolbarAccessory,
    mentionableNodes,
  }: {
    input: string;
    onInputChange?: (value: string) => void;
    error?: string | null;
    disabled?: boolean;
    isProcessing?: boolean;
    onSubmit?: (text: string, attachments: []) => void;
    toolbarAccessory?: ReactNode;
    rightToolbarAccessory?: ReactNode;
    mentionableNodes?: Array<{ type: string }>;
  }) => (
    <div
      data-testid="chat-input"
      data-disabled={disabled ? "true" : "false"}
      data-processing={isProcessing ? "true" : "false"}
      data-mention-types={mentionableNodes?.map((node) => node.type).join(",")}
    >
      {toolbarAccessory}
      {rightToolbarAccessory}
      <input
        aria-label="chat draft"
        value={input}
        onChange={(event) => onInputChange?.(event.currentTarget.value)}
      />
      <button
        type="button"
        data-testid="type-milkdown-slash"
        onClick={() => onInputChange?.("/\n")}
      >
        type slash
      </button>
      <button
        type="button"
        data-testid="submit-chat-input"
        onClick={() => onSubmit?.(input || "这个是?", [])}
      >
        submit
      </button>
      {error ? <div role="alert">{error}</div> : null}
    </div>
  ),
}));

const codexSessionModes = {
  currentModeId: "codex:review",
  availableModes: [
    {
      id: "codex:review",
      name: "Review",
      description: "Ask before applying changes",
    },
    {
      id: "codex:full-access",
      name: "Full access",
      description: "Codex can edit and run tools",
    },
  ],
};

const desktopLocalRuntime: Runtime = {
  id: "desktop-local",
  machine_id: "desktop-local",
  hostname: "BoAi's MacBook",
  os: "darwin",
  agents: [
    { id: "codex-acp", binary: "codex-acp", session_modes: codexSessionModes },
  ],
  version: "desktop",
  status: "online",
  last_heartbeat: 1,
  created_at: 1,
};

const queuedAnnotation: AgentAnnotationDraft = {
  id: "queued-annotation-1",
  kind: "agent-annotation",
  note: "Move this beat earlier.",
  target: {
    projectId: "project-one",
    surface: "timeline",
    surfaceId: "timeline-one",
    surfaceLabel: "Main Timeline",
    objectId: "clip-one",
    objectType: "timeline-clip",
    objectLabel: "Opening beat",
    objectPath: "timelines/timeline-one/clips/clip-one",
    capabilities: ["read", "modify"],
  },
};

const codexAcpConfigOptions = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "gpt-5.5",
    options: [
      {
        value: "gpt-5.5",
        name: "GPT-5.5",
        description: "Codex conversational model",
      },
      {
        value: "gpt-5.4",
        name: "GPT-5.4",
        description: "Compatibility profile",
      },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking effort",
    type: "select",
    category: "thought_level",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
] as const;

function runtimeState(
  overrides: Partial<UseClashRuntimeReturn> & Record<string, unknown> = {},
): UseClashRuntimeReturn {
  const draftStore = createAgentUIStore("draft");
  const state: UseClashRuntimeReturn = {
    runtimes: [desktopLocalRuntime],
    startupStatus: "ready",
    selectedRuntimeId: null,
    selectedAgentId: null,
    sessionId: null,
    currentSession: null,
    status: "idle",
    errorMessage: null,
    messages: [],
    availableCommands: [],
    sessionConfigOptions: [],
    sessionInfoMeta: null,
    goal: null,
    transientStatus: null,
    diagnostics: [],
    modelFallback: null,
    supportsMessageFork: false,
    agentUIStore: draftStore,
    agentUIState: draftStore.getState(),
    ready: false,
    sessionModes: null,
    permissionRequests: [],
    elicitationRequests: [],
    sessionRuntimeStatus: null,
    sessionRestartPhase: "idle",
    refresh: vi.fn(),
    startDraft: vi.fn(),
    select: vi.fn().mockResolvedValue(undefined),
    attachSession: vi.fn().mockResolvedValue(undefined),
    loadResumeOptions: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    promptQueue: [],
    promptQueueEnabled: true,
    promptQueueMode: "single",
    setPromptQueueEnabled: vi.fn(),
    setPromptQueueMode: vi.fn(),
    steerQueuedPrompt: vi.fn(),
    updateQueuedPrompt: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    reorderPromptQueue: vi.fn(),
    clearPromptQueue: vi.fn(),
    setConfigOption: vi.fn(),
    setSessionMode: vi.fn(),
    respondPermission: vi.fn(),
    respondElicitation: vi.fn(),
    restartSession: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
    sessionUsage: overrides.sessionUsage ?? null,
  };
  if (
    !Object.prototype.hasOwnProperty.call(overrides, "agentUIStore") &&
    !Object.prototype.hasOwnProperty.call(overrides, "agentUIState") &&
    Array.isArray(state.messages) &&
    state.messages.length > 0
  ) {
    const store = agentUIStoreFromMessages(
      state.messages,
      state.sessionId ?? "test-runtime-session",
      state.status === "sending" || state.status === "streaming",
    );
    state.agentUIStore = store;
    state.agentUIState = store.getState();
  }
  return state;
}

/** Flat component-test fixtures enter the same canonical Agent UI store used
 * by the live runtime. Production rendering consumes this store directly. */
function agentUIStoreFromMessages(
  messages: ByoMessage[],
  sessionId: string,
  leaveLastTurnRunning: boolean,
): AgentUIStore {
  const store = createAgentUIStore(sessionId);
  let currentTurnId: string | null = null;
  let sequence = 0;

  const dispatch = (event: OpenMAEvent) => store.dispatch(event);
  const eventContext = (turnId: string) => {
    sequence += 1;
    return {
      eventId: `${sessionId}:fixture:${sequence}`,
      occurredAt: new Date(sequence * 1_000).toISOString(),
      turnId,
      seq: sequence,
      harness: "codex-acp",
    };
  };
  const complete = (turnId: string) => {
    const context = eventContext(turnId);
    dispatch(
      createOpenMAEvent({
        event_id: context.eventId,
        type: "turn.completed",
        session_id: sessionId,
        turn_id: turnId,
        source: { kind: "harness", harness: "codex-acp" },
        occurred_at: context.occurredAt,
        seq: context.seq,
        data: {},
      }),
    );
  };

  for (const message of messages) {
    if (message.role === "user") {
      if (currentTurnId) {
        complete(currentTurnId);
      }
      currentTurnId = message.id.startsWith("user-")
        ? message.id.slice("user-".length)
        : message.id;
      const context = eventContext(currentTurnId);
      dispatch(
        createOpenMAEvent({
          event_id: context.eventId,
          type: "user.message",
          session_id: sessionId,
          turn_id: currentTurnId,
          source: { kind: "user" },
          occurred_at: context.occurredAt,
          seq: context.seq,
          data: {
            text: message.parts
              .filter(
                (
                  part,
                ): part is Extract<
                  ByoMessage["parts"][number],
                  { type: "text" }
                > => part.type === "text",
              )
              .map((part) => part.text)
              .join(""),
          },
        }),
      );
      const runningContext = eventContext(currentTurnId);
      dispatch(
        createOpenMAEvent({
          event_id: runningContext.eventId,
          type: "session.running",
          session_id: sessionId,
          turn_id: currentTurnId,
          source: { kind: "harness", harness: "codex-acp" },
          occurred_at: runningContext.occurredAt,
          seq: runningContext.seq,
          data: {},
        }),
      );
      continue;
    }

    if (!currentTurnId) {
      currentTurnId = `turn-${message.id}`;
      const runningContext = eventContext(currentTurnId);
      dispatch(
        createOpenMAEvent({
          event_id: runningContext.eventId,
          type: "session.running",
          session_id: sessionId,
          turn_id: currentTurnId,
          source: { kind: "harness", harness: "codex-acp" },
          occurred_at: runningContext.occurredAt,
          seq: runningContext.seq,
          data: {},
        }),
      );
    }
    for (const part of message.parts) {
      const event = eventFromMessagePart(part);
      const context = eventContext(currentTurnId);
      dispatch(decodeAcpSessionUpdate(sessionId, event, context).event);
    }
  }

  if (currentTurnId && !leaveLastTurnRunning) {
    complete(currentTurnId);
  }
  return store;
}

function eventFromMessagePart(part: ByoMessage["parts"][number]): unknown {
  switch (part.type) {
    case "text":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: part.text },
        ...(part.messageId ? { messageId: part.messageId } : {}),
        ...(part.phase ? { _meta: { codex: { phase: part.phase } } } : {}),
      };
    case "thought":
      return {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: part.text },
        ...(part.messageId ? { messageId: part.messageId } : {}),
      };
    case "tool_call": {
      const { type: _type, mcp: _mcp, ...tool } = part;
      return { sessionUpdate: "tool_call", ...tool };
    }
    case "plan":
      return { sessionUpdate: "plan", entries: part.entries };
    case "event_note":
      return {
        sessionUpdate: "openma.event_note",
        title: part.title,
        detail: part.detail,
        tone: part.tone,
      };
    case "raw_event":
      return part.event;
  }
}

function agentUIStoreWithActivity({
  sessionId = "runtime-session-one",
  turnId = "runtime-turn-one",
  promptText = "hello desktop runtime helper",
  startedAt = Date.now(),
  endedAt,
}: {
  sessionId?: string;
  turnId?: string;
  promptText?: string;
  startedAt?: number;
  endedAt?: number;
} = {}): AgentUIStore {
  const store = createAgentUIStore(sessionId);
  const source = { kind: "harness" as const, harness: "codex-acp" };
  const startedAtIso = new Date(startedAt).toISOString();
  store.dispatch(
    createOpenMAEvent({
      event_id: `${turnId}:user`,
      type: "user.message",
      session_id: sessionId,
      turn_id: turnId,
      source: { kind: "user" },
      occurred_at: startedAtIso,
      data: { text: promptText },
    }),
  );
  store.dispatch(
    createOpenMAEvent({
      event_id: `${turnId}:running`,
      type: "session.running",
      session_id: sessionId,
      turn_id: turnId,
      source,
      occurred_at: startedAtIso,
      data: {},
    }),
  );
  store.dispatch(
    decodeAcpSessionUpdate(
      sessionId,
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: `${turnId}-thought`,
        content: { type: "text", text: "Checking the project" },
      },
      {
        eventId: `${turnId}:thought`,
        occurredAt: startedAtIso,
        turnId,
        harness: "codex-acp",
      },
    ).event,
  );
  if (endedAt !== undefined) {
    store.dispatch(
      createOpenMAEvent({
        event_id: `${turnId}:completed`,
        type: "turn.completed",
        session_id: sessionId,
        turn_id: turnId,
        source,
        occurred_at: new Date(endedAt).toISOString(),
        data: {},
      }),
    );
  }
  return store;
}

function agentUIOverrides(store: AgentUIStore) {
  return { agentUIStore: store, agentUIState: store.getState() };
}

function cloudState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    sendMessage: vi.fn(),
    stop: vi.fn(),
    status: "ready",
    clearHistory: vi.fn(),
    connected: false,
    connectionError: null,
    lastFailedMessage: null,
    clearConnectionError: vi.fn(),
    customEvents: [],
    clearCustomEvents: vi.fn(),
    queueMessageOnOpen: vi.fn(),
    ...overrides,
  };
}

function renderDesktopCopilot(
  props: Partial<ComponentProps<typeof ChatbotCopilot>> = {},
) {
  return render(
    <ChatbotCopilot
      projectId="project-one"
      threadId="thread-one"
      initialMessages={[]}
      width={420}
      onWidthChange={() => undefined}
      isCollapsed={false}
      onCollapseChange={() => undefined}
      {...props}
    />,
  );
}

function copilotElement() {
  return (
    <ChatbotCopilot
      projectId="project-one"
      threadId="thread-one"
      initialMessages={[]}
      width={420}
      onWidthChange={() => undefined}
      isCollapsed={false}
      onCollapseChange={() => undefined}
    />
  );
}

function renderDesktopCopilotWithFeedback(
  props: Partial<ComponentProps<typeof ChatbotCopilot>> = {},
) {
  return render(copilotWithFeedbackElement(props));
}

function copilotWithFeedbackElement(
  props: Partial<ComponentProps<typeof ChatbotCopilot>> = {},
) {
  return (
    <MemoryRouter>
      <AppFeedbackProvider>
        <ChatbotCopilot
          projectId="project-one"
          threadId="thread-one"
          initialMessages={[]}
          width={420}
          onWidthChange={() => undefined}
          isCollapsed={false}
          onCollapseChange={() => undefined}
          {...props}
        />
      </AppFeedbackProvider>
    </MemoryRouter>
  );
}

function openSessionHistoryMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Session history" }));
}

describe("ChatbotCopilot desktop local mode", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.useIsBelowLg.mockReturnValue(false);
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("restores the matching composer draft when runtime sessions switch", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    Element.prototype.scrollIntoView = vi.fn();
    const session = (id: string) =>
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: id,
        currentSession: {
          id,
          threadId: id,
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          status: "active",
        },
        status: "connected",
        ready: true,
      });
    let currentRuntime = session("session-a");
    mocks.useClashRuntime.mockImplementation(() => currentRuntime);
    mocks.useAgentCopilot.mockReturnValue(cloudState());
    const copilot = (threadId: string) => (
      <ChatbotCopilot
        projectId="project-one"
        threadId={threadId}
        initialMessages={[]}
        width={420}
        onWidthChange={() => undefined}
        isCollapsed={false}
        onCollapseChange={() => undefined}
      />
    );

    const view = render(copilot("session-a"));
    fireEvent.change(screen.getByRole("textbox", { name: "chat draft" }), {
      target: { value: "draft for A" },
    });

    currentRuntime = session("session-b");
    view.rerender(copilot("session-b"));
    const draft = screen.getByRole("textbox", { name: "chat draft" });
    expect(draft).toHaveValue("");
    fireEvent.change(draft, { target: { value: "draft for B" } });

    currentRuntime = session("session-a");
    view.rerender(copilot("session-a"));
    expect(screen.getByRole("textbox", { name: "chat draft" })).toHaveValue(
      "draft for A",
    );
  });


  it("uses an expiring shared toast for model fallback without repeating on rerender", async () => {
    vi.useFakeTimers();
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(runtimeState({
      sessionId: "fallback-session",
      selectedRuntimeId: "desktop-local",
      status: "connected",
      ready: true,
      modelFallback: { from: "unknown-model", to: "supported-model" },
    }));
    mocks.useAgentCopilot.mockReturnValue(cloudState());
    try {
      const view = renderDesktopCopilotWithFeedback();
      const notice = screen.getByText("已切换至 supported-model");
      expect(notice.closest('[data-ui="toast-viewport"]')).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      expect(screen.queryByText("已切换至 supported-model")).toBeNull();
      view.rerender(copilotWithFeedbackElement());
      expect(screen.queryByText("已切换至 supported-model")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a composer draft after the chat component remounts", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "session-reopened",
        currentSession: {
          id: "session-reopened",
          threadId: "session-reopened",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          status: "active",
        },
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const first = renderDesktopCopilot({ threadId: "session-reopened" });
    fireEvent.change(screen.getByRole("textbox", { name: "chat draft" }), {
      target: { value: "survives a reload" },
    });
    first.unmount();

    renderDesktopCopilot({ threadId: "session-reopened" });
    expect(screen.getByRole("textbox", { name: "chat draft" })).toHaveValue(
      "survives a reload",
    );
  });

  it("offers an explicit crosshair toggle for following agent actions", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onFollowingAgentChange = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      followingAgent: false,
      onFollowingAgentChange,
    });

    const toggle = screen.getByRole("button", { name: "Follow agent actions" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onFollowingAgentChange).toHaveBeenCalledWith(true);
  });

  it("reports the latest structured Canvas patch target for follow mode", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onAddNode = vi.fn(() => "agent-target");
    const onAgentCanvasTarget = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming" as const,
        ready: true,
        messages: [
          {
            id: "runtime-follow-target",
            role: "assistant",
            parts: [
              {
                type: "raw_event",
                event: {
                  sessionUpdate: "clash.canvas.patch",
                  operations: [
                    {
                      op: "add_node",
                      node: {
                        id: "agent-target",
                        type: "text",
                        data: { label: "Agent target" },
                        position: { x: 1200, y: 600 },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({ onAddNode, onAgentCanvasTarget });

    await waitFor(() =>
      expect(onAgentCanvasTarget).toHaveBeenCalledWith("agent-target"),
    );
  });

  it("prepares the current desktop runtime as a draft and keeps web/cloud routing out of the header", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const select = vi.fn().mockResolvedValue(undefined);
    const startDraft = vi.fn();
    mocks.useClashRuntime.mockReturnValue(runtimeState({ select, startDraft }));
    mocks.useAgentCopilot.mockReturnValue(
      cloudState({ connectionError: "Authentication required" }),
    );

    const { container } = renderDesktopCopilot();

    await waitFor(() => {
      expect(startDraft).toHaveBeenCalledWith("desktop-local", undefined, {
        projectId: "project-one",
        agentId: "codex-acp",
        permissionModeId: "codex:review",
      });
    });
    expect(select).not.toHaveBeenCalled();

    expect(mocks.useAgentCopilot).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(
      screen.queryByRole("button", { name: "Run on (Cloud / local runtime)" }),
    ).toBeNull();
    expect(screen.queryByText("Cloud Agent")).toBeNull();
    expect(screen.queryByText("Authentication required")).toBeNull();
  });

  it("submits a Home composer prompt through the same desktop runtime path as the Project composer", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    const startDraft = vi.fn();
    const onCreateSession = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: null,
        selectedAgentId: null,
        status: "idle",
        ready: false,
        sendMessage,
        startDraft,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback({
      initialPrompt: "Cut a fast launch trailer",
      onCreateSession,
    });

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith("Cut a fast launch trailer"),
    );
    expect(startDraft).toHaveBeenCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "codex-acp",
      permissionModeId: "codex:review",
    });
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("chat draft") as HTMLInputElement).value,
    ).toBe("");
  });

  it("blocks the Project composer and links to Agents when no local harness is enabled", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        startupStatus: "ready",
        runtimes: [{ ...desktopLocalRuntime, agents: [] }],
        selectedRuntimeId: null,
        selectedAgentId: null,
        status: "idle",
        ready: false,
        refresh,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback({
      initialPrompt: "Animate the title card",
    });

    expect(screen.queryByTestId("chat-input")).toBeNull();
    const setupLink = await screen.findByRole("link", { name: "Open Agents" });
    expect(setupLink.getAttribute("href")).toBe("/settings?section=agents");
    expect(
      screen.getByText(
        "Install or enable an agent harness before starting a project chat.",
      ),
    ).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("links to Agents when session creation discovers that the selected harness is unavailable", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "error",
        ready: false,
        errorMessage:
          "session create failed: Local agent codex-acp is not enabled or available.",
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    const setupLink = await screen.findByRole("link", { name: "Open Agents" });
    expect(setupLink.getAttribute("href")).toBe("/settings?section=agents");
  });

  it("keeps the Backchat composer functional without an overlay fade", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sendMessage,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    expect(screen.queryByTestId("composer-bottom-fade")).toBeNull();

    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(sendMessage).toHaveBeenCalledWith("这个是?");
  });

  it("blocks chat submission when the selected harness needs auth and exposes auth actions", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startDraft = vi.fn();
    const sendMessage = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ harnesses: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              {
                id: "gemini",
                binary: "gemini",
                auth: {
                  status: "needs-auth",
                  message:
                    "Gemini has old accounts but no active auth method for ACP.",
                  command: "gemini",
                },
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "gemini",
        status: "idle",
        ready: false,
        startDraft,
        sendMessage,
        refresh,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    expect(screen.getByText("Sign in to Gemini")).toBeTruthy();
    expect(
      screen.getByText(
        "Gemini has old accounts but no active auth method for ACP.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(startDraft).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({ probe: "config", refresh: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/gemini/authenticate"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("submits agent-owned authentication fields from the agent panel", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const restartSession = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            harnesses: [
              {
                id: "codex-acp",
                auth: {
                  status: "configured",
                  message: "Codex is authenticated.",
                },
              },
            ],
          }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              {
                id: "codex-acp",
                label: "Codex",
                binary: "codex-acp",
                auth: {
                  status: "needs-auth",
                  message: "Enter the provider API key.",
                  methods: [
                    {
                      id: "provider-login",
                      name: "Provider key",
                      type: "agent",
                      form: "fields",
                      vars: [
                        { name: "api-key", label: "API key", secret: true },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "local-session-auth-blocked",
        status: "idle",
        ready: false,
        refresh,
        restartSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-agent-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/v1/local/harnesses/codex-acp/authenticate",
        ),
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method_id: "provider-login",
            values: { "api-key": "sk-agent-secret" },
          }),
        }),
      ),
    );
    await waitFor(() => expect(restartSession).toHaveBeenCalledWith("now"));
  });

  it("restarts an auth-blocked session after Check again observes configured auth", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const restartSession = vi.fn().mockResolvedValue(undefined);
    const blockedRuntime = {
      ...desktopLocalRuntime,
      agents: [
        {
          id: "codex-acp",
          label: "Codex",
          binary: "codex-acp",
          auth: {
            status: "needs-auth" as const,
            message: "Finish browser sign in.",
            command: "codex-acp login",
          },
        },
      ],
    };
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [blockedRuntime],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "local-session-auth-blocked",
        status: "connected",
        ready: true,
        refresh,
        restartSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const rendered = renderDesktopCopilotWithFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({ probe: "config", refresh: true }),
    );

    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...blockedRuntime,
            agents: [
              {
                id: "codex-acp",
                label: "Codex",
                binary: "codex-acp",
                auth: {
                  status: "configured",
                  message: "Codex is authenticated.",
                },
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "local-session-auth-blocked",
        status: "connected",
        ready: true,
        refresh,
        restartSession,
      }),
    );
    rendered.rerender(copilotWithFeedbackElement());

    await waitFor(() => expect(restartSession).toHaveBeenCalledWith("now"));
  });

  it("opens ACP URL elicitation through the desktop browser bridge after confirmation", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    const openExternal = vi.fn().mockResolvedValue(undefined);
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn().mockResolvedValue({ windowId: 1, windowCount: 1 }),
      openExternal,
    };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const respondElicitation = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        elicitationRequests: [
          {
            requestId: "url-elicitation-1",
            sessionId: "local-session-url-elicitation",
            mode: "url",
            message: "Sign in with GitHub",
            elicitationId: "github-oauth-1",
            url: "https://github.com/login/oauth/authorize?client_id=clash",
          },
        ],
        respondElicitation,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open github.com" }));

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?client_id=clash",
      ),
    );
    expect(respondElicitation).toHaveBeenCalledWith("url-elicitation-1", {
      action: "accept",
    });
  });

  it("shows local harness sign-in launch failures as non-blocking global feedback", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/harnesses/gemini/authenticate") &&
          init?.method === "POST"
        ) {
          return new Response(JSON.stringify({ error: "Login canceled" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ harnesses: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              {
                id: "gemini",
                label: "Gemini",
                binary: "gemini",
                auth: {
                  status: "needs-auth",
                  message:
                    "Gemini has old accounts but no active auth method for ACP.",
                  command: "gemini",
                },
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "gemini",
        status: "idle",
        ready: false,
        refresh,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/gemini/authenticate"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("Could not start Gemini sign in")).toBeTruthy(),
    );
    expect(screen.getByText("Could not start Gemini sign in")).toBeTruthy();
    expect(screen.getByText("Login canceled")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Could not start Gemini sign in" }),
    ).toBeNull();
  });

  it("does not start a session when selecting a Devin harness that still needs auth before a session exists", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const select = vi.fn().mockResolvedValue(undefined);
    const startDraft = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              { id: "cursor", label: "Cursor", binary: "clash-acp-cursor" },
              {
                id: "devin",
                label: "Devin",
                binary: "clash-acp-devin",
                auth: {
                  status: "needs-auth",
                  message: "Devin is not signed in for ACP.",
                  command: "clash-acp-devin auth login",
                },
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "cursor",
        status: "draft",
        ready: false,
        select,
        startDraft,
        refresh,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    const trigger = screen.getByRole("button", {
      name: "Session runtime, harness, and model",
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Devin/ }));

    await waitFor(() =>
      expect(screen.getByText("Sign in to Devin")).toBeTruthy(),
    );
    expect(screen.getByText("Devin is not signed in for ACP.")).toBeTruthy();
    expect(select).not.toHaveBeenCalled();
    expect(startDraft).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith({ probe: "config", refresh: true });
  });

  it("does not render local ACP authentication failures as red Clash auth errors", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "error",
        errorMessage: "Authentication required",
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(screen.queryByText(/Authentication required/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText("Local agent needs setup on this Mac."),
    ).toBeNull();
  });

  it("keeps desktop local session connection silent", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connecting",
        ready: false,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState({ status: "streaming" }));

    const { container } = renderDesktopCopilot();

    expect(
      screen.queryByRole("status", {
        name: "Connecting to the local agent on this Mac...",
      }),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-input").getAttribute("data-processing"),
    ).toBe("false");
    expect(container.textContent).not.toContain("Connecting to runtime...");
    expect(container.textContent).not.toContain(
      "Connecting to the local agent on this Mac...",
    );
    expect(container.textContent).not.toContain("Streaming");
  });

  it("keeps the composer unavailable until the cold-start harness probe settles", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        startupStatus: "loading",
        runtimes: [],
        status: "idle",
        ready: false,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.queryByRole("status", {
        name: "Connecting to the local agent on this Mac...",
      }),
    ).toBeNull();
    expect(screen.queryByTestId("chat-input")).toBeNull();
    expect(screen.queryByTestId("session-harness-config-trigger")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "New session" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Session history",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("replaces the composer with a Settings action when the ready snapshot has no agents", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        startupStatus: "ready",
        runtimes: [{ ...desktopLocalRuntime, agents: [] }],
        status: "idle",
        ready: false,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const settings = screen.getByRole("link", { name: "Open Agents" });
    expect(settings.getAttribute("href")).toBe("/settings?section=agents");
    expect(screen.queryByTestId("chat-input")).toBeNull();
    expect(screen.queryByTestId("session-harness-config-trigger")).toBeNull();
  });

  it("keeps agent controls unavailable when the startup snapshot fails", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        startupStatus: "error",
        runtimes: [],
        status: "idle",
        ready: false,
        errorMessage: "Runtime snapshot request failed: HTTP 503",
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.getByRole("link", { name: "Open Agents" }).getAttribute("href"),
    ).toBe("/settings?section=agents");
    expect(
      screen.getByText("Runtime snapshot request failed: HTTP 503"),
    ).toBeTruthy();
    expect(screen.queryByTestId("chat-input")).toBeNull();
    expect(screen.queryByTestId("session-harness-config-trigger")).toBeNull();
  });

  it("does not flash a missing-agent sentence before desktop runtimes load", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        startupStatus: "loading",
        runtimes: [],
        selectedRuntimeId: null,
        selectedAgentId: null,
        status: "idle",
        ready: false,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(
      screen.queryByRole("status", {
        name: "Connecting to the local agent on this Mac...",
      }),
    ).toBeNull();
    expect(container.textContent).not.toContain(
      "Start the local agent on this Mac.",
    );
  });

  it("does not show a desktop local ready empty-state sentence", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(container.textContent).not.toContain(
      "Local agent connected. Send a message to start.",
    );
  });

  it("shows runtime retry diagnostics beside the agent avatar instead of an empty state", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "sending",
        ready: true,
        transientStatus: {
          kind: "reconnecting",
          message: "Reconnecting... 2/5",
          detail: "request timed out",
          attempt: 2,
          maxAttempts: 5,
        },
        diagnostics: [
          {
            stream: "stderr",
            severity: "warning",
            raw: "Falling back from WebSockets to HTTPS transport. request timed out",
            message: "Reconnecting... 2/5",
            transientStatus: {
              status: "reconnecting",
              message: "Reconnecting... 2/5",
              detail: "request timed out",
              attempt: 2,
              maxAttempts: 5,
            },
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(
      screen.getByRole("status", {
        name: "Reconnecting 2/5 · request timed out",
      }),
    ).toBeTruthy();
    expect(container.textContent).not.toContain(
      "Local agent connected. Send a message to start.",
    );
  });

  it("keeps the runtime composer sendable while a turn is running so messages can enter the prompt queue", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "sending",
        ready: true,
        sendMessage,
        messages: [
          { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    expect(
      screen.getByTestId("chat-input").getAttribute("data-processing"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(sendMessage).toHaveBeenCalledWith("这个是?");
  });

  it("does not render per-message steer actions in the transcript", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "try this angle" }],
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.queryByRole("button", { name: "Steer this message" }),
    ).toBeNull();
    expect(screen.queryByText("Steer")).toBeNull();
  });

  it("shows the floating runtime prompt queue without a separate header row", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        promptQueue: [
          { id: "q1", turnId: "t1", text: "one", createdAt: 1 },
          { id: "q2", turnId: "t2", text: "two", createdAt: 2 },
        ],
        promptQueueMode: "single",
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.queryByText("2 queued")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Send one after this turn" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear queued messages" }),
    ).toBeNull();
  });

  it("renders queued prompt items with per-item steer controls in the queue bar", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const steerQueuedPrompt = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        promptQueue: [
          { id: "q1", turnId: "t1", text: "try this angle", createdAt: 1 },
          { id: "q2", turnId: "t2", text: "tighten the ending", createdAt: 2 },
        ],
        promptQueueMode: "single",
        steerQueuedPrompt,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(screen.getByText("try this angle")).toBeTruthy();
    expect(screen.getByText("tighten the ending")).toBeTruthy();
    const steerButtons = screen.getAllByRole("button", {
      name: /^Steer queued message/,
    });
    expect(steerButtons).toHaveLength(2);
    fireEvent.click(steerButtons[0]);

    expect(steerQueuedPrompt).toHaveBeenCalledWith("t1");
  });

  it("renders queued annotation content as a first-class queue summary", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const annotationBlock = serializeAgentAnnotationPromptBlock([
      queuedAnnotation,
    ]);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        promptQueue: [
          {
            id: "q-annotation",
            turnId: "t-annotation",
            text: `${annotationBlock}\nPlease revise this section.`,
            createdAt: 1,
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.getByRole("group", { name: "Queued prompt content" }),
    ).toBeTruthy();
    expect(screen.getByText("Please revise this section.")).toBeTruthy();
    expect(screen.getByText("Opening beat")).toBeTruthy();
    expect(screen.getByText("1 annotation")).toBeTruthy();
    expect(screen.queryByText(/clash-agent-annotations/)).toBeNull();
  });

  it("renders queued mentions and attachments without exposing their markdown transport", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        promptQueue: [
          {
            id: "q-rich-content",
            turnId: "t-rich-content",
            text: "Review @[Opening frame](node:image-1) ![reference.png](asset-key)",
            createdAt: 1,
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(screen.getByText("@Opening frame")).toBeTruthy();
    expect(screen.getByText("reference.png")).toBeTruthy();
    expect(screen.queryByText(/\]\(node:image-1\)/)).toBeNull();
    expect(screen.queryByText(/!\[reference\.png\]/)).toBeNull();
  });

  it("does not render a queued prompt again after its user message is already visible", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        messages: [
          {
            id: "user-t1",
            role: "user",
            parts: [{ type: "text", text: "already sent" }],
          },
        ],
        promptQueue: [
          { id: "q1", turnId: "t1", text: "already sent", createdAt: 1 },
          { id: "q2", turnId: "t2", text: "still queued", createdAt: 2 },
        ],
        promptQueueMode: "single",
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(screen.getAllByText("already sent")).toHaveLength(1);
    expect(screen.getByText("still queued")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /^Steer queued message/ }),
    ).toHaveLength(1);
  });

  it("edits and removes queued prompt items from the floating queue card", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const updateQueuedPrompt = vi.fn();
    const removeQueuedPrompt = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        promptQueue: [
          { id: "q1", turnId: "t1", text: "draft this line", createdAt: 1 },
        ],
        updateQueuedPrompt,
        removeQueuedPrompt,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Queued message options 1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    expect(
      (screen.getByLabelText("chat draft") as HTMLInputElement).value,
    ).toBe("draft this line");

    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "updated line" },
    });
    fireEvent.click(screen.getByTestId("submit-chat-input"));
    expect(updateQueuedPrompt).toHaveBeenCalledWith("t1", "updated line");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove queued message 1" }),
    );
    expect(removeQueuedPrompt).toHaveBeenCalledWith("t1");
  });

  it("preserves queued annotation blocks when editing the visible prompt text", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const annotationBlock = serializeAgentAnnotationPromptBlock([
      queuedAnnotation,
    ]);
    const updateQueuedPrompt = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        promptQueue: [
          {
            id: "q-annotation",
            turnId: "t-annotation",
            text: `${annotationBlock}\nOriginal request.`,
            createdAt: 1,
          },
        ],
        updateQueuedPrompt,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Queued message options 1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    expect(
      (screen.getByLabelText("chat draft") as HTMLInputElement).value,
    ).toBe("Original request.");

    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "Updated request." },
    });
    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(updateQueuedPrompt).toHaveBeenCalledWith(
      "t-annotation",
      expect.stringContaining("clash-agent-annotations"),
    );
    expect(updateQueuedPrompt.mock.calls[0]?.[1]).toContain("Updated request.");
    expect(updateQueuedPrompt.mock.calls[0]?.[1]).toContain("Opening beat");
  });

  it("hides the runtime prompt queue bar when queueing is disabled", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        promptQueueEnabled: false,
        promptQueue: [
          {
            id: "q1",
            turnId: "t1",
            text: "hidden pending input",
            createdAt: 1,
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(screen.queryByText("1 queued")).toBeNull();
    expect(screen.queryByText("hidden pending input")).toBeNull();
  });

  it("uses the active session title in the desktop header", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot({
      sessionHistory: [
        {
          threadId: "thread-one",
          title: "Storyboard beat pass",
          type: "cloud",
        },
      ],
    });

    const headerTitle = container.querySelector(
      ".clash-copilot-panel-header .font-display",
    );
    expect(headerTitle?.textContent).toBe("Storyboard beat pass");
  });

  it("keeps a long prompt-derived session title compact without hiding its full label", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());
    const storedTitle =
      "请认真思考一下，然后只回答 PRECISE\\_FIRST\\_CHAR\\_31";
    const visibleTitle = "请认真思考一下，然后只回答 PRECISE_FIRST_CHAR_31";

    const { container } = renderDesktopCopilot({
      sessionHistory: [
        { threadId: "thread-one", title: storedTitle, type: "cloud" },
      ],
    });

    const headerTitle = container.querySelector(
      ".clash-copilot-panel-header [data-copilot-session-title]",
    );
    expect(headerTitle).toHaveTextContent(
      "请认真思考一下，然后只回答 PRECISE_FIRST…",
    );
    expect(headerTitle).toHaveAttribute("title", visibleTitle);
  });

  it("labels an empty desktop draft as a new chat", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "draft",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot({ sessionHistory: [] });

    const headerTitle = container.querySelector(
      ".clash-copilot-panel-header .font-display",
    );
    expect(headerTitle?.textContent).toBe("New chat");
  });

  it("archives runtime sessions from the active history action menu", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onArchiveSession = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      onArchiveSession,
      sessionHistory: [
        {
          threadId: "runtime-session-one",
          title: "Run pwd",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
        },
      ],
    });

    openSessionHistoryMenu();
    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Session actions for Run pwd" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive session" }));

    expect(onArchiveSession).toHaveBeenCalledWith("runtime-session-one");
  });

  it("renders session history through the shared popover panel", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      sessionHistory: [
        {
          threadId: "runtime-session-one",
          title: "Run pwd",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
        },
      ],
    });

    openSessionHistoryMenu();

    const historyPopover = screen.getByRole("dialog", {
      name: "Session history",
    });
    expect(historyPopover).toHaveAttribute("data-slot", "popover-content");
    const historyPanel = historyPopover.querySelector(
      '[data-session-history-popover-panel=""]',
    );
    expect(historyPanel).toBeTruthy();
    expect(
      historyPopover.querySelector('[data-session-history-row="true"]'),
    ).toHaveClass("h-6", "rounded-md", "text-xs");
    expect(screen.getByRole("button", { name: /^Run pwd / })).toBeTruthy();
    expect(within(historyPopover).queryByText("Session history")).toBeNull();
  });

  it("loads the next session page when the history list reaches its end", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onLoadMoreSessionHistory = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      sessionHistory: [
        { threadId: "session-two", title: "Second", type: "runtime" },
        { threadId: "session-one", title: "First", type: "runtime" },
      ],
      sessionHistoryHasMore: true,
      onLoadMoreSessionHistory,
    } as Partial<ComponentProps<typeof ChatbotCopilot>>);

    openSessionHistoryMenu();
    const historyPopover = screen.getByRole("dialog", {
      name: "Session history",
    });
    const scrollRegion = historyPopover.querySelector<HTMLElement>(
      "[data-session-history-scroll]",
    );
    expect(scrollRegion).toBeTruthy();
    Object.defineProperties(scrollRegion!, {
      scrollHeight: { configurable: true, value: 480 },
      clientHeight: { configurable: true, value: 440 },
      scrollTop: { configurable: true, value: 40 },
    });
    fireEvent.scroll(scrollRegion!);

    expect(onLoadMoreSessionHistory).toHaveBeenCalledTimes(1);
  });

  it("renames a session from its action menu", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onRenameSession = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      sessionHistory: [
        {
          threadId: "runtime-session-one",
          title: "Run pwd",
          type: "runtime",
        },
      ],
      onRenameSession,
    } as Partial<ComponentProps<typeof ChatbotCopilot>>);

    openSessionHistoryMenu();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Session actions for Run pwd" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename session" }));

    const renameInput = screen.getByRole("textbox", { name: "Rename Run pwd" });
    fireEvent.change(renameInput, { target: { value: "Inspect canvas" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    expect(onRenameSession).toHaveBeenCalledWith(
      "runtime-session-one",
      "Inspect canvas",
    );
  });

  it("opens session history below its trigger without resizing the chat", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot({
      sessionHistory: [
        {
          threadId: "runtime-session-one",
          title: "Run pwd",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
        },
      ],
    });

    expect(
      screen.queryByRole("dialog", { name: "Session history" }),
    ).toBeNull();
    const panel = container.querySelector<HTMLElement>("#clash-copilot-panel");
    expect(panel?.style.width).toBe("420px");

    const historyTrigger = screen.getByRole("button", {
      name: "Session history",
    });
    expect(historyTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(historyTrigger);

    const historyPopover = screen.getByRole("dialog", {
      name: "Session history",
    });
    expect(historyPopover).toHaveAttribute("data-side", "bottom");
    expect(
      screen.getByRole("button", { name: "Session history" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: /^Run pwd / })).toBeTruthy();
    const unchangedPanel = container.querySelector<HTMLElement>(
      "#clash-copilot-panel",
    );
    expect(unchangedPanel?.style.width).toBe("420px");
    expect(
      container.querySelector('[data-chat-column="composer"]'),
    ).toBeTruthy();
  });

  it("keeps fork and archive in a session action menu instead of exposing icon-only row actions", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onArchiveSession = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      onArchiveSession,
      sessionHistory: [
        {
          threadId: "source-session",
          title: "Source session",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          acpSessionId: "acp-source-session",
        },
      ],
    } as any);

    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    expect(screen.queryByRole("button", { name: "Fork session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session actions for Source session",
      }),
    );
    expect(screen.getByRole("menuitem", { name: "Fork session" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive session" }));
    expect(onArchiveSession).toHaveBeenCalledWith("source-session");
  });

  it("keeps archived sessions out of history because Settings owns the archive library", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onLoadArchivedSessions = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      archivedSessionHistory: [
        {
          threadId: "archived-session",
          title: "Old storyboard",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          archivedAt: "2026-08-26T00:00:00.000Z",
        },
      ],
      onLoadArchivedSessions,
    } as any);

    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("Old storyboard")).toBeNull();
    expect(onLoadArchivedSessions).not.toHaveBeenCalled();
  });

  it("surfaces restored desktop runtime messages in session history", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const restoredMessages: ByoMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Run pwd" }],
      },
      {
        id: "asst-1",
        role: "assistant",
        parts: [{ type: "text", text: "Done." }],
      },
    ];
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "local-session-restored",
        currentSession: {
          id: "local-session-restored",
          threadId: "local-session-restored",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          status: "active",
        },
        status: "connected",
        ready: true,
        messages: restoredMessages,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot({ sessionHistory: [] });

    const headerTitle = container.querySelector(
      ".clash-copilot-panel-header .font-display",
    );
    expect(headerTitle?.textContent).toBe("Run pwd");

    openSessionHistoryMenu();

    const historyPopover = screen.getByRole("dialog", {
      name: "Session history",
    });
    expect(within(historyPopover).queryByText("Session history")).toBeNull();
    expect(screen.queryByText("No history yet")).toBeNull();
    expect(screen.getAllByText("Run pwd").length).toBeGreaterThan(1);
    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();
  });

  it("attaches a runtime history item and syncs the visible harness", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const attachSession = vi.fn().mockResolvedValue(undefined);
    const onSwitchSession = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              { id: "codex-acp", binary: "codex-acp" },
              { id: "cursor", label: "Cursor", binary: "clash-acp-cursor" },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        attachSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      onSwitchSession,
      sessionHistory: [
        {
          threadId: "local-session-old",
          type: "runtime",
          title: "Run pwd",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "cursor",
          status: "active",
        },
      ],
    });

    openSessionHistoryMenu();
    fireEvent.click(screen.getByRole("button", { name: /^Run pwd / }));

    expect(onSwitchSession).not.toHaveBeenCalled();
    expect(attachSession).toHaveBeenCalledWith({
      id: "local-session-old",
      threadId: "local-session-old",
      type: "runtime",
      title: "Run pwd",
      projectId: "project-one",
      runtimeId: "desktop-local",
      agentId: "cursor",
      status: "active",
    });
    expect(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }).textContent,
    ).toContain("Cursor");
  });

  it("restores the route-selected runtime session after the renderer remounts", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const attachSession = vi.fn().mockResolvedValue(undefined);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "idle",
        ready: false,
        attachSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      threadId: "local-session-restored-from-route",
      sessionHistory: [
        {
          threadId: "local-session-restored-from-route",
          type: "runtime",
          title: "Inspect the canvas",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          status: "active",
        },
      ],
    });

    await waitFor(() =>
      expect(attachSession).toHaveBeenCalledWith({
        id: "local-session-restored-from-route",
        threadId: "local-session-restored-from-route",
        type: "runtime",
        title: "Inspect the canvas",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      }),
    );
  });

  it("opens a fork draft with the source session's harness and permission mode", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startDraft = vi.fn();
    const attachSession = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        startDraft,
        attachSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());
    renderDesktopCopilot({
      sessionHistory: [
        {
          threadId: "source-session",
          type: "runtime",
          title: "Source session",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          permissionMode: "codex:full-access",
          acpSessionId: "acp-source-session",
          status: "active",
        },
      ],
    });

    openSessionHistoryMenu();
    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session actions for Source session",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));

    expect(attachSession).not.toHaveBeenCalled();
    expect(startDraft).toHaveBeenCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "codex-acp",
      permissionModeId: "codex:full-access",
      forkFromAcpSessionId: "acp-source-session",
    });
  });

  it("forks the current ACP session from the latest completed turn footer", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startDraft = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "source-session",
        currentSession: {
          id: "source-session",
          threadId: "source-session",
          type: "runtime",
          title: "Source session",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          permissionMode: "codex:full-access",
          acpSessionId: "acp-source-session",
          supportsSessionFork: true,
          status: "active",
        },
        status: "connected",
        ready: true,
        startDraft,
        messages: [
          {
            id: "user-current-turn",
            role: "user",
            parts: [{ type: "text", text: "Question" }],
          },
          {
            id: "assistant-current-turn",
            role: "assistant",
            parts: [{ type: "text", text: "Answer" }],
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue in new chat" }),
    );

    expect(startDraft).toHaveBeenCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "codex-acp",
      permissionModeId: "codex:full-access",
      forkFromAcpSessionId: "acp-source-session",
    });
  });

  it("shows a quiet placeholder and reveals hydrated history before connection finishes", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    let finishAttach!: () => void;
    const attachSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAttach = resolve;
        }),
    );
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "current-session",
        status: "connected",
        ready: true,
        messages: [
          {
            id: "old",
            role: "assistant",
            parts: [{ type: "text", text: "Old session" }],
          },
        ],
        attachSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());
    const historyProps: Partial<ComponentProps<typeof ChatbotCopilot>> = {
      sessionHistory: [
        {
          threadId: "next-session",
          type: "runtime" as const,
          title: "Next session",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          status: "active",
        },
      ],
    };
    const { rerender } = renderDesktopCopilot(historyProps);

    openSessionHistoryMenu();
    fireEvent.click(screen.getByRole("button", { name: /^Next session / }));
    expect(
      screen.getByRole("status", { name: "Loading session" }),
    ).toBeTruthy();
    expect(screen.queryByText("Loading session…")).toBeNull();
    expect(screen.getByTestId("chat-input")).toBeTruthy();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "next-session",
        status: "connecting",
        ready: false,
        messages: [
          {
            id: "loaded",
            role: "assistant",
            parts: [{ type: "text", text: "Loaded history" }],
          },
        ],
        attachSession,
      }),
    );
    rerender(
      <ChatbotCopilot
        projectId="project-one"
        threadId="thread-one"
        initialMessages={[]}
        width={420}
        onWidthChange={() => undefined}
        isCollapsed={false}
        onCollapseChange={() => undefined}
        {...historyProps}
      />,
    );
    expect(
      screen.queryByRole("status", { name: "Loading session" }),
    ).toBeNull();
    expect(screen.getByText("Loaded history")).toBeTruthy();
    expect(screen.getByTestId("chat-input")).toHaveAttribute(
      "data-processing",
      "false",
    );

    finishAttach();
    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading session" }),
      ).toBeNull(),
    );
  });

  it("keeps the canonical ACP item plan out of the transcript like Backchat main", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const planStore = agentUIStoreFromMessages(
      [
        {
          id: "assistant-progress",
          role: "assistant",
          parts: [
            {
              type: "plan",
              entries: [
                { content: "Inspect the panel", status: "in_progress" },
              ],
            },
          ],
        },
      ] as any,
      "plan-session",
      false,
    );
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        ...agentUIOverrides(planStore),
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(planStore.getState().planOrder).toHaveLength(1);
    expect(container.querySelector("[data-session-plan='true']")).toBeNull();
    expect(screen.queryByText("Inspect the panel")).toBeNull();
  });

  it("keeps the animated Clash persona inside a running Backchat turn without replacing the launcher", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "sending",
        ready: true,
        messages: [
          {
            id: "runtime-message-one",
            role: "user",
            parts: [{ type: "text", text: "hello desktop runtime helper" }],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    const headerRail = container.querySelector(
      ".clash-copilot-panel-header [data-copilot-rail-slot]",
    );
    const chatSurface = container.querySelector("[data-chat-surface='main']");
    const turnColumn = chatSurface?.querySelector("[data-chat-column='turns']");
    const composerColumn = chatSurface?.querySelector(
      "[data-chat-column='composer']",
    );
    const collapse = screen.getByRole("button", {
      name: "Collapse AI Copilot",
    });
    expect(headerRail).toBeNull();
    expect(collapse.closest('[role="toolbar"]')).toBeTruthy();
    expect(chatSurface).toBeTruthy();
    expect(turnColumn).toHaveClass("chat-turn-frame", "max-w-3xl");
    expect(composerColumn).toHaveClass("chat-composer-frame", "max-w-3xl");
    const processAvatar = chatSurface?.querySelector(
      "[data-session-process-state='running'] [data-session-process-avatar='true']",
    );
    expect(processAvatar).toBeTruthy();
    expect(
      processAvatar?.querySelector('[data-agent-motion-state="working"]'),
    ).toBeTruthy();
  });

  it("uses 44px header touch targets when the copilot becomes a mobile sheet", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    mocks.useIsBelowLg.mockReturnValue(true);
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const panel = document.querySelector<HTMLElement>("#clash-copilot-panel");
    expect(
      panel?.style.getPropertyValue("--clash-workspace-control-size"),
    ).toBe("44px");
    for (const label of [
      "New session",
      "Session history",
      "Collapse AI Copilot",
    ]) {
      expect(screen.getByRole("button", { name: label })).toHaveClass(
        "h-11",
        "w-11",
      );
    }
  });

  it("moves the collapsed Clash agent into the production editor header", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot({
      isCollapsed: true,
      collapsedLauncherPlacement: "header",
    });

    const launcher = container.querySelector<HTMLElement>(
      "[data-copilot-launcher-placement='header']",
    );
    const panel = container.querySelector<HTMLElement>("#clash-copilot-panel");
    expect(launcher).toBeTruthy();
    expect(launcher?.className).toContain(
      "top-[calc(var(--clash-desktop-chrome-height,0px)+0.375rem)]",
    );
    expect(
      screen.getByRole("button", { name: "copilot.panel.expand" }).className,
    ).toContain("h-8");
    expect(launcher?.querySelector(".clash-agent-motion")).toBeTruthy();
    expect(panel?.style.transformOrigin).toBe(
      "calc(100% - 16px) calc(0% + 14px)",
    );
  });

  it("renders fixed editor surfaces as a flush docked column", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({ layoutMode: "docked" });

    const panel = document.querySelector<HTMLElement>("#clash-copilot-panel");
    expect(panel).toBeTruthy();
    if (!panel) throw new Error("Missing Copilot panel");
    expect(panel.className).toContain("clash-copilot-panel-shell--docked");
    expect(panel.className).toContain("right-0");
    expect(panel.className).toContain("bottom-0");
    expect(panel.className).not.toContain("right-3");
    expect(panel.className).not.toContain("bottom-3");
  });

  it("resets to a desktop runtime draft from the header plus button", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const select = vi.fn().mockResolvedValue(undefined);
    const startDraft = vi.fn();
    const onNewSession = vi.fn();
    const onRuntimeSessionRouteChange = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        select,
        startDraft,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({ onNewSession, onRuntimeSessionRouteChange });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(startDraft).toHaveBeenCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "codex-acp",
      permissionModeId: "codex:review",
      freshSession: true,
    });
    expect(select).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
    expect(onRuntimeSessionRouteChange).toHaveBeenCalledWith(null);
  });

  it("keeps the completed runtime session in history before opening a fresh draft", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startDraft = vi.fn();
    const onUpsertSession = vi.fn();
    const onRuntimeSessionRouteChange = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "runtime-session-one",
        currentSession: {
          id: "runtime-session-one",
          threadId: "runtime-session-one",
          type: "runtime",
          title: "New session",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
          status: "active",
        },
        status: "connected",
        ready: true,
        startDraft,
        messages: [
          {
            id: "runtime-user-one",
            role: "user",
            parts: [
              {
                type: "text",
                text: '<!-- clash-workspace-context {"version":1,"projectId":"project-one"} -->\nRun pwd',
              },
            ],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      onUpsertSession,
      onRuntimeSessionRouteChange,
    });
    onUpsertSession.mockClear();

    expect(onRuntimeSessionRouteChange).toHaveBeenCalledWith(
      "runtime-session-one",
    );
    onRuntimeSessionRouteChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(onUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "runtime-session-one",
        title: "Run pwd",
        type: "runtime",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
      }),
    );
    expect(startDraft).toHaveBeenCalledWith(
      "desktop-local",
      undefined,
      expect.objectContaining({
        projectId: "project-one",
        agentId: "codex-acp",
        freshSession: true,
      }),
    );
    expect(onRuntimeSessionRouteChange).toHaveBeenCalledWith(null);
  });

  it("sends the first prompt from a desktop runtime draft instead of creating an empty session first", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const select = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "draft",
        ready: false,
        select,
        sendMessage,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(screen.getByTestId("chat-input").getAttribute("data-disabled")).toBe(
      "false",
    );
    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(sendMessage).toHaveBeenCalledWith("这个是?");
    expect(select).not.toHaveBeenCalled();
  });

  it("routes text revision restore requests through the local runtime CLI action path", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sendMessage,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("clash:revision-restore-request", {
          detail: {
            kind: "text",
            nodeId: "text-1",
            revisionId: "txrev-2",
            mode: "replace",
            command:
              "clash text restore --node text-1 --revision txrev-2 --mode replace",
          },
        }),
      );
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toContain(
      "clash text restore --node text-1 --revision txrev-2 --mode replace",
    );
    expect(sendMessage.mock.calls[0]?.[0]).toContain(
      "Do not edit the canvas, snapshot, or SQLite directly",
    );
  });

  it("renders each Backchat-style run setting as a submenu with its current value", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const setConfigOption = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        sessionConfigOptions: [...codexAcpConfigOptions] as any,
        setConfigOption,
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    const trigger = screen.getByRole("button", {
      name: "Session runtime, harness, and model",
    });
    expect(screen.getByTestId("session-harness-config-trigger")).toBe(trigger);
    expect(
      screen
        .getByTestId("session-permission-mode-trigger")
        .getAttribute("aria-label"),
    ).toBe("Harness permission mode");
    expect(screen.getByTestId("session-permission-mode-trigger")).not.toBe(
      trigger,
    );
    expect(trigger.querySelector("[data-acp-agent-logo]")).toBeTruthy();
    expect(
      trigger.querySelector("[data-session-config-status-slot]"),
    ).toBeTruthy();
    expect(trigger.textContent).toContain("GPT-5.5");
    expect(trigger.textContent).toContain("Low");
    expect(
      trigger.querySelector("[data-session-fast-mode-indicator]"),
    ).toBeNull();
    expect(trigger.textContent).not.toContain("Auto");
    expect(trigger.textContent).not.toContain("Local");
    expect(trigger.textContent).not.toContain("Codex");

    fireEvent.pointerDown(trigger);

    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.queryByText("Cloud")).toBeNull();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Harness × Code/ }),
    ).toBeNull();
    expect(screen.queryByText("Auto")).toBeNull();
    expect(
      screen.queryByText("Use the selected harness default model"),
    ).toBeNull();
    expect(screen.queryByText("Harness")).toBeNull();
    const modelSubmenu = screen.getByRole("menuitem", {
      name: /Model\s*GPT-5\.5/,
    });
    const effortSubmenu = screen.getByRole("menuitem", {
      name: /Effort\s*Low/,
    });
    expect(modelSubmenu).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: /Codex/ })).toBeNull();
    expect(screen.queryByText("OpenAI")).toBeNull();
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: "GPT-5.5" })).toBeNull();
    expect(screen.queryByText("Codex conversational model")).toBeNull();
    expect(effortSubmenu).toBeTruthy();
    fireEvent.keyDown(effortSubmenu, { key: "ArrowRight" });
    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: /Medium/ }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Medium/ }));

    expect(setConfigOption).toHaveBeenCalledWith("thought_level", "medium");
  });

  it("updates the ACP model through session/set_config_option", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const setConfigOption = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        sessionConfigOptions: [...codexAcpConfigOptions] as any,
        ready: true,
        setConfigOption,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const trigger = screen.getByRole("button", {
      name: "Session runtime, harness, and model",
    });
    fireEvent.pointerDown(trigger);

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: /Model\s*GPT-5\.5/ }),
      { key: "ArrowRight" },
    );
    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: /GPT-5\.4/ }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT-5\.4/ }));

    expect(setConfigOption).toHaveBeenCalledWith("model", "gpt-5.4");
  });

  it("keeps only model, effort, and fast mode in the run menu while routing custom options outside", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const setConfigOption = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        sessionConfigOptions: [
          ...codexAcpConfigOptions,
          {
            id: "fast-mode",
            name: "Fast mode",
            type: "boolean",
            currentValue: true,
            description: "Use lower-latency inference",
          },
          {
            id: "personality",
            name: "Personality",
            type: "select",
            currentValue: "concise",
            options: [
              { value: "concise", name: "Concise" },
              { value: "explanatory", name: "Explanatory" },
            ],
          },
        ] as any,
        ready: true,
        setConfigOption,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const trigger = screen.getByRole("button", {
      name: "Session runtime, harness, and model",
    });
    expect(trigger.textContent).toContain("GPT-5.5");
    expect(trigger.textContent).toContain("Low");
    expect(
      trigger.querySelector("[data-session-fast-mode-indicator]"),
    ).toBeTruthy();

    fireEvent.pointerDown(trigger);
    const runMenu = screen.getByRole("menu", {
      name: "Session runtime, harness, and model",
    });
    expect(within(runMenu).getByText("Fast mode")).toBeTruthy();
    expect(within(runMenu).queryByText("Personality")).toBeNull();

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: /Fast mode\s*On/ }),
      { key: "ArrowRight" },
    );
    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: /Fast mode/ }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast mode/ }));
    expect(setConfigOption).toHaveBeenCalledWith("fast-mode", false);

    const personalityTrigger = screen.getByRole("button", {
      name: "Personality",
    });
    fireEvent.pointerDown(personalityTrigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Explanatory" }));
    expect(setConfigOption).toHaveBeenCalledWith("personality", "explanatory");
  });

  it("shows Plan as a dismissible composer tag only while collaboration mode is active", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const setConfigOption = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        sessionConfigOptions: [
          ...codexAcpConfigOptions,
          {
            id: "collaboration_mode",
            name: "Collaboration mode",
            type: "select",
            currentValue: "plan",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
            ],
          },
        ] as any,
        ready: true,
        setConfigOption,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.queryByTestId("session-collaboration-mode-trigger"),
    ).toBeNull();
    const planTag = screen.getByTestId("session-plan-tag");
    expect(planTag.textContent).toContain("Plan");
    expect(planTag.className).toContain("shrink-0");
    fireEvent.click(screen.getByRole("button", { name: "Exit Plan mode" }));
    expect(setConfigOption).toHaveBeenCalledWith(
      "collaboration_mode",
      "default",
    );

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );
    const runMenu = screen.getByRole("menu", {
      name: "Session runtime, harness, and model",
    });
    expect(within(runMenu).queryByText("Collaboration mode")).toBeNull();
    expect(
      within(runMenu).queryByRole("menuitemradio", { name: "Plan" }),
    ).toBeNull();
  });

  it("renders live Goal state as a summary bar and a dismissible composer tag", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    const planStore = agentUIStoreFromMessages(
      [
        {
          id: "goal-plan",
          role: "assistant",
          parts: [
            {
              type: "plan",
              entries: [
                { content: "Trace the ACP lifecycle", status: "completed" },
                { content: "Verify the packaged app", status: "in_progress" },
              ],
            },
          ],
        },
      ],
      "goal-session",
      false,
    );
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sendMessage,
        ...agentUIOverrides(planStore),
        goal: {
          objective: "Repair the Clash Plan and Goal experience",
          status: "blocked",
          tokenBudget: 48_000,
          timeUsedSeconds: 361,
          createdAt: 1_785_201_976,
          controlMethod: "_codex/session/goal_control",
        },
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const goalBar = screen.getByRole("region", { name: "Goal status" });
    expect(goalBar.textContent).toContain("Goal blocked");
    expect(goalBar.textContent).toContain(
      "Repair the Clash Plan and Goal experience",
    );
    expect(goalBar.textContent).toContain("6m");
    expect(goalBar.textContent).toContain("1/2");
    expect(screen.getByTestId("session-goal-tag").textContent).toContain(
      "Goal",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show goal details" }));
    expect(
      within(goalBar).getByRole("list", { name: "Goal plan" }).textContent,
    ).toContain("Verify the packaged app");

    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(sendMessage).toHaveBeenCalledWith("/goal clear");
  });

  it("hides the locked harness list while allowing ACP model changes", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const select = vi.fn().mockResolvedValue(undefined);
    const startDraft = vi.fn();
    const setConfigOption = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              { id: "codex-acp", label: "Codex", binary: "codex-acp" },
              { id: "cursor", label: "Cursor", binary: "clash-acp-cursor" },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "runtime-session-one",
        status: "connected",
        sessionConfigOptions: [...codexAcpConfigOptions] as any,
        ready: true,
        select,
        startDraft,
        setConfigOption,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const trigger = screen.getByRole("button", {
      name: "Session runtime, harness, and model",
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    fireEvent.pointerDown(trigger);

    expect(screen.queryByText("Harness")).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /Codex/ })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /Cursor/ })).toBeNull();

    expect(select).not.toHaveBeenCalled();
    expect(startDraft).not.toHaveBeenCalled();

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: /Model\s*GPT-5\.5/ }),
      { key: "ArrowRight" },
    );
    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: /GPT-5\.4/ }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT-5\.4/ }));

    expect(setConfigOption).toHaveBeenCalledWith("model", "gpt-5.4");
  });

  it("refreshes runtime metadata when opening the session config selector", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.useClashRuntime.mockReturnValue(runtimeState({ refresh }));
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledWith({ probe: "config", refresh: true });
    });
  });

  it("notifies the user when session config refresh fails", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const refresh = vi
      .fn()
      .mockRejectedValue(new Error("runtime probe failed"));
    mocks.useClashRuntime.mockReturnValue(runtimeState({ refresh }));
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilotWithFeedback();

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not refresh local agents");
    expect(alert.textContent).toContain("runtime probe failed");
  });

  it("disables session config for an existing session when the harness exposes no model switch", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              { id: "codex-acp", label: "Codex", binary: "codex-acp" },
              { id: "cursor", label: "Cursor", binary: "clash-acp-cursor" },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "runtime-session-one",
        status: "connected",
        sessionConfigOptions: [],
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const trigger = screen.getByRole("button", {
      name: "Session runtime, harness, and model",
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);

    fireEvent.click(trigger);

    expect(
      screen.queryByRole("menu", {
        name: "Session runtime, harness, and model",
      }),
    ).toBeNull();
  });

  it("keeps long Cursor model menus scrollable inside the viewport", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const cursorModelConfig = {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "composer-2.5[fast=true]",
      options: Array.from({ length: 30 }, (_, index) => ({
        value: index === 0 ? "composer-2.5[fast=true]" : `model-${index}`,
        name: index === 0 ? "composer-2.5" : `Cursor model ${index}`,
      })),
    };
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              { id: "cursor", label: "Cursor", binary: "clash-acp-cursor" },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "cursor",
        status: "connected",
        sessionConfigOptions: [cursorModelConfig] as any,
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );

    const menu = screen.getByRole("menu", {
      name: "Session runtime, harness, and model",
    });
    expect(menu.className).toContain("overflow-hidden");
    expect(menu.querySelector('[class*="overflow-y-auto"]')).toBeTruthy();
    expect(menu.className).not.toContain("overflow-visible");
    expect(menu.getAttribute("style")).toContain("max-height:");
  });

  it("applies permission changes through the active harness session", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const select = vi.fn().mockResolvedValue(undefined);
    const setSessionMode = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sessionModes: {
          ...codexSessionModes,
          currentModeId: "codex:full-access",
        },
        select,
        setSessionMode,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const permissionTrigger = screen.getByRole("button", {
      name: "Harness permission mode",
    });
    expect(permissionTrigger.textContent).toContain("Full access");
    fireEvent.pointerDown(permissionTrigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Review/ }));

    expect(setSessionMode).toHaveBeenCalledWith("codex:review");
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps permission choices scoped to each selected harness before the session starts", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startDraft = vi.fn();
    const setSessionMode = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              {
                id: "codex-acp",
                label: "Codex",
                binary: "codex-acp",
                session_modes: {
                  ...codexSessionModes,
                  currentModeId: "codex:full-access",
                },
              },
              {
                id: "claude-acp",
                label: "Claude",
                binary: "claude-agent-acp",
                session_modes: {
                  currentModeId: "claude:full-access",
                  availableModes: [
                    {
                      id: "claude:ask",
                      name: "Ask first",
                      description: "Claude asks before tools",
                    },
                    {
                      id: "claude:full-access",
                      name: "Full access",
                      description: "Claude full access mode",
                    },
                  ],
                },
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "draft",
        ready: false,
        startDraft,
        setSessionMode,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const permissionTrigger = screen.getByRole("button", {
      name: "Harness permission mode",
    });
    expect(permissionTrigger.textContent).toContain("Full access");

    fireEvent.pointerDown(permissionTrigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Review/ }));
    expect(setSessionMode).toHaveBeenLastCalledWith("codex:review");

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude/ }));
    expect(startDraft).toHaveBeenLastCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "claude-acp",
      permissionModeId: "claude:full-access",
    });
    expect(
      screen.getByRole("button", { name: "Harness permission mode" })
        .textContent,
    ).not.toContain("Review");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Harness permission mode" }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Ask first/ }));
    expect(setSessionMode).toHaveBeenLastCalledWith("claude:ask");

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    expect(startDraft).toHaveBeenLastCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "codex-acp",
      permissionModeId: "codex:review",
    });
    expect(
      screen.getByRole("button", { name: "Harness permission mode" })
        .textContent,
    ).toContain("Review");
  });

  it("uses the selected agent's native ACP mode option as the visible permission mode", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const codexModeConfig = {
      id: "mode",
      name: "Mode",
      type: "select",
      category: "mode",
      currentValue: "agent",
      options: [
        {
          value: "read-only",
          name: "Read-only",
          description: "Requires approval before edits",
        },
        { value: "agent", name: "Agent", description: "Read and edit files" },
        {
          value: "agent-full-access",
          name: "Agent (full access)",
          description: "Can edit files and run tools",
        },
      ],
    };
    const qwenModeConfig = {
      id: "mode",
      name: "Mode",
      type: "select",
      category: "mode",
      currentValue: "qwen-safe",
      options: [
        {
          value: "qwen-safe",
          name: "Qwen safe",
          description: "Ask before tools",
        },
        {
          value: "qwen-auto",
          name: "Qwen auto",
          description: "Use Qwen defaults",
        },
      ],
    };
    const startDraft = vi.fn();
    const setConfigOption = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              {
                id: "codex-acp",
                label: "Codex",
                binary: "codex-acp",
                config_options: [codexModeConfig],
              },
              {
                id: "qwen-code",
                label: "Qwen Code",
                binary: "clash-acp-qwen-code",
                config_options: [qwenModeConfig],
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "draft",
        ready: false,
        sessionConfigOptions: [codexModeConfig] as any,
        startDraft,
        setConfigOption,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.getByRole("button", { name: "Harness permission mode" })
        .textContent,
    ).toContain("Approve for me");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Harness permission mode" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Ask for approval/ }),
    );

    expect(setConfigOption).toHaveBeenCalledWith("mode", "read-only");
    expect(startDraft).toHaveBeenLastCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "codex-acp",
      permissionModeId: "read-only",
    });

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Qwen Code/ }));
    expect(
      screen.getByRole("button", { name: "Harness permission mode" })
        .textContent,
    ).toContain("Qwen safe");

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));

    expect(startDraft).toHaveBeenLastCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "codex-acp",
      permissionModeId: "read-only",
    });
    expect(
      screen.getByRole("button", { name: "Harness permission mode" })
        .textContent,
    ).toContain("Ask for approval");
  });

  it("prefers ACP configOptions mode over deprecated session modes", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const setConfigOption = vi.fn();
    const setSessionMode = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sessionModes: codexSessionModes,
        sessionConfigOptions: [
          {
            id: "mode",
            name: "Permissions",
            type: "select",
            category: "mode",
            currentValue: "agent",
            options: [
              { value: "read-only", name: "Ask for approval" },
              { value: "agent", name: "Approve for me" },
            ],
          },
        ] as any,
        setConfigOption,
        setSessionMode,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.getByRole("button", { name: "Harness permission mode" })
        .textContent,
    ).toContain("Approve for me");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Harness permission mode" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Ask for approval/ }),
    );

    expect(setConfigOption).toHaveBeenCalledWith("mode", "read-only");
    expect(setSessionMode).not.toHaveBeenCalled();
  });

  it("does not reuse one agent's ACP mode config for another agent without mode config", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const codexModeConfig = {
      id: "mode",
      name: "Mode",
      type: "select",
      category: "mode",
      currentValue: "agent",
      options: [
        {
          value: "read-only",
          name: "Read-only",
          description: "Requires approval before edits",
        },
        { value: "agent", name: "Agent", description: "Read and edit files" },
      ],
    };
    const startDraft = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              {
                id: "codex-acp",
                label: "Codex",
                binary: "codex-acp",
                config_options: [codexModeConfig],
              },
              {
                id: "studio-agent",
                label: "Studio Agent",
                binary: "studio-agent",
              },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "draft",
        ready: false,
        sessionConfigOptions: [codexModeConfig] as any,
        startDraft,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Session runtime, harness, and model",
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Studio Agent/ }),
    );

    expect(startDraft).toHaveBeenLastCalledWith("desktop-local", undefined, {
      projectId: "project-one",
      agentId: "studio-agent",
    });
    expect(
      screen.queryByRole("button", { name: "Harness permission mode" }),
    ).toBeNull();
  });

  it("shows ACP slash commands only while the draft starts with slash", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        availableCommands: [
          { name: "review", description: "Review unstaged changes" },
          { name: "compact", description: "Compact this session" },
          {
            name: "frontend-design",
            description: "Build polished production interfaces",
            kind: "skill",
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    expect(
      screen.queryByRole("listbox", { name: "Slash commands" }),
    ).toBeNull();
    expect(screen.queryByText("/review")).toBeNull();

    fireEvent.click(screen.getByTestId("type-milkdown-slash"));

    const commandList = screen.getByRole("listbox", { name: "Slash commands" });
    expect(commandList).toBeTruthy();
    expect(within(commandList).getByText("/review")).toBeTruthy();
    expect(
      within(commandList).getByText("Review unstaged changes"),
    ).toBeTruthy();
    expect(within(commandList).getByText("/frontend-design")).toBeTruthy();
    expect(within(commandList).getByText("Commands")).toBeTruthy();
    expect(within(commandList).getByText("Skills")).toBeTruthy();
    const emptyActivity = document.querySelector(
      ".clash-copilot-agent-activity-empty-anchor",
    );
    expect(emptyActivity).toBeTruthy();
    expect(
      emptyActivity!.compareDocumentPosition(commandList) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(within(commandList).getByText("/review"));

    expect(
      (screen.getByLabelText("chat draft") as HTMLInputElement).value,
    ).toBe("/review ");
    expect(
      screen.queryByRole("listbox", { name: "Slash commands" }),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "hello" },
    });

    expect(
      screen.queryByRole("listbox", { name: "Slash commands" }),
    ).toBeNull();
    expect(screen.queryByText("/review")).toBeNull();
  });

  it("fuzzy-filters advertised ACP commands", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        availableCommands: [
          {
            name: "frontend-design",
            description: "Build polished interfaces",
            kind: "skill",
          },
          { name: "review", description: "Review changes" },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();
    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "/fd" },
    });

    const commandList = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commandList).getByText("/frontend-design")).toBeTruthy();
    expect(within(commandList).queryByText("/review")).toBeNull();
  });

  it("does not invent client-side slash commands when the active agent advertises none", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const prepareSession = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "draft",
        ready: false,
        availableCommands: [],
        prepareSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();
    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "/" },
    });

    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(
      within(commands).getByText("This agent has no slash commands."),
    ).toBeTruthy();
    expect(screen.queryByText("/model")).toBeNull();
    expect(prepareSession).not.toHaveBeenCalled();
  });

  it("exposes the Backchat plan command for any harness advertising collaboration mode", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [{ id: "future-harness", label: "Future Harness" }],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "future-harness",
        status: "draft",
        ready: false,
        availableCommands: [],
        sessionConfigOptions: [
          {
            id: "collaboration_mode",
            name: "Collaboration mode",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
            ],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();
    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "/" },
    });

    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commands).getByText("/plan")).toBeTruthy();
    fireEvent.click(within(commands).getByText("/plan"));
    expect(
      (screen.getByLabelText("chat draft") as HTMLInputElement).value,
    ).toBe("/plan");
  });

  it("executes an advertised config command action without sending it as a prompt", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    const setConfigOption = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [{ id: "future-harness", label: "Future Harness" }],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "future-harness",
        status: "draft",
        ready: false,
        sendMessage,
        setConfigOption,
        availableCommands: [
          {
            name: "plan",
            description: "Turn plan mode on.",
            _meta: {
              commandAction: {
                kind: "setConfigOption",
                configId: "collaboration_mode",
                value: "plan",
                resetValue: "default",
                presentation: "state",
              },
            },
          },
        ] as any,
        sessionConfigOptions: [
          {
            id: "collaboration_mode",
            name: "Collaboration mode",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
            ],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();
    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "/plan" },
    });
    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(setConfigOption).toHaveBeenCalledWith("collaboration_mode", "plan");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends ACP slash commands without prefixing Clash workspace context", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sendMessage,
        availableCommands: [
          { name: "goal", description: "Set a session goal" },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      workspaceContext: {
        projectId: "project-one",
        projectName: "Clash",
        activeSurface: { kind: "canvas", id: "main", name: "Main" },
      },
    });
    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "/goal Ship the product" },
    });
    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(sendMessage).toHaveBeenCalledWith("/goal Ship the product");
  });

  it("groups Codex dollar-prefixed advertised commands as skills", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        availableCommands: [
          { name: "review", description: "Review changes" },
          {
            name: "$frontend-design",
            description: "Build polished interfaces",
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();
    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "/" },
    });

    const commandList = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commandList).getByText("Commands")).toBeTruthy();
    expect(within(commandList).getByText("Skills")).toBeTruthy();
    expect(within(commandList).getByText("/$frontend-design")).toBeTruthy();
  });

  it("includes audio canvas nodes in the mention candidates", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      nodes: [{ id: "audio-one", type: "audio", data: { label: "Narration" } }],
    });

    expect(
      screen.getByTestId("chat-input").getAttribute("data-mention-types"),
    ).toContain("audio");
  });

  it("keeps the session selector compact beside the animated Backchat process persona", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "sending",
        ready: true,
        sessionConfigOptions: [...codexAcpConfigOptions] as any,
        messages: [
          {
            id: "runtime-message-one",
            role: "user",
            parts: [{ type: "text", text: "hello desktop runtime helper" }],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    const trigger = screen.getByRole("button", {
      name: "Session runtime, harness, and model",
    });
    const statusSlot = trigger.querySelector(
      "[data-session-config-status-slot]",
    );
    const process = container.querySelector(
      "[data-session-process-state='running']",
    );
    const processAvatar = process?.querySelector(
      "[data-session-process-avatar='true']",
    );
    expect(trigger.querySelector("[data-acp-agent-logo]")).toBeTruthy();
    expect(statusSlot?.textContent).toBe("");
    expect(process).toBeTruthy();
    expect(processAvatar).toBeTruthy();
    expect(
      processAvatar?.querySelector('[data-agent-motion-state="working"]'),
    ).toBeTruthy();
    expect(container.querySelector(".clash-copilot-agent-perch")).toBeNull();
    expect(
      container.querySelector(".clash-copilot-agent-activity-row"),
    ).toBeNull();
    expect(trigger.textContent).toContain("GPT-5.5");
    expect(trigger.textContent).not.toContain("Auto");
    expect(trigger.textContent).not.toContain("Local");
    expect(trigger.textContent).not.toContain("Codex");
  });

  it("does not leak runtime identity or a context meter below the composer", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "runtime-session-one",
        currentSession: {
          id: "runtime-session-one",
          threadId: "runtime-session-one",
          type: "runtime",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
        },
        status: "connected",
        ready: true,
        sessionUsage: { used: 1_500, size: 8_000 },
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();
    expect(container.querySelector('[data-session-runtime="true"]')).toBeNull();
    expect(container.querySelector('[data-context-used="1500"]')).toBeNull();
  });

  it("keeps the idle persona on the latest settled duration summary", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startedAt = Date.parse("2026-06-21T00:00:00.000Z");
    const runningStore = agentUIStoreWithActivity({ startedAt });
    const completedStore = agentUIStoreWithActivity({
      startedAt,
      endedAt: startedAt + 125_000,
    });
    const runningState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      status: "sending",
      ready: true,
      ...agentUIOverrides(runningStore),
      messages: [
        {
          id: "runtime-message-one",
          role: "user",
          parts: [{ type: "text", text: "hello desktop runtime helper" }],
        },
      ] as any,
    });
    const completedState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "connected",
      ready: true,
      ...agentUIOverrides(completedStore),
      messages: runningState.messages,
    });
    mocks.useClashRuntime.mockReturnValue(runningState);
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container, rerender } = renderDesktopCopilot();
    expect(
      container.querySelector("[data-session-process-state='running']"),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-session-process-avatar='true']"),
    ).toBeTruthy();

    mocks.useClashRuntime.mockReturnValue(completedState);
    act(() => {
      rerender(
        <ChatbotCopilot
          projectId="project-one"
          threadId="thread-one"
          initialMessages={[]}
          width={420}
          onWidthChange={() => undefined}
          isCollapsed={false}
          onCollapseChange={() => undefined}
        />,
      );
    });

    const settled = container.querySelector(
      "[data-session-process-state='complete']",
    );
    expect(settled).toBeTruthy();
    expect(settled?.textContent).toContain("125");
    expect(
      settled?.querySelector("[data-session-process-avatar='true']"),
    ).toBeTruthy();
    expect(
      settled?.querySelector('[data-agent-motion-state="idle"]'),
    ).toBeTruthy();
    expect(
      settled?.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("does not invent a streaming activity row for attached completed runtime history", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        runtimes: [
          {
            ...desktopLocalRuntime,
            agents: [
              { id: "codex-acp", binary: "codex-acp" },
              { id: "cursor", label: "Cursor", binary: "clash-acp-cursor" },
            ],
          },
        ],
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "cursor",
        sessionId: "local-session-cursor",
        currentSession: {
          id: "local-session-cursor",
          threadId: "local-session-cursor",
          type: "runtime",
          projectId: "project-one",
          runtimeId: "desktop-local",
          agentId: "cursor",
          status: "active",
        },
        status: "connected",
        ready: true,
        messages: [
          {
            id: "user-turn-cursor",
            role: "user",
            parts: [{ type: "text", text: "Reply exactly: pong" }],
          },
          {
            id: "assistant-turn-cursor",
            role: "assistant",
            parts: [{ type: "text", text: "pong" }],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(screen.getAllByText("Reply exactly: pong").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Putting it into words")).toBeNull();
    expect(
      container.querySelector(".clash-copilot-agent-activity-wrapper"),
    ).toBeNull();
  });

  it("keeps one running Backchat process on the newest registered follow-up turn", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const runningState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "sending",
      ready: true,
      messages: [
        {
          id: "user-runtime-message-one",
          role: "user",
          parts: [{ type: "text", text: "first prompt" }],
        },
      ] as any,
    });
    const runningWithFollowUpState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "sending",
      ready: true,
      messages: [
        ...runningState.messages,
        {
          id: "user-runtime-message-two",
          role: "user",
          parts: [{ type: "text", text: "second prompt" }],
        },
      ] as any,
    });
    mocks.useClashRuntime.mockReturnValue(runningState);
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container, rerender } = renderDesktopCopilot();
    expect(
      container.querySelectorAll("[data-session-process-state='running']"),
    ).toHaveLength(1);

    mocks.useClashRuntime.mockReturnValue(runningWithFollowUpState);
    act(() => {
      rerender(
        <ChatbotCopilot
          projectId="project-one"
          threadId="thread-one"
          initialMessages={[]}
          width={420}
          onWidthChange={() => undefined}
          isCollapsed={false}
          onCollapseChange={() => undefined}
        />,
      );
    });

    const turns = container.querySelectorAll("[data-turn-id]");
    const runningProcesses = container.querySelectorAll(
      "[data-session-process-state='running']",
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]?.getAttribute("data-turn-id")).toBe("runtime-message-one");
    expect(turns[1]?.getAttribute("data-turn-id")).toBe("runtime-message-two");
    expect(runningProcesses).toHaveLength(1);
    expect(
      runningProcesses[0]
        ?.closest("[data-turn-id]")
        ?.getAttribute("data-turn-id"),
    ).toBe("runtime-message-two");
    expect(
      runningProcesses[0]?.querySelector('[data-agent-motion-state="working"]'),
    ).toBeTruthy();
  });

  it("restores the Clash empty activity after a Backchat turn completes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startedAt = Date.parse("2026-06-21T00:00:00.000Z");
    const runningState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "sending",
      ready: true,
      ...agentUIOverrides(agentUIStoreWithActivity({ startedAt })),
      messages: [
        {
          id: "runtime-message-one",
          role: "user",
          parts: [{ type: "text", text: "hello desktop runtime helper" }],
        },
      ] as any,
    });
    const completedState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "connected",
      ready: true,
      ...agentUIOverrides(
        agentUIStoreWithActivity({
          startedAt,
          endedAt: startedAt + 125_000,
        }),
      ),
      messages: runningState.messages,
    });
    const newChatState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: null,
      status: "draft",
      ready: false,
      messages: [],
    });
    mocks.useClashRuntime.mockReturnValue(runningState);
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { rerender } = renderDesktopCopilot();
    expect(
      document.querySelector("[data-session-process-state='running']"),
    ).toBeTruthy();

    vi.setSystemTime(new Date("2026-06-21T00:02:05.000Z"));
    mocks.useClashRuntime.mockReturnValue(completedState);
    act(() => {
      rerender(
        <ChatbotCopilot
          projectId="project-one"
          threadId="thread-one"
          initialMessages={[]}
          width={420}
          onWidthChange={() => undefined}
          isCollapsed={false}
          onCollapseChange={() => undefined}
        />,
      );
    });
    expect(
      document.querySelector("[data-session-process-state='complete']")
        ?.textContent,
    ).toContain("125");

    mocks.useClashRuntime.mockReturnValue(newChatState);
    act(() => {
      rerender(
        <ChatbotCopilot
          projectId="project-one"
          threadId="thread-one"
          initialMessages={[]}
          width={420}
          onWidthChange={() => undefined}
          isCollapsed={false}
          onCollapseChange={() => undefined}
        />,
      );
    });

    expect(
      document.querySelector(".clash-copilot-agent-activity-empty-anchor"),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-agent-motion-state="idle"]'),
    ).toBeTruthy();
    expect(screen.getByText("Ready when you are")).toBeTruthy();
    expect(document.querySelector("[data-session-process]")).toBeNull();
    vi.useRealTimers();
  });

  it("does not restore stale worked duration after the new chat view remounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const startedAt = Date.parse("2026-06-21T00:00:00.000Z");
    const runningState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "sending",
      ready: true,
      ...agentUIOverrides(agentUIStoreWithActivity({ startedAt })),
      messages: [
        {
          id: "runtime-message-one",
          role: "user",
          parts: [{ type: "text", text: "hello desktop runtime helper" }],
        },
      ] as any,
    });
    const completedState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "connected",
      ready: true,
      ...agentUIOverrides(
        agentUIStoreWithActivity({
          startedAt,
          endedAt: startedAt + 125_000,
        }),
      ),
      messages: runningState.messages,
    });
    const newChatState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: null,
      status: "draft",
      ready: false,
      messages: [],
    });
    mocks.useClashRuntime.mockReturnValue(runningState);
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { rerender, unmount } = renderDesktopCopilot();
    expect(
      document.querySelector("[data-session-process-state='running']"),
    ).toBeTruthy();

    vi.setSystemTime(new Date("2026-06-21T00:02:05.000Z"));
    mocks.useClashRuntime.mockReturnValue(completedState);
    act(() => {
      rerender(
        <ChatbotCopilot
          projectId="project-one"
          threadId="thread-one"
          initialMessages={[]}
          width={420}
          onWidthChange={() => undefined}
          isCollapsed={false}
          onCollapseChange={() => undefined}
        />,
      );
    });
    expect(
      document.querySelector("[data-session-process-state='complete']")
        ?.textContent,
    ).toContain("125");

    unmount();
    mocks.useClashRuntime.mockReturnValue(newChatState);
    renderDesktopCopilot({ threadId: "thread-two" });

    expect(
      document.querySelector(".clash-copilot-agent-activity-empty-anchor"),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-agent-motion-state="idle"]'),
    ).toBeTruthy();
    expect(screen.getByText("Ready when you are")).toBeTruthy();
    expect(document.querySelector("[data-session-process]")).toBeNull();
    vi.useRealTimers();
  });

  it("keeps the idle new-chat activity near the composer without anchoring active messages", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const newChatState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: null,
      status: "draft",
      ready: false,
      messages: [],
    });
    const activeMessageState = runtimeState({
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "runtime-session-one",
      status: "sending",
      ready: true,
      messages: [
        {
          id: "user-runtime-message-one",
          role: "user",
          parts: [{ type: "text", text: "start the run" }],
        },
      ] as any,
    });

    mocks.useClashRuntime.mockReturnValue(newChatState);
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { rerender } = renderDesktopCopilot();

    const emptyAnchor = document.querySelector(
      ".clash-copilot-agent-activity-empty-anchor",
    );
    expect(emptyAnchor).toBeTruthy();
    expect(emptyAnchor?.className).toContain(
      "clash-copilot-agent-activity-composer-companion",
    );
    expect(emptyAnchor?.className).toContain("pb-1");
    expect(emptyAnchor?.className).toContain("top-2");
    expect(emptyAnchor?.className).toContain("-left-3");
    expect(emptyAnchor?.className).not.toContain("sm:-left-6");
    expect(emptyAnchor?.closest('[data-chat-column="composer"]')).toBeTruthy();
    expect(screen.getByText("Ready when you are")).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Starter suggestions" }),
    ).toBeNull();

    mocks.useClashRuntime.mockReturnValue(activeMessageState);
    act(() => {
      rerender(
        <ChatbotCopilot
          projectId="project-one"
          threadId="thread-one"
          initialMessages={[]}
          width={420}
          onWidthChange={() => undefined}
          isCollapsed={false}
          onCollapseChange={() => undefined}
        />,
      );
    });

    expect(
      document.querySelector(".clash-copilot-agent-activity-empty-anchor"),
    ).toBeNull();
    expect(screen.getByText("start the run")).toBeTruthy();
  });

  it("renders runtime thinking and tools through the canonical Backchat timeline", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const assistantMessage = {
      id: "runtime-assistant-one",
      role: "assistant",
      parts: [
        { type: "thought", text: "Checking the canvas first." },
        {
          type: "tool_call",
          toolCallId: "tool-1",
          title: "Read",
          rawInput: { path: "notes.md" },
          status: "pending",
        },
      ],
    };
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        messages: [assistantMessage] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(
      screen
        .getByTestId("runtime-session-timeline")
        .getAttribute("data-renderer"),
    ).toBe("backchat");
    expect(container.querySelector("[data-thought-block='true']")).toBeTruthy();
    expect(
      container.querySelector("[data-tool-call-id='tool-1']"),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-session-process-avatar='true']"),
    ).toBeTruthy();
    expect(screen.queryByTestId("acp-message-list")).toBeNull();
  });

  it("does not route canonical turns back through the flat-message renderer", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const assistantMessage = {
      id: "runtime-clash-mcp",
      role: "assistant",
      parts: [{ type: "text", text: "Done." }],
    };
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        messages: [assistantMessage] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      workspaceContext: {
        projectId: "project-one",
        projectName: "Launch Film",
        activeSurface: { kind: "canvas", id: "main", name: "Main Storyboard" },
      },
      mentionSources: [
        {
          id: "action-1",
          type: "action",
          label: "Render variants",
          kind: "node",
          scope: "current-canvas",
          canvasId: "main",
          canvasName: "Main Storyboard",
        },
      ],
    });

    expect(screen.getByTestId("runtime-session-timeline")).toBeTruthy();
    expect(screen.getByText("Done.")).toBeTruthy();
    expect(screen.queryByTestId("acp-message-list")).toBeNull();
  });

  it("treats runtime edge update and delete after same-patch edge creation as new-edge operations", async () => {
    vi.useFakeTimers();
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const onAddNode = vi.fn();
    const onAddEdge = vi.fn();
    const onUpdateEdge = vi.fn();
    const onRemoveEdge = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        messages: [
          {
            id: "runtime-patch-one",
            role: "assistant",
            parts: [
              {
                type: "raw_event",
                event: {
                  sessionUpdate: "clash.canvas.patch",
                  operations: [
                    {
                      op: "add_node",
                      node: {
                        id: "agent-source",
                        type: "text",
                        data: { label: "Source" },
                      },
                    },
                    {
                      op: "add_node",
                      node: {
                        id: "agent-target",
                        type: "image",
                        data: { label: "Target" },
                      },
                    },
                    {
                      op: "add_edge",
                      edge: {
                        id: "agent-source-agent-target",
                        source: "agent-source",
                        target: "agent-target",
                        type: "default",
                      },
                    },
                    {
                      op: "update_edge",
                      edge: {
                        id: "agent-source-agent-target",
                        patch: { label: "reviewed", animated: true },
                      },
                    },
                    {
                      op: "delete_edge",
                      edge: { id: "agent-source-agent-target" },
                    },
                  ],
                },
              },
            ],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({ onAddNode, onAddEdge, onUpdateEdge, onRemoveEdge });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(onAddEdge).toHaveBeenCalledWith(
      {
        id: "agent-source-agent-target",
        source: "agent-source",
        target: "agent-target",
        type: "default",
      },
      undefined,
    );
    expect(onUpdateEdge).toHaveBeenCalledWith(
      "agent-source-agent-target",
      { label: "reviewed", animated: true },
      undefined,
    );
    expect(onRemoveEdge).toHaveBeenCalledWith(
      "agent-source-agent-target",
      undefined,
    );
    vi.useRealTimers();
  });

  it("delegates runtime transcript scrolling to the common chat surface", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "streaming",
        ready: true,
        messages: [
          {
            id: "runtime-assistant-one",
            role: "assistant",
            parts: [{ type: "text", text: "First chunk" }],
          },
        ] as any,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const { container } = renderDesktopCopilot();

    expect(screen.getByRole("log")).toBeTruthy();
    expect(container.querySelector('[data-chat-column="turns"]')).toBeTruthy();
    expect(
      container.querySelector('[data-chat-column="composer"]'),
    ).toBeTruthy();
    expect(container.querySelector(".clash-copilot-composer-stack")).toBeNull();
    expect(container.querySelector(".overflow-y-auto")).toBeNull();
  });

  it("keeps runtime prompts free of implicit selection context (annotations own that flow)", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sendMessage,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    fireEvent.click(screen.getByTestId("submit-chat-input"));

    expect(sendMessage).toHaveBeenCalledWith("这个是?");
    expect(sendMessage.mock.calls[0]?.[0]).not.toContain("Selected context:");
  });

  it("sends the active canvas address with the user turn", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const sendMessage = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        status: "connected",
        ready: true,
        sendMessage,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot({
      workspaceContext: {
        projectId: "project-one",
        projectName: "Launch Film",
        activeSurface: {
          kind: "canvas",
          id: "canvas-main",
          name: "Main Storyboard",
        },
      },
      mentionSources: [
        {
          id: "action-1",
          type: "action",
          label: "Render variants",
          kind: "node",
          scope: "current-canvas",
          canvasId: "canvas-main",
          canvasName: "Main Storyboard",
        },
      ],
    });

    fireEvent.change(screen.getByLabelText("chat draft"), {
      target: { value: "Run @[Render variants](node:action-1)" },
    });
    fireEvent.click(screen.getByTestId("submit-chat-input"));

    const prompt = sendMessage.mock.calls[0]?.[0] as string;
    expect(prompt.endsWith("Run @[Render variants](node:action-1)")).toBe(true);
    const payload = JSON.parse(
      prompt.split("<!-- clash-workspace-context ")[1].split(" -->")[0],
    );
    expect(payload.projectId).toBe("project-one");
    expect(payload.activeSurface).toEqual({
      kind: "canvas", id: "canvas-main", name: "Main Storyboard",
    });
  });

  it("auto-opens the session update notice from the header and lets the user collapse it", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const restartSession = vi.fn().mockResolvedValue(undefined);
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "session-old-codex",
        currentSession: {
          id: "session-old-codex",
          threadId: "session-old-codex",
          type: "runtime",
          runtimeId: "desktop-local",
          agentId: "codex-acp",
        },
        status: "connected",
        ready: true,
        sessionRuntimeStatus: {
          session_id: "session-old-codex",
          harness_id: "codex-acp",
          harness_label: "Codex",
          running_version: "1.0.1",
          installed_version: "1.0.2",
          restart_required: true,
          busy: false,
          restart_pending: false,
        },
        promptQueue: [
          {
            id: "queued-one",
            turnId: "queued-turn-one",
            text: "Tighten the ending",
            createdAt: 1,
          },
        ],
        promptQueueMode: "single",
        restartSession,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const trigger = screen.getByRole("button", {
      name: "ACP update requires session restart",
    });
    const notice = await screen.findByText("Codex 1.0.2 installed");
    const promptQueue = document.querySelector(".clash-runtime-prompt-queue");
    expect(
      notice.closest('[data-session-runtime-update-popover="true"]'),
    ).toBeTruthy();
    expect(promptQueue).toBeTruthy();
    expect(promptQueue?.className).toContain("w-[calc(100%-6rem)]");
    expect(promptQueue?.className).toContain("max-w-[940px]");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss ACP update notice" }),
    );
    expect(screen.queryByText("Codex 1.0.2 installed")).toBeNull();
    expect(trigger).toBeTruthy();

    fireEvent.click(trigger);
    expect(await screen.findByText("Codex 1.0.2 installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart session" }));
    expect(restartSession).toHaveBeenCalledWith("now");
  });

  it("replaces the entire composer with the blocking ACP permission form", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const respondPermission = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "session-permission",
        status: "streaming",
        ready: true,
        permissionRequests: [
          {
            requestId: "permission-1",
            sessionId: "session-permission",
            toolCall: { toolCallId: "tool-1", title: "Edit file" },
            options: [
              { optionId: "reject", name: "Reject", kind: "reject_once" },
              { optionId: "allow", name: "Allow", kind: "allow_once" },
            ],
          },
        ],
        respondPermission,
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    renderDesktopCopilot();

    const approval = await screen.findByRole("group", {
      name: "Approval required",
    });
    expect(approval.closest("aside")).toBeTruthy();
    expect(approval.className).toContain("clash-chat-input-surface");
    expect(
      screen.queryByRole("dialog", { name: "Approval required" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Harness permission mode" }),
    ).toBeNull();
    expect(screen.queryByTestId("milkdown-editor")).toBeNull();
    expect(screen.getByText("Edit file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(respondPermission).toHaveBeenCalledWith("permission-1", "allow");
  });

  it("answers multi-step ACP elicitation without losing the existing composer draft", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const respondElicitation = vi.fn();
    const baseRuntime = {
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "session-elicitation",
      status: "streaming" as const,
      ready: true,
    };
    mocks.useClashRuntime.mockReturnValue(runtimeState(baseRuntime));
    mocks.useAgentCopilot.mockReturnValue(cloudState());
    const view = renderDesktopCopilot();
    fireEvent.change(screen.getByRole("textbox", { name: "chat draft" }), {
      target: { value: "keep my unfinished prompt" },
    });

    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        ...baseRuntime,
        elicitationRequests: [
          {
            requestId: "elicitation-1",
            sessionId: "session-elicitation",
            mode: "form",
            message: "Choose release settings",
            schema: {
              properties: {
                channel: {
                  type: "string",
                  title: "Channel",
                  enum: ["stable", "preview"],
                },
                notes: { type: "string", title: "Notes", minLength: 2 },
              },
              required: ["channel", "notes"],
            },
          },
        ],
        respondElicitation,
      }),
    );
    view.rerender(copilotElement());

    expect(screen.getByRole("group", { name: "Input required" })).toBeTruthy();
    expect(screen.getByText("Question 1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "stable" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Question 2 of 2")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(respondElicitation).toHaveBeenCalledWith("elicitation-1", {
      action: "accept",
      content: { channel: "stable", notes: "Ship it" },
    });

    mocks.useClashRuntime.mockReturnValue(runtimeState(baseRuntime));
    view.rerender(copilotElement());
    expect(screen.getByRole("textbox", { name: "chat draft" })).toHaveValue(
      "keep my unfinished prompt",
    );
  });

  it("does not append resolved elicitation callbacks after the Backchat timeline", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        selectedRuntimeId: "desktop-local",
        selectedAgentId: "codex-acp",
        sessionId: "session-receipt",
        status: "connected",
        ready: true,
        elicitationReceipts: [
          {
            requestId: "receipt-1",
            message: "Choose release settings",
            action: "accept",
            content: { channel: "stable", targets: ["macOS", "Windows"] },
          },
        ],
      }),
    );
    mocks.useAgentCopilot.mockReturnValue(cloudState());
    renderDesktopCopilot();

    expect(
      screen.queryByRole("button", {
        name: /Answered.*Choose release settings/,
      }),
    ).toBeNull();
    expect(screen.queryByText("stable")).toBeNull();
    expect(screen.queryByText("macOS, Windows")).toBeNull();
  });

  it("restores the untouched composer draft after a blocking permission is resolved", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const baseRuntime = {
      selectedRuntimeId: "desktop-local",
      selectedAgentId: "codex-acp",
      sessionId: "session-permission-draft",
      status: "streaming" as const,
      ready: true,
    };
    mocks.useClashRuntime.mockReturnValue(runtimeState(baseRuntime));
    mocks.useAgentCopilot.mockReturnValue(cloudState());

    const view = renderDesktopCopilot();
    fireEvent.change(screen.getByRole("textbox", { name: "chat draft" }), {
      target: { value: "keep this draft" },
    });

    mocks.useClashRuntime.mockReturnValue(
      runtimeState({
        ...baseRuntime,
        permissionRequests: [
          {
            requestId: "permission-draft",
            sessionId: "session-permission-draft",
            toolCall: { toolCallId: "tool-draft", title: "Write project file" },
            options: [
              { optionId: "reject", name: "Reject", kind: "reject_once" },
              { optionId: "allow", name: "Allow", kind: "allow_once" },
            ],
          },
        ],
      }),
    );
    view.rerender(
      <ChatbotCopilot
        projectId="project-one"
        threadId="thread-one"
        initialMessages={[]}
        width={420}
        onWidthChange={() => undefined}
        isCollapsed={false}
        onCollapseChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("textbox", { name: "chat draft" })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Approval required" }),
    ).toBeTruthy();

    mocks.useClashRuntime.mockReturnValue(runtimeState(baseRuntime));
    view.rerender(
      <ChatbotCopilot
        projectId="project-one"
        threadId="thread-one"
        initialMessages={[]}
        width={420}
        onWidthChange={() => undefined}
        isCollapsed={false}
        onCollapseChange={() => undefined}
      />,
    );
    expect(
      (screen.getByRole("textbox", { name: "chat draft" }) as HTMLInputElement)
        .value,
    ).toBe("keep this draft");
  });
});
