// @vitest-environment jsdom
import {
  forwardRef,
  useImperativeHandle,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardComposerRuntime } from "./HeroSection";
import {
  DashboardComposerProvider,
  useDashboardComposer,
} from "./DashboardComposerContext";
import type { UseClashRuntimeReturn } from "@clash/web-ui/hooks/useClashRuntime";
import { createAgentUIStore } from "@openma/common/agent-ui";

function emptyAgentUIRuntime() {
  const store = createAgentUIStore("draft");
  return { agentUIStore: store, agentUIState: store.getState() };
}

const mocks = vi.hoisted(() => ({
  runtimeState: {
    selectedAgentId: null as string | null,
    sessionConfigOptions: [] as UseClashRuntimeReturn["sessionConfigOptions"],
  },
  startDraft: vi.fn(),
  setConfigOption: vi.fn(),
  setSessionMode: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  createProjectRecord: vi.fn().mockResolvedValue({ id: "project-1" }),
  updateProjectName: vi.fn().mockResolvedValue(undefined),
  persistRuntimeRunPreferences: vi.fn().mockResolvedValue(undefined),
  focusEditor: vi.fn(),
  insertAssetReference: vi.fn(),
  listPersonalGlobalAssets: vi.fn().mockResolvedValue([
    {
      id: "global-still",
      kind: "image",
      name: "Library still",
      metadata: {},
      lifecycle: { state: "active" },
      status: "ready",
      url: "https://media.clash.test/global-still.png",
      thumbnailUrl: "https://media.clash.test/global-still.png",
    },
  ]),
  listProjectAssets: vi.fn().mockResolvedValue([]),
  admitPersonalGlobalAssetToProject: vi.fn().mockResolvedValue({
    id: "project-still",
    kind: "image",
    name: "Library still",
    metadata: {},
    lifecycle: { state: "active" },
    status: "ready",
    url: "https://media.clash.test/project-still.png",
    thumbnailUrl: "https://media.clash.test/project-still.png",
  }),
}));

vi.mock("@clash/web-ui/lib/clientActions", () => ({
  createProjectRecord: mocks.createProjectRecord,
  updateProjectName: mocks.updateProjectName,
  persistRuntimeRunPreferences: mocks.persistRuntimeRunPreferences,
}));

vi.mock("@clash/web-ui/lib/hooks/useAsset", () => ({
  listPersonalGlobalAssets: mocks.listPersonalGlobalAssets,
  listProjectAssets: mocks.listProjectAssets,
  admitPersonalGlobalAssetToProject: mocks.admitPersonalGlobalAssetToProject,
  importProjectAssetFile: vi.fn(),
}));

const modeOption = {
  id: "mode",
  name: "Mode",
  type: "select",
  category: "mode",
  currentValue: "agent",
  options: [
    { value: "read-only", name: "Read-only" },
    { value: "agent", name: "Agent" },
    { value: "agent-full-access", name: "Agent (full access)" },
  ],
};

const modelOption = {
  id: "model",
  name: "Model",
  type: "select",
  category: "model",
  currentValue: "gpt-5.6-sol",
  options: [
    { value: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    { value: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
  ],
};

vi.mock("@clash/web-ui/hooks/useClashRuntime", () => ({
  useClashRuntime: (): UseClashRuntimeReturn => ({
    runtimes: [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [
          {
            id: "codex-acp",
            label: "Codex",
            config_options: [modeOption, modelOption],
          },
        ],
        preferences: {
          agent_id: "codex-acp",
          config_by_agent: {},
          mode_by_agent: { "codex-acp": "agent" },
        },
        version: "desktop",
        status: "online",
        last_heartbeat: Date.now(),
        created_at: Date.now(),
      },
    ],
    startupStatus: "ready",
    selectedRuntimeId: null,
    selectedAgentId: mocks.runtimeState.selectedAgentId,
    sessionId: null,
    currentSession: null,
    status: "idle",
    errorMessage: null,
    transientStatus: null,
    diagnostics: [],
    modelFallback: null,
    supportsMessageFork: false,
    ...emptyAgentUIRuntime(),
    messages: [],
    availableCommands: [],
    promptQueue: [],
    promptQueueEnabled: true,
    promptQueueMode: "single",
    sessionConfigOptions: mocks.runtimeState.sessionConfigOptions,
    sessionModes: null,
    sessionInfoMeta: null,
    goal: null,
    sessionUsage: null,
    permissionRequests: [],
    elicitationRequests: [],
    sessionRuntimeStatus: null,
    sessionRestartPhase: "idle",
    ready: false,
    refresh: mocks.refresh,
    select: vi.fn(),
    startDraft: mocks.startDraft,
    prepareSession: vi.fn(),
    attachSession: vi.fn(),
    loadResumeOptions: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    setPromptQueueEnabled: vi.fn(),
    setPromptQueueMode: vi.fn(),
    steerQueuedPrompt: vi.fn(),
    updateQueuedPrompt: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    reorderPromptQueue: vi.fn(),
    clearPromptQueue: vi.fn(),
    setConfigOption: mocks.setConfigOption,
    setSessionMode: mocks.setSessionMode,
    respondPermission: vi.fn(),
    respondElicitation: vi.fn(),
    restartSession: vi.fn(),
    cancel: vi.fn(),
    shutdown: vi.fn(),
  }),
}));

vi.mock("./copilot/ChatInput", () => ({
  ChatInput: forwardRef(
    (
      props: {
        input: string;
        onInputChange: (value: string) => void;
        onSubmit: (value: string) => void;
        variant?: string;
        projectId?: string;
        ensureProjectId?: () => Promise<string | null>;
        toolbarAccessory?: ReactNode;
        rightToolbarAccessory?: ReactNode;
        referenceAccessory?: ReactNode;
        visualState?: "compact" | "expanded";
        placeholder?: string;
        mentionableNodes?: Array<{
          id: string;
          scope?: string;
          resolveReference?: () => Promise<unknown>;
        }>;
        onOpenAssetPicker?: () => void;
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => ({
        focus: mocks.focusEditor,
        insertAssetReference: mocks.insertAssetReference,
      }));
      return (
        <div
          data-testid="dashboard-composer-runtime"
          data-variant={props.variant}
          data-visual-state={props.visualState}
          data-has-reference-accessory={String(
            Boolean(props.referenceAccessory),
          )}
          data-can-attach={String(
            Boolean(props.projectId || props.ensureProjectId),
          )}
          data-placeholder={props.placeholder}
          data-mention-scopes={props.mentionableNodes
            ?.map((node) => node.scope)
            .join(",")}
        >
          <input
            aria-label="Composer input"
            value={props.input}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              props.onInputChange(event.target.value)
            }
          />
          <button type="button" onClick={() => props.onSubmit(props.input)}>
            Submit
          </button>
          <button type="button" onClick={props.onOpenAssetPicker}>
            Open asset library
          </button>
          <button
            type="button"
            onClick={() =>
              void props.mentionableNodes
                ?.find((node) => node.scope === "global-assets")
                ?.resolveReference?.()
            }
          >
            Resolve global mention
          </button>
          {props.ensureProjectId ? (
            <button
              type="button"
              onClick={() => void props.ensureProjectId?.()}
            >
              Ensure Project scope
            </button>
          ) : null}
          {props.toolbarAccessory}
          {props.rightToolbarAccessory}
          {props.referenceAccessory}
        </div>
      );
    },
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function AddSkill() {
  const { addSkillReference } = useDashboardComposer();
  return (
    <button
      type="button"
      onClick={() => addSkillReference({ id: "skill-1", name: "storyboard" })}
    >
      Add skill
    </button>
  );
}

function AddProject() {
  const { addProjectReference } = useDashboardComposer();
  return (
    <button
      type="button"
      onClick={() =>
        addProjectReference({ id: "existing-project", name: "Existing film" })
      }
    >
      Add project
    </button>
  );
}

function FocusComposerButton() {
  const { focusComposer } = useDashboardComposer();
  return (
    <button type="button" onClick={focusComposer}>
      Focus composer
    </button>
  );
}

function renderComposer() {
  return render(
    <MemoryRouter>
      <DashboardComposerProvider>
        <DashboardComposerRuntime />
        <AddSkill />
        <AddProject />
        <FocusComposerButton />
        <LocationProbe />
      </DashboardComposerProvider>
    </MemoryRouter>,
  );
}

describe("dashboard composer runtime", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.runtimeState.selectedAgentId = null;
    mocks.runtimeState.sessionConfigOptions = [];
    delete document.documentElement.dataset.dashboardComposerTransition;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: undefined,
    });
  });

  it("shares the Backchat permission/model rail and an explicit focus action", async () => {
    renderComposer();

    expect(
      screen.getByTestId("dashboard-composer-runtime").dataset.variant,
    ).toBe("default");
    expect(
      screen.getByTestId("dashboard-composer-runtime").dataset.visualState,
    ).toBeUndefined();
    expect(
      screen.getByTestId("dashboard-composer-runtime").dataset
        .hasReferenceAccessory,
    ).toBe("false");
    expect(
      screen.getByTestId("dashboard-composer-runtime"),
    ).not.toHaveAttribute("data-placeholder");
    expect(
      screen.getByTestId("session-permission-mode-trigger").textContent,
    ).toContain("Approve for me");
    expect(
      screen.getByTestId("session-harness-config-trigger").textContent,
    ).toContain("GPT-5.6-Sol");

    fireEvent.click(screen.getByRole("button", { name: "Focus composer" }));
    expect(mocks.focusEditor).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.startDraft).toHaveBeenCalled());
  });

  it("shows the active draft permission mode ahead of the saved dashboard preference", () => {
    mocks.runtimeState.selectedAgentId = "codex-acp";
    mocks.runtimeState.sessionConfigOptions = [
      { ...modeOption, currentValue: "agent-full-access" },
      modelOption,
    ];

    renderComposer();

    expect(
      screen.getByTestId("session-permission-mode-trigger").textContent,
    ).toContain("Full access");
  });

  it("uses Backchat's distinct permission icons in the dashboard composer", () => {
    renderComposer();

    const trigger = screen.getByRole("button", {
      name: "Harness permission mode",
    });
    expect(trigger.querySelector("svg")).toHaveClass("lucide-shield-check");

    fireEvent.pointerDown(trigger);

    expect(
      screen
        .getByRole("menuitemradio", { name: /Ask for approval/ })
        .querySelector("svg"),
    ).toHaveClass("lucide-hand");
    expect(
      screen
        .getByRole("menuitemradio", { name: /Approve for me/ })
        .querySelector("svg"),
    ).toHaveClass("lucide-shield-check");
    expect(
      screen
        .getByRole("menuitemradio", { name: /Full access/ })
        .querySelector("svg"),
    ).toHaveClass("lucide-shield-alert");
  });

  it("creates and binds one owning Project when Dashboard attachment scope is requested", async () => {
    renderComposer();

    expect(
      screen.getByTestId("dashboard-composer-runtime").dataset.canAttach,
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Ensure Project scope" }),
    );

    await waitFor(() => {
      expect(mocks.createProjectRecord).toHaveBeenCalledWith(
        "Untitled project",
      );
    });
  });

  it("offers Global Assets to both the plus picker and the @ mention boundary", async () => {
    renderComposer();

    await waitFor(() => {
      expect(
        screen.getByTestId("dashboard-composer-runtime").dataset.mentionScopes,
      ).toContain("global-assets");
    });

    fireEvent.click(screen.getByRole("button", { name: "Open asset library" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Add Library still" }),
    );

    await waitFor(() => {
      expect(mocks.admitPersonalGlobalAssetToProject).toHaveBeenCalledWith(
        "project-1",
        "global-still",
      );
      expect(mocks.insertAssetReference).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "project-still",
          label: "Library still",
          kind: "asset",
          scope: "project-assets",
        }),
      );
    });
  });

  it("keeps Global Assets mentionable after an existing Project is selected", async () => {
    mocks.listProjectAssets.mockResolvedValueOnce([
      {
        id: "project-clip",
        kind: "video",
        name: "Project clip",
        metadata: {},
        lifecycle: { state: "active" },
        status: "ready",
        url: "https://media.clash.test/project-clip.mp4",
        thumbnailUrl: "https://media.clash.test/project-clip.jpg",
      },
    ]);
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() => {
      const scopes =
        screen.getByTestId("dashboard-composer-runtime").dataset
          .mentionScopes ?? "";
      expect(scopes).toContain("project-assets");
      expect(scopes).toContain("global-assets");
    });
  });

  it("creates from the raw name and performs one same-document transition with skill prompt", async () => {
    const finished = Promise.resolve();
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished,
      };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Composer input" }), {
      target: { value: " Quiet forest film " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(mocks.createProjectRecord).toHaveBeenCalledWith(
        "Quiet forest film",
      );
    });
    expect(startViewTransition).toHaveBeenCalledOnce();
    await finished;
    expect(
      decodeURIComponent(screen.getByTestId("location").textContent ?? ""),
    ).toBe("/projects/project-1?prompt=$storyboard\n\nQuiet forest film");
    expect(screen.getByRole("textbox", { name: "Composer input" })).toHaveValue(
      "",
    );
    await waitFor(() => {
      expect(
        document.documentElement.dataset.dashboardComposerTransition,
      ).toBeUndefined();
    });
  });

  it("opens the referenced Project without creating another one", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Composer input" }), {
      target: { value: "Polish the opening shot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toContain(
        "/projects/existing-project",
      );
    });
    expect(mocks.createProjectRecord).not.toHaveBeenCalled();
    expect(
      decodeURIComponent(screen.getByTestId("location").textContent ?? ""),
    ).toBe(
      "/projects/existing-project?prompt=$storyboard\n\nPolish the opening shot",
    );
  });

  it("switches routes immediately under reduced motion without starting a transition", async () => {
    const startViewTransition = vi.fn();
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    renderComposer();

    fireEvent.change(screen.getByRole("textbox", { name: "Composer input" }), {
      target: { value: "Quiet forest film" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toContain(
        "/projects/project-1",
      );
    });
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});
