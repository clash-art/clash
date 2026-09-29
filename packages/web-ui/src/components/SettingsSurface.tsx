import { useMediaQuery } from "../lib/hooks/useMediaQuery";
import { SettingsPlugins } from "./SettingsPlugins";
import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import {
  X,
  ArrowsOutSimple,
  Plug,
  Key,
  PuzzlePiece,
  BookOpen,
  Terminal,
  SignOut,
  CloudArrowUp,
  Microphone,
  PaintBrush,
  VideoCamera,
  PlugsConnected,
  Cube,
  Archive,
} from "@phosphor-icons/react";
import betterAuthClient from "@clash/web-ui/lib/betterAuthClient";
import { getRuntimeConfig } from "@clash/web-ui/lib/runtimeConfig";
import SettingsClient, { type SettingsSection } from "./SettingsClient";
import { Tooltip } from "./ui/tooltip";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { ControlContextProvider } from "./ui/control-context";
import { InlineAlert } from "./ui/feedback";
import { Tab, TabList, TabProvider } from "./ui/tabs";
import { AppPage } from "./AppPage";
import { SessionArchiveLibrary } from "./SessionArchiveLibrary";
import {
  listApiTokens,
  listVariables,
  listInstalledActions,
  listInstalledSkills,
  listModelProviders,
  listModelCatalog,
  type ApiTokenInfo,
  type VariableInfo,
  type InstalledActionInfo,
  type InstalledSkillInfo,
  type ModelProviderAccountInfo,
  type ModelCatalogEntryInfo,
} from "@clash/web-ui/lib/clientActions";

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{
    className?: string;
    weight?: "regular" | "bold" | "fill" | "duotone";
  }>;
}

export const SETTINGS_NAV_ITEMS: NavItem[] = [
  { id: "appearance", label: "Appearance", icon: PaintBrush },
  { id: "plugins", label: "Plugins", icon: PuzzlePiece },
  { id: "agents", label: "Agents", icon: Plug },
  { id: "sync", label: "Sync", icon: CloudArrowUp },
  { id: "public-storage", label: "Public storage", icon: CloudArrowUp },
  { id: "audio", label: "Voice input", icon: Microphone },
  { id: "media-analysis", label: "Media analysis", icon: VideoCamera },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "tokens", label: "API Tokens", icon: Key },
  { id: "providers", label: "Providers", icon: PlugsConnected },
  { id: "models", label: "Models", icon: Cube },
  { id: "actions", label: "Actions", icon: PuzzlePiece },
  { id: "skills", label: "Skills", icon: BookOpen },
  { id: "cli", label: "CLI", icon: Terminal },
];

const HOSTED_ONLY_SETTINGS_SECTIONS = new Set<SettingsSection>([
  "tokens",
  "variables",
  "actions",
  "skills",
]);
const LOCAL_ONLY_SETTINGS_SECTIONS = new Set<SettingsSection>([
  "plugins",
  "public-storage",
  "media-analysis",
]);

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      tokens: ApiTokenInfo[];
      variables: VariableInfo[];
      actions: InstalledActionInfo[];
      skills: InstalledSkillInfo[];
      modelProviders: ModelProviderAccountInfo[];
      modelCatalog: ModelCatalogEntryInfo[];
    };

export interface SettingsSurfaceProps {
  projectId?: string;
  active: SettingsSection;
  onActiveChange: (section: SettingsSection) => void;
  onClose?: () => void;
  onExpand?: () => void;
  variant?: "dialog" | "page";
}

export function isSettingsSection(
  value: string | null | undefined,
): value is SettingsSection {
  return Boolean(value && SETTINGS_NAV_ITEMS.some((item) => item.id === value));
}

export const SETTINGS_SECTION_STORAGE_KEY = "clash.settings.activeSection";

export function readLastSettingsSection(): SettingsSection | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
    return isSettingsSection(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastSettingsSection(section: SettingsSection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, section);
  } catch {
    // Local storage can be blocked in private or embedded contexts.
  }
}

function supportsRemoteWorkerVariables(): boolean {
  return getRuntimeConfig().mode === "hosted";
}

function supportsHostedSettings(): boolean {
  return getRuntimeConfig().mode === "hosted";
}

function availableSettingsNavItems(
  hostedSettingsAvailable: boolean,
): NavItem[] {
  return SETTINGS_NAV_ITEMS.filter((item) =>
    hostedSettingsAvailable
      ? !LOCAL_ONLY_SETTINGS_SECTIONS.has(item.id)
      : !HOSTED_ONLY_SETTINGS_SECTIONS.has(item.id),
  );
}

function effectiveSettingsSection(
  section: SettingsSection,
  hostedSettingsAvailable: boolean,
): SettingsSection {
  if (!hostedSettingsAvailable && HOSTED_ONLY_SETTINGS_SECTIONS.has(section))
    return "agents";
  if (hostedSettingsAvailable && LOCAL_ONLY_SETTINGS_SECTIONS.has(section))
    return "agents";
  return section;
}

function SettingsSurfaceSkeletonLine({
  className = "",
}: {
  className?: string;
}) {
  return <span className={`block rounded-full bg-muted ${className}`} />;
}

function SettingsSurfaceLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading settings"
      aria-live="polite"
      className="space-y-4"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[0, 1].map((index) => (
          <div
            key={index}
            className="rounded-xl border border-border bg-card p-4 shadow-xs"
          >
            <SettingsSurfaceSkeletonLine className="h-3 w-24" />
            <SettingsSurfaceSkeletonLine className="mt-2 h-2.5 w-36" />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
        <SettingsSurfaceSkeletonLine className="h-2.5 w-32" />
        <SettingsSurfaceSkeletonLine className="h-9 w-full rounded-lg" />
        <SettingsSurfaceSkeletonLine className="h-2.5 w-28" />
        <SettingsSurfaceSkeletonLine className="h-9 w-full rounded-lg" />
        <div className="flex gap-2 pt-1">
          <SettingsSurfaceSkeletonLine className="h-2.5 w-20" />
          <SettingsSurfaceSkeletonLine className="h-2.5 w-16" />
        </div>
      </div>
    </div>
  );
}

export function SettingsSurface({
  projectId,
  active,
  onActiveChange,
  onClose,
  onExpand,
  variant = "dialog",
}: SettingsSurfaceProps) {
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  const isPage = variant === "page";
  const narrow = useMediaQuery("(max-width: 767px)");
  const hostedSettingsAvailable = supportsHostedSettings();
  const remoteWorkerVariablesAvailable = supportsRemoteWorkerVariables();
  const navItems = availableSettingsNavItems(hostedSettingsAvailable);
  const activeSection = effectiveSettingsSection(
    active,
    hostedSettingsAvailable,
  );

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    Promise.all([
      hostedSettingsAvailable
        ? listApiTokens().catch(() => [] as ApiTokenInfo[])
        : Promise.resolve([] as ApiTokenInfo[]),
      remoteWorkerVariablesAvailable
        ? listVariables().catch(() => [] as VariableInfo[])
        : Promise.resolve([] as VariableInfo[]),
      hostedSettingsAvailable
        ? listInstalledActions().catch(() => [] as InstalledActionInfo[])
        : Promise.resolve([] as InstalledActionInfo[]),
      hostedSettingsAvailable
        ? listInstalledSkills().catch(() => [] as InstalledSkillInfo[])
        : Promise.resolve([] as InstalledSkillInfo[]),
      listModelProviders().catch(() => [] as ModelProviderAccountInfo[]),
      listModelCatalog().catch(() => [] as ModelCatalogEntryInfo[]),
    ])
      .then(
        ([
          tokens,
          variables,
          actions,
          skills,
          modelProviders,
          modelCatalog,
        ]) => {
          if (cancelled) return;
          setLoad({
            status: "ready",
            tokens,
            variables,
            actions,
            skills,
            modelProviders,
            modelCatalog,
          });
        },
      )
      .catch((err) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [hostedSettingsAvailable, remoteWorkerVariablesAvailable]);

  const handleSignOut = useCallback(async () => {
    try {
      await betterAuthClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            window.location.href = "/";
          },
        },
      });
    } catch (err) {
      console.error("Sign out error:", err);
      window.location.href = "/";
    }
  }, []);

  const settingsContent =
    activeSection === "plugins" ? (
      <SettingsPlugins projectId={projectId} />
    ) : activeSection === "archive" ? (
      <SessionArchiveLibrary />
    ) : load.status === "loading" || load.status === "idle" ? (
      <SettingsSurfaceLoadingSkeleton />
    ) : load.status === "error" ? (
      <InlineAlert
        tone="error"
        title="Settings could not load"
        message={load.message}
      />
    ) : (
      <SettingsClient
        initialTokens={load.tokens}
        initialVariables={load.variables}
        initialActions={load.actions}
        initialSkills={load.skills}
        initialModelProviders={load.modelProviders}
        initialModelCatalog={load.modelCatalog}
        activeSection={activeSection}
        embedded
      />
    );

  return (
    <ControlContextProvider value="settings">
      <div
        className={
          isPage
            ? "clash-settings-page-shell flex h-full min-h-full w-full overflow-hidden"
            : "clash-settings-dialog-shell relative flex h-full flex-col overflow-hidden rounded-2xl md:flex-row"
        }
      >
        <aside
          className={`${isPage ? "clash-settings-page-sidebar" : "clash-settings-dialog-sidebar"} flex w-full shrink-0 flex-col border-b border-border md:w-52 md:border-b-0 md:border-r [--clash-settings-sidebar-item-inline-inset:0.5rem]`}
        >
          <div className="clash-settings-sidebar-header flex h-10 shrink-0 items-center px-2">
            <h1 className="px-[var(--clash-settings-sidebar-item-inline-inset)] font-display text-[13px] font-semibold leading-5 text-foreground">
              Settings
            </h1>
            {!isPage && onExpand ? (
              <Tooltip label="Open settings page">
                <IconButton
                  label="Open settings page"
                  icon={<ArrowsOutSimple className="h-4 w-4" weight="bold" />}
                  shape="rounded"
                  size="sm"
                  onClick={onExpand}
                  className="ml-auto text-muted-foreground hover:bg-accent hover:text-foreground max-md:hidden"
                />
              </Tooltip>
            ) : null}
          </div>
          <TabProvider
            selectedId={activeSection}
            setSelectedId={(section) => {
              if (isSettingsSection(section)) onActiveChange(section);
            }}
            orientation={narrow ? "horizontal" : "vertical"}
            focusLoop
          >
            <TabList
              className="flex flex-row gap-1 overflow-x-auto px-2 py-1 md:flex-1 md:flex-col md:gap-0 md:overflow-y-auto"
              aria-label="Settings sections"
            >
              {navItems.map((item) => {
                const isActive = activeSection === item.id;
                const Icon = item.icon;
                return (
                  <Tab
                    key={item.id}
                    id={item.id}
                    className={`relative flex h-8 w-auto shrink-0 items-center md:w-full gap-2 rounded-md border px-[var(--clash-settings-sidebar-item-inline-inset)] text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                      isActive
                        ? "border-border bg-accent text-foreground shadow-xs"
                        : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="absolute left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                      />
                    )}
                    <Icon className="h-4 w-4" weight="bold" />
                    <span className="truncate">{item.label}</span>
                  </Tab>
                );
              })}
            </TabList>
          </TabProvider>
          {hostedSettingsAvailable ? (
            <div className="border-t border-border p-2">
              <Button
                onClick={handleSignOut}
                size="sm"
                className="h-8 w-full justify-start rounded-md border-transparent bg-transparent px-2 text-[13px] text-muted-foreground shadow-none hover:bg-accent hover:text-destructive focus-visible:ring-ring/60"
                leftIcon={<SignOut className="h-4 w-4" weight="bold" />}
              >
                Sign out
              </Button>
            </div>
          ) : null}
        </aside>

        <main
          className={`${isPage ? "clash-settings-page-content" : "clash-settings-dialog-content"} min-w-0 flex-1 overflow-y-auto`}
        >
          {isPage ? (
            <AppPage>{settingsContent}</AppPage>
          ) : (
            <div className="px-4 py-6 md:px-6 md:pt-12">{settingsContent}</div>
          )}
        </main>
        {onClose ? (
          <IconButton
            label="Close settings"
            icon={<X className="size-4" />}
            size="sm"
            onClick={onClose}
            className="absolute right-3 top-2 z-10 border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent"
          />
        ) : null}
      </div>
    </ControlContextProvider>
  );
}
