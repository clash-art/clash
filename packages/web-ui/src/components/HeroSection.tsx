import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ForwardedRef,
} from "react";
import { PuzzlePiece, X } from "@phosphor-icons/react";
import { Link, useNavigate } from "react-router";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ResolvedAsset } from "@clash/shared-types";
import {
  createProjectRecord,
  persistRuntimeRunPreferences,
  updateProjectName,
} from "@clash/web-ui/lib/clientActions";
import { useClashRuntime } from "@clash/web-ui/hooks/useClashRuntime";
import {
  admitPersonalGlobalAssetToProject,
  importProjectAssetFile,
  listPersonalGlobalAssets,
  listProjectAssets,
} from "@clash/web-ui/lib/hooks/useAsset";
import {
  applyRecentConfigPreferences,
  applyRecentModePreference,
  configValuesFromOptions,
  preferredRecentAgentId,
} from "@clash/web-ui/lib/recentRunPreferences";
import { ChatInput, type ChatInputHandle } from "./copilot/ChatInput";
import type { MentionableNode } from "./MilkdownEditor";
import {
  HarnessPermissionSelector,
  InlineSessionConfigControls,
  SessionConfigSelector,
  SessionPlanTag,
} from "./ChatbotCopilot";
import {
  findAcpSelectConfigOption,
  permissionModeOption,
  resolvePermissionModeForSession,
} from "../lib/acpSessionConfig";
import { buttonVariants } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { useDashboardComposer } from "./DashboardComposerContext";
import { buildDashboardComposerPrompt } from "../lib/dashboardComposerPrompt";
import { ScopedAssetPicker } from "./ScopedAssetPicker";
import {
  buildComposerAssetSections,
  type ScopedAssetOption,
} from "./scopedAssetPickerModel";
import { assetThumbnailImageUrl } from "../features/assets/media-url";

export interface HeroSectionHandle {
  focus: () => void;
}

function DashboardComposerRuntimeInner(
  _props: object,
  ref: ForwardedRef<HeroSectionHandle>,
) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    input: inputValue,
    setInput: setInputValue,
    references,
    addProjectReference,
    registerComposerFocus,
    clearAfterSubmit,
  } = useDashboardComposer();
  const [isPending, startTransition] = useTransition();
  const [sessionConfigOpen, setSessionConfigOpen] = useState(false);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const draftProjectIdRef = useRef<string | null>(null);
  const projectRequestRef = useRef<Promise<string | null> | null>(null);
  const assetRefreshSequenceRef = useRef(0);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetPickerBusy, setAssetPickerBusy] = useState(false);
  const [globalAssets, setGlobalAssets] = useState<ResolvedAsset[]>([]);
  const [projectAssets, setProjectAssets] = useState<ResolvedAsset[]>([]);
  const [admittedGlobalAssetIds, setAdmittedGlobalAssetIds] = useState<
    Set<string>
  >(() => new Set());
  const clashRt = useClashRuntime();
  const localRuntime = useMemo(
    () =>
      clashRt.runtimes.find((runtime) => runtime.id === "desktop-local") ??
      null,
    [clashRt.runtimes],
  );
  const selectedHarnessId =
    clashRt.selectedAgentId ??
    preferredRecentAgentId(
      localRuntime?.agents ?? [],
      localRuntime?.preferences?.agent_id,
    ) ??
    null;
  const selectedHarness = useMemo(
    () =>
      localRuntime?.agents.find((agent) => agent.id === selectedHarnessId) ??
      null,
    [localRuntime, selectedHarnessId],
  );
  const configOptions = useMemo(() => {
    if (
      clashRt.selectedAgentId === selectedHarnessId &&
      clashRt.sessionConfigOptions.length > 0
    ) {
      return clashRt.sessionConfigOptions;
    }
    return applyRecentConfigPreferences(
      selectedHarness?.config_options,
      selectedHarnessId
        ? localRuntime?.preferences?.config_by_agent[selectedHarnessId]
        : undefined,
    );
  }, [
    clashRt.selectedAgentId,
    clashRt.sessionConfigOptions,
    localRuntime?.preferences?.config_by_agent,
    selectedHarness?.config_options,
    selectedHarnessId,
  ]);
  const modelConfigOption = useMemo(
    () => findAcpSelectConfigOption(configOptions, "model"),
    [configOptions],
  );
  const modeConfigOption = useMemo(
    () => findAcpSelectConfigOption(configOptions, "mode"),
    [configOptions],
  );
  const sessionModes = useMemo(() => {
    if (clashRt.selectedAgentId === selectedHarnessId && clashRt.sessionModes) {
      return clashRt.sessionModes;
    }
    return applyRecentModePreference(
      selectedHarness?.session_modes,
      selectedHarnessId
        ? localRuntime?.preferences?.mode_by_agent[selectedHarnessId]
        : undefined,
    );
  }, [
    clashRt.selectedAgentId,
    clashRt.sessionModes,
    localRuntime?.preferences?.mode_by_agent,
    selectedHarness?.session_modes,
    selectedHarnessId,
  ]);
  const selectedPermissionModeId = useMemo(
    () =>
      resolvePermissionModeForSession(
        clashRt.selectedAgentId !== selectedHarnessId && selectedHarnessId
          ? localRuntime?.preferences?.mode_by_agent[selectedHarnessId]
          : undefined,
        sessionModes,
        modeConfigOption,
      ),
    [
      localRuntime?.preferences?.mode_by_agent,
      modeConfigOption,
      clashRt.selectedAgentId,
      selectedHarnessId,
      sessionModes,
    ],
  );
  const needsAgentSetup =
    clashRt.startupStatus === "ready" &&
    localRuntime?.status === "online" &&
    localRuntime.agents.length === 0;
  const runtimeReady =
    clashRt.startupStatus === "ready" &&
    localRuntime?.status === "online" &&
    localRuntime.agents.length > 0;

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        chatInputRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    const focus = () => chatInputRef.current?.focus();
    registerComposerFocus(focus);
    return () => {
      registerComposerFocus(null);
    };
  }, [registerComposerFocus]);

  useEffect(() => {
    if (!runtimeReady || !localRuntime || !selectedHarnessId) return;
    if (
      clashRt.selectedRuntimeId === localRuntime.id &&
      clashRt.selectedAgentId === selectedHarnessId &&
      clashRt.status === "draft"
    ) {
      return;
    }
    clashRt.startDraft(localRuntime.id, undefined, {
      agentId: selectedHarnessId,
      ...permissionModeOption(selectedPermissionModeId),
    });
  }, [
    clashRt.selectedAgentId,
    clashRt.selectedRuntimeId,
    clashRt.startDraft,
    clashRt.status,
    localRuntime,
    runtimeReady,
    selectedHarnessId,
    selectedPermissionModeId,
  ]);

  const handleSelectHarness = useCallback(
    (agentId: string) => {
      if (!localRuntime) return;
      const agent = localRuntime.agents.find(
        (candidate) => candidate.id === agentId,
      );
      const nextConfigOptions = applyRecentConfigPreferences(
        agent?.config_options,
        localRuntime.preferences?.config_by_agent[agentId],
      );
      const nextModeConfigOption = findAcpSelectConfigOption(
        nextConfigOptions,
        "mode",
      );
      const nextMode = resolvePermissionModeForSession(
        localRuntime.preferences?.mode_by_agent[agentId],
        applyRecentModePreference(
          agent?.session_modes,
          localRuntime.preferences?.mode_by_agent[agentId],
        ),
        nextModeConfigOption,
      );
      clashRt.startDraft(localRuntime.id, undefined, {
        agentId,
        ...permissionModeOption(nextMode),
      });
      void persistRuntimeRunPreferences(localRuntime.id, {
        agentId,
        configValues: configValuesFromOptions(nextConfigOptions),
        ...(nextMode ? { modeId: nextMode } : {}),
      }).catch(() => undefined);
    },
    [clashRt.startDraft, localRuntime],
  );

  const ensureDraft = useCallback(() => {
    if (!localRuntime || !selectedHarnessId) return false;
    if (
      clashRt.selectedRuntimeId !== localRuntime.id ||
      clashRt.selectedAgentId !== selectedHarnessId ||
      clashRt.status !== "draft"
    ) {
      clashRt.startDraft(localRuntime.id, undefined, {
        agentId: selectedHarnessId,
        ...permissionModeOption(selectedPermissionModeId),
      });
    }
    return true;
  }, [
    clashRt.selectedAgentId,
    clashRt.selectedRuntimeId,
    clashRt.startDraft,
    clashRt.status,
    localRuntime,
    selectedHarnessId,
    selectedPermissionModeId,
  ]);

  const handleSelectConfigOption = useCallback(
    (configId: string, value: string | boolean) => {
      if (!ensureDraft()) return;
      clashRt.setConfigOption(configId, value);
      if (!localRuntime || !selectedHarnessId) return;
      const nextConfigOptions = configOptions.map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      );
      void persistRuntimeRunPreferences(localRuntime.id, {
        agentId: selectedHarnessId,
        configValues: configValuesFromOptions(nextConfigOptions),
        ...(selectedPermissionModeId
          ? { modeId: selectedPermissionModeId }
          : {}),
      }).catch(() => undefined);
    },
    [
      clashRt.setConfigOption,
      configOptions,
      ensureDraft,
      localRuntime,
      selectedHarnessId,
      selectedPermissionModeId,
    ],
  );

  const handleSelectPermissionMode = useCallback(
    (modeId: string) => {
      if (!ensureDraft()) return;
      if (modeConfigOption) {
        clashRt.setConfigOption(modeConfigOption.id, modeId);
      } else {
        clashRt.setSessionMode(modeId);
      }
      if (!localRuntime || !selectedHarnessId) return;
      const nextConfigOptions = modeConfigOption
        ? configOptions.map((option) =>
            option.id === modeConfigOption.id
              ? { ...option, currentValue: modeId }
              : option,
          )
        : configOptions;
      void persistRuntimeRunPreferences(localRuntime.id, {
        agentId: selectedHarnessId,
        configValues: configValuesFromOptions(nextConfigOptions),
        modeId,
      }).catch(() => undefined);
    },
    [
      clashRt.setConfigOption,
      clashRt.setSessionMode,
      configOptions,
      ensureDraft,
      localRuntime,
      modeConfigOption,
      selectedHarnessId,
    ],
  );

  const handleSessionConfigOpenChange = useCallback(
    (open: boolean) => {
      setSessionConfigOpen(open);
      if (open) {
        void clashRt.refresh({ probe: "config", refresh: true }).catch(() => {
          setSessionConfigOpen(false);
        });
      }
    },
    [clashRt.refresh],
  );

  const ensureProjectId = useCallback(async (): Promise<string | null> => {
    if (references.project) return references.project.id;
    if (draftProjectIdRef.current) {
      addProjectReference({
        id: draftProjectIdRef.current,
        name: inputValue.trim() || "Untitled project",
      });
      return draftProjectIdRef.current;
    }
    if (projectRequestRef.current) return projectRequestRef.current;

    const name = inputValue.trim() || "Untitled project";
    const request = createProjectRecord(name)
      .then(({ id }) => {
        draftProjectIdRef.current = id;
        addProjectReference({ id, name });
        return id;
      })
      .finally(() => {
        projectRequestRef.current = null;
      });
    projectRequestRef.current = request;
    return request;
  }, [addProjectReference, inputValue, references.project]);

  const toMentionableAsset = useCallback(
    (asset: ResolvedAsset): MentionableNode => ({
      id: asset.id,
      type: asset.kind,
      label: asset.name?.trim() || asset.id,
      kind: "asset",
      scope: "project-assets",
      description: t("copilot.dashboardComposer.projectAsset", {
        defaultValue: "Project asset",
      }),
      thumbnail: assetThumbnailImageUrl(asset) ?? undefined,
    }),
    [t],
  );

  const refreshAssetLibrary = useCallback(async () => {
    const sequence = ++assetRefreshSequenceRef.current;
    const projectId = references.project?.id ?? draftProjectIdRef.current;
    const [nextGlobalAssets, nextProjectAssets] = await Promise.all([
      listPersonalGlobalAssets(),
      projectId ? listProjectAssets(projectId) : Promise.resolve([]),
    ]);
    if (sequence !== assetRefreshSequenceRef.current) return;
    setGlobalAssets(nextGlobalAssets);
    setProjectAssets(nextProjectAssets);
  }, [references.project?.id]);

  useEffect(() => {
    void refreshAssetLibrary().catch((error) =>
      console.warn("[Dashboard Composer assets] load failed", error),
    );
  }, [refreshAssetLibrary]);

  useEffect(() => {
    setAdmittedGlobalAssetIds(new Set());
  }, [references.project?.id]);

  const admitGlobalAsset = useCallback(
    async (asset: ResolvedAsset): Promise<MentionableNode> => {
      const projectId = await ensureProjectId();
      if (!projectId) throw new Error("Project scope is unavailable");
      const admitted = await admitPersonalGlobalAssetToProject(
        projectId,
        asset.id,
      );
      assetRefreshSequenceRef.current += 1;
      setProjectAssets((current) => [
        admitted,
        ...current.filter((candidate) => candidate.id !== admitted.id),
      ]);
      setAdmittedGlobalAssetIds((current) => {
        const next = new Set(current);
        next.add(asset.id);
        return next;
      });
      return toMentionableAsset(admitted);
    },
    [ensureProjectId, toMentionableAsset],
  );

  const mentionableAssets = useMemo<MentionableNode[]>(
    () => [
      ...projectAssets.map(toMentionableAsset),
      ...globalAssets
        .filter(
          (asset) =>
            asset.kind !== "model" &&
            asset.lifecycle.state === "active" &&
            !admittedGlobalAssetIds.has(asset.id),
        )
        .map((asset): MentionableNode => ({
          id: `global:${asset.id}`,
          type: asset.kind,
          label: asset.name?.trim() || asset.id,
          kind: "asset",
          scope: "global-assets",
          description: t("copilot.dashboardComposer.globalAsset", {
            defaultValue: "Global asset",
          }),
          thumbnail: assetThumbnailImageUrl(asset) ?? undefined,
          resolveReference: () => admitGlobalAsset(asset),
        })),
    ],
    [
      admittedGlobalAssetIds,
      admitGlobalAsset,
      globalAssets,
      projectAssets,
      t,
      toMentionableAsset,
    ],
  );

  const assetPickerSections = useMemo(
    () =>
      buildComposerAssetSections({
        projectAssets,
        globalAssets: globalAssets.filter(
          (asset) => !admittedGlobalAssetIds.has(asset.id),
        ),
      }),
    [admittedGlobalAssetIds, globalAssets, projectAssets],
  );

  const insertAssetReference = useCallback(
    (asset: ResolvedAsset) => {
      chatInputRef.current?.insertAssetReference?.(toMentionableAsset(asset));
    },
    [toMentionableAsset],
  );

  const handleAssetSelection = useCallback(
    async (option: ScopedAssetOption) => {
      setAssetPickerBusy(true);
      try {
        if (option.source.kind === "global-library") {
          const source = globalAssets.find(
            (asset) => asset.id === option.assetId,
          );
          if (!source) return;
          const resolved = await admitGlobalAsset(source);
          chatInputRef.current?.insertAssetReference?.(resolved);
        } else {
          const source = projectAssets.find(
            (asset) => asset.id === option.assetId,
          );
          if (source) insertAssetReference(source);
        }
        setAssetPickerOpen(false);
      } finally {
        setAssetPickerBusy(false);
      }
    },
    [admitGlobalAsset, globalAssets, insertAssetReference, projectAssets],
  );

  const handleAssetUpload = useCallback(
    async (file: File) => {
      const type = file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
            ? "audio"
            : null;
      if (!type) return;
      setAssetPickerBusy(true);
      try {
        const projectId = await ensureProjectId();
        if (!projectId) return;
        const asset = await importProjectAssetFile(projectId, file, {
          kind: type,
        });
        assetRefreshSequenceRef.current += 1;
        setProjectAssets((current) => [asset, ...current]);
        insertAssetReference(asset);
        setAssetPickerOpen(false);
      } finally {
        setAssetPickerBusy(false);
      }
    },
    [ensureProjectId, insertAssetReference],
  );

  const handleSend = (text: string) => {
    const rawName = text.trim();
    if (!rawName) return;

    startTransition(async () => {
      if (localRuntime && selectedHarnessId) {
        await persistRuntimeRunPreferences(localRuntime.id, {
          agentId: selectedHarnessId,
          configValues: configValuesFromOptions(configOptions),
          ...(selectedPermissionModeId
            ? { modeId: selectedPermissionModeId }
            : {}),
        });
      }

      const initialPrompt = buildDashboardComposerPrompt(
        rawName,
        references.skills,
      );
      const projectId = references.project
        ? references.project.id
        : (await createProjectRecord(rawName)).id;
      if (projectId === draftProjectIdRef.current) {
        await updateProjectName(projectId, rawName);
      }
      const destination = `/projects/${projectId}?prompt=${encodeURIComponent(initialPrompt)}`;
      const root = document.documentElement;
      const prefersReducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const startViewTransition = document.startViewTransition?.bind(document);
      const commitRoute = () => {
        root.dataset.dashboardComposerTransition = "target";
        flushSync(() => {
          clearAfterSubmit();
          navigate(destination);
        });
      };

      if (prefersReducedMotion || !startViewTransition) {
        commitRoute();
        delete root.dataset.dashboardComposerTransition;
        return;
      }

      root.dataset.dashboardComposerTransition = "source";
      const transition = startViewTransition(commitRoute);
      void transition.finished.finally(() => {
        delete root.dataset.dashboardComposerTransition;
      });
    });
  };

  return (
    <>
      <ChatInput
        ref={chatInputRef}
        input={inputValue}
        onInputChange={setInputValue}
        onSubmit={(text) => handleSend(text)}
        isProcessing={isPending}
        isCreatingSession={isPending}
        variant="default"
        projectId={references.project?.id}
        ensureProjectId={ensureProjectId}
        mentionableNodes={mentionableAssets}
        onOpenAssetPicker={() => {
          setAssetPickerOpen(true);
          void refreshAssetLibrary().catch((error) =>
            console.warn("[Dashboard Composer assets] refresh failed", error),
          );
        }}
        disabled={!runtimeReady}
        placeholder={
          needsAgentSetup
            ? t("copilot.dashboardComposer.agentSetupHint", {
                defaultValue: "Configure an Agent to start creating.",
              })
            : undefined
        }
        toolbarAccessory={
          <div className="clash-composer-session-controls flex min-w-0 items-center gap-1">
            <HarnessPermissionSelector
              agentId={selectedHarnessId}
              selectedPermissionModeId={selectedPermissionModeId}
              sessionModes={sessionModes}
              modeConfigOption={modeConfigOption}
              onSelectPermissionMode={handleSelectPermissionMode}
            />
            <SessionPlanTag
              configOptions={configOptions}
              onSelectConfigOption={handleSelectConfigOption}
            />
            <InlineSessionConfigControls
              configOptions={configOptions}
              onSelectConfigOption={handleSelectConfigOption}
            />
          </div>
        }
        rightToolbarAccessory={
          needsAgentSetup ? (
            <Link
              to="/settings?section=agents"
              className={buttonVariants({ variant: "primary", size: "sm" })}
            >
              {t("copilot.dashboardComposer.configureAgent", {
                defaultValue: "Configure Agent",
              })}
            </Link>
          ) : (
            <SessionConfigSelector
              open={sessionConfigOpen}
              onOpenChange={handleSessionConfigOpenChange}
              embedded
              selectedHarnessId={selectedHarnessId}
              statusLabel={null}
              harnessOptions={localRuntime?.agents ?? []}
              configOptions={configOptions}
              modelConfigOption={modelConfigOption}
              onSelectHarness={handleSelectHarness}
              onSelectConfigOption={handleSelectConfigOption}
            />
          )
        }
        referenceAccessory={
          references.skills.length > 0 ? (
            <DashboardComposerSkillReferences />
          ) : undefined
        }
      />
      <ScopedAssetPicker
        open={assetPickerOpen}
        sections={assetPickerSections}
        busy={assetPickerBusy}
        onClose={() => {
          if (!assetPickerBusy) setAssetPickerOpen(false);
        }}
        onSelect={handleAssetSelection}
        onUpload={handleAssetUpload}
      />
    </>
  );
}

export const DashboardComposerRuntime = forwardRef<HeroSectionHandle, object>(
  DashboardComposerRuntimeInner,
);
DashboardComposerRuntime.displayName = "DashboardComposerRuntime";

export function DashboardComposerSkillReferences() {
  const { references, removeSkillReference } = useDashboardComposer();
  const { t } = useTranslation();
  if (references.skills.length === 0) return null;

  return (
    <div
      role="list"
      aria-label={t("copilot.dashboardComposer.skillReferences", {
        defaultValue: "Skill references",
      })}
      className="clash-dashboard-composer-skill-references"
    >
      {references.skills.map((skill) => (
        <div
          key={skill.id}
          role="listitem"
          data-slot="dashboard-composer-skill-reference"
          className="clash-dashboard-composer-skill-reference"
        >
          <PuzzlePiece aria-hidden="true" weight="duotone" />
          <span>${skill.name}</span>
          <IconButton
            label={t("copilot.dashboardComposer.removeSkill", {
              name: skill.name,
              defaultValue: `Remove ${skill.name}`,
            })}
            size="sm"
            shape="circle"
            onClick={() => removeSkillReference(skill.id)}
            icon={<X aria-hidden="true" weight="bold" />}
          />
        </div>
      ))}
    </div>
  );
}
