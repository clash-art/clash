// @vitest-environment jsdom
import type { ReactNode } from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

import SettingsClient from "./SettingsClient";
import { AppFeedbackProvider } from "./AppFeedback";
import { HarnessUpdateNotifier } from "./HarnessUpdateNotifier";
import {
  listApiTokens,
  listInstalledActions,
  listInstalledSkills,
  listVariables,
} from "@clash/web-ui/lib/clientActions";
import {
  SETTINGS_NAV_ITEMS,
  SettingsSurface,
  readLastSettingsSection,
  writeLastSettingsSection,
} from "./SettingsSurface";

const runtimeMock = vi.hoisted(() => ({
  runtimes: [] as any[],
  refresh: vi.fn(),
  promptQueueEnabled: true,
  setPromptQueueEnabled: vi.fn(),
}));

vi.mock("@clash/web-ui/hooks/useClashRuntime", () => ({
  useClashRuntime: () => ({
    runtimes: runtimeMock.runtimes,
    refresh: runtimeMock.refresh,
    promptQueueEnabled: runtimeMock.promptQueueEnabled,
    setPromptQueueEnabled: runtimeMock.setPromptQueueEnabled,
  }),
}));

vi.mock("@clash/web-ui/lib/clientActions", () => ({
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
  setVariable: vi.fn(),
  deleteVariable: vi.fn(),
  uninstallAction: vi.fn(),
  uninstallSkill: vi.fn(),
  listModelCatalog: vi.fn(async () => []),
  listApiTokens: vi.fn(async () => []),
  listVariables: vi.fn(async () => []),
  listInstalledActions: vi.fn(async () => []),
  listInstalledSkills: vi.fn(async () => []),
  listModelProviders: vi.fn(async () => []),
  listArchivedProjects: vi.fn(async () => []),
  restoreProject: vi.fn(),
  purgeProject: vi.fn(),
  updateModelProviders: vi.fn(),
  deleteModelProvider: vi.fn(),
  saveModelCardConfig: vi.fn(),
  deleteModelCardConfig: vi.fn(),
  testModelProvider: vi.fn(),
  listProviderOAuth: vi.fn(async () => []),
  listPluginProviders: vi.fn(async () => []),
  startProviderOAuth: vi.fn(),
  completeProviderOAuth: vi.fn(),
  importLocalProviderToken: vi.fn(),
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => (
      <>{children}</>
    ),
    motion: new Proxy(
      {},
      {
        get:
          (_target, tag: string) =>
          ({
            children,
            whileTap: _whileTap,
            initial: _initial,
            animate: _animate,
            exit: _exit,
            transition: _transition,
            ...props
          }: any) =>
            React.createElement(tag, props, children),
      },
    ),
  };
});

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

const LOCAL_ASR_MODEL_CATALOG = [
  {
    model: {
      id: "sensevoice-small-asr",
      name: "SenseVoice Small",
      provider: "Local",
      kind: "text",
      defaultAspectRatio: "1:1",
      description: "Local microphone transcription.",
      parameters: [],
      defaultParams: { asr_model: "iic/SenseVoiceSmall" },
      input: {
        requiresPrompt: false,
        inputMode: { audios: { min: 1, max: 1 } },
        promptModalities: ["audio"],
      },
      maxRuntimeMs: 120_000,
    },
    tier: "available",
    routes: [
      {
        modelCode: "sensevoice-small-asr",
        kind: "text",
        providerId: "local",
        upstreamId: "local",
        upstreamModel: "iic/SenseVoiceSmall",
        apiShape: "local-asr",
        priority: 1,
      },
    ],
    selectedRoute: {
      modelCode: "sensevoice-small-asr",
      kind: "text",
      providerId: "local",
      upstreamId: "local",
      upstreamModel: "iic/SenseVoiceSmall",
      apiShape: "local-asr",
      priority: 1,
    },
    candidateProviders: ["local"],
    unavailableParameterIds: [],
    missingCredentials: [],
    missingOAuth: [],
  },
] as any;

const LOCAL_ASR_MODEL_CATALOG_WITH_WHISPER = [
  ...LOCAL_ASR_MODEL_CATALOG,
  {
    model: {
      ...LOCAL_ASR_MODEL_CATALOG[0].model,
      id: "whisper-small-asr",
      name: "Whisper Small",
      provider: "OpenAI",
      defaultParams: { asr_model: "mlx-community/whisper-small-mlx" },
    },
    routes: [
      {
        ...LOCAL_ASR_MODEL_CATALOG[0].routes[0],
        modelCode: "whisper-small-asr",
        upstreamModel: "mlx-community/whisper-small-mlx",
      },
    ],
    selectedRoute: {
      ...LOCAL_ASR_MODEL_CATALOG[0].selectedRoute,
      modelCode: "whisper-small-asr",
      upstreamModel: "mlx-community/whisper-small-mlx",
    },
  },
] as any;

const GLOBAL_VOICE_INPUT_MODEL_CATALOG = [
  ...LOCAL_ASR_MODEL_CATALOG,
  {
    model: {
      id: "gemini-3-flash",
      name: "Gemini 3 Flash",
      provider: "Google",
      kind: "text",
      defaultAspectRatio: "1:1",
      description: "Cloud multimodal text model with audio input.",
      parameters: [],
      defaultParams: {},
      input: {
        requiresPrompt: true,
        inputMode: { audios: { min: 1, max: 1 } },
        promptModalities: ["text", "audio"],
      },
      maxRuntimeMs: 120_000,
    },
    tier: "available",
    routes: [
      {
        modelCode: "gemini-3-flash",
        kind: "text",
        providerId: "official",
        accountId: "google-account",
        upstreamId: "google-ai-studio",
        upstreamModel: "gemini-3-flash",
        apiShape: "google-ai-studio",
        priority: 1,
      },
    ],
    selectedRoute: {
      modelCode: "gemini-3-flash",
      kind: "text",
      providerId: "official",
      accountId: "google-account",
      upstreamId: "google-ai-studio",
      upstreamModel: "gemini-3-flash",
      apiShape: "google-ai-studio",
      priority: 1,
    },
    candidateProviders: ["official"],
    unavailableParameterIds: [],
    missingCredentials: [],
    missingOAuth: [],
  },
] as any;

const LOCAL_SPEECH_MODEL_CATALOG = [
  ...LOCAL_ASR_MODEL_CATALOG,
  {
    model: {
      id: "piper-huayan-tts",
      name: "Piper Huayan",
      provider: "Local",
      kind: "audio",
      defaultAspectRatio: "1:1",
      description: "Downloadable Mandarin voice running fully on-device.",
      parameters: [],
      defaultParams: {
        tts_model: "zh_CN-huayan-medium",
        voice_name: "huayan",
        speed: 1,
      },
      input: {
        requiresPrompt: true,
        inputMode: {},
        promptModalities: ["text"],
      },
      maxRuntimeMs: 120_000,
    },
    tier: "available",
    routes: [
      {
        modelCode: "piper-huayan-tts",
        kind: "audio",
        providerId: "local",
        upstreamId: "local",
        upstreamModel: "zh_CN-huayan-medium",
        apiShape: "local-tts",
        priority: 1,
      },
    ],
    selectedRoute: {
      modelCode: "piper-huayan-tts",
      kind: "audio",
      providerId: "local",
      upstreamId: "local",
      upstreamModel: "zh_CN-huayan-medium",
      apiShape: "local-tts",
      priority: 1,
    },
    candidateProviders: ["local"],
    unavailableParameterIds: [],
    missingCredentials: [],
    missingOAuth: [],
  },
] as any;

const VIBEVOICE_MODEL_CATALOG = [
  {
    model: {
      id: "vibevoice-asr",
      name: "VibeVoice ASR",
      provider: "Local",
      kind: "text",
      defaultAspectRatio: "1:1",
      description: "Long-form transcription with speaker diarization.",
      parameters: [],
      defaultParams: { asr_model: "mlx-community/VibeVoice-ASR-4bit" },
      input: {
        requiresPrompt: false,
        inputMode: { audios: { min: 1, max: 1 } },
        promptModalities: ["audio"],
      },
    },
    tier: "available",
    routes: [
      {
        modelCode: "vibevoice-asr",
        kind: "text",
        providerId: "local",
        upstreamId: "local",
        upstreamModel: "mlx-community/VibeVoice-ASR-4bit",
        apiShape: "local-asr",
        priority: 1,
      },
    ],
    selectedRoute: {
      modelCode: "vibevoice-asr",
      kind: "text",
      providerId: "local",
      upstreamId: "local",
      upstreamModel: "mlx-community/VibeVoice-ASR-4bit",
      apiShape: "local-asr",
      priority: 1,
    },
    candidateProviders: ["local"],
    unavailableParameterIds: [],
    missingCredentials: [],
    missingOAuth: [],
  },
] as any;

const PARAKEET_MODEL_CATALOG = VIBEVOICE_MODEL_CATALOG.map((entry: any) => ({
  ...entry,
  model: {
    ...entry.model,
    id: "parakeet-tdt-0.6b-v3-asr",
    name: "Parakeet TDT 0.6B v3",
    description: "Fast multilingual transcription on Apple Silicon.",
    defaultParams: { asr_model: "mlx-community/parakeet-tdt-0.6b-v3" },
  },
  routes: entry.routes.map((route: any) => ({
    ...route,
    modelCode: "parakeet-tdt-0.6b-v3-asr",
    upstreamModel: "mlx-community/parakeet-tdt-0.6b-v3",
  })),
  selectedRoute: {
    ...entry.selectedRoute,
    modelCode: "parakeet-tdt-0.6b-v3-asr",
    upstreamModel: "mlx-community/parakeet-tdt-0.6b-v3",
  },
}));

describe("SettingsSurface tab state", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
    window.localStorage.clear();
  });

  it("persists the last selected settings section", () => {
    writeLastSettingsSection("audio");
    expect(readLastSettingsSection()).toBe("audio");

    window.localStorage.setItem(
      "clash.settings.activeSection",
      "not-a-section",
    );
    expect(readLastSettingsSection()).toBeNull();
  });

  it("names the local speech settings for the user-facing capability", () => {
    render(
      <MemoryRouter>
        <SettingsSurface
          active="audio"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("tab", { name: "Voice input" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Audio" })).toBeNull();
  });

  it("exposes the archive library as a first-class settings section", () => {
    expect(SETTINGS_NAV_ITEMS.some((item) => item.id === "archive")).toBe(true);
  });

  it("renders the shared session and project archive library from settings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ sessions: [] }),
    );
    render(
      <MemoryRouter>
        <SettingsSurface
          active="archive"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("tab", { name: "Archive" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: "Archive Library" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
  });

  it("uses distinct navigation identities for provider routes and model capabilities", () => {
    const providers = SETTINGS_NAV_ITEMS.find(
      (item) => item.id === "providers",
    );
    const models = SETTINGS_NAV_ITEMS.find((item) => item.id === "models");

    expect(providers?.icon).toBeTruthy();
    expect(models?.icon).toBeTruthy();
    expect(providers?.icon).not.toBe(models?.icon);
  });

  it("renders the hosted API tokens sidebar tab with semantic neutral chrome and a primary marker", () => {
    render(
      <MemoryRouter>
        <SettingsSurface
          active="tokens"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    const activeTab = screen.getByRole("tab", { name: "API Tokens" });
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
    expect(activeTab.className).toContain("border-border");
    expect(activeTab.className).toContain("bg-accent");
    expect(activeTab.className).not.toContain("border-warm-border");
    expect(activeTab.querySelector(".bg-primary")).toBeTruthy();
  });

  it("scopes direct SettingsClient controls without restoring page-specific skins", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
        />
      </MemoryRouter>,
    );

    const filter = screen.getByRole("button", { name: "Filter" });
    expect(filter.getAttribute("data-slot")).toBe("dropdown-menu-trigger");
    expect(filter.className).not.toContain("clash-settings-select-trigger");
  });

  it("lets the shared Input own API token field material", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="tokens"
          embedded
        />
      </MemoryRouter>,
    );

    const tokenName = screen.getByPlaceholderText("Token name");
    expect(tokenName.getAttribute("data-slot")).toBe("input");
    expect(tokenName.className).not.toContain("clash-settings-field");
  });

  it("lets the shared Button own API token primary action material", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="tokens"
          embedded
        />
      </MemoryRouter>,
    );

    const create = screen.getByRole("button", { name: "Create" });
    expect(create.getAttribute("data-variant")).toBe("primary");
    expect(create.className).not.toContain("clash-settings-primary");
  });

  it("renders one Models page heading instead of repeating the active tab title", async () => {
    render(
      <MemoryRouter>
        <SettingsSurface
          active="models"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(screen.getAllByRole("heading", { name: "Models" })).toHaveLength(1);
  });

  it("does not load or expose hosted API tokens in desktop local settings", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };
    const listApiTokensMock = vi.mocked(listApiTokens);
    listApiTokensMock.mockClear();

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"tokens" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(listApiTokensMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Agents" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("tab", { name: "API Tokens" })).toBeNull();
    expect(
      screen.queryByText("Create tokens for CLI or API access"),
    ).toBeNull();
  });

  it("does not offer cloud sign out in desktop local settings", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };

    render(
      <MemoryRouter>
        <SettingsSurface
          active="agents"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("keeps sign out available in hosted settings", () => {
    render(
      <MemoryRouter>
        <SettingsSurface
          active="agents"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("offers machine public storage only when settings are backed by local-api", () => {
    const { unmount } = render(
      <MemoryRouter>
        <SettingsSurface
          active="agents"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("tab", { name: "Public storage" })).toBeNull();
    unmount();

    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };
    render(
      <MemoryRouter>
        <SettingsSurface
          active="public-storage"
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: "Public storage" })).toBeTruthy();
  });

  it("keeps hosted API tokens available", async () => {
    const listApiTokensMock = vi.mocked(listApiTokens);
    listApiTokensMock.mockClear();

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"tokens" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(listApiTokensMock).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("tab", { name: "API Tokens" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("does not load or expose hosted installed actions in desktop local settings", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };
    const listInstalledActionsMock = vi.mocked(listInstalledActions);
    listInstalledActionsMock.mockClear();

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"actions" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(listInstalledActionsMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Agents" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("tab", { name: "Actions" })).toBeNull();
    expect(screen.queryByText("Installed Actions")).toBeNull();
  });

  it("does not load or expose hosted installed skills in desktop local settings", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };
    const listInstalledSkillsMock = vi.mocked(listInstalledSkills);
    listInstalledSkillsMock.mockClear();

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"skills" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(listInstalledSkillsMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Agents" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("tab", { name: "Skills" })).toBeNull();
    expect(screen.queryByText("Installed Skills")).toBeNull();
  });

  it("keeps hosted installed actions and skills available", async () => {
    const listInstalledActionsMock = vi.mocked(listInstalledActions);
    const listInstalledSkillsMock = vi.mocked(listInstalledSkills);
    listInstalledActionsMock.mockClear();
    listInstalledSkillsMock.mockClear();

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"actions" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(listInstalledActionsMock).toHaveBeenCalledTimes(1);
    expect(listInstalledSkillsMock).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("tab", { name: "Actions" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Skills" })).toBeTruthy();
  });

  it("uses Agents as the local agent settings tab instead of Runtimes", () => {
    render(
      <MemoryRouter>
        <SettingsSurface
          active={"agents" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("tab", { name: "Agents" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("tab", { name: "Runtimes" })).toBeNull();
  });

  it("does not load remote worker variables in desktop local settings", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };
    const listVariablesMock = vi.mocked(listVariables);
    listVariablesMock.mockClear();

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"agents" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(listVariablesMock).not.toHaveBeenCalled();
  });

  it("keeps remote worker variables available in hosted settings", async () => {
    const listVariablesMock = vi.mocked(listVariables);
    listVariablesMock.mockClear();

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"agents" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(listVariablesMock).toHaveBeenCalledTimes(1);
  });

  it("does not render the hidden variables section in desktop local settings", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };

    render(
      <MemoryRouter>
        <SettingsSurface
          active={"variables" as any}
          onActiveChange={vi.fn()}
          variant="page"
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Loading settings" }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("tab", { name: "Agents" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText("API Keys")).toBeNull();
    expect(screen.queryByPlaceholderText("KEY_NAME")).toBeNull();
  });

  it("uses the shared tab primitive for the settings section selector instead of direct Ariakit or handwritten sidebar tab buttons", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/web-ui/src/components/SettingsSurface.tsx",
      ),
      "utf8",
    );
    const tabsPath = resolve(
      process.cwd(),
      "packages/gui/src/components/ui/tabs.tsx",
    );
    const tabsSource = existsSync(tabsPath)
      ? readFileSync(tabsPath, "utf8")
      : "";

    expect(existsSync(tabsPath)).toBe(true);
    expect(tabsSource).toContain("@ariakit/react");
    expect(source).toContain("./ui/tabs");
    expect(source).toContain("TabProvider");
    expect(source).toContain("TabList");
    expect(source).toContain("<Tab");
    expect(source).not.toContain("@ariakit/react");
    expect(source).not.toContain(
      "aria-current={isActive ? 'page' : undefined}",
    );
  });

  it("uses the shared tooltip primitive for the dialog close icon instead of a browser title attribute", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/web-ui/src/components/SettingsSurface.tsx",
      ),
      "utf8",
    );
    const tooltipSource = readFileSync(
      resolve(process.cwd(), "packages/gui/src/components/ui/tooltip.tsx"),
      "utf8",
    );

    expect(tooltipSource).toContain("@ariakit/react");
    expect(source).toContain("./ui/tooltip");
    expect(source).toContain("./ui/icon-button");
    expect(source).toContain('<Tooltip label="Close settings">');
    expect(source).toContain("<IconButton");
    expect(source).not.toContain("onPointerDown={(event) => {");
    expect(source).not.toContain('title="Close (Esc)"');
    expect(source).not.toContain("TooltipProvider");
    expect(source).not.toContain("TooltipAnchor");
  });

  it("uses the shared tooltip primitive for agent controls instead of browser title attributes", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/web-ui/src/components/SettingsClient.tsx",
      ),
      "utf8",
    );
    const tooltipSource = readFileSync(
      resolve(process.cwd(), "packages/gui/src/components/ui/tooltip.tsx"),
      "utf8",
    );
    const agentsSectionStart = source.indexOf("function AgentsSection()");
    const nextSectionStart = source.indexOf(
      "function UninstallHarnessDialog",
      agentsSectionStart,
    );
    const agentsSectionSource = source.slice(
      agentsSectionStart,
      nextSectionStart,
    );

    expect(tooltipSource).toContain("@ariakit/react");
    expect(source).toContain("./ui/tooltip");
    expect(agentsSectionSource).toContain(
      "<Tooltip label={harnessCheckTooltip}>",
    );
    expect(agentsSectionSource).toContain("<Tooltip label={authRetryTooltip}>");
    expect(agentsSectionSource).toContain(
      "<Tooltip label={switchDisabledReason}>",
    );
    expect(agentsSectionSource).not.toContain(
      'title={harnessLoading ? harnessLoadingMessage : "Check installed agents, auth, and model options again."}',
    );
    expect(agentsSectionSource).not.toContain(
      'title={savingAction === "probe" ? `Checking ${harness.label} auth.` : harnessLoading ? "A global agent check is already running." : `Check ${harness.label} auth again.`}',
    );
    expect(agentsSectionSource).not.toContain("title={switchDisabledReason}");
    expect(agentsSectionSource).not.toContain("TooltipProvider");
    expect(agentsSectionSource).not.toContain("TooltipAnchor");
  });

  it("uses the shared tooltip primitive for audio controls instead of browser title attributes", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/web-ui/src/components/SettingsClient.tsx",
      ),
      "utf8",
    );
    const tooltipSource = readFileSync(
      resolve(process.cwd(), "packages/gui/src/components/ui/tooltip.tsx"),
      "utf8",
    );
    const audioSectionStart = source.indexOf(
      "function LocalSpeechSettingsCard(",
    );
    const nextSectionStart = source.indexOf(
      "function AgentsSection()",
      audioSectionStart,
    );
    const audioSectionSource = source.slice(
      audioSectionStart,
      nextSectionStart,
    );

    expect(tooltipSource).toContain("@ariakit/react");
    expect(source).toContain("./ui/tooltip");
    expect(audioSectionSource).toContain(
      "<Tooltip label={switchDisabledReason}>",
    );
    expect(audioSectionSource).not.toContain("title={switchDisabledReason}");
    expect(audioSectionSource).not.toContain("TooltipProvider");
    expect(audioSectionSource).not.toContain("TooltipAnchor");
  });

  it("uses the shared tooltip primitive for variable provider presets instead of browser title attributes", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/web-ui/src/components/SettingsClient.tsx",
      ),
      "utf8",
    );
    const tooltipSource = readFileSync(
      resolve(process.cwd(), "packages/gui/src/components/ui/tooltip.tsx"),
      "utf8",
    );

    expect(tooltipSource).toContain("@ariakit/react");
    expect(source).toContain("./ui/tooltip");
    expect(source).toContain("<Tooltip label={preset.secretDescription}");
    expect(source).not.toContain("title={preset.secretDescription}");
  });

  it("uses the shared tooltip primitive for provider logos instead of browser title attributes", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/web-ui/src/components/SettingsClient.tsx",
      ),
      "utf8",
    );
    const tooltipSource = readFileSync(
      resolve(process.cwd(), "packages/gui/src/components/ui/tooltip.tsx"),
      "utf8",
    );

    expect(tooltipSource).toContain("@ariakit/react");
    expect(source).toContain("./ui/tooltip");
    expect(source).toContain("<Tooltip label={`${title} logo`}>");
    expect(source).not.toContain("title={`${title} logo`}");
  });
});

describe("SettingsClient sync section", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    runtimeMock.runtimes = [];
    runtimeMock.refresh = vi.fn();
    runtimeMock.promptQueueEnabled = true;
    runtimeMock.setPromptQueueEnabled = vi.fn();
    window.localStorage.clear();
  });

  it("shows a sync skeleton while local sync configuration is loading", async () => {
    let resolveSync!: (response: Response) => void;
    const syncPromise = new Promise<Response>((resolve) => {
      resolveSync = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          url.includes("/api/v1/local/sync") &&
          (!init || init.method === "GET")
        ) {
          return syncPromise;
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection="sync"
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("status", { name: "Loading sync settings" }),
    ).toBeTruthy();

    resolveSync(
      new Response(
        JSON.stringify({
          mode: "local-only",
          remote_loro: {
            enabled: false,
            url: null,
            has_token: false,
            source: "none",
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await screen.findByRole("radio", { name: /Local only/ });
    expect(
      screen.queryByRole("status", { name: "Loading sync settings" }),
    ).toBeNull();
  });

  it("loads and saves local sync configuration", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/sync") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              mode: "local-only",
              remote_loro: {
                enabled: false,
                url: null,
                has_token: false,
                source: "none",
              },
              capabilities: {
                canvas: false,
                asset_metadata: false,
                revision_content: false,
                project_metadata: false,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/v1/local/sync") && init?.method === "PATCH") {
          expect(JSON.parse(String(init.body))).toEqual({
            mode: "cloud-sync",
            remote_loro_url: "https://cloud.example",
            remote_loro_token: "secret",
            capabilities: {
              canvas: true,
              asset_metadata: true,
              revision_content: true,
              project_metadata: true,
            },
          });
          return new Response(
            JSON.stringify({
              mode: "cloud-sync",
              remote_loro: {
                enabled: true,
                url: "https://cloud.example",
                has_token: true,
                source: "config",
              },
              capabilities: {
                canvas: true,
                asset_metadata: true,
                revision_content: true,
                project_metadata: true,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection="sync"
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Local only");
    const syncSection = screen
      .getByRole("heading", { name: "Sync" })
      .closest('[data-slot="settings-section"]');
    expect(syncSection).toBeTruthy();
    const readiness = screen.getByRole("heading", {
      name: "Cloud mirror readiness",
    });
    expect(readiness.closest('[data-slot="settings-panel"]')).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Canvas mirror ready" })
        .closest('[data-slot="settings-capability-row"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Canvas mirror ready" })
        .closest('[data-slot="settings-row"]'),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Cloud sync/ }));
    fireEvent.change(screen.getByLabelText("Remote Loro URL"), {
      target: { value: "https://cloud.example" },
    });
    fireEvent.change(screen.getByLabelText("Remote Loro token"), {
      target: { value: "secret" },
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Canvas mirror ready" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Asset metadata mirror ready" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Revision content mirror ready" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Project metadata mirror ready" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("Token saved").length).toBeGreaterThan(0);
    expect(await screen.findByText("Sync settings saved")).toBeTruthy();
    expect(screen.queryByText("Sync settings saved.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save sync settings" }),
    ).toBeNull();
  });

  it("manages runtime machines from Sync without an add-machine action", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [{ id: "codex-acp", binary: "codex-acp" }],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/sync") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              mode: "local-only",
              remote_loro: {
                enabled: false,
                url: null,
                has_token: false,
                source: "none",
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="sync"
          embedded
        />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Runtime machines" });
    expect(screen.getByText("This Mac")).toBeTruthy();
    expect(screen.getByText("Agents: codex-acp")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove This Mac runtime" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add machine" })).toBeNull();
  });
});

describe("SettingsClient media analysis section", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offers a real Settings destination for video analysis", () => {
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "media-analysis",
          label: "Media analysis",
        }),
      ]),
    );
  });

  it("loads declaration-derived choices and persists user-selected analysis controls", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/media-analysis") &&
          init?.method === "PUT"
        ) {
          return new Response(String(init.body), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/local/media-analysis")) {
          return new Response(
            JSON.stringify({
              videoEnabled: false,
              modelId: "video-card",
              allowedCategories: null,
              video: {
                fps: 2,
                mediaResolution: "high",
                boundaryRefinement: {
                  enabled: false,
                  fps: 12,
                  safetyMarginSeconds: 0.75,
                },
              },
              modelOptions: [
                {
                  id: "video-card",
                  name: "Gemini Video",
                  provider: "google",
                  route: "generate-content",
                  sourceKinds: ["video"],
                },
              ],
              categoryOptions: [
                {
                  id: "description",
                  title: "Description",
                  sourceMediaKinds: ["video"],
                },
                {
                  id: "scene-shot",
                  title: "Scenes and shots",
                  sourceMediaKinds: ["video"],
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"media-analysis" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Media analysis" });
    const mediaSection = screen
      .getByRole("heading", { name: "Media analysis" })
      .closest('[data-slot="settings-section"]');
    expect(mediaSection).toBeTruthy();
    expect(mediaSection?.className).toContain("max-w-3xl");
    expect(
      mediaSection?.querySelectorAll('[data-slot="settings-panel"]'),
    ).toHaveLength(4);
    expect(
      screen.getByRole("combobox", { name: "Video model" }).textContent,
    ).toContain("Gemini Video");
    expect(screen.getByRole("checkbox", { name: "Description" })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "Scenes and shots" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("switch", { name: "Enable video analysis" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Refine scene boundaries" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Description" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save media analysis settings" }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (
            !String(input).includes("/api/v1/local/media-analysis") ||
            init?.method !== "PUT"
          )
            return false;
          const body = JSON.parse(String(init.body));
          return (
            body.videoEnabled === true &&
            body.modelId === "video-card" &&
            body.allowedCategories?.length === 1 &&
            body.allowedCategories[0] === "scene-shot" &&
            body.video.boundaryRefinement.enabled === true
          );
        }),
      ).toBe(true),
    );
  });
});

describe("SettingsClient audio section", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    runtimeMock.runtimes = [];
    runtimeMock.refresh = vi.fn();
    runtimeMock.promptQueueEnabled = true;
    runtimeMock.setPromptQueueEnabled = vi.fn();
    window.localStorage.clear();
  });

  it("shows an audio skeleton while local audio configuration is loading", async () => {
    let resolveAudio!: (response: Response) => void;
    const audioPromise = new Promise<Response>((resolve) => {
      resolveAudio = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return audioPromise;
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"audio" as any}
          embedded
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("status", { name: "Loading audio settings" }),
    ).toBeTruthy();

    resolveAudio(
      new Response(
        JSON.stringify({
          asr: {
            enabled: false,
            provider: "builtin-funasr",
            base_url: null,
            model: "iic/SenseVoiceSmall",
            has_api_key: false,
            ready: false,
            setup: {
              provider: "funasr",
              runtime: "builtin-rpc",
              status: "disabled",
              available: false,
              default_base_url: null,
              commands: [
                "python3 -m pip install -U funasr modelscope torch torchaudio",
              ],
              message: "FunASR is not installed",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await screen.findByText("Voice input");
    expect(
      screen.queryByRole("status", { name: "Loading audio settings" }),
    ).toBeNull();
  });

  it("deploys local ASR from the model card without fake model selection", async () => {
    let asrAvailable = false;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/audio/install") &&
          init?.method === "POST"
        ) {
          expect(JSON.parse(String(init.body))).toEqual({
            capability: "speech-to-text",
            model: "iic/SenseVoiceSmall",
          });
          asrAvailable = true;
          return new Response(
            JSON.stringify({
              asr: {
                enabled: false,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "funasr",
                  runtime: "builtin-rpc",
                  status: "disabled",
                  available: asrAvailable,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/v1/local/audio/models/status")) {
          return new Response(JSON.stringify({ available: asrAvailable }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: false,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "funasr",
                  runtime: "builtin-rpc",
                  status: "needs-install",
                  available: asrAvailable,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_ASR_MODEL_CATALOG}
            activeSection={"models" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText("SenseVoice Small")).toBeTruthy();
    expect(screen.getByText("Text")).toBeTruthy();
    const getModelCard = () =>
      document.getElementById("model-card-sensevoice-small-asr") as HTMLElement;
    const modelCard = getModelCard();
    expect(modelCard).toBeTruthy();
    expect(within(modelCard).getByText("Uses local model cache.")).toBeTruthy();
    expect(within(modelCard).getByText("Not deployed")).toBeTruthy();
    expect(modelCard.dataset.modelState).toBe("unavailable");
    expect(
      within(screen.getByRole("region", { name: "Unavailable" })).getByText(
        "SenseVoice Small",
      ),
    ).toBeTruthy();

    fireEvent.click(
      within(modelCard).getByRole("button", { name: "Deploy local ASR model" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/v1/local/audio/install") &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );
    await screen.findByText("Deployed");
    const deployedModelCard = getModelCard();
    expect(deployedModelCard.dataset.modelState).toBe("enabled");
    expect(
      within(screen.getByRole("region", { name: "Enabled" })).getByText(
        "SenseVoice Small",
      ),
    ).toBeTruthy();
    expect(
      within(deployedModelCard).queryByRole("button", { name: "Add" }),
    ).toBeNull();
    expect(
      window.localStorage.getItem("clash.settings.selectedModelIds"),
    ).toBeNull();
  });

  it("downloads and removes local TTS from the same model lifecycle", async () => {
    let ttsAvailable = false;
    const config = () => ({
      asr: {
        capability: "speech-to-text",
        enabled: false,
        provider: "builtin-funasr",
        base_url: null,
        model: "iic/SenseVoiceSmall",
        has_api_key: false,
        ready: false,
        setup: {
          provider: "funasr",
          runtime: "builtin-rpc",
          status: "disabled",
          available: true,
          default_base_url: null,
          commands: [],
        },
      },
      tts: {
        capability: "text-to-speech",
        enabled: false,
        provider: "builtin-piper",
        base_url: null,
        model: "zh_CN-huayan-medium",
        has_api_key: false,
        ready: false,
        setup: {
          provider: "piper",
          runtime: "builtin-rpc",
          status: "disabled",
          available: ttsAvailable,
          default_base_url: null,
          commands: [],
        },
      },
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/audio/install") &&
          init?.method === "POST"
        ) {
          expect(JSON.parse(String(init.body))).toEqual({
            capability: "text-to-speech",
            model: "zh_CN-huayan-medium",
          });
          ttsAvailable = true;
          return new Response(JSON.stringify(config()), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/audio/remove") &&
          init?.method === "POST"
        ) {
          expect(JSON.parse(String(init.body))).toEqual({
            capability: "text-to-speech",
            model: "zh_CN-huayan-medium",
          });
          ttsAvailable = false;
          return new Response(JSON.stringify(config()), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(JSON.stringify(config()), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_SPEECH_MODEL_CATALOG}
            activeSection={"models" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    const getModelCard = () =>
      document.getElementById("model-card-piper-huayan-tts") as HTMLElement;
    const modelCard = getModelCard();
    expect(within(modelCard).getByText("Not downloaded")).toBeTruthy();
    expect(modelCard.dataset.modelState).toBe("unavailable");
    expect(
      within(screen.getByRole("region", { name: "Unavailable" })).getByText(
        "Piper Huayan",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(modelCard).getByRole("button", {
        name: "Download local TTS model",
      }),
    );
    await screen.findByText("Downloaded");
    const downloadedModelCard = getModelCard();
    expect(downloadedModelCard.dataset.modelState).toBe("enabled");
    expect(
      within(screen.getByRole("region", { name: "Enabled" })).getByText(
        "Piper Huayan",
      ),
    ).toBeTruthy();

    fireEvent.click(
      within(downloadedModelCard).getByRole("button", {
        name: "Remove local TTS model",
      }),
    );
    await screen.findByText("Not downloaded");
    const removedModelCard = getModelCard();
    expect(removedModelCard.dataset.modelState).toBe("unavailable");
    expect(
      within(screen.getByRole("region", { name: "Unavailable" })).getByText(
        "Piper Huayan",
      ),
    ).toBeTruthy();
  });

  it("uses the VibeVoice brand mark while keeping Local as its runtime provider", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          initialModelCatalog={VIBEVOICE_MODEL_CATALOG}
          activeSection={"models" as any}
          embedded
        />
      </MemoryRouter>,
    );

    const modelCard = document.getElementById("model-card-vibevoice-asr");
    expect(
      modelCard?.querySelector('[data-model-logo="vibevoice"]'),
    ).toBeTruthy();
    expect(
      modelCard?.querySelector('[data-model-provider-logo="local"]'),
    ).toBeTruthy();
  });

  it("uses NVIDIA branding for Parakeet while keeping Local as its runtime provider", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          initialModelCatalog={PARAKEET_MODEL_CATALOG}
          activeSection={"models" as any}
          embedded
        />
      </MemoryRouter>,
    );

    const modelCard = document.getElementById(
      "model-card-parakeet-tdt-0.6b-v3-asr",
    );
    expect(modelCard?.querySelector('[data-model-logo="nvidia"]')).toBeTruthy();
    expect(
      modelCard?.querySelector('[data-model-provider-logo="local"]'),
    ).toBeTruthy();
  });

  it("summarizes models with the same enabled truth used by the catalog sections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/v1/local/audio/models/status")) {
          return new Response(JSON.stringify({ available: false }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          initialModelCatalog={LOCAL_ASR_MODEL_CATALOG}
          activeSection={"models" as any}
          embedded
        />
      </MemoryRouter>,
    );

    const summary = screen.getByRole("group", {
      name: "Model availability summary",
    });
    expect(
      within(summary).getByRole("status", { name: "Enabled models" })
        .textContent,
    ).toContain("0");
    expect(
      within(summary).getByRole("status", { name: "Unavailable models" })
        .textContent,
    ).toContain("1");
    expect(
      within(summary).getByRole("status", { name: "All models" }).textContent,
    ).toContain("1");
    expect(within(summary).queryByText("Needs key")).toBeNull();
  });

  it("classifies a local model provider by the real download state on its detail page", async () => {
    let available = false;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/audio/install") &&
          init?.method === "POST"
        ) {
          available = true;
          return new Response(JSON.stringify({ available }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/local/audio/models/status")) {
          return new Response(JSON.stringify({ available }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter
        initialEntries={["/settings?section=models&model=vibevoice-asr"]}
      >
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={VIBEVOICE_MODEL_CATALOG}
            activeSection={"models" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    expect(
      document.querySelector('[data-model-logo="vibevoice"]'),
    ).toBeTruthy();
    const providers = screen.getByRole("list", {
      name: "VibeVoice ASR supported providers",
    });
    expect(await within(providers).findByText("Local runtime")).toBeTruthy();
    expect(within(providers).getByText("Download required")).toBeTruthy();
    fireEvent.click(
      within(providers).getByRole("button", { name: "Download VibeVoice ASR" }),
    );

    expect(
      await within(providers).findByText("Downloaded and ready"),
    ).toBeTruthy();
    expect(
      screen.queryByText("No compatible provider account is configured."),
    ).toBeNull();
  });

  it("keeps TTS generation controls in audio nodes instead of global Audio settings", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const responseConfig = {
          asr: {
            capability: "speech-to-text",
            enabled: false,
            provider: "builtin-funasr",
            base_url: null,
            model: "iic/SenseVoiceSmall",
            has_api_key: false,
            ready: false,
            setup: {
              provider: "funasr",
              runtime: "builtin-rpc",
              status: "disabled",
              available: true,
              default_base_url: null,
              commands: [],
            },
          },
          tts: {
            capability: "text-to-speech",
            enabled: false,
            provider: "builtin-piper",
            base_url: null,
            model: "zh_CN-huayan-medium",
            has_api_key: false,
            ready: false,
            setup: {
              provider: "piper",
              runtime: "builtin-rpc",
              status: "disabled",
              available: true,
              default_base_url: null,
              commands: [],
            },
          },
        };
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(JSON.stringify(responseConfig), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_SPEECH_MODEL_CATALOG}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Voice input" });
    expect(
      screen.getByRole("combobox", { name: "ASR model" }).textContent,
    ).toContain("SenseVoice Small");
    expect(screen.queryByRole("combobox", { name: "TTS model" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Enable local voice generation" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Voice generation" }),
    ).toBeNull();
  });

  it("offers enabled cloud models that accept audio from the global model catalog", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/local/audio/models/status")) {
          return new Response(JSON.stringify({ available: false }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: true,
                provider: "global-model",
                base_url: null,
                model: "gemini-3-flash",
                has_api_key: true,
                ready: true,
                setup: {
                  provider: "google-ai-studio",
                  runtime: "provider-route",
                  status: "ready",
                  available: true,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={GLOBAL_VOICE_INPUT_MODEL_CATALOG}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    const modelSelect = await screen.findByRole("combobox", {
      name: "ASR model",
    });
    expect(modelSelect.textContent).toContain("Gemini 3 Flash");
    fireEvent.click(modelSelect);
    expect(screen.getByRole("option", { name: "Gemini 3 Flash" })).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: "SenseVoice Small" }),
    ).toBeNull();
  });

  it("renders voice input without waiting for background local-model probes", async () => {
    let releaseStatus: ((response: Response) => void) | undefined;
    const pendingStatus = new Promise<Response>((resolve) => {
      releaseStatus = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/local/audio/models/status"))
          return pendingStatus;
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: true,
                provider: "global-model",
                base_url: null,
                model: "gemini-3-flash",
                has_api_key: true,
                ready: true,
                setup: {
                  provider: "google-ai-studio",
                  runtime: "provider-route",
                  status: "ready",
                  available: true,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={GLOBAL_VOICE_INPUT_MODEL_CATALOG}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            String(input).includes("/api/v1/local/audio") &&
            !String(input).includes("/models/status"),
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("heading", { name: "Voice input" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "ASR model" }).textContent,
    ).toContain("Gemini 3 Flash");

    await act(async () => {
      releaseStatus?.(
        new Response(JSON.stringify({ available: false }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await pendingStatus;
    });
  });

  it("reuses global local-model availability when moving between Voice input and Models", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/local/audio/models/status")) {
          return Response.json({ available: true });
        }
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return Response.json({
            asr: {
              enabled: true,
              provider: "global-model",
              base_url: null,
              model: "sensevoice-small-asr",
              has_api_key: false,
              ready: true,
              setup: {
                provider: "funasr",
                runtime: "builtin-rpc",
                status: "ready",
                available: true,
                default_base_url: null,
                commands: [],
              },
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const renderSettings = (activeSection: "audio" | "models") => (
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={GLOBAL_VOICE_INPUT_MODEL_CATALOG}
            activeSection={activeSection as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>
    );
    const rendered = render(renderSettings("audio"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("/api/v1/local/audio/models/status"),
        ),
      ).toHaveLength(1),
    );

    rendered.rerender(renderSettings("models"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/v1/local/audio/models/status"),
      ),
    ).toHaveLength(1);
  });

  it("loads and saves local ASR using catalog model cards", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: false,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "funasr",
                  runtime: "builtin-rpc",
                  status: "disabled",
                  available: true,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/v1/local/audio") && init?.method === "PATCH") {
          expect(JSON.parse(String(init.body))).toEqual({
            asr_enabled: true,
            asr_model: "sensevoice-small-asr",
          });
          return new Response(
            JSON.stringify({
              asr: {
                enabled: true,
                provider: "builtin-funasr",
                base_url: null,
                model: "sensevoice-small-asr",
                has_api_key: false,
                ready: true,
                setup: {
                  provider: "funasr",
                  runtime: "builtin-rpc",
                  status: "ready",
                  available: true,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_ASR_MODEL_CATALOG}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Voice input" });
    expect(screen.getByText("Voice input")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Install local speech recognition",
      }),
    ).toBeNull();
    expect(screen.queryByText("Built-in FunASR setup")).toBeNull();
    expect(screen.queryByText("FunASR is not installed")).toBeNull();
    expect(screen.queryByText("Needs install")).toBeNull();
    expect(screen.queryByLabelText("ASR engine")).toBeNull();
    expect(screen.queryByLabelText("Endpoint URL")).toBeNull();
    expect(screen.queryByLabelText("ASR API key")).toBeNull();
    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.queryByText(/FunASR/i)).toBeNull();
    expect(
      screen.queryByText(
        "python3 -m pip install -U funasr modelscope torch torchaudio",
      ),
    ).toBeNull();

    const modelSelect = screen.getByRole("combobox", { name: "ASR model" });
    expect(modelSelect.getAttribute("data-context")).toBe("settings");
    expect(modelSelect.getAttribute("data-slot")).toBe("select-trigger");
    expect(modelSelect.className).not.toContain(
      "clash-settings-select-trigger",
    );
    expect(modelSelect.textContent).toContain("SenseVoice Small");
    expect(
      (
        screen.getByRole("switch", {
          name: "Enable voice input",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: "Enable voice input" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/v1/local/audio") &&
            init?.method === "PATCH",
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("Ready")).toBeNull();
    expect(document.querySelector(".clash-settings-alert-error")).toBeNull();
    expect(screen.queryByText("Audio settings saved.")).toBeNull();
  });

  it("reconciles stale voice input config to the deployed ASR model", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/local/audio/models/status")) {
          return new Response(
            JSON.stringify({
              available: url.includes(
                encodeURIComponent("iic/SenseVoiceSmall"),
              ),
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: true,
                provider: "builtin-funasr",
                base_url: null,
                model: "mlx-community/whisper-small-mlx",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "mlx-whisper",
                  runtime: "builtin-rpc",
                  status: "needs-install",
                  available: false,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/v1/local/audio") && init?.method === "PATCH") {
          expect(JSON.parse(String(init.body))).toEqual({
            asr_enabled: true,
            asr_provider: "builtin-funasr",
            asr_model: "iic/SenseVoiceSmall",
          });
          return new Response(
            JSON.stringify({
              asr: {
                enabled: true,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
                has_api_key: false,
                ready: true,
                setup: {
                  provider: "funasr",
                  runtime: "builtin-rpc",
                  status: "ready",
                  available: true,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_ASR_MODEL_CATALOG_WITH_WHISPER}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    const modelSelect = await screen.findByRole("combobox", {
      name: "ASR model",
    });
    expect(modelSelect.textContent).toContain("SenseVoice Small");
    expect(
      (
        screen.getByRole("switch", {
          name: "Enable voice input",
        }) as HTMLElement
      ).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(modelSelect);
    expect(
      screen.getByRole("option", { name: "SenseVoice Small" }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Whisper Small" })).toBeNull();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/v1/local/audio") &&
            !String(input).includes("/models/status") &&
            init?.method === "PATCH",
        ),
      ).toBe(true),
    );
  });

  it("turns off stale voice input config when no ASR model is deployed", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/local/audio/models/status")) {
          return new Response(JSON.stringify({ available: false }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: true,
                provider: "builtin-funasr",
                base_url: null,
                model: "mlx-community/whisper-small-mlx",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "mlx-whisper",
                  runtime: "builtin-rpc",
                  status: "needs-install",
                  available: false,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/v1/local/audio") && init?.method === "PATCH") {
          expect(JSON.parse(String(init.body))).toEqual({
            asr_enabled: false,
            asr_model: "mlx-community/whisper-small-mlx",
          });
          return new Response(
            JSON.stringify({
              asr: {
                enabled: false,
                provider: "builtin-funasr",
                base_url: null,
                model: "mlx-community/whisper-small-mlx",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "mlx-whisper",
                  runtime: "builtin-rpc",
                  status: "needs-install",
                  available: false,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_ASR_MODEL_CATALOG_WITH_WHISPER}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Voice input" });
    expect(
      (
        screen.getByRole("switch", {
          name: "Enable voice input",
        }) as HTMLElement
      ).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getAllByText(
        "Enable an audio-capable model in Models before enabling voice input.",
      ).length,
    ).toBeGreaterThan(0);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/v1/local/audio") &&
            !String(input).includes("/models/status") &&
            init?.method === "PATCH",
        ),
      ).toBe(true),
    );
  });

  it("explains missing ASR deployment instead of disabling audio controls", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: false,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "funasr",
                  runtime: "builtin-rpc",
                  status: "needs-install",
                  available: false,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_ASR_MODEL_CATALOG}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Voice input" });
    const switchButton = screen.getByRole("switch", {
      name: "Enable voice input",
    }) as HTMLButtonElement;
    expect(switchButton.disabled).toBe(false);
    const modelButton = screen.getByRole("button", {
      name: "ASR model",
    }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(false);

    fireEvent.click(switchButton);

    const dialog = await screen.findByRole("dialog", {
      name: "Configure voice input model",
    });
    expect(
      within(dialog).getByText(
        "Enable a model that accepts audio and returns text. Local and cloud routes are both supported.",
      ),
    ).toBeTruthy();
    const openModels = within(dialog).getByRole("link", {
      name: "Open Models",
    });
    expect(openModels.getAttribute("href")).toBe("/settings?section=models");
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/api/v1/local/audio") &&
          init?.method === "PATCH",
      ),
    ).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Configure voice input model" }),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "ASR model" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Configure voice input model",
      }),
    ).toBeTruthy();
  });

  it("shows local ASR deploy failures through global feedback instead of an inline alert", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/audio/install") &&
          init?.method === "POST"
        ) {
          return new Response(JSON.stringify({ error: "HTTP 404" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/audio") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: false,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
                has_api_key: false,
                ready: false,
                setup: {
                  provider: "funasr",
                  runtime: "builtin-rpc",
                  status: "needs-install",
                  available: false,
                  default_base_url: null,
                  commands: [],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            initialModelCatalog={LOCAL_ASR_MODEL_CATALOG}
            activeSection={"models" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("SenseVoice Small");
    fireEvent.click(
      screen.getByRole("button", { name: "Deploy local ASR model" }),
    );

    const toast = await screen.findByRole("alert");
    expect(toast.textContent).toContain("Could not deploy local ASR model");
    expect(toast.textContent).toContain("HTTP 404");
    expect(document.querySelector(".clash-settings-alert-error")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Deploy local ASR model" })
        .textContent,
    ).toBe("Deploy");
  });

  it("shows local ASR load failures through global feedback instead of an inline alert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "HTTP 404" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"audio" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    const toast = await screen.findByRole("alert");
    expect(toast.textContent).toContain("Could not load voice input settings");
    expect(toast.textContent).toContain("HTTP 404");
    expect(document.querySelector(".clash-settings-alert-error")).toBeNull();
  });
});

describe("SettingsClient runtime harnesses", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    runtimeMock.runtimes = [];
    runtimeMock.refresh = vi.fn();
    runtimeMock.promptQueueEnabled = true;
    runtimeMock.setPromptQueueEnabled = vi.fn();
  });

  it("shows an agent skeleton while local harness metadata is loading", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    let resolveHarnesses!: (response: Response) => void;
    const harnessesPromise = new Promise<Response>((resolve) => {
      resolveHarnesses = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return harnessesPromise;
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByText("Checking installed agent auth…").length,
      ).toBeGreaterThan(0);
    });
    const skeleton = screen.getByRole("status", { name: "Loading agents" });
    expect(skeleton).toBeTruthy();
    expect(skeleton.getAttribute("data-slot")).toBe("settings-collection");
    expect(
      skeleton.querySelectorAll('[data-slot="settings-row"]'),
    ).toHaveLength(3);
    expect(skeleton.className).not.toContain("divide-y");
    expect(within(skeleton).queryByTestId("agent-skeleton-actions")).toBeNull();

    resolveHarnesses(
      new Response(
        JSON.stringify({
          harnesses: [
            {
              id: "codex-acp",
              label: "Codex",
              binary: "/tmp/clash-acp-codex",
              enabled: false,
              available: true,
              installed: true,
              installable: true,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await screen.findByText("Codex");
    expect(screen.queryByRole("status", { name: "Loading agents" })).toBeNull();
  });

  it("renders local harnesses and persists enablement changes", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [{ id: "codex-acp", binary: "codex-acp" }],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    const harnesses: Array<{
      id: string;
      label: string;
      binary: string;
      enabled: boolean;
      available: boolean;
      custom?: boolean;
      installed?: boolean;
      installedVersion?: string;
      latestVersion?: string;
      updateAvailable?: boolean;
      installable?: boolean;
      installSource?: "registry" | "adapter";
      downloadUrl?: string;
      downloadKind?: "adapter";
      homepage?: string;
      auth?: {
        status: string;
        message: string;
        command?: string;
        methodId?: string;
        methodName?: string;
        methods?: Array<{
          id: string;
          name?: string;
          description?: string;
          type?: string;
        }>;
      };
    }> = [
      {
        id: "codex-acp",
        label: "Codex",
        binary: "codex-acp",
        enabled: false,
        available: false,
        installable: true,
        installSource: "registry",
      },
      {
        id: "claude-acp",
        label: "Claude",
        binary: "claude-agent-acp",
        enabled: false,
        available: false,
        installable: true,
        installSource: "registry",
      },
      {
        id: "opencode",
        label: "OpenCode",
        binary: "opencode",
        enabled: false,
        available: false,
        installable: true,
        installSource: "registry",
        homepage: "https://opencode.ai/",
      },
      {
        id: "gemini",
        label: "Gemini",
        binary: "clash-acp-gemini",
        enabled: false,
        available: false,
        installable: true,
        installSource: "registry",
      },
      {
        id: "cursor",
        label: "Cursor",
        binary: "/tmp/clash-acp-cursor",
        enabled: true,
        available: true,
        installed: true,
        installedVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
        installable: true,
        installSource: "registry",
      },
    ];
    let agentServers = {
      "Local ACP": {
        type: "custom",
        command: "node",
        args: ["~/projects/local-agent/index.js", "--acp"],
        env: {},
      },
    };
    runtimeMock.runtimes = [
      {
        id: "local-runtime",
        machine_id: "local-runtime",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [
          { id: "cursor", label: "Cursor", binary: "/tmp/clash-acp-cursor" },
          ...Array.from({ length: 38 }, (_unused, index) => ({
            id: `registry-${index}`,
            label: `Registry ${index}`,
            binary: `registry-${index}`,
          })),
        ],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
      {
        id: "studio-runtime",
        machine_id: "studio-runtime",
        hostname: "Studio Mac",
        os: "darwin/arm64",
        agents: [
          {
            id: "remote-codex",
            label: "Remote Codex",
            binary: "codex-acp",
            version: "1.0.0",
          },
        ],
        version: "desktop",
        status: "offline",
        last_heartbeat: 1_699_999_000,
        created_at: 1_699_999_000,
      },
    ];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: agentServers }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/agent-servers") &&
          init?.method === "PUT"
        ) {
          const body = JSON.parse(String(init.body));
          agentServers = body.agent_servers;
          harnesses[3] = {
            id: "custom-studio-acp",
            label: "Studio ACP",
            binary: "node",
            enabled: true,
            available: true,
            custom: true,
          };
          return new Response(
            JSON.stringify({ agent_servers: agentServers, harnesses }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/local/harnesses") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            enabled_harness_ids?: string[];
          };
          expect(body.enabled_harness_ids).toEqual(
            expect.arrayContaining(["cursor", "claude-acp"]),
          );
          expect(body.enabled_harness_ids).toHaveLength(2);
          harnesses[1] = { ...harnesses[1], enabled: true };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/gemini/authenticate") &&
          init?.method === "POST"
        ) {
          harnesses[3] = {
            ...harnesses[3],
            enabled: false,
            auth: {
              status: "configured",
              message: "Gemini authentication is configured for ACP.",
              command: "/tmp/clash-acp-gemini",
              methodId: "login",
              methodName: "Login",
              methods: [{ id: "login", name: "Login", type: "terminal" }],
            },
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/gemini/install") &&
          init?.method === "POST"
        ) {
          harnesses[3] = {
            ...harnesses[3],
            binary: "/tmp/clash-acp-gemini",
            enabled: false,
            available: true,
            installed: true,
            auth: {
              status: "needs-auth",
              message: "Gemini has no auth method selected for ACP.",
              command: "/tmp/clash-acp-gemini",
              methodId: "login",
              methodName: "Login",
              methods: [{ id: "login", name: "Login", type: "terminal" }],
            },
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/claude-acp/install") &&
          init?.method === "POST"
        ) {
          harnesses[1] = {
            ...harnesses[1],
            binary: "/tmp/claude-agent-acp",
            available: true,
            installed: true,
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/cursor/upgrade") &&
          init?.method === "POST"
        ) {
          harnesses[4] = {
            ...harnesses[4],
            installedVersion: "1.1.0",
            latestVersion: "1.1.0",
            updateAvailable: false,
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/cursor/install") &&
          init?.method === "DELETE"
        ) {
          harnesses[4] = {
            ...harnesses[4],
            enabled: false,
            available: false,
            installed: false,
            installedVersion: undefined,
            updateAvailable: false,
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    await screen.findByText("Agents");
    const agentsHeading = screen.getByRole("heading", { name: "Agents" });
    const promptQueueHeading = screen.getByRole("heading", {
      name: "Prompt queue",
    });
    expect(
      agentsHeading.compareDocumentPosition(promptQueueHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Machines" })).toBeNull();
    expect(screen.queryByText("Bound agents")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add machine" })).toBeNull();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.queryByText("Bundled")).toBeNull();
    expect(screen.getByRole("button", { name: "Install Codex" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install Claude" })).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Enable Codex agent" }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Enable Gemini agent" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade Cursor" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Uninstall Cursor" }),
    ).toBeTruthy();
    expect(screen.getByText("Version: 1.0.0 -> 1.1.0")).toBeTruthy();
    expect(screen.getAllByText("Not installed").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(
      screen.getByRole("button", { name: "Install OpenCode" }),
    ).toBeTruthy();
    expect(screen.queryByText("OpenClaw")).toBeNull();
    expect(screen.queryByText("Hermes")).toBeNull();
    expect(screen.getByText("Custom agent servers")).toBeTruthy();
    const machineTabs = screen.getByRole("tablist", {
      name: "Runtime machines",
    });
    expect(
      within(machineTabs)
        .getByRole("tab", { name: /This Mac/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(machineTabs)
        .getByRole("tab", { name: /Studio Mac/ })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.queryByText("39 configured agents")).toBeNull();
    expect(screen.queryByText("Show agents")).toBeNull();
    expect(screen.queryByText("Hide agents")).toBeNull();
    expect(screen.queryByText("Remote Codex")).toBeNull();
    expect(
      screen.getByText("node ~/projects/local-agent/index.js --acp"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Custom agent servers JSON")).toBeNull();
    expect(screen.getByRole("button", { name: "Install Gemini" })).toBeTruthy();
    expect(screen.getByText("clash-acp-gemini")).toBeTruthy();
    expect(screen.queryByText("/opt/homebrew/bin/gemini")).toBeNull();
    expect(screen.queryByText(/npm install -g/)).toBeNull();

    fireEvent.click(
      within(machineTabs).getByRole("tab", { name: /Studio Mac/ }),
    );
    expect(screen.getByText("Remote Codex")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install Codex" })).toBeNull();
    runtimeMock.runtimes = runtimeMock.runtimes.filter(
      (runtime) => runtime.id !== "studio-runtime",
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: /This Mac/ })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(screen.queryByRole("tab", { name: /Studio Mac/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Install Codex" })).toBeTruthy();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(
            "/api/v1/local/harnesses?probe=auth&refresh=1",
          ),
        ),
      ).toBe(true),
    );
    expect(runtimeMock.refresh).toHaveBeenCalledWith({
      probe: "config",
      refresh: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Install Gemini" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/gemini/install"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Uninstall Gemini" }),
    ).toBeTruthy();
    expect(screen.getByText("Auth needed")).toBeTruthy();
    expect(
      screen.getByText(/Gemini has no auth method selected for ACP/),
    ).toBeTruthy();
    expect(screen.getAllByText("/tmp/clash-acp-gemini").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("Manual fallback")).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Enable Gemini agent" }),
    ).toBeNull();
    expect(screen.queryByText(/Click Auth/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Check Gemini auth again" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes(
            "/api/v1/local/harnesses?probe=auth&refresh=1",
          ),
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(runtimeMock.refresh).toHaveBeenCalledWith({
      probe: "config",
      refresh: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Gemini setup" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/gemini/authenticate"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.getByText("Auth configured")).toBeTruthy();
    expect(
      (
        screen.getByRole("switch", {
          name: "Enable Gemini agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(runtimeMock.refresh).toHaveBeenCalledWith({
      probe: "config",
      refresh: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Install Claude" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/claude-acp/install"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    expect(
      (
        await screen.findByRole("switch", { name: "Disable Claude agent" })
      ).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "Add custom agent server" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Add custom agent server" }),
    ).toBeTruthy();
    expect(screen.getByText("Settings preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Node script" }));
    fireEvent.change(screen.getByLabelText("Agent server name"), {
      target: { value: "Studio ACP" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save agent server" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/agent-servers"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const agentServerPut = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes("/api/v1/local/agent-servers") &&
        init?.method === "PUT",
    );
    expect(JSON.parse(String(agentServerPut?.[1]?.body))).toEqual({
      agent_servers: {
        "Local ACP": {
          type: "custom",
          command: "node",
          args: ["~/projects/local-agent/index.js", "--acp"],
          env: {},
        },
        "Studio ACP": {
          type: "custom",
          command: "node",
          args: ["~/projects/my-agent/index.js", "--acp"],
          env: {},
        },
      },
    });
    expect(screen.getByText("node")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Upgrade Cursor" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/cursor/upgrade"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.getByText("Version: 1.1.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade Cursor" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Cursor" }));
    const uninstallDialog = screen.getByRole("dialog", {
      name: "Uninstall Cursor?",
    });
    expect(
      within(uninstallDialog).getByText(
        /removes the Clash-managed ACP install/,
      ),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/api/v1/local/harnesses/cursor/install") &&
          init?.method === "DELETE",
      ),
    ).toBe(false);
    fireEvent.click(
      within(uninstallDialog).getByRole("button", {
        name: "Confirm uninstall Cursor",
      }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/cursor/install"),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(screen.getByRole("button", { name: "Install Cursor" })).toBeTruthy();
  });

  it("tracks concurrent agent upgrades independently and ignores stale sibling results", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    const initialHarnesses = [
      {
        id: "codex-acp",
        label: "Codex",
        binary: "/tmp/clash-acp-codex",
        enabled: true,
        available: true,
        installed: true,
        installable: true,
        installedVersion: "0.50.0",
        latestVersion: "0.60.0",
        updateAvailable: true,
      },
      {
        id: "claude-acp",
        label: "Claude",
        binary: "/tmp/clash-acp-claude",
        enabled: true,
        available: true,
        installed: true,
        installable: true,
        installedVersion: "0.52.0",
        latestVersion: "0.61.0",
        updateAvailable: true,
      },
    ];
    let resolveCodex!: (response: Response) => void;
    let resolveClaude!: (response: Response) => void;
    const codexResponse = new Promise<Response>((resolve) => {
      resolveCodex = resolve;
    });
    const claudeResponse = new Promise<Response>((resolve) => {
      resolveClaude = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/local/agent-servers")) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/codex-acp/upgrade") &&
          init?.method === "POST"
        ) {
          return codexResponse;
        }
        if (
          url.includes("/api/v1/local/harnesses/claude-acp/upgrade") &&
          init?.method === "POST"
        ) {
          return claudeResponse;
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ harnesses: initialHarnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Upgrade Codex" }),
    );
    await screen.findByText("Upgrading Codex from the ACP registry…");
    const claudeButton = screen.getByRole("button", { name: "Upgrade Claude" });
    expect((claudeButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(claudeButton);

    expect(
      await screen.findByText("Upgrading Codex from the ACP registry…"),
    ).toBeTruthy();
    expect(
      await screen.findByText("Upgrading Claude from the ACP registry…"),
    ).toBeTruthy();

    await act(async () => {
      resolveClaude(
        new Response(
          JSON.stringify({
            harnesses: initialHarnesses.map((harness) =>
              harness.id === "claude-acp"
                ? {
                    ...harness,
                    installedVersion: harness.latestVersion,
                    updateAvailable: false,
                  }
                : harness,
            ),
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await claudeResponse;
    });

    await act(async () => {
      resolveCodex(
        new Response(
          JSON.stringify({
            harnesses: initialHarnesses.map((harness) =>
              harness.id === "codex-acp"
                ? {
                    ...harness,
                    installedVersion: harness.latestVersion,
                    updateAvailable: false,
                  }
                : harness,
            ),
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await codexResponse;
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Upgrade Codex" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Upgrade Claude" }),
      ).toBeNull();
    });
  });

  it("shares agent upgrade progress and completion with the desktop update control", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    const codexHarness = {
      id: "codex-acp",
      label: "Codex",
      binary: "/tmp/clash-acp-codex",
      enabled: true,
      available: true,
      installed: true,
      installable: true,
      installedVersion: "0.50.0",
      latestVersion: "0.60.0",
      updateAvailable: true,
    };
    let resolveUpgrade!: (response: Response) => void;
    const upgradeResponse = new Promise<Response>((resolve) => {
      resolveUpgrade = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/local/agent-servers")) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/codex-acp/upgrade") &&
          init?.method === "POST"
        ) {
          return upgradeResponse;
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ harnesses: [codexHarness] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <HarnessUpdateNotifier />
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    const updateTrigger = await screen.findByRole("button", {
      name: "1 ACP update available",
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Upgrade Codex" }),
    );
    fireEvent.click(updateTrigger);
    expect(
      await screen.findByRole("button", { name: "Updating Codex" }),
    ).toBeTruthy();

    await act(async () => {
      resolveUpgrade(
        new Response(
          JSON.stringify({
            harnesses: [
              {
                ...codexHarness,
                installedVersion: codexHarness.latestVersion,
                updateAvailable: false,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await upgradeResponse;
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Upgrade Codex" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Updating Codex" }),
      ).toBeNull();
      expect(screen.getByText("Codex updated to 0.60.0")).toBeTruthy();
    });
  });

  it("does not offer install for available unmanaged agents", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [{ id: "codex-acp", binary: "codex-acp" }],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "codex-acp",
                  label: "Codex",
                  binary: "/tmp/dev-build/acp-bin/codex-acp",
                  enabled: true,
                  available: true,
                  installable: true,
                  installSource: "registry",
                  auth: {
                    status: "configured",
                    message:
                      "Codex ACP auth is configured (Login with ChatGPT).",
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    await screen.findByText("Auth configured");
    expect(screen.queryByRole("button", { name: "Install Codex" })).toBeNull();
    expect(
      screen
        .getByRole("switch", { name: "Disable Codex agent" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("updates harness enablement optimistically and probes missing metadata after save", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    let resolvePut!: (response: Response) => void;
    const putPromise = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/local/harnesses") && init?.method === "PUT") {
          return putPromise;
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "claude-acp",
                  label: "Claude",
                  binary: "/tmp/claude-agent-acp",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  installSource: "registry",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    const enableSwitch = await screen.findByRole("switch", {
      name: "Enable Claude agent",
    });
    fireEvent.click(enableSwitch);

    expect(
      screen
        .getByRole("switch", { name: "Disable Claude agent" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(runtimeMock.refresh).not.toHaveBeenCalled();

    resolvePut(
      new Response(
        JSON.stringify({
          harnesses: [
            {
              id: "claude-acp",
              label: "Claude",
              binary: "/tmp/claude-agent-acp",
              enabled: true,
              available: true,
              installed: true,
              installable: true,
              installSource: "registry",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await waitFor(() =>
      expect(runtimeMock.refresh).toHaveBeenCalledWith({
        probe: "config",
        refresh: true,
      }),
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/v1/local/harnesses?probe=auth&refresh=1"),
      ),
    ).toBe(true);
  });

  it("does not show unknown as the installed version for legacy registry installs", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [{ id: "cursor", binary: "clash-acp-cursor" }],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "cursor",
                  label: "Cursor",
                  binary:
                    "/Users/xiaoyang/.clash/local-api/acp-bin/clash-acp-cursor",
                  enabled: true,
                  available: true,
                  installed: true,
                  latestVersion: "2026.06.24",
                  updateAvailable: true,
                  installable: true,
                  installSource: "registry",
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    await screen.findByText("Cursor");
    expect(screen.getByText("Latest version: 2026.06.24")).toBeTruthy();
    expect(screen.queryByText(/unknown/)).toBeNull();
  });

  it("keeps install and uninstall busy labels separate while an install refresh is pending", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    let finishRefresh!: () => void;
    runtimeMock.refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const harnesses: Array<{
      id: string;
      label: string;
      binary: string;
      enabled: boolean;
      available: boolean;
      installed?: boolean;
      installable: boolean;
      installSource: "registry";
      latestVersion?: string;
    }> = [
      {
        id: "devin",
        label: "Devin",
        binary: "clash-acp-devin",
        enabled: false,
        available: false,
        installable: true,
        installSource: "registry" as const,
        latestVersion: "2026.8.18",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/devin/install") &&
          init?.method === "POST"
        ) {
          harnesses[0] = {
            ...harnesses[0],
            installed: true,
            enabled: false,
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "Install Devin" });
    fireEvent.click(screen.getByRole("button", { name: "Install Devin" }));

    await screen.findByRole("button", { name: "Uninstall Devin" });
    expect(runtimeMock.refresh).toHaveBeenCalledWith({
      probe: "config",
      refresh: true,
    });
    expect(screen.queryByText("Uninstalling…")).toBeNull();
    finishRefresh();
  });

  it("installs and enables an auth-ready registry agent in one flow", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    const harnesses: Array<{
      id: string;
      label: string;
      binary: string;
      enabled: boolean;
      available: boolean;
      installed?: boolean;
      installable: boolean;
      installSource: "registry";
    }> = [
      {
        id: "codex-acp",
        label: "Codex",
        binary: "codex-acp",
        enabled: false,
        available: false,
        installable: true,
        installSource: "registry" as const,
      },
    ];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/codex-acp/install") &&
          init?.method === "POST"
        ) {
          harnesses[0] = {
            ...harnesses[0],
            binary: "/tmp/clash-acp-codex",
            available: true,
            installed: true,
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/local/harnesses") && init?.method === "PUT") {
          expect(JSON.parse(String(init.body))).toEqual({
            enabled_harness_ids: ["codex-acp"],
          });
          harnesses[0] = {
            ...harnesses[0],
            enabled: true,
          };
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ harnesses }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "Install Codex" });
    expect(
      screen.queryByRole("switch", { name: "Enable Codex agent" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Install Codex" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/codex-acp/install"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await screen.findByRole("button", { name: "Uninstall Codex" });
    expect(screen.queryByRole("button", { name: "Install Codex" })).toBeNull();
  });

  it("refreshes auth state when enablement is rejected by the backend guard", async () => {
    let authRefreshRequested = false;
    const readyHarness = {
      id: "qwen-code",
      label: "Qwen Code",
      binary: "/tmp/clash-acp-qwen-code",
      enabled: false,
      available: true,
      installed: true,
      installable: true,
      installSource: "registry" as const,
    };
    const needsAuthHarness = {
      ...readyHarness,
      auth: {
        status: "needs-auth" as const,
        message: "Qwen Code requires ACP authentication (Use OpenAI API key).",
        command: "/tmp/clash-acp-qwen-code",
        methodId: "openai-api-key",
        methodName: "Use OpenAI API key",
        methods: [
          {
            id: "openai-api-key",
            name: "Use OpenAI API key",
            description:
              "Requires setting the OPENAI_API_KEY environment variable",
            type: "terminal",
          },
        ],
      },
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/local/harnesses") && init?.method === "PUT") {
          authRefreshRequested = true;
          return new Response(
            JSON.stringify({
              error:
                "Authenticate Qwen Code before enabling. Qwen Code requires ACP authentication (Use OpenAI API key).",
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                authRefreshRequested ? needsAuthHarness : readyHarness,
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("switch", { name: "Enable Qwen Code agent" }),
    );

    await screen.findByText("Auth needed");
    expect(
      screen.queryByRole("button", { name: "Open Qwen Code setup" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Configure Qwen Code credentials" }),
    );

    await screen.findByRole("status");
    expect(screen.getByText("Configure Qwen Code credentials")).toBeTruthy();
    expect(
      screen.getByText(
        "Set OPENAI_API_KEY in your agent environment, then check again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Providers" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Check again" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("switch", { name: "Enable Qwen Code agent" }),
    ).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(
          "/api/v1/local/harnesses/qwen-code/authenticate",
        ),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/v1/local/harnesses?probe=auth&refresh=1"),
      ),
    ).toBe(true);
  });

  it("lets users disable runtime prompt queueing from settings", async () => {
    runtimeMock.runtimes = [
      {
        id: "desktop-local",
        machine_id: "desktop-local",
        hostname: "This Mac",
        os: "darwin/arm64",
        agents: [{ id: "codex-acp", binary: "codex-acp" }],
        version: "desktop",
        status: "online",
        last_heartbeat: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ harnesses: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection={"agents" as any}
          embedded
        />
      </MemoryRouter>,
    );

    const queueSwitch = screen.getByRole("switch", {
      name: "Disable prompt queue",
    });
    expect(queueSwitch.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(queueSwitch);

    expect(runtimeMock.setPromptQueueEnabled).toHaveBeenCalledWith(false);
  });

  it("shows non-blocking agent probe failures as global feedback with a retry action", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ error: "probe unavailable" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Could not load agents");
    expect(screen.getByText("HTTP 500")).toBeTruthy();
    expect(screen.queryByText(/Failed to load agents/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes(
            "/api/v1/local/harnesses?probe=auth&refresh=1",
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(runtimeMock.refresh).toHaveBeenCalledWith({
      probe: "config",
      refresh: true,
    });
  });

  it("shows auth launch failures as non-blocking global feedback", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/devin/authenticate") &&
          init?.method === "POST"
        ) {
          return new Response(JSON.stringify({ error: "Login canceled" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "devin",
                  label: "Devin",
                  binary: "/tmp/clash-acp-devin",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  auth: {
                    status: "needs-auth",
                    message: "Devin is not signed in for ACP.",
                    command: "/tmp/clash-acp-devin auth login",
                    methodId: "login",
                    methodName: "Login",
                    methods: [{ id: "login", name: "Login", type: "agent" }],
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Devin");
    expect(
      screen.queryByRole("switch", { name: "Enable Devin agent" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Devin" }));

    await screen.findByRole("alert");
    expect(screen.getByText("Could not start Devin sign in")).toBeTruthy();
    expect(screen.getByText("Login canceled")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Could not start Devin sign in" }),
    ).toBeNull();
    expect(screen.queryByText(/Failed to load agents/)).toBeNull();
  });

  it("routes env var auth methods to credential configuration instead of sign-in", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/local/harnesses/qwen-code/authenticate")) {
          return new Response(
            JSON.stringify({
              error: "should not authenticate env_var methods",
            }),
            {
              status: 500,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "qwen-code",
                  label: "Qwen Code",
                  binary: "/tmp/clash-acp-qwen-code",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  auth: {
                    status: "needs-auth",
                    message:
                      "Qwen Code requires ACP authentication (OpenAI API key).",
                    command: "/tmp/clash-acp-qwen-code",
                    methodId: "openai-key",
                    methodName: "OpenAI API key",
                    methods: [
                      {
                        id: "openai-key",
                        name: "OpenAI API key",
                        description: "Use an OpenAI-compatible API key",
                        type: "env_var",
                        vars: [
                          {
                            name: "OPENAI_API_KEY",
                            label: "API key",
                            secret: true,
                          },
                        ],
                        link: "https://platform.openai.com/api-keys",
                      },
                    ],
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Auth needed");
    expect(
      screen.queryByRole("button", { name: "Sign in to Qwen Code" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Configure Qwen Code credentials" }),
    );

    await screen.findByRole("status");
    expect(screen.getByText("Configure Qwen Code credentials")).toBeTruthy();
    expect(
      screen.getByText(
        "Set OPENAI_API_KEY in your agent environment, then check again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Providers" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Check again" }).length,
    ).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(
          "/api/v1/local/harnesses/qwen-code/authenticate",
        ),
      ),
    ).toBe(false);
  });

  it("shows scoped auth checking copy when rechecking one agent", async () => {
    let resolveAuthRefresh!: (response: Response) => void;
    const authRefreshPromise = new Promise<Response>((resolve) => {
      resolveAuthRefresh = resolve;
    });
    const qwenHarness = {
      id: "qwen-code",
      label: "Qwen Code",
      binary: "/tmp/clash-acp-qwen-code",
      enabled: false,
      available: true,
      installed: true,
      installable: true,
      installSource: "registry" as const,
      auth: {
        status: "needs-auth" as const,
        message: "Qwen Code requires ACP authentication (Use OpenAI API key).",
        command: "/tmp/clash-acp-qwen-code",
        methodId: "openai-key",
        methodName: "OpenAI API key",
        methods: [
          {
            id: "openai-key",
            name: "OpenAI API key",
            description:
              "Requires setting the OPENAI_API_KEY environment variable",
            type: "env_var",
            vars: [{ name: "OPENAI_API_KEY", label: "API key", secret: true }],
          },
        ],
      },
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses?probe=auth&refresh=1") &&
          (!init || init.method === "GET")
        ) {
          return authRefreshPromise;
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ harnesses: [qwenHarness] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Auth needed");
    fireEvent.click(
      screen.getByRole("button", { name: "Check Qwen Code auth again" }),
    );

    expect(screen.getByText("Checking Qwen Code auth…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Check Qwen Code auth again" })
        .textContent,
    ).toContain("Checking auth…");
    expect(screen.queryByText("Checking agents…")).toBeNull();

    resolveAuthRefresh(
      new Response(JSON.stringify({ harnesses: [qwenHarness] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Checking Qwen Code auth…")).toBeNull(),
    );
  });

  it("lets users choose a concrete ACP auth method", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/devin/authenticate") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "devin",
                  label: "Devin",
                  binary: "/tmp/clash-acp-devin",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  auth: {
                    status: "needs-auth",
                    message: "Devin is not signed in for ACP.",
                    methodId: "browser",
                    methodName: "Browser Login",
                    methods: [
                      { id: "browser", name: "Browser Login", type: "agent" },
                      {
                        id: "api-key",
                        name: "API Key",
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
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "devin",
                  label: "Devin",
                  binary: "/tmp/clash-acp-devin",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  auth: {
                    status: "needs-auth",
                    message: "Devin is not signed in for ACP.",
                    methodId: "browser",
                    methodName: "Browser Login",
                    methods: [
                      { id: "browser", name: "Browser Login", type: "agent" },
                      {
                        id: "api-key",
                        name: "API Key",
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
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByLabelText("API key");
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-settings-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with API Key" }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/harnesses/devin/authenticate"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            method_id: "api-key",
            values: { "api-key": "sk-settings-secret" },
          }),
        }),
      );
    });
  });

  it("automatically rechecks auth after a sign-in launch", async () => {
    let authConfigured = false;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/devin/authenticate") &&
          init?.method === "POST"
        ) {
          authConfigured = true;
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "devin",
                  label: "Devin",
                  binary: "/tmp/clash-acp-devin",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  auth: {
                    status: "needs-auth",
                    message: "Devin is not signed in for ACP.",
                    methodId: "api-key",
                    methodName: "API Key",
                    methods: [
                      { id: "api-key", name: "API Key", type: "agent" },
                    ],
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "devin",
                  label: "Devin",
                  binary: "/tmp/clash-acp-devin",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  auth: authConfigured
                    ? {
                        status: "configured",
                        message: "Devin ACP auth is configured (API Key).",
                        methodId: "api-key",
                        methodName: "API Key",
                        methods: [
                          { id: "api-key", name: "API Key", type: "agent" },
                        ],
                      }
                    : {
                        status: "needs-auth",
                        message: "Devin is not signed in for ACP.",
                        methodId: "api-key",
                        methodName: "API Key",
                        methods: [
                          { id: "api-key", name: "API Key", type: "agent" },
                        ],
                      },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Auth needed");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Devin" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Waiting for Devin auth…")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Auth configured")).toBeTruthy();
    expect(screen.queryByText("Waiting for Devin auth…")).toBeNull();
    expect(runtimeMock.refresh).toHaveBeenCalledWith({
      probe: "config",
      refresh: true,
    });
  });

  it("releases the Opening state when sign-in launch does not settle", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/v1/local/agent-servers") &&
          (!init || init.method === "GET")
        ) {
          return new Response(JSON.stringify({ agent_servers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.includes("/api/v1/local/harnesses/devin/authenticate") &&
          init?.method === "POST"
        ) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        }
        if (
          url.includes("/api/v1/local/harnesses") &&
          (!init || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({
              harnesses: [
                {
                  id: "devin",
                  label: "Devin",
                  binary: "/tmp/clash-acp-devin",
                  enabled: false,
                  available: true,
                  installed: true,
                  installable: true,
                  auth: {
                    status: "needs-auth",
                    message: "Devin is not signed in for ACP.",
                    methodId: "api-key",
                    methodName: "API Key",
                    methods: [
                      { id: "api-key", name: "API Key", type: "agent" },
                    ],
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <AppFeedbackProvider>
          <SettingsClient
            initialTokens={[]}
            initialVariables={[]}
            initialActions={[]}
            initialSkills={[]}
            activeSection={"agents" as any}
            embedded
          />
        </AppFeedbackProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Auth needed");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Devin" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: "Sign in to Devin" }).textContent,
    ).toContain("Opening sign in…");

    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(screen.getByText("Waiting for Devin auth…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign in to Devin" }).textContent,
    ).toContain("Open again");
  });
});

describe("SettingsClient model routing", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    delete globalThis.__CLASH_DESKTOP__;
  });

  it("uses the shared Settings section and panel rhythm for Providers", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
        />
      </MemoryRouter>,
    );

    const providersSection = screen
      .getByRole("heading", { name: "Providers" })
      .closest('[data-slot="settings-section"]');
    expect(providersSection).toBeTruthy();
    expect(providersSection?.className).toContain("max-w-3xl");
    expect(
      providersSection?.querySelector('[data-slot="settings-section-header"]'),
    ).toBeTruthy();
    const availableProviders = screen.getByRole("list", {
      name: "Available BYOK providers",
    });
    expect(availableProviders.getAttribute("data-slot")).not.toBe(
      "settings-panel",
    );
    expect(availableProviders.getAttribute("data-slot")).toBe(
      "settings-collection",
    );
    const firstProviderRow = availableProviders.querySelector("li");
    expect(firstProviderRow?.getAttribute("data-slot")).toBe("settings-row");
    const providerTrigger = within(firstProviderRow as HTMLElement).getByRole(
      "button",
      {
        name: /Open .* BYOK settings/,
      },
    );
    expect(providerTrigger).toBeTruthy();
    expect(providerTrigger).toHaveClass("hover:bg-accent/60");
  });

  it("does not expose legacy fallback or advanced routing controls in BYOK provider details", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              providerId: "fal",
              upstreamId: "fal",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[
            {
              model: {
                id: "nano-banana-2",
                aliases: [],
                name: "Nano Banana 2",
                provider: "fal",
                kind: "image",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "16:9",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: {
                modelCode: "nano-banana-2",
                kind: "image",
                providerId: "fal",
                upstreamId: "fal",
                upstreamModel: "fal-ai/nano-banana-2",
                apiShape: "fal",
                priority: 20,
              },
              routes: [],
              candidateProviders: ["fal"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Search providers")).toBeTruthy();
    expect(
      screen
        .getByLabelText("Search providers")
        .closest('[data-slot="search-field"]'),
    ).toHaveAttribute("data-leading-icon", "true");
    expect(screen.getByText("fal.ai")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /fal\.ai/i }));

    expect(screen.queryByText("Fallback")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add fallback fal.ai key" }),
    ).toBeNull();
    expect(screen.queryByText("Advanced routing")).toBeNull();
    expect(screen.queryByLabelText("Weight for fal/fal")).toBeNull();
    expect(screen.queryByLabelText("Priority for fal/fal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save providers" })).toBeNull();
  });

  it("uses brand assets for built-in provider logos", () => {
    const { container } = render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    const logos = Object.fromEntries(
      [
        ...container.querySelectorAll<HTMLImageElement>("[data-provider-logo]"),
      ].map((logo) => [
        logo.getAttribute("data-provider-logo"),
        logo.getAttribute("src"),
      ]),
    );

    expect(logos).toMatchObject({
      openai: "/brand/providers/openai.svg",
      anthropic: "/brand/providers/anthropic.svg",
      google: "/brand/providers/google.svg",
      fal: "/brand/providers/fal.svg",
      flux: "/brand/models/flux.svg",
      replicate: "/brand/providers/replicate.svg",
      kling: "/brand/providers/kling.svg",
      minimax: "/brand/providers/minimax.svg",
      volcengine: "/brand/providers/volcengine.svg",
      elevenlabs: "/brand/providers/elevenlabs.svg",
    });
  });

  it("does not repeat the provider page heading inside the Providers content", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.queryByText("Provider accounts and execution settings"),
    ).toBeNull();
  });

  it("renders the BYOK provider directory without competing row actions", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Providers" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "BYOK" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "BYOK settings" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Providers" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Web Search" })).toBeNull();
    expect(screen.getByLabelText("Search providers")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add custom provider" }),
    ).toBeTruthy();
  });

  /**
   * Reversed. Google is one Provider, and `service` is a setting on the account.
   *
   * This asserted the split that was measured away: both surfaces authenticate the same
   * way -- `x-goog-api-key` against `:generateContent` -- and only the host differs. Same
   * authentication method, same Provider. The surface became a declared `choice` on the account
   * form, so two accounts on different services are two accounts of one Provider, not two
   * Providers.
   */
  it("renders Google as one BYOK provider whose accounts choose a service", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "google-ai-studio-primary",
              label: "AI Studio primary",
              providerId: "official",
              upstreamId: "google-ai-studio",
              region: "global",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "google-agent-platform-primary",
              label: "Cloud primary",
              providerId: "official",
              upstreamId: "google-ai-studio",
              region: "global",
              enabled: true,
              configuredCredentials: ["serviceAccountKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    const configuredProviders = screen.getByRole("list", {
      name: "Configured BYOK providers",
    });
    expect(
      within(configuredProviders).getByText("Google AI Studio"),
    ).toBeTruthy();
    // No second entry: the two accounts differ by a setting, not by Provider.
    expect(
      within(configuredProviders).queryByText("Google Cloud Agent Platform"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Google AI Studio BYOK settings",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Google AI Studio" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "View supported models" })
        .getAttribute("href"),
    ).toBe(
      "/settings?section=models&provider=official%3Agoogle-ai-studio%3Aglobal",
    );
    fireEvent.click(screen.getByText("AI Studio primary"));
    expect(screen.getByLabelText("Google AI Studio API key")).toBeTruthy();
    expect(screen.queryByText(/Vertex/i)).toBeNull();

    // The second account is reached inside the same Provider, not behind a second one. There is
    // no "Open Google Cloud Agent Platform BYOK settings" button to press any more, because the
    // surface is a setting on the account rather than a Provider of its own.
    expect(
      screen.queryByRole("button", {
        name: "Open Google Cloud Agent Platform BYOK settings",
      }),
    ).toBeNull();
    // The account list lives inside the Provider, which is the point of the merge: two accounts on
    // different services are two accounts of one Provider.
    expect(screen.getAllByText(/AI Studio primary/).length).toBeGreaterThan(0);
  });

  it("renders the official Black Forest Labs FLUX provider setup", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "bfl-primary",
              label: "BFL primary",
              providerId: "official",
              upstreamId: "bfl",
              apiShape: "bfl",
              region: "global",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    const configuredProviders = screen.getByRole("list", {
      name: "Configured BYOK providers",
    });
    expect(
      within(configuredProviders).getByText("Black Forest Labs"),
    ).toBeTruthy();
    expect(
      configuredProviders
        .querySelector('[data-provider-logo="flux"]')
        ?.getAttribute("src"),
    ).toBe("/brand/models/flux.svg");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Black Forest Labs BYOK settings",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Black Forest Labs" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "View supported models" })
        .getAttribute("href"),
    ).toBe("/settings?section=models&provider=official%3Abfl%3Aglobal");
    fireEvent.click(screen.getByText("BFL primary"));
    expect(screen.getByLabelText("Black Forest Labs API key")).toBeTruthy();
    expect(
      screen
        .getByLabelText("Black Forest Labs base URL")
        .getAttribute("placeholder"),
    ).toBe("https://api.bfl.ai");
  });

  it("renders providers as a compact directory before revealing setup forms", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    const configuredProviders = screen.getByRole("list", {
      name: "Configured BYOK providers",
    });
    const availableProviders = screen.getByRole("list", {
      name: "Available BYOK providers",
    });
    expect(within(configuredProviders).getByText("Replicate")).toBeTruthy();
    expect(within(configuredProviders).getByText("1 key")).toBeTruthy();
    expect(within(availableProviders).getByText("OpenAI")).toBeTruthy();
    expect(
      within(availableProviders).getAllByText("Not configured").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open OpenAI BYOK settings" }),
    ).toBeTruthy();
    expect(screen.queryByText("Settings")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Manage Replicate" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Configure OpenAI" }),
    ).toBeNull();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.queryByLabelText("Replicate API key")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Enable OpenAI" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Provider enabled for Replicate" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );

    expect(
      screen.queryByRole("list", { name: "Configured BYOK providers" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Back to BYOK" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Replicate" })).toBeTruthy();
    const nanoLink = screen.getByRole("link", {
      name: "View supported models",
    });
    expect(nanoLink.getAttribute("href")).toBe(
      "/settings?section=models&provider=replicate%3Areplicate%3A",
    );
    expect(screen.getByText("Provider Keys")).toBeTruthy();
    expect(screen.getByText("Prioritized")).toBeTruthy();
    expect(screen.queryByText("Fallback")).toBeNull();
    const apiKeys = screen.getByRole("list", {
      name: "Replicate prioritized keys",
    });
    expect(within(apiKeys).getByText("API key 1")).toBeTruthy();
    expect(within(apiKeys).getByText("•••• •••• ••••")).toBeTruthy();
    expect(
      within(apiKeys).getByRole("switch", {
        name: "Provider enabled for API key 1",
      }),
    ).toBeTruthy();
    expect(
      within(apiKeys).getByRole("button", { name: "Drag API key 1" }),
    ).toBeTruthy();
    expect(within(apiKeys).queryByText("All")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add prioritized Replicate key" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add fallback Replicate key" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add Replicate API key" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByLabelText("Replicate API key")).toBeNull();
    expect(screen.queryByPlaceholderText("Saved")).toBeNull();

    const existingRow = within(apiKeys).getAllByRole("listitem")[0];
    fireEvent.click(within(existingRow).getByText("API key 1"));

    const existingKeyEditor = within(existingRow).getByRole("group", {
      name: "API key 1 Replicate API key",
    });
    expect(
      within(existingKeyEditor).getByLabelText("Replicate key name"),
    ).toBeTruthy();
    expect(
      within(existingKeyEditor).getByLabelText("Replicate API key"),
    ).toBeTruthy();
    expect(
      within(existingKeyEditor).queryByRole("button", { name: "Save" }),
    ).toBeNull();
    fireEvent.change(
      within(existingKeyEditor).getByLabelText("Replicate key name"),
      {
        target: { value: "Primary" },
      },
    );
    expect(
      within(existingKeyEditor).getByRole("button", { name: "Save" }),
    ).toBeTruthy();
    expect(within(existingKeyEditor).queryByText("Filters")).toBeNull();
    expect(within(existingKeyEditor).queryByText("API Keys")).toBeNull();
    expect(
      within(existingKeyEditor).queryByText("Always use for this provider"),
    ).toBeNull();
    expect(
      within(existingKeyEditor).getByRole("combobox", {
        name: /Choose test model/i,
      }),
    ).toBeTruthy();
    expect(
      within(existingKeyEditor).getByRole("button", {
        name: "Run provider test",
      }),
    ).toBeTruthy();
    expect(
      within(existingKeyEditor).queryByRole("button", { name: /Remove key/i }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Add prioritized Replicate key" }),
    );

    expect(
      within(existingRow).queryByRole("group", {
        name: "API key 1 Replicate API key",
      }),
    ).toBeNull();
    const newKeyEditor = screen.getByRole("group", {
      name: "New Replicate API key",
    });
    expect(within(newKeyEditor).getByText("New key")).toBeTruthy();
    expect(
      within(newKeyEditor).getByLabelText("Replicate key name"),
    ).toBeTruthy();
    expect(
      within(newKeyEditor).getByLabelText("Replicate API key"),
    ).toBeTruthy();
    expect(
      within(newKeyEditor).getByRole("button", { name: "Cancel" }),
    ).toBeTruthy();
    expect(
      within(newKeyEditor).queryByRole("switch", {
        name: "Always use for this provider",
      }),
    ).toBeNull();
    expect(
      within(newKeyEditor).queryByRole("button", { name: /Test/i }),
    ).toBeNull();
    expect(within(newKeyEditor).queryByText("Filters")).toBeNull();
    expect(within(newKeyEditor).queryByText("Models")).toBeNull();
    expect(within(newKeyEditor).queryByText("API Keys")).toBeNull();
    expect(screen.queryByText("Fallback")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add fallback Replicate key" }),
    ).toBeNull();
    expect(screen.queryByText("Advanced routing")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to BYOK" }));

    expect(
      screen.getByRole("list", { name: "Configured BYOK providers" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Replicate API key")).toBeNull();
  });

  it("offers Pika API Club as a BYOK provider without a fake OAuth control", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "Open Pika API Club BYOK settings" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Pika API Club BYOK settings" }),
    );
    expect(screen.getByRole("heading", { name: "Pika API Club" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add prioritized Pika API Club key" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /authorize pika/i }),
    ).toBeNull();
  });

  it("counts multiple credentialless provider accounts in the directory summary", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "mock-primary",
              label: "Mock primary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 10,
            },
            {
              id: "mock-secondary",
              label: "Mock secondary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 20,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    const configuredProviders = screen.getByRole("list", {
      name: "Configured BYOK providers",
    });
    expect(within(configuredProviders).getByText("Mock Provider")).toBeTruthy();
    expect(within(configuredProviders).getByText("2 keys")).toBeTruthy();
  });

  it("adds another API key as a separate provider account", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              label: "Primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add prioritized Replicate key" }),
    );
    fireEvent.change(screen.getByLabelText("Replicate API key"), {
      target: { value: "r8-second-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String),
            providerId: "replicate",
            upstreamId: "replicate",
            enabled: true,
            credentials: { apiKey: "r8-second-key" },
            configuredCredentials: ["apiKey"],
          }),
        ]),
      );
    });
  });

  it("shows the saved server state after adding a second provider key", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => [...providers],
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add prioritized Replicate key" }),
    );
    fireEvent.change(screen.getByLabelText("Replicate API key"), {
      target: { value: "r8-second-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalled();
    });

    await waitFor(() => {
      const apiKeys = screen.getByRole("list", {
        name: "Replicate prioritized keys",
      });
      const rows = within(apiKeys).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(within(apiKeys).getByText("API key 1")).toBeTruthy();
      expect(within(apiKeys).getByText("API key 2")).toBeTruthy();
    });
  });

  it("persists provider enablement and disables the switch while save is pending", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    let resolveSave!: (providers: any[]) => void;
    vi.mocked(actions.updateModelProviders).mockImplementation(
      (providers) =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    const initialSwitch = within(
      screen.getByRole("list", { name: "Replicate prioritized keys" }),
    ).getByRole("switch", {
      name: "Provider enabled for API key 1",
    });
    expect(initialSwitch.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(initialSwitch);

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "replicate-primary",
          providerId: "replicate",
          enabled: false,
        }),
      ]);
    });
    const pendingSwitch = within(
      screen.getByRole("list", { name: "Replicate prioritized keys" }),
    ).getByRole("switch", {
      name: "Provider enabled for API key 1",
    });
    expect(pendingSwitch.getAttribute("aria-checked")).toBe("false");
    expect(pendingSwitch.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveSave([
        {
          id: "replicate-primary",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: false,
          configuredCredentials: ["apiKey"],
        },
      ]);
    });

    await waitFor(() => {
      const savedSwitch = within(
        screen.getByRole("list", { name: "Replicate prioritized keys" }),
      ).getByRole("switch", {
        name: "Provider enabled for API key 1",
      });
      expect(savedSwitch.hasAttribute("disabled")).toBe(false);
      expect(savedSwitch.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("does not expose a provider saving status while idle", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Saving provider settings…")).toBeNull();
  });

  it("renders provider keys in priority order with drag handles", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              label: "Primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 20,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "replicate-team",
              label: "Team",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 10,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );

    const apiKeys = screen.getByRole("list", {
      name: "Replicate prioritized keys",
    });
    const rows = within(apiKeys).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Team")).toBeTruthy();
    expect(within(rows[1]).getByText("Primary")).toBeTruthy();
    expect(
      within(apiKeys).getByRole("button", { name: "Drag Team" }),
    ).toBeTruthy();
    expect(
      within(apiKeys).getByRole("button", { name: "Drag Primary" }),
    ).toBeTruthy();
  });

  it("reorders provider keys with keyboard-accessible controls and persists priorities", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              label: "Primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 20,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "replicate-team",
              label: "Team",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 10,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    const apiKeys = screen.getByRole("list", {
      name: "Replicate prioritized keys",
    });
    const rows = within(apiKeys).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Team")).toBeTruthy();
    expect(within(rows[1]).getByText("Primary")).toBeTruthy();

    fireEvent.click(
      within(rows[1]).getByRole("button", { name: "Move Primary up" }),
    );

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: "replicate-primary",
            priority: 10,
          }),
          expect.objectContaining({
            id: "replicate-team",
            priority: 20,
          }),
        ]),
      );
    });
  });

  it("removes a saved provider account from the provider detail editor", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.deleteModelProvider).mockResolvedValue();
    vi.mocked(actions.listModelProviders).mockResolvedValue([
      {
        id: "replicate-secondary",
        label: "Secondary",
        providerId: "replicate",
        upstreamId: "replicate",
        enabled: true,
        priority: 20,
        configuredCredentials: ["apiKey"],
      },
    ]);
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              label: "Primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 10,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "replicate-secondary",
              label: "Secondary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 20,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    const apiKeys = screen.getByRole("list", {
      name: "Replicate prioritized keys",
    });
    const primaryRow = within(apiKeys)
      .getByText("Primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(primaryRow).getByText("Primary"));

    const editor = within(primaryRow).getByRole("group", {
      name: "Primary Replicate API key",
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Remove key" }));

    await waitFor(() => {
      expect(actions.deleteModelProvider).toHaveBeenCalledWith(
        "replicate-primary",
      );
    });
    expect(screen.queryByText("Primary")).toBeNull();
    expect(screen.getByText("Secondary")).toBeTruthy();
  });

  it("discovers a plugin Provider and completes its browser OAuth callback in the desktop window", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked((actions as any).listPluginProviders).mockResolvedValue([
      {
        pluginId: "hilo-hub-media",
        pluginVersion: "1.0.0",
        schemaHash: `sha256:${"e".repeat(64)}`,
        id: "hilo-hub",
        name: "MiniMax Hilo Hub",
        description: "Hub OAuth media provider",
        upstreamId: "hilo-hub",
        apiShape: "hilo-hub",
        executorExportId: "hilo-hub-execute",
        auth: {
          methods: [
            {
              id: "sign-in",
              label: "Sign in to MiniMax Hub",
              flow: {
                open: "https://hub.minimax.io/login",
                callback: { type: "scheme", scheme: "minimax-hub" },
                credential: {
                  from: "query",
                  name: "accessToken",
                  storeAs: "accessToken",
                },
              },
            },
          ],
        },
      },
    ]);
    vi.mocked(actions.listProviderOAuth).mockResolvedValue([]);
    vi.mocked(actions.startProviderOAuth).mockResolvedValue({
      providerId: "hilo-hub",
      accountId: "hilo-primary",
      status: "pending",
      flow: "browser",
      verificationUri: "https://hub.minimax.io/login",
      callbackScheme: "minimax-hub",
      deviceCode: "browser-flow",
      hasAccessToken: false,
    } as any);
    vi.mocked(actions.completeProviderOAuth).mockResolvedValue({
      providerId: "hilo-hub",
      accountId: "hilo-primary",
      status: "authorized",
      accountLabel: "Primary Hilo",
      hasAccessToken: true,
    });
    vi.mocked(actions.listModelProviders).mockResolvedValue([]);
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);
    const authorizeProvider = vi.fn(async () => ({
      cancelled: false,
      callbackUrl: "minimax-hub://auth-callback?accessToken=hub-access-token",
    }));
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
      authorizeProvider,
    };

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "hilo-primary",
              label: "Primary Hilo",
              providerId: "hilo-hub",
              upstreamId: "hilo-hub",
              apiShape: "hilo-hub",
              enabled: true,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open MiniMax Hilo Hub BYOK settings",
      }),
    );
    const accounts = screen.getByRole("list", {
      name: "MiniMax Hilo Hub prioritized accounts",
    });
    const accountRow = within(accounts)
      .getByText("Primary Hilo")
      .closest("li") as HTMLElement;
    fireEvent.click(within(accountRow).getByText("Primary Hilo"));
    fireEvent.click(
      within(accountRow).getByRole("button", { name: "Connect" }),
    );

    await waitFor(() => {
      expect(authorizeProvider).toHaveBeenCalledWith({
        verificationUri: "https://hub.minimax.io/login",
        callbackScheme: "minimax-hub",
      });
      expect(actions.completeProviderOAuth).toHaveBeenCalledWith(
        "hilo-hub",
        "browser-flow",
        "hilo-primary",
        "minimax-hub://auth-callback?accessToken=hub-access-token",
      );
    });
  });

  it("explicitly reuses a plugin Provider token from its declared local app source", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked((actions as any).listPluginProviders).mockResolvedValue([
      {
        pluginId: "hilo-hub-media",
        pluginVersion: "1.1.0",
        schemaHash: `sha256:${"e".repeat(64)}`,
        id: "hilo-hub",
        name: "MiniMax Hilo Hub",
        description: "Hub OAuth media provider",
        upstreamId: "hilo-hub",
        apiShape: "hilo-hub",
        executorExportId: "hilo-hub-execute",
        auth: {
          methods: [
            {
              id: "reuse-local-login",
              label: "Reuse MiniMax Hub login",
              import: {
                format: "electron-store-aes-256-gcm-v2",
                appDataSubdirectory: "@hilo/MiniMax Hub Global",
                configFile: "hub-config-global.json",
                keyFile: ".token-key",
                tokenPath: ["tokens", "accessToken"],
                storeAs: "accessToken",
              },
            },
          ],
        },
      },
    ]);
    vi.mocked(actions.listProviderOAuth).mockResolvedValue([]);
    vi.mocked(actions.importLocalProviderToken).mockResolvedValue({
      providerId: "hilo-hub",
      accountId: "hilo-primary",
      accountLabel: "Primary Hilo",
      status: "authorized",
      hasAccessToken: true,
      importedFrom: "MiniMax Hub Global",
    });
    vi.mocked(actions.listModelProviders).mockResolvedValue([
      {
        id: "hilo-primary",
        label: "Primary Hilo",
        providerId: "hilo-hub",
        upstreamId: "hilo-hub",
        apiShape: "hilo-hub",
        enabled: true,
        availableOAuth: ["hilo-hub"],
      },
    ]);
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "hilo-primary",
              label: "Primary Hilo",
              providerId: "hilo-hub",
              upstreamId: "hilo-hub",
              apiShape: "hilo-hub",
              enabled: true,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open MiniMax Hilo Hub BYOK settings",
      }),
    );
    const accounts = screen.getByRole("list", {
      name: "MiniMax Hilo Hub prioritized accounts",
    });
    const accountRow = within(accounts)
      .getByText("Primary Hilo")
      .closest("li") as HTMLElement;
    fireEvent.click(within(accountRow).getByText("Primary Hilo"));
    fireEvent.click(
      within(accountRow).getByRole("button", {
        name: "Reuse MiniMax Hub login",
      }),
    );

    await waitFor(() => {
      expect(actions.importLocalProviderToken).toHaveBeenCalledWith(
        "hilo-hub",
        "hilo-primary",
        "Primary Hilo",
      );
      expect(
        within(accountRow).getAllByText("Connected: Primary Hilo").length,
      ).toBeGreaterThan(0);
    });
  });

  it("runs a deterministic mock provider test from the provider config editor", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.testModelProvider).mockImplementation(
      async ({ modelId }) => ({
        ok: true,
        providerId: "mock",
        upstreamId: "mock",
        modelId,
        provider: modelId === "mock-text-model" ? "mock" : "fal-mock",
        ...(modelId === "mock-text-model"
          ? {}
          : { requestId: "fal-mock-provider-test" }),
        modelEndpoint:
          modelId === "mock-text-model"
            ? "mock/text-completion"
            : modelId === "mock-image-model"
              ? "fal-ai/mock-image"
              : "fal-ai/nano-banana-2",
        input:
          modelId === "mock-text-model"
            ? {
                shape: "text",
                model: "mock-text-model",
                prompt: "Provider test for Mock Text Model",
              }
            : {
                shape: "image",
                model: modelId,
                prompt: `Provider test for ${modelId === "mock-image-model" ? "Mock Image Model" : "Nano Banana 2"}`,
                aspectRatio: "16:9",
              },
        output:
          modelId === "mock-text-model"
            ? {
                shape: "text",
                provider: "mock",
                endpoint: "mock/text-completion",
                text: "Generated text (mock-text-model)\n\nProvider test for Mock Text Model",
              }
            : {
                shape: "image",
                provider: "fal-mock",
                endpoint:
                  modelId === "mock-image-model"
                    ? "fal-ai/mock-image"
                    : "fal-ai/nano-banana-2",
                requestId: "fal-mock-provider-test",
                url: "http://local-provider-test/api/mock-fal/files/fal-mock-provider-test.png",
                contentType: "image/png",
                width: 1024,
                height: 576,
              },
        message: `Mock provider ran ${modelId === "mock-text-model" ? "Mock Text Model" : modelId === "mock-image-model" ? "Mock Image Model" : "Nano Banana 2"} through ${modelId === "mock-text-model" ? "mock/text-completion" : modelId === "mock-image-model" ? "fal-ai/mock-image" : "fal-ai/nano-banana-2"}.`,
      }),
    );

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "mock-primary",
              label: "Mock primary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 10,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Mock Provider BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Mock Provider prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Mock primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Mock primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Mock primary Mock Provider API key",
    });
    const modelToTestSelect = within(editor).getByRole("combobox", {
      name: /Choose test model/i,
    });
    expect(modelToTestSelect).toBeTruthy();
    expect(modelToTestSelect.className).toContain("clash-select-trigger");
    expect(modelToTestSelect.className).not.toContain(
      "clash-settings-test-model-picker",
    );
    fireEvent.click(modelToTestSelect);
    expect(modelToTestSelect.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("combobox", { name: "Search test models" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Mock Image Model/ }));
    fireEvent.click(
      within(editor).getByRole("button", { name: "Run provider test" }),
    );

    await waitFor(() => {
      expect(actions.testModelProvider).toHaveBeenCalledWith({
        provider: expect.objectContaining({
          id: "mock-primary",
          providerId: "mock",
          upstreamId: "mock",
        }),
        modelId: "mock-image-model",
        live: true,
      });
    });
    expect(
      await within(editor).findByText(
        "Mock provider ran Mock Image Model through fal-ai/mock-image.",
      ),
    ).toBeTruthy();
    expect(within(editor).getByText("Input")).toBeTruthy();
    expect(within(editor).getByText("Output")).toBeTruthy();
    expect(
      within(editor).getByLabelText("Provider test input").textContent,
    ).toContain('"shape": "image"');
    expect(
      within(editor).getByLabelText("Provider test input").textContent,
    ).toContain('"aspectRatio": "16:9"');
    expect(
      within(editor).getByLabelText("Provider test output").textContent,
    ).toContain(
      '"url": "http://local-provider-test/api/mock-fal/files/fal-mock-provider-test.png"',
    );

    fireEvent.click(
      within(editor).getByRole("combobox", { name: /Choose test model/i }),
    );
    expect(
      screen.getByRole("combobox", { name: "Search test models" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Mock Text Model/ }));
    fireEvent.click(
      within(editor).getByRole("button", { name: "Run provider test" }),
    );

    expect(
      await within(editor).findByText(
        "Mock provider ran Mock Text Model through mock/text-completion.",
      ),
    ).toBeTruthy();
    expect(
      within(editor).getByLabelText("Provider test input").textContent,
    ).toContain('"shape": "text"');
    expect(
      within(editor).getByLabelText("Provider test output").textContent,
    ).toContain(
      '"text": "Generated text (mock-text-model)\\n\\nProvider test for Mock Text Model"',
    );
    expect(
      within(editor).getByLabelText("Provider test output").textContent,
    ).not.toContain('"url":');
  });

  it("scopes provider test model choices to the provider config model allowlist", async () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "mock-primary",
              label: "Mock primary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 10,
              supportedModelIds: ["gpt-image-2"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Mock Provider BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Mock Provider prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Mock primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Mock primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Mock primary Mock Provider API key",
    });
    expect(
      within(editor).getByRole("combobox", { name: /Choose test model/i })
        .textContent,
    ).toContain("GPT Image 2");

    fireEvent.click(
      within(editor).getByRole("combobox", { name: /Choose test model/i }),
    );

    expect(
      screen.getByRole("combobox", { name: "Search test models" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: /GPT Image 2/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Nano Banana 2/ })).toBeNull();
  });

  it("filters provider test model choices from a searchable picker", async () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "mock-primary",
              label: "Mock primary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 10,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Mock Provider BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Mock Provider prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Mock primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Mock primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Mock primary Mock Provider API key",
    });
    fireEvent.click(
      within(editor).getByRole("combobox", { name: /Choose test model/i }),
    );

    const search = screen.getByRole("combobox", { name: "Search test models" });
    fireEvent.change(search, { target: { value: "text" } });

    expect(
      screen.queryByRole("option", { name: /Mock Image Model/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Mock Text Model/ }));

    expect(
      within(editor).getByRole("combobox", { name: /Choose test model/i })
        .textContent,
    ).toContain("Mock Text Model");
  });

  it("shows provider route details in the provider test model picker", async () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "mock-primary",
              label: "Mock primary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 10,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Mock Provider BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Mock Provider prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Mock primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Mock primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Mock primary Mock Provider API key",
    });
    fireEvent.click(
      within(editor).getByRole("combobox", { name: /Choose test model/i }),
    );

    const imageOption = screen.getByRole("option", {
      name: /Mock Image Model/,
    });
    expect(within(imageOption).getByText("image")).toBeTruthy();
    expect(imageOption.textContent).toContain("fal-ai/mock-image");
    expect(imageOption.textContent).toContain("fal");

    const search = screen.getByRole("combobox", { name: "Search test models" });
    fireEvent.change(search, { target: { value: "fal-ai/mock-image" } });

    expect(
      screen.getByRole("option", { name: /Mock Image Model/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: /Mock Text Model/ }),
    ).toBeNull();
  });

  it("selects a provider test model from the keyboard", async () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "mock-primary",
              label: "Mock primary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 10,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Mock Provider BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Mock Provider prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Mock primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Mock primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Mock primary Mock Provider API key",
    });
    const modelPicker = within(editor).getByRole("combobox", {
      name: /Choose test model/i,
    });
    fireEvent.click(modelPicker);
    const search = screen.getByRole("combobox", {
      name: "Search test models",
    });
    expect(search).toBe(document.activeElement);

    fireEvent.change(search, { target: { value: "text" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyUp(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.keyUp(search, { key: "Enter" });

    await waitFor(() =>
      expect(modelPicker.textContent).toContain("Mock Text Model"),
    );
  });

  it("runs a saved live provider configuration check from the provider config editor", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.testModelProvider).mockResolvedValue({
      ok: true,
      providerId: "replicate",
      upstreamId: "replicate",
      modelId: "nano-banana-2",
      message: "Replicate configuration is ready for Nano Banana 2.",
    });

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              label: "Replicate primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 10,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Replicate prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Replicate primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Replicate primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Replicate primary Replicate API key",
    });
    expect(
      within(editor).getByRole("combobox", { name: /Choose test model/i }),
    ).toBeTruthy();
    fireEvent.click(
      within(editor).getByRole("button", { name: "Run provider test" }),
    );

    await waitFor(() => {
      expect(actions.testModelProvider).toHaveBeenCalledWith({
        provider: expect.objectContaining({
          id: "replicate-primary",
          providerId: "replicate",
          upstreamId: "replicate",
        }),
        modelId: "nano-banana-2",
        live: true,
      });
    });
    expect(
      await within(editor).findByText(
        "Replicate configuration is ready for Nano Banana 2.",
      ),
    ).toBeTruthy();
  });

  it("does not run provider tests against stale saved data when the editor has unsaved changes", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.testModelProvider).mockResolvedValue({
      ok: true,
      providerId: "replicate",
      upstreamId: "replicate",
      modelId: "nano-banana-2",
      message: "Replicate configuration is ready for Nano Banana 2.",
    });

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              label: "Replicate primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 10,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Replicate prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Replicate primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Replicate primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Replicate primary Replicate API key",
    });
    const testButton = within(editor).getByRole("button", {
      name: "Run provider test",
    });
    expect(testButton.hasAttribute("disabled")).toBe(false);

    fireEvent.change(within(editor).getByLabelText("Replicate key name"), {
      target: { value: "Unsaved key name" },
    });

    expect(within(editor).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(testButton.hasAttribute("disabled")).toBe(true);

    vi.mocked(actions.testModelProvider).mockClear();
    fireEvent.click(testButton);
    expect(actions.testModelProvider).not.toHaveBeenCalled();
  });

  it("clears provider test results when the provider editor changes", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.testModelProvider).mockResolvedValue({
      ok: true,
      providerId: "replicate",
      upstreamId: "replicate",
      modelId: "nano-banana-2",
      message: "Replicate configuration is ready for Nano Banana 2.",
    });

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "replicate-primary",
              label: "Replicate primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 10,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Replicate BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Replicate prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Replicate primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Replicate primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Replicate primary Replicate API key",
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Run provider test" }),
    );

    expect(
      await within(editor).findByText(
        "Replicate configuration is ready for Nano Banana 2.",
      ),
    ).toBeTruthy();

    fireEvent.change(within(editor).getByLabelText("Replicate key name"), {
      target: { value: "Unsaved key name" },
    });

    expect(within(editor).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(
      within(editor).queryByText(
        "Replicate configuration is ready for Nano Banana 2.",
      ),
    ).toBeNull();
  });

  it("saves a provider account model allowlist from the config editor", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "mock-primary",
              label: "Mock primary",
              providerId: "mock",
              upstreamId: "mock",
              enabled: true,
              priority: 10,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Mock Provider BYOK settings" }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Mock Provider prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Mock primary")
      .closest("li") as HTMLElement;
    fireEvent.click(within(providerConfig).getByText("Mock primary"));

    const editor = within(providerConfig).getByRole("group", {
      name: "Mock primary Mock Provider API key",
    });
    expect(within(editor).getByText("Model access")).toBeTruthy();
    fireEvent.click(
      within(editor).getByRole("combobox", { name: "Model access" }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Specific models/ }));
    fireEvent.click(
      within(editor).getByRole("combobox", { name: "Add supported model" }),
    );
    expect(
      screen.queryByRole("menu", { name: "Add supported model" }),
    ).toBeNull();
    const search = screen.getByRole("combobox", {
      name: "Search supported models",
    });
    fireEvent.change(search, { target: { value: "gpt image" } });
    expect(screen.queryByRole("option", { name: /Nano Banana 2/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /GPT Image 2/ }));
    expect(
      within(editor).getByRole("button", { name: "Remove GPT Image 2" }),
    ).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: "mock-primary",
            providerId: "mock",
            upstreamId: "mock",
            supportedModelIds: ["gpt-image-2"],
          }),
        ]),
      );
    });
  });

  it("deduplicates provider model choices that have multiple route implementations", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "google-primary",
              label: "Google AI Studio primary",
              providerId: "official",
              upstreamId: "google-ai-studio",
              region: "global",
              enabled: true,
              priority: 10,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Google AI Studio BYOK settings",
      }),
    );
    const providerConfigs = screen.getByRole("list", {
      name: "Google AI Studio prioritized keys",
    });
    const providerConfig = within(providerConfigs)
      .getByText("Google AI Studio primary")
      .closest("li") as HTMLElement;
    fireEvent.click(
      within(providerConfig).getByText("Google AI Studio primary"),
    );

    const editor = screen.getByRole("group", {
      name: "Google AI Studio primary Google AI Studio API key",
    });
    fireEvent.click(
      within(editor).getByRole("combobox", { name: "Model access" }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Specific models/ }));
    fireEvent.click(
      within(editor).getByRole("combobox", { name: "Add supported model" }),
    );
    expect(
      screen.queryByRole("menu", { name: "Add supported model" }),
    ).toBeNull();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search supported models" }),
      {
        target: { value: "Gemini 3.1 Flash Image" },
      },
    );

    const exactNanoBananaOptions = screen
      .getAllByRole("option")
      .filter((option) => within(option).queryByText("Nano Banana 2"));
    expect(exactNanoBananaOptions).toHaveLength(1);
  });

  it("configures multiple OpenAI provider keys inline", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open OpenAI BYOK settings" }),
    );
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Add prioritized OpenAI key" }),
    );
    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: "sk-second-openai" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI base URL"), {
      target: { value: "https://openai-compatible.example/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: "official",
            upstreamId: "openai",
            region: "global",
            credentials: {
              apiKey: "sk-second-openai",
              baseUrl: "https://openai-compatible.example/v1",
            },
            configuredCredentials: ["apiKey", "baseUrl"],
          }),
        ]),
      );
    });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("creates a stable account id for every new provider key", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockClear();
    vi.mocked(actions.listModelCatalog).mockClear();
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open OpenAI BYOK settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add prioritized OpenAI key" }),
    );
    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: "sk-first-openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledTimes(1);
    });
    const firstSave =
      vi.mocked(actions.updateModelProviders).mock.calls[0]?.[0] ?? [];
    expect(firstSave).toHaveLength(1);
    expect(firstSave[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^official-openai-global-/),
        providerId: "official",
        upstreamId: "openai",
        region: "global",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Add prioritized OpenAI key" }),
    );
    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: "sk-second-openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledTimes(2);
    });
    const secondSave =
      vi.mocked(actions.updateModelProviders).mock.calls[1]?.[0] ?? [];
    expect(secondSave).toHaveLength(2);
    expect(new Set(secondSave.map((provider) => provider.id)).size).toBe(2);
    expect(secondSave.every((provider) => !!provider.id)).toBe(true);
  });

  it("configures all required Kling credential fields inline", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Kling/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add prioritized Kling key" }),
    );
    fireEvent.change(screen.getByLabelText("Kling access key"), {
      target: { value: "kling-access" },
    });
    fireEvent.change(screen.getByLabelText("Kling secret key"), {
      target: { value: "kling-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: "kling",
            upstreamId: "kling",
            credentials: {
              accessKey: "kling-access",
              secretKey: "kling-secret",
            },
            configuredCredentials: ["accessKey", "secretKey"],
          }),
        ]),
      );
    });
  });

  it("treats a Google Cloud service account as a configured account of the unified Google provider", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              id: "openai-primary",
              providerId: "official",
              upstreamId: "google-ai-studio",
              region: "global",
              enabled: true,
              configuredCredentials: ["serviceAccountKey"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    const configuredProviders = screen.getByRole("list", {
      name: "Configured BYOK providers",
    });
    expect(
      within(configuredProviders).getByText("Google AI Studio"),
    ).toBeTruthy();
    expect(within(configuredProviders).getByText("1 key")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Open Google AI Studio BYOK settings",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Open Google Cloud Agent Platform BYOK settings",
      }),
    ).toBeNull();
  });

  it("hides legacy provider rows that do not map to a configurable provider", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[
            {
              providerId: "official",
              region: "global",
              enabled: true,
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("official/global")).toBeNull();
    expect(screen.getByText("OpenAI")).toBeTruthy();
  });

  it("keeps model discovery controls sticky inside the settings scroller", () => {
    const { container } = render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
        />
      </MemoryRouter>,
    );

    const stickyControls = container.querySelector(
      '[data-slot="models-sticky-controls"]',
    );
    const heading = screen.getByRole("heading", { name: "Models" });
    const search = screen.getByRole("searchbox", { name: "Search models" });
    const toolbar = stickyControls?.querySelector(
      '[data-slot="search-filter-toolbar"]',
    );

    expect(stickyControls).toHaveClass("sticky", "top-0", "z-20");
    expect(stickyControls?.className).toContain("py-4");
    expect(stickyControls?.className).not.toContain("pt-2");
    expect(toolbar?.className).not.toContain("pb-4");
    expect(stickyControls).toContainElement(search);
    expect(stickyControls).not.toContainElement(heading);
    expect(
      (heading.compareDocumentPosition(stickyControls as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows models separately from provider forms", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelCatalog={[
            {
              model: {
                id: "nano-banana-2",
                aliases: [],
                name: "Nano Banana 2",
                provider: "fal",
                kind: "image",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "16:9",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: null,
              routes: [],
              candidateProviders: ["official", "fal", "replicate"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
            {
              model: {
                id: "gpt-5.4",
                aliases: [],
                name: "GPT-5.4",
                provider: "OpenAI",
                kind: "text",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "1:1",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: {
                modelCode: "gpt-5.4",
                kind: "text",
                providerId: "official",
                upstreamId: "openai",
                upstreamModel: "gpt-5.4",
                apiShape: "openai-compatible",
                priority: 10,
              },
              routes: [],
              candidateProviders: ["official"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Models" })).toBeTruthy();
    expect(screen.getByText("Nano Banana 2")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Enabled" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Unavailable" })).toBeTruthy();
    const modelToolbar = screen
      .getByRole("searchbox", { name: "Search models" })
      .closest('[data-slot="search-filter-toolbar"]');
    expect(modelToolbar).toBeTruthy();
    const modelSearchField = modelToolbar?.querySelector(
      '[data-slot="search-field"]',
    );
    expect(modelSearchField).toContainElement(
      within(modelToolbar as HTMLElement).getByRole("button", {
        name: "Filter",
      }),
    );
    expect(
      modelToolbar?.querySelector('[data-slot="search-filter-controls"]'),
    ).toBeNull();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByText("Selected models")).toBeNull();
    expect(screen.queryByText(/Provider (?:not configured|ready):/)).toBeNull();
    expect(screen.queryByText("Provider order")).toBeNull();
    expect(document.querySelector('[data-model-logo="openai"]')).toBeTruthy();
    expect(document.querySelector('[data-model-logo="google"]')).toBeTruthy();
    expect(
      document.querySelector('[data-model-provider-logo="fal"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-model-provider-logo="google"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-model-provider-logo="replicate"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-model-provider-logo="openai"]'),
    ).toBeTruthy();
  });

  it("groups speech catalog entries by the output kind declared on the model card", () => {
    const catalogEntry = (
      id: string,
      name: string,
      kind: "text" | "audio",
      promptModalities: Array<"text" | "audio">,
    ) => ({
      model: {
        id,
        aliases: [],
        name,
        provider: "Example",
        kind,
        parameters: [],
        defaultParams: {},
        defaultAspectRatio: "1:1",
        input: {
          requiresPrompt: promptModalities.includes("text"),
          inputMode: {},
          promptModalities,
        },
      },
      tier: "available",
      selectedRoute: null,
      routes: [],
      candidateProviders: ["official"],
      unavailableParameterIds: [],
      missingCredentials: [],
      missingOAuth: [],
    });

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelCatalog={
            [
              catalogEntry("sensevoice-small-asr", "SenseVoice Small", "text", [
                "audio",
              ]),
              catalogEntry("piper-huayan-tts", "Piper Huayan", "audio", [
                "text",
              ]),
              catalogEntry("suno-v5.5", "Suno V5.5", "audio", [
                "text",
                "audio",
              ]),
            ] as any
          }
        />
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Type" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Text" })).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Audio" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: "ASR" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "TTS" })).toBeNull();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Music" }),
    ).toBeNull();
  });

  it("opens a model card second-level page for description, prompt guidance, and provider order", () => {
    render(
      <MemoryRouter initialEntries={["/settings?section=models&model=gpt-5.4"]}>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              id: "openai-primary",
              label: "OpenAI primary",
              providerId: "official",
              upstreamId: "openai",
              region: "global",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "openai-secondary",
              label: "OpenAI fallback",
              providerId: "official",
              upstreamId: "openai",
              region: "global",
              enabled: true,
              priority: 20,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[
            {
              model: {
                id: "gpt-5.4",
                aliases: [],
                name: "GPT-5.4 Text",
                provider: "OpenAI",
                kind: "text",
                description: "General-purpose text generation.",
                promptGuidance: "Put the desired deliverable first.",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "1:1",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: {
                modelCode: "gpt-5.4",
                kind: "text",
                providerId: "official",
                upstreamId: "openai",
                region: "global",
                upstreamModel: "gpt-5.4",
                apiShape: "openai-compatible",
                priority: 10,
              },
              routes: [
                {
                  modelCode: "gpt-5.4",
                  kind: "text",
                  providerId: "official",
                  upstreamId: "openai",
                  region: "global",
                  upstreamModel: "gpt-5.4",
                  apiShape: "openai-compatible",
                  priority: 10,
                },
              ],
              candidateProviders: ["official"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "GPT-5.4 Text" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Models" }).getAttribute("href"),
    ).toBe("/settings?section=models");
    const description = screen.getByLabelText(
      "Model description",
    ) as HTMLTextAreaElement;
    const guidance = screen.getByLabelText(
      "Prompt guidance",
    ) as HTMLTextAreaElement;
    expect(description.value).toBe("General-purpose text generation.");
    expect(guidance.value).toBe("Put the desired deliverable first.");
    expect(description.getAttribute("data-slot")).toBe("textarea");
    expect(description.getAttribute("data-context")).toBe("settings");
    expect(
      description.closest('[data-slot="settings-field-group"]'),
    ).toBeTruthy();
    expect(description.closest('[data-slot="settings-panel"]')).toBeNull();

    const providerOrder = screen.getByRole("list", {
      name: "GPT-5.4 Text provider order",
    });
    expect(providerOrder.getAttribute("data-slot")).toBe("settings-collection");
    expect(
      providerOrder.querySelector('[data-slot="settings-row"]'),
    ).toBeTruthy();

    const save = screen.getByRole("button", { name: "Save model card" });
    expect(save.getAttribute("data-variant")).toBe("primary");
    expect(save.closest('[data-slot="settings-actions"]')).toBeTruthy();
    expect(save.closest('[data-slot="settings-section"]')?.className).toContain(
      "pb-8",
    );
  });

  it("labels a text-to-speech model correctly and separates configured from unconfigured supported providers", () => {
    render(
      <MemoryRouter
        initialEntries={["/settings?section=models&model=minimax-tts"]}
      >
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              id: "minimax-primary",
              providerId: "minimax",
              upstreamId: "minimax",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[
            {
              model: {
                id: "minimax-tts",
                aliases: [],
                name: "MiniMax TTS",
                provider: "MiniMax",
                kind: "audio",
                description: "High-quality Chinese and English text-to-speech.",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "1:1",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: {
                modelCode: "minimax-tts",
                kind: "audio",
                providerId: "minimax",
                upstreamId: "minimax",
                upstreamModel: "speech-02-hd",
                apiShape: "minimax",
                priority: 10,
              },
              routes: [
                {
                  modelCode: "minimax-tts",
                  kind: "audio",
                  providerId: "minimax",
                  upstreamId: "minimax",
                  upstreamModel: "speech-02-hd",
                  apiShape: "minimax",
                  priority: 10,
                },
                {
                  modelCode: "minimax-tts",
                  kind: "audio",
                  providerId: "fal",
                  upstreamId: "fal",
                  upstreamModel: "fal-ai/minimax/speech-02-hd",
                  apiShape: "fal",
                  priority: 20,
                },
              ],
              candidateProviders: ["minimax", "fal"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Audio model")).toBeTruthy();
    const providers = screen.getByRole("list", {
      name: "MiniMax TTS supported providers",
    });
    expect(
      within(providers)
        .getByRole("link", { name: "Configure MiniMax" })
        .getAttribute("href"),
    ).toContain("section=providers");
    expect(
      within(providers)
        .getByRole("link", { name: "Configure fal.ai" })
        .getAttribute("href"),
    ).toContain("section=providers");
  });

  it("offers real custom provider and custom model entry points", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "Add custom provider" }),
    ).toBeTruthy();
  });

  it("creates an OpenAI-compatible custom provider with a real endpoint and key", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="providers"
          embedded
          initialModelProviders={[]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Add custom provider" }),
    );
    fireEvent.change(screen.getByLabelText("Provider name"), {
      target: { value: "Editorial proxy" },
    });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://proxy.example/v1" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-custom" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save custom provider" }),
    );

    await waitFor(() =>
      expect(actions.updateModelProviders).toHaveBeenCalled(),
    );
    expect(
      vi.mocked(actions.updateModelProviders).mock.calls.at(-1)?.[0],
    ).toEqual([
      expect.objectContaining({
        providerId: "custom",
        upstreamId: "openai",
        apiShape: "openai-compatible",
        label: "Editorial proxy",
        credentials: {
          apiKey: "sk-custom",
          baseUrl: "https://proxy.example/v1",
        },
      }),
    ]);
  });

  it("creates a custom text model and mounts it to compatible provider accounts", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.saveModelCardConfig).mockResolvedValue({
      modelId: "editorial-pro",
      custom: true,
      name: "Editorial Pro",
      kind: "text",
      providerBindings: [
        {
          providerAccountId: "custom-openai-account",
          upstreamModel: "editorial/pro-v2",
        },
      ],
    });
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/settings?section=models&model=new"]}>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              id: "custom-openai-account",
              providerId: "custom",
              upstreamId: "openai",
              apiShape: "openai-compatible",
              label: "Editorial proxy",
              enabled: true,
              configuredCredentials: ["apiKey", "baseUrl"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "editorial-pro" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "Editorial Pro" },
    });
    // The binding toggle is the shared Switch primitive, so its accessible role
    // is "switch" -- a raw checkbox here would be the project-rule violation.
    fireEvent.click(
      screen.getByRole("switch", { name: "Use Editorial proxy" }),
    );
    fireEvent.change(screen.getByLabelText("Editorial proxy upstream model"), {
      target: { value: "editorial/pro-v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save text model" }));

    await waitFor(() =>
      expect(actions.saveModelCardConfig).toHaveBeenCalledWith(
        "editorial-pro",
        expect.objectContaining({
          custom: true,
          name: "Editorial Pro",
          kind: "text",
          providerBindings: [
            {
              providerAccountId: "custom-openai-account",
              upstreamModel: "editorial/pro-v2",
            },
          ],
        }),
      ),
    );
  });

  it("filters the Models page to one provider from the supported-models link", () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/settings?section=models&provider=replicate%3Areplicate%3A",
        ]}
      >
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
            {
              providerId: "official",
              upstreamId: "openai",
              region: "global",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[
            {
              model: {
                id: "nano-banana-2",
                aliases: [],
                name: "Nano Banana 2",
                provider: "Replicate",
                kind: "image",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "16:9",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: null,
              routes: [],
              candidateProviders: ["replicate"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
            {
              model: {
                id: "claude-sonnet-4",
                aliases: [],
                name: "Claude Sonnet 4",
                provider: "Anthropic",
                kind: "text",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "16:9",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: null,
              routes: [],
              candidateProviders: ["official"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Models supported by Replicate")).toBeTruthy();
    expect(screen.getByText("Nano Banana 2")).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Show all" }).getAttribute("href"),
    ).toBe("/settings?section=models");
  });

  it("uses the unified search control for model filter chips", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelCatalog={[
            {
              model: {
                id: "nano-banana-2",
                aliases: [],
                name: "Nano Banana 2",
                provider: "fal",
                kind: "image",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "16:9",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: null,
              routes: [],
              candidateProviders: ["fal"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("menuitem", { name: "Type" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Availability" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Provider" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Input" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Origin" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Type" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Image" }));
    expect(screen.getByText("Type · Image")).toBeTruthy();
  });

  it("applies every selected model filter as an independent AND predicate", () => {
    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelCatalog={
            [
              {
                model: {
                  id: "nano-banana-2",
                  aliases: [],
                  name: "Nano Banana 2",
                  provider: "Google",
                  kind: "image",
                  parameters: [],
                  defaultParams: {},
                  defaultAspectRatio: "1:1",
                  input: {
                    requiresPrompt: true,
                    inputMode: {},
                    promptModalities: ["text"],
                  },
                },
                tier: "all",
                selectedRoute: null,
                routes: [],
                candidateProviders: ["official"],
                unavailableParameterIds: [],
                missingCredentials: [],
                missingOAuth: [],
              },
              {
                model: {
                  id: "claude-sonnet-4",
                  aliases: [],
                  name: "Claude Sonnet 4",
                  provider: "Anthropic",
                  kind: "text",
                  parameters: [],
                  defaultParams: {},
                  defaultAspectRatio: "1:1",
                  input: {
                    requiresPrompt: true,
                    inputMode: { images: { max: 20 } },
                    promptModalities: ["text", "image"],
                  },
                },
                tier: "available",
                selectedRoute: {
                  modelCode: "claude-sonnet-4",
                  kind: "text",
                  providerId: "official",
                  upstreamId: "anthropic",
                  upstreamModel: "claude-sonnet-4",
                  apiShape: "anthropic-compatible",
                  priority: 10,
                },
                routes: [],
                candidateProviders: ["official"],
                unavailableParameterIds: [],
                missingCredentials: [],
                missingOAuth: [],
              },
              {
                model: {
                  id: "custom-audio-reader",
                  aliases: [],
                  name: "Custom Audio Reader",
                  provider: "Custom",
                  custom: true,
                  kind: "text",
                  parameters: [],
                  defaultParams: {},
                  defaultAspectRatio: "1:1",
                  input: {
                    requiresPrompt: true,
                    inputMode: { audios: { max: 1 } },
                    promptModalities: ["text", "audio"],
                  },
                },
                tier: "available",
                selectedRoute: {
                  modelCode: "custom-audio-reader",
                  kind: "text",
                  providerId: "custom",
                  upstreamId: "reader-api",
                  upstreamModel: "reader-v1",
                  apiShape: "openai-compatible",
                  priority: 10,
                },
                routes: [],
                candidateProviders: ["custom"],
                unavailableParameterIds: [],
                missingCredentials: [],
                missingOAuth: [],
              },
            ] as any
          }
        />
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Input" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Can use audio" }),
    );
    expect(screen.getByText("Custom Audio Reader")).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4")).toBeNull();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Can use images" }),
    );
    expect(screen.queryByText("Custom Audio Reader")).toBeNull();
    expect(screen.getByText("Input · Can use audio")).toBeTruthy();
    expect(screen.getByText("Input · Can use images")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Input filter: Can use images",
      }),
    );
    expect(screen.getByText("Custom Audio Reader")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), {
      target: { value: "reader" },
    });
    expect(screen.getByText("Custom Audio Reader")).toBeTruthy();
  });

  it("lets a model reorder its supported provider priority", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.updateModelProviders).mockImplementation(
      async (providers) => providers,
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter
        initialEntries={["/settings?section=models&model=gpt-image-2"]}
      >
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              id: "openai-primary",
              providerId: "official",
              upstreamId: "openai",
              region: "global",
              enabled: true,
              priority: 30,
              weight: 10,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "replicate-primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 50,
              weight: 1,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[
            {
              model: {
                id: "gpt-image-2",
                aliases: [],
                name: "GPT Image 2",
                provider: "OpenAI",
                kind: "image",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "1:1",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: {
                modelCode: "gpt-image-2",
                kind: "image",
                providerId: "official",
                upstreamId: "openai",
                region: "global",
                upstreamModel: "gpt-image-2",
                apiShape: "openai-images",
                priority: 10,
              },
              routes: [
                {
                  modelCode: "gpt-image-2",
                  kind: "image",
                  providerId: "official",
                  upstreamId: "openai",
                  region: "global",
                  upstreamModel: "gpt-image-2",
                  apiShape: "openai-images",
                  priority: 10,
                },
                {
                  modelCode: "gpt-image-2",
                  kind: "image",
                  providerId: "replicate",
                  upstreamId: "replicate",
                  upstreamModel: "openai/gpt-image-2",
                  apiShape: "replicate",
                  priority: 25,
                },
              ],
              candidateProviders: ["official", "replicate"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    const providerOrder = screen.getByRole("list", {
      name: "GPT Image 2 provider order",
    });
    const rows = within(providerOrder).getAllByRole("listitem");
    expect(within(rows[0]).getByText("OpenAI")).toBeTruthy();
    expect(within(rows[1]).getByText("Replicate")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move Replicate up" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: "replicate",
            upstreamId: "replicate",
            priority: 50,
            weight: 1,
            modelPriorities: { "gpt-image-2": 10 },
          }),
          expect.objectContaining({
            providerId: "official",
            upstreamId: "openai",
            region: "global",
            priority: 30,
            weight: 10,
            modelPriorities: { "gpt-image-2": 20 },
          }),
        ]),
      );
    });
  });

  it("omits provider configs filtered out of a model from that model provider order", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter
        initialEntries={["/settings?section=models&model=gpt-image-2"]}
      >
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              id: "openai-primary",
              providerId: "official",
              upstreamId: "openai",
              region: "global",
              enabled: true,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "replicate-primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
              supportedModelIds: ["nano-banana-2"],
            },
          ]}
        />
      </MemoryRouter>,
    );

    const providerOrder = screen.getByRole("list", {
      name: "GPT Image 2 provider order",
    });
    expect(within(providerOrder).getByText("OpenAI")).toBeTruthy();
    expect(within(providerOrder).queryByText("Replicate")).toBeNull();
  });

  it("builds fallback model catalog from every provider account instead of folded provider rows", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              id: "replicate-nano",
              label: "Nano key",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
              supportedModelIds: ["nano-banana-2"],
            },
            {
              id: "replicate-gpt-image",
              label: "GPT Image key",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              configuredCredentials: ["apiKey"],
              supportedModelIds: ["gpt-image-2"],
            },
          ]}
          initialModelCatalog={[]}
        />
      </MemoryRouter>,
    );

    const gptImageCard = document.getElementById("model-card-gpt-image-2");
    expect(gptImageCard).toBeTruthy();
    expect(gptImageCard?.getAttribute("data-model-state")).toBe("enabled");
    expect(
      gptImageCard?.querySelector('[data-model-provider-logo="replicate"]'),
    ).toBeTruthy();
    expect(document.querySelector('[data-model-logo="flux"]')).toBeTruthy();
    expect(
      document.querySelector('[data-model-logo="bytedance"]'),
    ).toBeTruthy();
    expect(document.querySelector('[data-model-logo="recraft"]')).toBeTruthy();
    for (const modelCard of document.querySelectorAll('[id^="model-card-"]')) {
      expect(modelCard.querySelector("[data-model-logo]")).toBeTruthy();
    }
  });

  it("disables model provider ordering while provider settings are saving", async () => {
    const actions = await import("@clash/web-ui/lib/clientActions");
    let resolveSave!: (providers: any[]) => void;
    vi.mocked(actions.updateModelProviders).mockImplementation(
      (providers) =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    vi.mocked(actions.listModelCatalog).mockResolvedValue([]);

    render(
      <MemoryRouter
        initialEntries={["/settings?section=models&model=gpt-image-2"]}
      >
        <SettingsClient
          initialTokens={[]}
          initialVariables={[]}
          initialActions={[]}
          initialSkills={[]}
          activeSection="models"
          embedded
          initialModelProviders={[
            {
              id: "openai-primary",
              providerId: "official",
              upstreamId: "openai",
              region: "global",
              enabled: true,
              priority: 30,
              weight: 10,
              configuredCredentials: ["apiKey"],
            },
            {
              id: "replicate-primary",
              providerId: "replicate",
              upstreamId: "replicate",
              enabled: true,
              priority: 50,
              weight: 1,
              configuredCredentials: ["apiKey"],
            },
          ]}
          initialModelCatalog={[
            {
              model: {
                id: "gpt-image-2",
                aliases: [],
                name: "GPT Image 2",
                provider: "OpenAI",
                kind: "image",
                parameters: [],
                defaultParams: {},
                defaultAspectRatio: "1:1",
                input: {
                  requiresPrompt: true,
                  inputMode: {},
                  promptModalities: ["text"],
                },
              },
              tier: "available",
              selectedRoute: {
                modelCode: "gpt-image-2",
                kind: "image",
                providerId: "official",
                upstreamId: "openai",
                region: "global",
                upstreamModel: "gpt-image-2",
                apiShape: "openai-images",
                priority: 10,
              },
              routes: [
                {
                  modelCode: "gpt-image-2",
                  kind: "image",
                  providerId: "official",
                  upstreamId: "openai",
                  region: "global",
                  upstreamModel: "gpt-image-2",
                  apiShape: "openai-images",
                  priority: 10,
                },
                {
                  modelCode: "gpt-image-2",
                  kind: "image",
                  providerId: "replicate",
                  upstreamId: "replicate",
                  upstreamModel: "openai/gpt-image-2",
                  apiShape: "replicate",
                  priority: 25,
                },
              ],
              candidateProviders: ["official", "replicate"],
              unavailableParameterIds: [],
              missingCredentials: [],
              missingOAuth: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Replicate up" }));

    await waitFor(() => {
      expect(actions.updateModelProviders).toHaveBeenCalled();
    });

    const pendingProviderOrder = screen.getByRole("list", {
      name: "GPT Image 2 provider order",
    });
    expect(
      within(pendingProviderOrder)
        .getByRole("button", { name: "Move Replicate down" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(pendingProviderOrder)
        .getByRole("button", { name: "Move OpenAI up" })
        .hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      resolveSave([
        {
          id: "replicate-primary",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 50,
          weight: 1,
          configuredCredentials: ["apiKey"],
          modelPriorities: { "gpt-image-2": 10 },
        },
        {
          id: "openai-primary",
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          priority: 30,
          weight: 10,
          configuredCredentials: ["apiKey"],
          modelPriorities: { "gpt-image-2": 20 },
        },
      ]);
    });

    await waitFor(() => {
      const savedProviderOrder = screen.getByRole("list", {
        name: "GPT Image 2 provider order",
      });
      expect(
        within(savedProviderOrder)
          .getByRole("button", { name: "Move Replicate down" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        within(savedProviderOrder)
          .getByRole("button", { name: "Move OpenAI up" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
  });
});
