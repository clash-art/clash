import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Key,
  Plus,
  Trash,
  Copy,
  Check,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Lock,
  Eye,
  EyeSlash,
  PuzzlePiece,
  BookOpen,
  Terminal,
  Plug,
  PlugsConnected,
  Cube,
  CloudArrowUp,
  MagnifyingGlass,
  CaretDown,
  CaretRight,
  Microphone,
  X,
  ImageSquare,
  VideoCamera,
  SpeakerHigh,
  TextT,
  Desktop,
  Moon,
  Sun,
} from "@phosphor-icons/react";
import { useClashRuntime } from "@clash/web-ui/hooks/useClashRuntime";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  asrModelValue,
  isLocalAsrModelEntry,
  isLocalSpeechModelEntry,
  isLocalTtsModelEntry,
  localSpeechCapability,
  transcribesAudioToText,
  type LocalSpeechCapability,
} from "@clash/shared-types";
import { authFormControls, type AuthFormControl } from "@clash/shared-types";
import {
  ACCOUNT_SETTINGS,
  ACTION_PROVIDER_PRESETS,
  CustomActionDefinitionSchema,
  MODEL_CARDS,
  listModelCatalogEntries,
  resolveCredentialSources,
  listProviderModelSupport,
  normalizeActionProviderId,
  type ProviderCredentialRequirements,
  type ProviderOAuthId,
  type UserModelCardConfig,
} from "@clash/shared-types";
import {
  createApiToken,
  revokeApiToken,
  type ApiTokenInfo,
  setVariable,
  deleteVariable,
  type VariableInfo,
  uninstallAction,
  type InstalledActionInfo,
  uninstallSkill,
  type InstalledSkillInfo,
  updateModelProviders,
  deleteModelProvider,
  listModelProviders,
  listModelCatalog,
  saveModelCardConfig,
  deleteModelCardConfig,
  listProviderOAuth,
  listPluginProviders,
  startProviderOAuth,
  completeProviderOAuth,
  importLocalProviderToken,
  testModelProvider,
  type ModelProviderAccountInfo,
  type ModelCatalogEntryInfo,
  type ProviderOAuthInfo,
  type PluginProviderInfo,
  type ModelProviderTestResult,
} from "@clash/web-ui/lib/clientActions";
import { runtimeApiUrl } from "@clash/web-ui/lib/runtimeConfig";
import {
  clearHarnessOperation,
  setHarnessOperation,
  useHarnessOperations,
  type HarnessOperationAction,
} from "@clash/web-ui/lib/harnessOperations";
import { HARNESS_UPDATED_EVENT } from "@clash/web-ui/lib/sessionRuntime";
import { cn } from "./ai-elements/utils";
import { Dialog } from "./ui/dialog";
import { Button, buttonVariants } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { IconButton } from "./ui/icon-button";
import { Input } from "./ui/input";
import { SelectMenu, type SelectOption } from "./ui/select";
import { SearchableSelect } from "./ui/searchable-select";
import { SortableList, moveItem, useSortableItem } from "./ui/sortable";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tab, TabList, TabProvider } from "./ui/tabs";
import { Tooltip } from "./ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { ControlContextProvider } from "./ui/control-context";
import { InlineAlert } from "./ui/feedback";
import { useAppFeedback } from "./AppFeedback";
import { CLASH_BRAND_ASSETS } from "./BrandAsset";
import { useTheme } from "./ThemeProvider";
import { SearchField, SearchFilterToolbar } from "./SearchFilterToolbar";
import {
  SettingsActions,
  SettingsCollection,
  SettingsEmptyState,
  SettingsFieldGroup,
  SettingsPanel,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSectionLayout,
} from "./SettingsPrimitives";
import { type ThemePreference } from "../lib/theme";

/** Stable identifiers for each section pane — shared between the legacy
 *  SettingsSurface. The host uses these as its sidebar nav keys. */
export type SettingsSection =
  | "appearance"
  | "agents"
  | "sync"
  | "public-storage"
  | "audio"
  | "media-analysis"
  | "archive"
  | "tokens"
  | "providers"
  | "variables"
  | "models"
  | "actions"
  | "skills"
  | "cli";

interface Props {
  initialTokens: ApiTokenInfo[];
  initialVariables: VariableInfo[];
  initialActions: InstalledActionInfo[];
  initialSkills: InstalledSkillInfo[];
  initialModelProviders?: ModelProviderAccountInfo[];
  initialModelCatalog?: ModelCatalogEntryInfo[];
  /** When provided, only that section's body renders — used by
   *  SettingsSurface's content pane. */
  activeSection?: SettingsSection;
  /** When true, the sticky header / page chrome is suppressed and
   *  the layout is meant to live inside a modal panel. */
  embedded?: boolean;
}

const settingsHoverActionClass = "opacity-0 group-hover:opacity-100";
const settingsCodeBlockClass =
  "clash-settings-code block overflow-x-auto whitespace-nowrap rounded-xl px-4 py-3 font-mono text-sm";
const settingsSkeletonLineClass = "rounded-full bg-warm-muted";
function formatProviderTestPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

type ModelAvailabilityFilter = "enabled" | "unavailable";
type ModelInputFilter = "text-only" | "image" | "video" | "audio";
type ModelOriginFilter = "built-in" | "custom";

const MODEL_AVAILABILITY_FILTER_OPTIONS: Array<{
  value: ModelAvailabilityFilter;
  label: string;
}> = [
  { value: "enabled", label: "Enabled" },
  { value: "unavailable", label: "Unavailable" },
];

const MODEL_INPUT_FILTER_OPTIONS: Array<{
  value: ModelInputFilter;
  label: string;
}> = [
  { value: "text-only", label: "Text only" },
  { value: "image", label: "Can use images" },
  { value: "video", label: "Can use video" },
  { value: "audio", label: "Can use audio" },
];

const MODEL_ORIGIN_FILTER_OPTIONS: Array<{
  value: ModelOriginFilter;
  label: string;
}> = [
  { value: "built-in", label: "Built-in cards" },
  { value: "custom", label: "Custom cards" },
];

const AUTH_LAUNCH_OPENING_TIMEOUT_MS = 8_000;
const AUTH_RECHECK_INTERVAL_MS = 2_000;
const AUTH_RECHECK_MAX_ATTEMPTS = 30;

function displayErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(media.matches);
    const onChange = () => setPrefersReducedMotion(media.matches);
    media.addEventListener?.("change", onChange);
    return () => {
      media.removeEventListener?.("change", onChange);
    };
  }, []);

  return prefersReducedMotion;
}

function SettingsAnimatedBody({
  children,
  className = "space-y-4",
}: {
  children: ReactNode;
  className?: string;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

const APPEARANCE_OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Desktop;
}> = [
  {
    value: "system",
    label: "System",
    description: "Follow this device automatically.",
    icon: Desktop,
  },
  {
    value: "light",
    label: "Light",
    description: "Warm studio surfaces for bright rooms.",
    icon: Sun,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Low-glare surfaces for focused editing.",
    icon: Moon,
  },
];

const TEXT_PROTOCOL_OPTIONS: SelectOption<
  "openai-compatible" | "anthropic-compatible"
>[] = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "anthropic-compatible", label: "Anthropic-compatible" },
];

function ThemePreview({ theme }: { theme: ThemePreference }) {
  const lightPane = (
    <span className="relative block h-full overflow-hidden bg-[#f4f1eb]">
      <span className="absolute inset-x-2 bottom-2 top-5 rounded-md border border-[#ddd8ce] bg-[#fffefd]" />
      <span className="absolute left-4 top-8 h-1 w-7 rounded-full bg-[#c8c2b8]" />
      <span className="absolute left-4 top-11 h-1 w-10 rounded-full bg-[#ded9d0]" />
    </span>
  );
  const darkPane = (
    <span className="relative block h-full overflow-hidden bg-[#262626]">
      <span className="absolute inset-x-2 bottom-2 top-5 rounded-md border border-[#444444] bg-[#1c1c1c]" />
      <span className="absolute left-4 top-8 h-1 w-7 rounded-full bg-[#7a7a7a]" />
      <span className="absolute left-4 top-11 h-1 w-10 rounded-full bg-[#4d4d4d]" />
    </span>
  );

  return (
    <span
      aria-hidden="true"
      className={`grid h-24 w-full overflow-hidden rounded-lg border border-warm-border ${theme === "system" ? "grid-cols-2" : "grid-cols-1"}`}
    >
      {theme !== "dark" ? lightPane : null}
      {theme !== "light" ? darkPane : null}
    </span>
  );
}

export function AppearanceSection() {
  const { preference, resolvedTheme, setPreference } = useTheme();

  return (
    <SettingsSectionLayout aria-labelledby="appearance-heading">
      <SettingsSectionHeader
        title="Appearance"
        titleId="appearance-heading"
        description="Choose how Clash follows this device. Product feedback colors stay consistent across themes."
      />
      <div className="space-y-4">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-foreground">Theme</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Canvas media and the Director viewport keep their presentation
            colors.
          </p>
        </div>
        <RadioGroup
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
          aria-label="Interface theme"
          className="grid gap-3 sm:grid-cols-3"
        >
          {APPEARANCE_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <RadioGroupItem
                key={option.value}
                value={option.value}
                className="relative flex-col gap-3 rounded-[var(--settings-row-radius)] border-border bg-background p-3 hover:bg-accent/60 data-[state=checked]:border-ring data-[state=checked]:bg-[var(--control-bg-open)] [&>span:first-child]:absolute [&>span:first-child]:right-3 [&>span:first-child]:top-3"
              >
                <ThemePreview theme={option.value} />
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Icon
                    className="h-4 w-4 text-muted-foreground"
                    weight="bold"
                    aria-hidden="true"
                  />
                  {option.label}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {option.description}
                </span>
              </RadioGroupItem>
            );
          })}
        </RadioGroup>
        <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
          Currently using {resolvedTheme} appearance.
        </p>
      </div>
    </SettingsSectionLayout>
  );
}

function SettingsSkeletonLine({ className = "" }: { className?: string }) {
  return <span className={`${settingsSkeletonLineClass} block ${className}`} />;
}

function SettingsFieldSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="space-y-2">
      <SettingsSkeletonLine className={wide ? "h-2.5 w-40" : "h-2.5 w-28"} />
      <SettingsSkeletonLine className="h-9 w-full rounded-lg" />
    </div>
  );
}

function SettingsFormSkeleton({
  ariaLabel,
  variant,
}: {
  ariaLabel: string;
  variant: "sync" | "audio";
}) {
  return (
    <div role="status" aria-label={ariaLabel} className="space-y-4">
      {variant === "sync" ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[0, 1].map((index) => (
            <div
              key={index}
              className="rounded-xl border border-warm-border bg-warm-surface p-4"
            >
              <SettingsSkeletonLine className="h-3 w-24" />
              <SettingsSkeletonLine className="mt-2 h-2.5 w-36" />
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-warm-border bg-warm-surface p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SettingsSkeletonLine className="h-3 w-24" />
              <SettingsSkeletonLine className="mt-2 h-2.5 w-64 max-w-full" />
            </div>
            <SettingsSkeletonLine className="h-6 w-11 shrink-0" />
          </div>
        </div>
      )}
      <div className="space-y-3 rounded-xl border border-warm-border bg-warm-surface p-4">
        <SettingsFieldSkeleton wide />
        <SettingsFieldSkeleton />
        {variant === "audio" && (
          <>
            <SettingsFieldSkeleton />
            <SettingsFieldSkeleton />
          </>
        )}
        <div className="flex gap-2">
          <SettingsSkeletonLine className="h-2.5 w-20" />
          <SettingsSkeletonLine className="h-2.5 w-16" />
        </div>
      </div>
      {variant === "audio" && (
        <div className="rounded-xl border border-warm-border bg-warm-surface p-4">
          <SettingsSkeletonLine className="h-3 w-28" />
          <div className="mt-3 space-y-2">
            <SettingsSkeletonLine className="h-10 w-full rounded-xl" />
            <SettingsSkeletonLine className="h-10 w-full rounded-xl" />
          </div>
        </div>
      )}
    </div>
  );
}

function AgentRowsSkeleton({ ariaLabel }: { ariaLabel: string }) {
  return (
    <SettingsCollection role="status" aria-label={ariaLabel}>
      {[0, 1, 2].map((index) => (
        <SettingsRow
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_10rem] items-center gap-3 px-2.5 py-1.5"
        >
          <div className="min-w-0">
            <SettingsSkeletonLine className="h-3 w-28" />
            <SettingsSkeletonLine className="mt-2 h-2.5 w-44 max-w-full" />
            <SettingsSkeletonLine className="mt-2 h-2.5 w-36 max-w-full" />
          </div>
          <div className="flex justify-end gap-2">
            <SettingsSkeletonLine className="h-8 w-20 rounded-lg" />
            <SettingsSkeletonLine className="h-8 w-10 rounded-lg" />
          </div>
        </SettingsRow>
      ))}
    </SettingsCollection>
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

interface LocalHarnessInfo {
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
    status: "configured" | "needs-auth" | "unknown";
    message: string;
    command?: string;
    methodId?: string;
    methodName?: string;
    methods?: Array<{
      id: string;
      name?: string;
      description?: string;
      type?: string;
      form?: "fields";
      vars?: Array<{
        name: string;
        label?: string;
        secret?: boolean;
        optional?: boolean;
      }>;
      link?: string;
    }>;
  };
}

type HarnessSavingAction = HarnessOperationAction;

function harnessBusyMessage(
  label: string,
  action: HarnessSavingAction | null,
): string | null {
  if (action === "probe") return `Checking ${label} auth…`;
  if (action === "install") return `Installing ${label} from the ACP registry…`;
  if (action === "upgrade") return `Upgrading ${label} from the ACP registry…`;
  if (action === "uninstall")
    return `Removing ${label} from Clash-managed installs…`;
  if (action === "toggle") return `Saving ${label} enablement…`;
  return null;
}

function harnessBusyStatusLabel(
  action: HarnessSavingAction | null,
): string | null {
  if (action === "probe") return "Checking auth…";
  if (action === "install") return "Installing…";
  if (action === "upgrade") return "Upgrading…";
  if (action === "uninstall") return "Uninstalling…";
  if (action === "toggle") return "Saving enablement…";
  return null;
}

function mergeHarnessResult(
  current: LocalHarnessInfo[],
  incoming: LocalHarnessInfo[],
  harnessId: string,
): LocalHarnessInfo[] {
  const updatedHarness = incoming.find(
    (candidate) => candidate.id === harnessId,
  );
  if (!updatedHarness) return current;
  return current.map((candidate) =>
    candidate.id === harnessId ? updatedHarness : candidate,
  );
}

type AuthLaunchStatus = "opening" | "waiting" | "attention";

interface AuthLaunchState {
  status: AuthLaunchStatus;
  methodId?: string;
  methodLabel?: string;
  message?: string;
}

type LocalAgentServersConfig = Record<
  string,
  {
    type: "custom";
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }
>;

const CUSTOM_AGENT_SERVER_STARTERS = [
  {
    id: "blank",
    label: "Blank",
    name: "my-agent",
    command: "",
    args: [],
    env: {},
  },
  {
    id: "node-script",
    label: "Node script",
    name: "node-agent",
    command: "node",
    args: ["~/projects/my-agent/index.js", "--acp"],
    env: {},
  },
  {
    id: "package-runner",
    label: "Package",
    name: "package-agent",
    command: "npx",
    args: ["-y", "<agent-package>", "--acp"],
    env: {},
  },
] as const;

function formatArgsText(args: readonly string[] | undefined): string {
  return (args ?? []).join("\n");
}

function parseArgsText(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatEnvText(env: Record<string, string> | undefined): string {
  return JSON.stringify(env ?? {}, null, 2);
}

function formatAgentCommand(server: LocalAgentServersConfig[string]): string {
  return [server.command, ...(server.args ?? [])].join(" ");
}

function formatHarnessVersionLine(harness: LocalHarnessInfo): string | null {
  if (!harness.installed) return null;
  if (harness.updateAvailable) {
    if (harness.installedVersion && harness.latestVersion) {
      return `Version: ${harness.installedVersion} -> ${harness.latestVersion}`;
    }
    if (harness.latestVersion)
      return `Latest version: ${harness.latestVersion}`;
    if (harness.installedVersion) return `Version: ${harness.installedVersion}`;
    return null;
  }
  const version = harness.installedVersion ?? harness.latestVersion;
  return version ? `Version: ${version}` : null;
}

function harnessStatus(harness: LocalHarnessInfo): {
  label: string;
  className: string;
} {
  if (harness.auth?.status === "needs-auth") {
    return {
      label: "Auth needed",
      className:
        "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
    };
  }
  if (harness.auth?.status === "unknown") {
    return {
      label: "Check auth",
      className:
        "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
    };
  }
  if (harness.updateAvailable) {
    return {
      label: "Update available",
      className:
        "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
    };
  }
  if (harness.auth?.status === "configured") {
    return {
      label: "Auth configured",
      className:
        "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
    };
  }
  if (harness.available) {
    return {
      label: "Ready",
      className:
        "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
    };
  }
  if (harness.installable) {
    return {
      label: "Not installed",
      className:
        "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
    };
  }
  return {
    label: "Needs setup",
    className:
      "bg-stone-100 text-stone-600 dark:bg-stone-700/50 dark:text-stone-300",
  };
}

function harnessAuthBlocksEnable(
  harness: LocalHarnessInfo | undefined,
): boolean {
  return (
    harness?.auth?.status === "needs-auth" ||
    harness?.auth?.status === "unknown"
  );
}

function harnessIsConfigured(harness: LocalHarnessInfo): boolean {
  return harness.enabled;
}

type LocalAuthMethod = NonNullable<
  NonNullable<LocalHarnessInfo["auth"]>["methods"]
>[number];

type LocalAuthProtocol =
  "none" | "agent" | "terminal" | "env_var" | "unsupported";

function authEnvVarNamesFromText(text: string | undefined): string[] {
  if (!text || !/\benvironment variable\b|\benv(?:ironment)? var\b/i.test(text))
    return [];
  return [
    ...new Set(
      [...text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

function authMethodProtocol(
  method: LocalAuthMethod | undefined,
): LocalAuthProtocol {
  if (!method) return "none";
  if (method.type === "terminal") {
    return authEnvVarNamesFromText(method.description).length > 0
      ? "env_var"
      : "terminal";
  }
  if (method.type === "env_var") return "env_var";
  if (!method.type || method.type === "agent") return "agent";
  return "unsupported";
}

function authMethodIsTerminal(method: LocalAuthMethod | undefined): boolean {
  return authMethodProtocol(method) === "terminal";
}

function authMethodIsEnvVar(method: LocalAuthMethod | undefined): boolean {
  return authMethodProtocol(method) === "env_var";
}

function authActionLabel(
  method: LocalAuthMethod | undefined,
  multiple: boolean,
): string {
  const protocol = authMethodProtocol(method);
  const methodLabel = method?.name ?? method?.id ?? "setup";
  if (protocol === "terminal") {
    return multiple ? `Open ${methodLabel}` : "Open setup";
  }
  if (protocol === "env_var") {
    return multiple ? `Configure ${methodLabel}` : "Configure";
  }
  return multiple && method
    ? `Sign in with ${method.name ?? method.id}`
    : "Sign in";
}

function authActionAriaLabel(
  harnessLabel: string,
  method: LocalAuthMethod | undefined,
  multiple: boolean,
): string {
  const protocol = authMethodProtocol(method);
  const methodLabel = method?.name ?? method?.id ?? "setup";
  if (protocol === "terminal") {
    return multiple
      ? `Open ${harnessLabel} setup with ${methodLabel}`
      : `Open ${harnessLabel} setup`;
  }
  if (protocol === "env_var") {
    return multiple
      ? `Configure ${harnessLabel} credentials for ${methodLabel}`
      : `Configure ${harnessLabel} credentials`;
  }
  return multiple && method
    ? `Sign in to ${harnessLabel} with ${method.name ?? method.id}`
    : `Sign in to ${harnessLabel}`;
}

function authMethodVariableNames(
  method: LocalAuthMethod | undefined,
): string[] {
  const explicit =
    method?.vars?.map((variable) => variable.name).filter(Boolean) ?? [];
  return explicit.length > 0
    ? explicit
    : authEnvVarNamesFromText(method?.description);
}

export default function SettingsClient({
  initialTokens,
  initialVariables,
  initialActions,
  initialSkills,
  initialModelProviders = [],
  initialModelCatalog = [],
  activeSection,
  embedded = false,
}: Props) {
  const showAll = activeSection == null;
  const showSection = (s: SettingsSection) => showAll || activeSection === s;
  const [tokens, setTokens] = useState<ApiTokenInfo[]>(initialTokens);
  const [newTokenName, setNewTokenName] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [variables, setVariables] = useState<VariableInfo[]>(initialVariables);
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarValue, setNewVarValue] = useState("");
  const [isAddingVar, setIsAddingVar] = useState(false);
  const [showVarValue, setShowVarValue] = useState(false);

  const [actions, setActions] = useState<InstalledActionInfo[]>(initialActions);
  const [skills, setSkills] = useState<InstalledSkillInfo[]>(initialSkills);
  const [modelProviders, setModelProviders] = useState<
    ModelProviderAccountInfo[]
  >(initialModelProviders);
  const [modelCatalog, setModelCatalog] =
    useState<ModelCatalogEntryInfo[]>(initialModelCatalog);
  const [isSavingModelProviders, setIsSavingModelProviders] = useState(false);
  const [isSavingModelCard, setIsSavingModelCard] = useState(false);
  const [modelProviderError, setModelProviderError] = useState<string | null>(
    null,
  );
  const [providerOAuth, setProviderOAuth] = useState<ProviderOAuthInfo[]>([]);
  const [pluginProviders, setPluginProviders] = useState<PluginProviderInfo[]>(
    [],
  );
  const feedback = useAppFeedback();

  const variableKeys = new Set(variables.map((v) => v.key));
  const providerPresets = Object.values(ACTION_PROVIDER_PRESETS);
  const pluginProviderById = useMemo(
    () => new Map(pluginProviders.map((provider) => [provider.id, provider])),
    [pluginProviders],
  );
  const modelProvidersWithPlugins = useMemo(
    () =>
      modelProviders.map((provider) => {
        const pluginProvider = pluginProviderById.get(provider.providerId);
        return pluginProvider ? { ...provider, pluginProvider } : provider;
      }),
    [modelProviders, pluginProviderById],
  );
  const modelProviderRows = useMemo(
    () => buildModelProviderRows(modelProvidersWithPlugins, pluginProviders),
    [modelProvidersWithPlugins, pluginProviders],
  );
  const modelCatalogProviderInputs = useMemo(
    () =>
      buildModelCatalogProviderInputs(
        modelProvidersWithPlugins,
        modelProviderRows,
      ),
    [modelProviderRows, modelProvidersWithPlugins],
  );
  const effectiveModelCatalog = useMemo<ModelCatalogEntryInfo[]>(
    () =>
      modelCatalog.length > 0
        ? modelCatalog
        : listModelCatalogEntries({
            configuredProviders: modelCatalogProviderInputs,
          }),
    [modelCatalog, modelCatalogProviderInputs],
  );
  const voiceInputModelEntries = useMemo(
    () => effectiveModelCatalog.filter(isVoiceInputModelEntry),
    [effectiveModelCatalog],
  );
  const [localSpeechModelStatuses, setLocalSpeechModelStatuses] = useState<
    Record<string, boolean>
  >({});
  const localSpeechModelStatusesRef = useRef<Record<string, boolean>>({});
  const localSpeechProbeVersionRef = useRef(0);

  useEffect(() => {
    localSpeechModelStatusesRef.current = localSpeechModelStatuses;
  }, [localSpeechModelStatuses]);

  useEffect(() => {
    if (!(showAll || activeSection === "audio" || activeSection === "models"))
      return;
    const localModels = effectiveModelCatalog.filter(
      (entry) =>
        isLocalSpeechModelEntry(entry) &&
        localSpeechModelStatusesRef.current[entry.model.id] === undefined,
    );
    if (localModels.length === 0) return;

    let cancelled = false;
    const version = ++localSpeechProbeVersionRef.current;
    void Promise.all(
      localModels.map(async (entry) => {
        const capability = localSpeechCapability(entry);
        if (!capability) return null;
        const available = await fetchLocalSpeechModelStatus(
          capability,
          localSpeechModelValue(entry),
        ).catch(() => false);
        return [entry.model.id, available] as const;
      }),
    ).then((statuses) => {
      if (cancelled || localSpeechProbeVersionRef.current !== version) return;
      setLocalSpeechModelStatuses((current) => ({
        ...current,
        ...Object.fromEntries(
          statuses.filter(
            (status): status is readonly [string, boolean] => status !== null,
          ),
        ),
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [activeSection, effectiveModelCatalog, showAll]);

  const handleCreate = useCallback(async () => {
    if (!newTokenName.trim()) return;
    setIsCreating(true);
    try {
      const result = await createApiToken(newTokenName.trim());
      setTokens((prev) => [result.info, ...prev]);
      setRevealedToken(result.token);
      setNewTokenName("");
    } catch (err) {
      console.error("Failed to create token:", err);
    } finally {
      setIsCreating(false);
    }
  }, [newTokenName]);

  const handleCreateTokenSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void handleCreate();
    },
    [handleCreate],
  );

  const handleRevoke = useCallback(
    async (tokenId: string) => {
      try {
        await revokeApiToken(tokenId);
        setTokens((prev) => prev.filter((t) => t.id !== tokenId));
        if (revealedToken) setRevealedToken(null);
      } catch (err) {
        console.error("Failed to revoke token:", err);
      }
    },
    [revealedToken],
  );

  const handleAddVariable = useCallback(async () => {
    if (!newVarKey.trim() || !newVarValue.trim()) return;
    setIsAddingVar(true);
    try {
      const result = await setVariable(
        newVarKey.trim().toUpperCase(),
        newVarValue.trim(),
      );
      setVariables((prev) => {
        const filtered = prev.filter((v) => v.key !== result.key);
        return [result, ...filtered];
      });
      setNewVarKey("");
      setNewVarValue("");
      setShowVarValue(false);
    } catch (err) {
      console.error("Failed to set variable:", err);
    } finally {
      setIsAddingVar(false);
    }
  }, [newVarKey, newVarValue]);

  const handleAddVariableSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void handleAddVariable();
    },
    [handleAddVariable],
  );

  const handleSetVariable = useCallback(async (key: string, value: string) => {
    const normalizedKey = key
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "");
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) return;
    const result = await setVariable(normalizedKey, normalizedValue);
    setVariables((prev) => {
      const filtered = prev.filter((v) => v.key !== result.key);
      return [result, ...filtered];
    });
  }, []);

  const handleDeleteVariable = useCallback(async (varId: string) => {
    try {
      await deleteVariable(varId);
      setVariables((prev) => prev.filter((v) => v.id !== varId));
    } catch (err) {
      console.error("Failed to delete variable:", err);
    }
  }, []);

  const handleUninstallAction = useCallback(async (actionId: string) => {
    try {
      await uninstallAction(actionId);
      setActions((prev) => prev.filter((a) => a.actionId !== actionId));
    } catch (err) {
      console.error("Failed to uninstall action:", err);
    }
  }, []);

  const handleUninstallSkill = useCallback(async (skillId: string) => {
    try {
      await uninstallSkill(skillId);
      setSkills((prev) => prev.filter((s) => s.skillId !== skillId));
    } catch (err) {
      console.error("Failed to uninstall skill:", err);
    }
  }, []);

  const saveModelProviders = useCallback(
    async (nextProviders: ModelProviderAccountInfo[]) => {
      const previousProviders = modelProviders;
      setModelProviders(nextProviders);
      setIsSavingModelProviders(true);
      setModelProviderError(null);
      try {
        const savedProviders = await updateModelProviders(nextProviders);
        const nextCatalog = await listModelCatalog();
        setModelProviders(savedProviders);
        setModelCatalog(nextCatalog);
        feedback.notify({
          variant: "success",
          title: "Provider settings saved",
        });
        return savedProviders;
      } catch (err) {
        setModelProviders(previousProviders);
        const message = displayErrorMessage(err);
        setModelProviderError(message);
        feedback.notify({
          variant: "error",
          title: "Could not save provider settings",
          message,
        });
        throw err;
      } finally {
        setIsSavingModelProviders(false);
      }
    },
    [feedback, modelProviders],
  );

  const handlePatchModelProvider = useCallback(
    (key: string, patch: Partial<ModelProviderAccountInfo>) => {
      const nextProviders = patchModelProviderList(
        modelProviders,
        key,
        patch,
        modelProviderRows,
      );
      if (nextProviders === modelProviders)
        return Promise.resolve(modelProviders);
      return saveModelProviders(nextProviders);
    },
    [modelProviderRows, modelProviders, saveModelProviders],
  );

  const handlePatchModelProviders = useCallback(
    (patches: ModelProviderPatch[]) => {
      const nextProviders = patchModelProviderLists(
        modelProviders,
        patches,
        modelProviderRows,
      );
      if (nextProviders === modelProviders)
        return Promise.resolve(modelProviders);
      return saveModelProviders(nextProviders);
    },
    [modelProviderRows, modelProviders, saveModelProviders],
  );

  const handleCreateModelProvider = useCallback(
    (provider: ModelProviderAccountInfo) =>
      saveModelProviders([...modelProviders, provider]),
    [modelProviders, saveModelProviders],
  );

  const handleSaveModelCard = useCallback(
    async (modelId: string, config: Omit<UserModelCardConfig, "modelId">) => {
      setIsSavingModelCard(true);
      setModelProviderError(null);
      try {
        const saved = await saveModelCardConfig(modelId, config);
        setModelCatalog(await listModelCatalog());
        feedback.notify({
          variant: "success",
          title: config.custom ? "Text model saved" : "Model card saved",
        });
        return saved;
      } catch (err) {
        const message = displayErrorMessage(err);
        setModelProviderError(message);
        feedback.notify({
          variant: "error",
          title: "Could not save model card",
          message,
        });
        throw err;
      } finally {
        setIsSavingModelCard(false);
      }
    },
    [feedback],
  );

  const handleDeleteModelCard = useCallback(
    async (modelId: string) => {
      setIsSavingModelCard(true);
      try {
        await deleteModelCardConfig(modelId);
        setModelCatalog(await listModelCatalog());
        feedback.notify({ variant: "success", title: "Custom model removed" });
      } finally {
        setIsSavingModelCard(false);
      }
    },
    [feedback],
  );

  const handleDeleteModelProvider = useCallback(
    async (accountId: string) => {
      const previousProviders = modelProviders;
      setModelProviders((prev) =>
        prev.filter((provider) => provider.id !== accountId),
      );
      setIsSavingModelProviders(true);
      setModelProviderError(null);
      try {
        await deleteModelProvider(accountId);
        const [savedProviders, nextCatalog] = await Promise.all([
          listModelProviders(),
          listModelCatalog(),
        ]);
        setModelProviders(savedProviders);
        setModelCatalog(nextCatalog);
        feedback.notify({
          variant: "success",
          title: "Provider account removed",
        });
      } catch (err) {
        setModelProviders(previousProviders);
        const message = displayErrorMessage(err);
        setModelProviderError(message);
        feedback.notify({
          variant: "error",
          title: "Could not remove provider account",
          message,
        });
        throw err;
      } finally {
        setIsSavingModelProviders(false);
      }
    },
    [feedback, modelProviders],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listProviderOAuth(), listPluginProviders()])
      .then(([oauthRows, providerRows]) => {
        if (cancelled) return;
        setProviderOAuth(oauthRows);
        setPluginProviders(providerRows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleStartProviderOAuth = useCallback(
    async (providerId: string, accountId?: string, accountLabel?: string) => {
      try {
        const row = await startProviderOAuth(
          providerId,
          accountId,
          accountLabel,
        );
        setProviderOAuth((prev) => upsertProviderOAuthRow(prev, row));
        if (row.flow === "browser") {
          if (!row.verificationUri || !row.callbackScheme) {
            throw new Error(
              "Browser OAuth response is missing its authorization URL or callback scheme.",
            );
          }
          const authorizeProvider =
            globalThis.__CLASH_DESKTOP__?.authorizeProvider;
          if (!authorizeProvider) {
            throw new Error(
              "Browser Provider OAuth requires the Clash desktop runtime.",
            );
          }
          const authorization = await authorizeProvider({
            verificationUri: row.verificationUri,
            callbackScheme: row.callbackScheme,
          });
          if (authorization.cancelled || !authorization.callbackUrl) return;
          const completed = await completeProviderOAuth(
            providerId,
            row.deviceCode,
            accountId,
            authorization.callbackUrl,
          );
          setProviderOAuth((prev) => upsertProviderOAuthRow(prev, completed));
          const [providerRows, catalogRows] = await Promise.all([
            listModelProviders(),
            listModelCatalog(),
          ]);
          setModelProviders(providerRows);
          setModelCatalog(catalogRows);
        }
      } catch (err) {
        const message = displayErrorMessage(err);
        setProviderOAuth((prev) =>
          upsertProviderOAuthRow(prev, {
            providerId,
            ...(accountId ? { accountId } : {}),
            ...(accountLabel ? { accountLabel } : {}),
            status: "error",
            error: message,
            hasAccessToken: false,
          }),
        );
        feedback.notify({
          variant: "error",
          title: `Could not start ${providerOAuthDisplayName(providerId)} authorization`,
          message,
        });
      }
    },
    [feedback],
  );

  const handleCompleteProviderOAuth = useCallback(
    async (providerId: string, deviceCode?: string, accountId?: string) => {
      try {
        const row = await completeProviderOAuth(
          providerId,
          deviceCode,
          accountId,
        );
        setProviderOAuth((prev) => upsertProviderOAuthRow(prev, row));
        const [providerRows, catalogRows] = await Promise.all([
          listModelProviders(),
          listModelCatalog(),
        ]);
        setModelProviders(providerRows);
        setModelCatalog(catalogRows);
      } catch (err) {
        const message = displayErrorMessage(err);
        setProviderOAuth((prev) =>
          upsertProviderOAuthRow(prev, {
            providerId,
            ...(accountId ? { accountId } : {}),
            status: "error",
            error: message,
            hasAccessToken: false,
          }),
        );
        feedback.notify({
          variant: "error",
          title: `Could not complete ${providerOAuthDisplayName(providerId)} authorization`,
          message,
        });
      }
    },
    [feedback],
  );

  const handleImportLocalProviderToken = useCallback(
    async (providerId: string, accountId?: string, accountLabel?: string) => {
      try {
        const row = await importLocalProviderToken(
          providerId,
          accountId,
          accountLabel,
        );
        setProviderOAuth((prev) => upsertProviderOAuthRow(prev, row));
        const [providerRows, catalogRows] = await Promise.all([
          listModelProviders(),
          listModelCatalog(),
        ]);
        setModelProviders(providerRows);
        setModelCatalog(catalogRows);
        feedback.notify({
          variant: "success",
          title: row.importedFrom
            ? `Reused login from ${row.importedFrom}`
            : "Reused local provider login",
        });
      } catch (err) {
        const message = displayErrorMessage(err);
        setProviderOAuth((prev) =>
          upsertProviderOAuthRow(prev, {
            providerId,
            ...(accountId ? { accountId } : {}),
            ...(accountLabel ? { accountLabel } : {}),
            status: "error",
            error: message,
            hasAccessToken: false,
          }),
        );
        feedback.notify({
          variant: "error",
          title: "Could not reuse local provider login",
          message,
        });
      }
    },
    [feedback],
  );

  const handleCopy = useCallback(async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const formatDate = (date: Date | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  // When embedded, drop both the min-h-screen + sticky header — the
  // host (SettingsSurface) provides its own chrome.
  const content = (
    <div
      className={
        embedded ? "space-y-12" : "mx-auto max-w-3xl px-6 py-10 space-y-12"
      }
    >
      {/* ── Appearance ── */}
      {showSection("appearance") && <AppearanceSection />}

      {showAll && <hr className="border-warm-border" />}

      {/* ── Agents ── */}
      {showSection("agents") && <AgentsSection />}

      {/* ── Sync ── */}
      {showSection("sync") && <SyncSection />}

      {/* ── Public storage ── */}
      {showSection("public-storage") && <PublicStorageSection />}

      {showAll && <hr className="border-warm-border" />}

      {/* ── Audio ── */}
      {showSection("audio") && (
        <AudioSection
          voiceInputModels={voiceInputModelEntries}
          localSpeechModelStatuses={localSpeechModelStatuses}
        />
      )}

      {/* ── Media analysis ── */}
      {showSection("media-analysis") && <MediaAnalysisSection />}

      {showAll && <hr className="border-warm-border" />}

      {/* ── API Tokens ── */}
      {showSection("tokens") && (
        <section>
          <div className="flex items-center gap-3 mb-5">
            <Key
              className="h-5 w-5 text-stone-600 dark:text-stone-300"
              weight="bold"
            />
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
                API Tokens
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                For CLI and agent access
              </p>
            </div>
          </div>

          <form className="flex gap-2 mb-4" onSubmit={handleCreateTokenSubmit}>
            <Input
              type="text"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              placeholder="Token name"
              controlSize="lg"
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={isCreating || !newTokenName.trim()}
            >
              Create
            </Button>
          </form>

          <AnimatePresence>
            {revealedToken && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden mb-4"
              >
                <div className="rounded-xl bg-warm-muted border border-warm-border p-4">
                  <p className="text-sm font-medium text-stone-700 dark:text-stone-200 mb-2">
                    Copy this token now — it won&apos;t be shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-lg bg-warm-surface border border-warm-border px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-50 select-all truncate">
                      {revealedToken}
                    </code>
                    <IconButton
                      label="Copy new token"
                      onClick={() => handleCopy(revealedToken, "new")}
                      size="sm"
                      icon={
                        copiedId === "new" ? (
                          <Check
                            className="h-4 w-4 text-green-600"
                            weight="bold"
                          />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )
                      }
                      className="rounded-lg text-slate-800 hover:bg-warm-muted hover:text-slate-900 dark:text-slate-300 dark:hover:bg-warm-hover dark:hover:text-slate-50"
                    />
                  </div>
                  <Button
                    onClick={() => setRevealedToken(null)}
                    size="sm"
                    className="mt-2 h-auto min-h-0 border-transparent bg-transparent px-0 py-0 text-xs text-slate-700 shadow-none hover:bg-transparent hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    Dismiss
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {tokens.length === 0 ? (
            <div className="rounded-xl border border-dashed border-warm-border py-10 text-center">
              <Key
                className="h-8 w-8 text-stone-500 mx-auto mb-2 dark:text-stone-500"
                weight="duotone"
              />
              <p className="text-sm text-stone-600 dark:text-stone-300">
                No tokens yet
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className="group flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-warm-muted transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                        {token.name}
                      </span>
                      <code className="text-xs text-stone-500 dark:text-stone-400 font-mono">
                        {token.tokenPrefix}
                      </code>
                    </div>
                    <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                      Created {formatDate(token.createdAt)} · Last used{" "}
                      {formatDate(token.lastUsedAt)}
                    </p>
                  </div>
                  <IconButton
                    label={`Revoke ${token.name}`}
                    onClick={() => handleRevoke(token.id)}
                    variant="destructive"
                    size="sm"
                    icon={<Trash className="h-4 w-4" />}
                    className={settingsHoverActionClass}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {showAll && <hr className="border-warm-border" />}

      {/* ── Providers ── */}
      {showSection("providers") && (
        <ModelRoutingSection
          mode="providers"
          providers={modelProviderRows}
          providerAccounts={modelProvidersWithPlugins}
          catalog={effectiveModelCatalog}
          providerOAuth={providerOAuth}
          onStartProviderOAuth={handleStartProviderOAuth}
          onCompleteProviderOAuth={handleCompleteProviderOAuth}
          onImportLocalProviderToken={handleImportLocalProviderToken}
          onPatchProvider={handlePatchModelProvider}
          onPatchProviders={handlePatchModelProviders}
          onCreateProvider={handleCreateModelProvider}
          onDeleteProvider={handleDeleteModelProvider}
          onSaveModelCard={handleSaveModelCard}
          onDeleteModelCard={handleDeleteModelCard}
          saving={isSavingModelProviders || isSavingModelCard}
          error={modelProviderError}
          localSpeechModelStatuses={localSpeechModelStatuses}
          onLocalSpeechModelStatusesChange={setLocalSpeechModelStatuses}
        />
      )}

      {showAll && <hr className="border-warm-border" />}

      {/* ── Variables: hidden compatibility section for raw secret variables. ── */}
      {activeSection === "variables" && (
        <section>
          <div className="flex items-center gap-3 mb-5">
            <Lock
              className="h-5 w-5 text-stone-600 dark:text-stone-300"
              weight="bold"
            />
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
                API Keys
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                OpenAI image generation and canvas action keys
              </p>
            </div>
          </div>

          <div className="mb-5 divide-y divide-warm-border border-y border-warm-border">
            {providerPresets.map((preset) => {
              const configured = variableKeys.has(preset.defaultSecretId);
              return (
                <Tooltip label={preset.secretDescription} key={preset.id}>
                  <Button
                    aria-label={`${preset.label} · ${preset.defaultSecretId}`}
                    onClick={() => setNewVarKey(preset.defaultSecretId)}
                    className="flex h-auto min-h-0 w-full items-center justify-between gap-3 rounded-none border-transparent bg-transparent px-0 py-2.5 text-left shadow-none hover:bg-warm-muted"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900 dark:text-slate-50">
                        {preset.label}
                      </span>
                      <code className="block truncate text-xs text-stone-500 dark:text-stone-400">
                        {preset.defaultSecretId}
                      </code>
                    </span>
                    <span
                      className={
                        configured
                          ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                          : "rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"
                      }
                    >
                      {configured ? "Configured" : "Missing"}
                    </span>
                  </Button>
                </Tooltip>
              );
            })}
          </div>

          <form className="flex gap-2 mb-4" onSubmit={handleAddVariableSubmit}>
            <Input
              type="text"
              value={newVarKey}
              onChange={(e) =>
                setNewVarKey(
                  e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""),
                )
              }
              placeholder="KEY_NAME"
              autoComplete="off"
              controlSize="lg"
              className="w-36 font-mono"
            />
            <div className="flex-1 relative">
              <Input
                type={showVarValue ? "text" : "password"}
                value={newVarValue}
                onChange={(e) => setNewVarValue(e.target.value)}
                placeholder="Value"
                autoComplete="new-password"
                controlSize="lg"
                className="pr-9"
              />
              <IconButton
                label={
                  showVarValue ? "Hide variable value" : "Show variable value"
                }
                onClick={() => setShowVarValue(!showVarValue)}
                size="sm"
                icon={
                  showVarValue ? (
                    <EyeSlash className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )
                }
                className="absolute right-2 top-1/2 h-7 min-h-7 w-7 min-w-7 -translate-y-1/2 text-slate-700 hover:bg-transparent hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={isAddingVar || !newVarKey.trim() || !newVarValue.trim()}
            >
              Set
            </Button>
          </form>

          {variables.length === 0 ? (
            <div className="rounded-xl border border-dashed border-warm-border py-10 text-center">
              <Lock
                className="h-8 w-8 text-stone-500 mx-auto mb-2 dark:text-stone-500"
                weight="duotone"
              />
              <p className="text-sm text-stone-600 dark:text-stone-300">
                No variables yet
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {variables.map((v) => (
                <div
                  key={v.id}
                  className="group flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-warm-muted transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono font-medium text-slate-900 dark:text-slate-50">
                        {v.key}
                      </code>
                      <span className="text-[10px] text-stone-600 dark:text-stone-400 bg-warm-muted rounded-lg px-2 py-0.5">
                        saved
                      </span>
                    </div>
                    <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                      Updated {formatDate(v.updatedAt || v.createdAt)}
                    </p>
                  </div>
                  <IconButton
                    label={`Delete ${v.key}`}
                    onClick={() => handleDeleteVariable(v.id)}
                    variant="destructive"
                    size="sm"
                    icon={<Trash className="h-4 w-4" />}
                    className={settingsHoverActionClass}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {showAll && <hr className="border-warm-border" />}

      {/* ── Models ── */}
      {showSection("models") && (
        <ModelRoutingSection
          mode="models"
          providers={modelProviderRows}
          providerAccounts={modelProvidersWithPlugins}
          catalog={effectiveModelCatalog}
          providerOAuth={providerOAuth}
          onStartProviderOAuth={handleStartProviderOAuth}
          onCompleteProviderOAuth={handleCompleteProviderOAuth}
          onImportLocalProviderToken={handleImportLocalProviderToken}
          onPatchProvider={handlePatchModelProvider}
          onPatchProviders={handlePatchModelProviders}
          onCreateProvider={handleCreateModelProvider}
          onDeleteProvider={handleDeleteModelProvider}
          onSaveModelCard={handleSaveModelCard}
          onDeleteModelCard={handleDeleteModelCard}
          saving={isSavingModelProviders || isSavingModelCard}
          error={modelProviderError}
          localSpeechModelStatuses={localSpeechModelStatuses}
          onLocalSpeechModelStatusesChange={setLocalSpeechModelStatuses}
        />
      )}

      {showAll && <hr className="border-warm-border" />}

      {/* ── Installed Actions ── */}
      {showSection("actions") && (
        <section>
          <div className="flex items-center gap-3 mb-5">
            <PuzzlePiece
              className="h-5 w-5 text-stone-600 dark:text-stone-300"
              weight="bold"
            />
            <div className="flex-1">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
                Legacy Action records
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Historical manifests; executable plugins are managed by the Local
                Host
              </p>
            </div>
            <Link
              to="/marketplace/manage"
              className="text-sm font-medium text-stone-600 transition-colors hover:text-brand dark:text-stone-300 dark:hover:text-brand"
            >
              Browse
            </Link>
          </div>

          {actions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-warm-border py-10 text-center">
              <PuzzlePiece
                className="h-8 w-8 text-stone-500 mx-auto mb-2 dark:text-stone-500"
                weight="duotone"
              />
              <p className="text-sm text-stone-600 dark:text-stone-300 mb-2">
                No legacy Action records
              </p>
              <Link
                to="/marketplace/manage"
                className="text-sm font-medium text-slate-950 transition-colors hover:text-brand dark:text-slate-50 dark:hover:text-brand"
              >
                Explore Marketplace
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              {actions.map((action) => {
                const manifest = (() => {
                  try {
                    const parsed = CustomActionDefinitionSchema.safeParse(
                      JSON.parse(action.manifest),
                    );
                    return parsed.success ? parsed.data : null;
                  } catch {
                    return null;
                  }
                })();
                const secrets = manifest?.secrets ?? [];
                const missingSecrets = secrets.filter(
                  (s) => !variableKeys.has(s.id),
                );
                const modelProvider = (() => {
                  const provider = manifest?.model?.provider;
                  if (!provider) return null;
                  const presetId = normalizeActionProviderId(provider);
                  return presetId
                    ? ACTION_PROVIDER_PRESETS[presetId].label
                    : provider;
                })();
                const modelLabel = manifest?.model
                  ? `${modelProvider ?? manifest.model.provider} · ${manifest.model.name ?? manifest.model.id}`
                  : null;
                return (
                  <div
                    key={action.id}
                    className="group rounded-xl px-4 py-3 hover:bg-warm-muted transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                            {action.name}
                          </span>
                          {action.version && (
                            <span className="text-xs text-stone-500 dark:text-stone-400 font-mono">
                              v{action.version}
                            </span>
                          )}
                          {action.author && (
                            <span className="text-xs text-stone-500 dark:text-stone-400">
                              @{action.author}
                            </span>
                          )}
                        </div>
                        {action.description && (
                          <p className="text-xs text-stone-600 dark:text-stone-300 mt-0.5 line-clamp-1">
                            {action.description}
                          </p>
                        )}
                        {modelLabel && (
                          <div className="mt-1.5">
                            <span className="text-[10px] text-stone-600 dark:text-stone-300 bg-warm-surface border border-warm-border rounded-lg px-2 py-0.5 font-medium">
                              {modelLabel}
                            </span>
                          </div>
                        )}
                        {missingSecrets.length > 0 && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="text-[10px] text-amber-600 bg-amber-50 rounded-full px-2 py-0.5 font-medium">
                              Missing{" "}
                              {missingSecrets.map((s) => s.id).join(", ")}
                            </span>
                          </div>
                        )}
                      </div>
                      {action.removable === true && (
                        <IconButton
                          label={`Uninstall ${action.name}`}
                          onClick={() => handleUninstallAction(action.actionId)}
                          variant="destructive"
                          size="sm"
                          icon={<Trash className="h-4 w-4" />}
                          className={`${settingsHoverActionClass} flex-shrink-0`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {showAll && <hr className="border-warm-border" />}

      {/* ── Installed Skills ── */}
      {showSection("skills") && (
        <section>
          <div className="flex items-center gap-3 mb-5">
            <BookOpen
              className="h-5 w-5 text-stone-600 dark:text-stone-300"
              weight="bold"
            />
            <div className="flex-1">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
                Installed Skills
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                AI agent skills for Claude
              </p>
            </div>
            <Link
              to="/marketplace/manage"
              className="text-sm font-medium text-stone-600 transition-colors hover:text-brand dark:text-stone-300 dark:hover:text-brand"
            >
              Browse
            </Link>
          </div>

          {skills.length === 0 ? (
            <div className="rounded-xl border border-dashed border-warm-border py-10 text-center">
              <BookOpen
                className="h-8 w-8 text-stone-500 mx-auto mb-2 dark:text-stone-500"
                weight="duotone"
              />
              <p className="text-sm text-stone-600 dark:text-stone-300 mb-2">
                No skills installed
              </p>
              <Link
                to="/marketplace/manage"
                className="text-sm font-medium text-slate-950 transition-colors hover:text-brand dark:text-slate-50 dark:hover:text-brand"
              >
                Explore Marketplace
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="group flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-warm-muted transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                        {skill.name}
                      </span>
                      {skill.version && (
                        <span className="text-xs text-stone-500 dark:text-stone-400 font-mono">
                          v{skill.version}
                        </span>
                      )}
                      {skill.author && (
                        <span className="text-xs text-stone-500 dark:text-stone-400">
                          @{skill.author}
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="text-xs text-stone-600 dark:text-stone-300 mt-0.5 line-clamp-1">
                        {skill.description}
                      </p>
                    )}
                  </div>
                  <IconButton
                    label={`Uninstall ${skill.name}`}
                    onClick={() => handleUninstallSkill(skill.skillId)}
                    variant="destructive"
                    size="sm"
                    icon={<Trash className="h-4 w-4" />}
                    className={settingsHoverActionClass}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {showAll && <hr className="border-warm-border" />}

      {/* ── CLI ── */}
      {showSection("cli") && (
        <section className="pb-4">
          <div className="flex items-center gap-3 mb-4">
            <Terminal
              className="h-5 w-5 text-stone-600 dark:text-stone-300"
              weight="bold"
            />
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
              CLI
            </h2>
          </div>
          <code className="block rounded-xl bg-warm-muted border border-warm-border px-4 py-3 text-sm font-mono text-stone-700 dark:text-stone-200">
            npm install -g @clash/cli
          </code>
        </section>
      )}
    </div>
  );

  const scopedContent = (
    <ControlContextProvider value="settings">{content}</ControlContextProvider>
  );

  if (embedded) return scopedContent;

  return (
    <div className="min-h-screen bg-warm-surface">
      {/* Sticky header */}
      <header className="sticky top-0 z-40 border-b border-warm-border bg-warm-surface/90 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center gap-4">
          <Link
            to="/"
            className="flex items-center justify-center h-9 w-9 rounded-xl border border-warm-border text-stone-600 transition-all hover:text-slate-950 hover:border-brand/35 dark:text-stone-300 dark:hover:text-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-50">
            Settings
          </h1>
        </div>
      </header>
      {scopedContent}
    </div>
  );
}

const MODEL_PROVIDER_PRESETS: ModelProviderAccountInfo[] = [
  {
    providerId: "official",
    upstreamId: "openai",
    region: "global",
    enabled: false,
    priority: 10,
  },
  {
    providerId: "official",
    upstreamId: "anthropic",
    region: "global",
    enabled: false,
    priority: 15,
  },
  {
    providerId: "official",
    upstreamId: "google-ai-studio",
    region: "global",
    enabled: false,
    priority: 20,
  },
  {
    providerId: "official",
    upstreamId: "google-agent-platform",
    region: "global",
    enabled: false,
    priority: 25,
  },
  {
    providerId: "official",
    upstreamId: "bfl",
    region: "global",
    enabled: false,
    priority: 27,
  },
  { providerId: "fal", upstreamId: "fal", enabled: false, priority: 30 },
  { providerId: "pika", upstreamId: "pika", enabled: false, priority: 35 },
  {
    providerId: "replicate",
    upstreamId: "replicate",
    enabled: false,
    priority: 50,
  },
  { providerId: "kling", upstreamId: "kling", enabled: false, priority: 60 },
  {
    providerId: "minimax",
    upstreamId: "minimax",
    enabled: false,
    priority: 70,
  },
  {
    providerId: "volcengine",
    upstreamId: "volcengine",
    enabled: false,
    priority: 90,
  },
  {
    providerId: "elevenlabs",
    upstreamId: "elevenlabs",
    enabled: false,
    priority: 100,
  },
  { providerId: "suno", upstreamId: "suno", enabled: false, priority: 110 },
];

function modelProviderKey(
  provider: Pick<
    ModelProviderAccountInfo,
    "id" | "providerId" | "upstreamId" | "region"
  >,
): string {
  if (provider.providerId === "custom" && provider.id)
    return `custom-account:${provider.id}`;
  return [
    provider.providerId,
    provider.upstreamId ?? "",
    provider.region ?? "",
  ].join(":");
}

function modelProviderAccountIdentity(
  provider: Pick<
    ModelProviderAccountInfo,
    "id" | "providerId" | "upstreamId" | "region"
  >,
): string {
  return provider.id
    ? `account:${provider.id}`
    : `provider:${modelProviderKey(provider)}`;
}

function modelProviderLabel(
  provider: Pick<
    ModelProviderAccountInfo,
    "providerId" | "upstreamId" | "region"
  >,
): string {
  return [provider.providerId, provider.upstreamId, provider.region]
    .filter(Boolean)
    .join("/");
}

function isGoogleAiStudio(
  provider: Pick<
    ModelProviderAccountInfo,
    "providerId" | "upstreamId" | "region"
  >,
): boolean {
  return (
    provider.providerId === "official" &&
    provider.upstreamId === "google-ai-studio"
  );
}

function requiredModelProviderCredentials(
  provider: Pick<
    ModelProviderAccountInfo,
    "providerId" | "upstreamId" | "region"
  >,
): string[] {
  if (provider.providerId === "custom") return ["apiKey", "baseUrl"];
  if (provider.providerId === "fal") return ["apiKey"];
  if (provider.providerId === "pika") return ["apiKey"];
  if (provider.providerId === "replicate") return ["apiKey"];
  if (provider.providerId === "kling") return ["accessKey", "secretKey"];
  if (provider.providerId === "minimax") return ["apiKey"];
  if (provider.providerId === "volcengine") return ["apiKey"];
  if (provider.providerId === "elevenlabs") return ["apiKey"];
  if (provider.providerId === "suno") return ["apiKey", "callbackUrl"];
  if (provider.providerId === "official" && provider.upstreamId === "openai")
    return ["apiKey"];
  if (provider.providerId === "official" && provider.upstreamId === "anthropic")
    return ["apiKey"];
  if (provider.providerId === "official" && provider.upstreamId === "bfl")
    return ["apiKey"];
  // One credential is required, but which one depends on the account's `service`: an api key
  // answers on the Developer API and returns 401 "API keys are not supported by this API" on
  // Agent Platform, where a service account is what works. Requiring both would block an account
  // that is correctly configured for one surface.
  if (isGoogleAiStudio(provider)) return [];
  return [];
}

type ModelProviderCredentialField = {
  key: string;
  label: string;
  ariaLabel?: string;
  placeholder?: string;
  allowMultiple?: boolean;
  /**
   * A closed set of answers, rendered as a choice rather than a text field.
   *
   * Some account facts are not secrets to paste but selections from a list the provider defines —
   * which of two services an account belongs to, for one. Asking for those as free text invites a
   * typo in the character that distinguishes them, and tells nobody the alternative exists.
   */
  options?: { value: string; label: string }[];
  /** Pre-selected when the account has no stored value. Comes from the shared declaration. */
  defaultValue?: string;
};

type ModelProviderSetup = {
  title: string;
  description: string;
  apiKey: string;
  credentials?: ModelProviderCredentialField[];
  oauthProviderId?: ProviderOAuthId;
  localTokenImport?: {
    providerId: ProviderOAuthId;
    label: string;
  };
  requiresAllCredentials?: boolean;
  credentialRequirements?: ProviderCredentialRequirements;
  baseUrlKey?: string;
  baseUrlPlaceholder?: string;
};

function modelProviderAccountAuthId(
  setup: ModelProviderSetup,
): ProviderOAuthId | undefined {
  return setup.oauthProviderId ?? setup.localTokenImport?.providerId;
}

function modelProviderCredentialFields(
  setup: ModelProviderSetup,
): ModelProviderCredentialField[] {
  return (
    setup.credentials ?? [
      {
        key: setup.apiKey,
        label: "API key",
        ariaLabel: `${setup.title} API key`,
        allowMultiple: true,
      },
    ]
  );
}

function providerCredentialRequirementState(
  setup: ModelProviderSetup,
  configuredKeys: ReadonlySet<string>,
): { valid: boolean; message?: string } {
  const requirements = setup.credentialRequirements;
  if (!requirements) return { valid: true };
  const satisfied = requirements.anyOf.some((credentials) =>
    credentials.every((credential) => configuredKeys.has(credential)),
  );
  return satisfied
    ? { valid: true }
    : { valid: false, message: "This account needs a credential." };
}

function modelProviderSetup(
  provider: Pick<
    ModelProviderAccountInfo,
    | "providerId"
    | "upstreamId"
    | "region"
    | "label"
    | "apiShape"
    | "pluginProvider"
  >,
): ModelProviderSetup | null {
  if (provider.pluginProvider) {
    // Read the normalized source list rather than picking entries out by type name.
    // Three `find`s produced three differently shaped fields, so a Provider offering
    // two sources of one kind -- two regions, two installed clients -- silently lost
    // one, and every new kind meant another branch here.
    const sources = resolveCredentialSources(provider.pluginProvider.auth);
    // Every control the Provider declared, in the order it declared them. The previous version
    // read only `field` entries, so a `choice` -- Google's service and region, MiniMax's host --
    // was dropped from the form while the host still required it, and the account failed later
    // for a field the user was never shown.
    const declared = authFormControls(provider.pluginProvider.auth);
    const credentials = declared
      .filter(
        (
          control,
        ): control is Extract<
          AuthFormControl,
          { control: "text" | "select" }
        > => control.control === "text" || control.control === "select",
      )
      .map((control) => ({
        key: control.key,
        label: control.label,
        ariaLabel: `${provider.pluginProvider!.name} ${control.label}`,
        allowMultiple: false,
        ...(control.control === "select" ? { options: control.options } : {}),
        ...(control.value ? { defaultValue: control.value } : {}),
      }));
    const fields = sources.filter((source) => source.control === "field");
    const windowSource = sources.find(
      (source) => source.control === "button-window",
    );
    const actionSource = sources.find(
      (source) => source.control === "button-action",
    );
    return {
      title: provider.pluginProvider.name,
      description:
        provider.pluginProvider.description ??
        `Models served by the ${provider.pluginProvider.name} plugin Provider.`,
      apiKey: fields[0]?.credentialId ?? "",
      credentials,
      // The HTTP route names the Provider; the source's methodId names which declared way
      // credentials are obtained. A credential storage key such as `accessToken` is neither.
      ...(windowSource ? { oauthProviderId: provider.pluginProvider.id } : {}),
      ...(actionSource
        ? {
            localTokenImport: {
              providerId: provider.pluginProvider.id,
              label: actionSource.label,
            },
          }
        : {}),
    };
  }
  if (
    provider.providerId === "custom" &&
    (provider.apiShape === "openai-compatible" ||
      provider.apiShape === "anthropic-compatible")
  ) {
    return {
      title: provider.label ?? "Custom text provider",
      description:
        provider.apiShape === "openai-compatible"
          ? "Text models served through an OpenAI-compatible endpoint."
          : "Text models served through an Anthropic-compatible endpoint.",
      apiKey: "apiKey",
      baseUrlKey: "baseUrl",
      baseUrlPlaceholder:
        provider.apiShape === "openai-compatible"
          ? "https://provider.example/v1"
          : "https://provider.example",
    };
  }
  if (provider.providerId === "mock") {
    return {
      title: "Mock Provider",
      description:
        "Deterministic local provider used to verify provider and model routing flows.",
      apiKey: "",
      credentials: [],
    };
  }
  if (provider.providerId === "fal") {
    return {
      title: "fal.ai",
      description:
        "Image, video, and audio models served through fal.ai endpoints.",
      apiKey: "apiKey",
    };
  }
  if (provider.providerId === "official" && provider.upstreamId === "bfl") {
    return {
      title: "Black Forest Labs",
      description: "Official FLUX API for FLUX 3 video generation.",
      apiKey: "apiKey",
      baseUrlKey: "baseUrl",
      baseUrlPlaceholder: "https://api.bfl.ai",
    };
  }
  if (provider.providerId === "pika") {
    return {
      title: "Pika API Club",
      description:
        "Image, video, and audio models served through the unified Pika media API.",
      apiKey: "apiKey",
    };
  }
  if (provider.providerId === "replicate") {
    return {
      title: "Replicate",
      description: "Replicate-hosted image and media generation models.",
      apiKey: "apiKey",
    };
  }
  if (provider.providerId === "kling") {
    return {
      title: "Kling",
      description:
        "Official Kling video generation through Clash-hosted execution.",
      apiKey: "accessKey",
      credentials: [
        {
          key: "accessKey",
          label: "Access key",
          ariaLabel: "Kling access key",
          placeholder: "Paste access key",
          allowMultiple: false,
        },
        {
          key: "secretKey",
          label: "Secret key",
          ariaLabel: "Kling secret key",
          placeholder: "Paste secret key",
          allowMultiple: false,
        },
      ],
      requiresAllCredentials: true,
    };
  }
  if (provider.providerId === "minimax") {
    return {
      title: "MiniMax",
      description:
        "Official MiniMax speech generation through Clash-hosted execution.",
      apiKey: "apiKey",
      credentials: [
        {
          key: "apiKey",
          label: "API key",
          ariaLabel: "MiniMax API key",
          allowMultiple: true,
        },
        {
          // Rendered from the shared declaration rather than spelled out here, so the
          // options and the default cannot drift from what the host resolves against.
          key: "service",
          label: ACCOUNT_SETTINGS.minimax?.[0]?.label ?? "Service",
          ariaLabel: "MiniMax service",
          options: (ACCOUNT_SETTINGS.minimax?.[0]?.options ?? []).map(
            (option) => ({
              value: option.value,
              label: option.label,
            }),
          ),
          defaultValue: ACCOUNT_SETTINGS.minimax?.[0]?.defaultValue,
        },
      ],
    };
  }
  if (provider.providerId === "volcengine") {
    return {
      title: "Volcengine",
      description:
        "Official Volcengine ModelArk generation through Clash-hosted execution.",
      apiKey: "apiKey",
      baseUrlKey: "baseUrl",
      baseUrlPlaceholder: "https://ark.cn-beijing.volces.com/api/v3",
    };
  }
  if (provider.providerId === "elevenlabs") {
    return {
      title: "ElevenLabs",
      description:
        "Official ElevenLabs speech generation through Clash-hosted execution.",
      apiKey: "apiKey",
    };
  }
  if (provider.providerId === "suno") {
    return {
      title: "Suno API",
      description: "Suno V5.5 music generation through SunoAPI.org.",
      apiKey: "apiKey",
      credentials: [
        {
          key: "apiKey",
          label: "API key",
          ariaLabel: "Suno API key",
          placeholder: "Paste SunoAPI.org key",
          allowMultiple: false,
        },
        {
          key: "callbackUrl",
          label: "Callback URL",
          ariaLabel: "Suno callback URL",
          placeholder: "https://your-public-endpoint.example/suno-callback",
          allowMultiple: false,
        },
      ],
      requiresAllCredentials: true,
      baseUrlKey: "baseUrl",
      baseUrlPlaceholder: "https://api.sunoapi.org",
    };
  }
  if (provider.providerId === "official" && provider.upstreamId === "openai") {
    return {
      title: "OpenAI",
      description:
        "OpenAI text and image models through Clash-hosted execution.",
      apiKey: "apiKey",
      baseUrlKey: "baseUrl",
      baseUrlPlaceholder: "https://api.openai.com/v1",
    };
  }
  if (
    provider.providerId === "official" &&
    provider.upstreamId === "anthropic"
  ) {
    return {
      title: "Anthropic",
      description: "Anthropic text models through Clash-hosted execution.",
      apiKey: "apiKey",
      baseUrlKey: "baseUrl",
      baseUrlPlaceholder: "https://api.anthropic.com",
    };
  }
  if (isGoogleAiStudio(provider)) {
    return {
      title: "Google AI Studio",
      description:
        "Gemini models through a Google API key or Google Cloud service account.",
      apiKey: "apiKey",
      credentials: [
        {
          key: "apiKey",
          label: "API key",
          ariaLabel: "Google AI Studio API key",
          placeholder: "Paste API key",
          allowMultiple: false,
        },
        {
          key: "serviceAccountKey",
          label: "Service account JSON",
          ariaLabel: "Google Cloud service account JSON",
          placeholder: "Paste service account JSON",
          allowMultiple: false,
        },
      ],
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
      baseUrlKey: "baseUrl",
      baseUrlPlaceholder:
        "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/google-ai-studio",
    };
  }
  return null;
}

function withCredentialAvailability(
  provider: ModelProviderAccountInfo,
): ModelProviderAccountInfo {
  const configuredCredentials = provider.configuredCredentials ?? [];
  return {
    ...provider,
    configuredCredentials,
  };
}

function buildModelProviderRows(
  configured: ModelProviderAccountInfo[],
  pluginProviders: PluginProviderInfo[] = [],
): ModelProviderAccountInfo[] {
  const rows = new Map<string, ModelProviderAccountInfo>();
  for (const preset of MODEL_PROVIDER_PRESETS) {
    if (!modelProviderSetup(preset)) continue;
    rows.set(modelProviderKey(preset), withCredentialAvailability(preset));
  }
  for (const pluginProvider of pluginProviders) {
    const provider: ModelProviderAccountInfo = {
      providerId: pluginProvider.id,
      upstreamId: pluginProvider.upstreamId,
      apiShape: pluginProvider.apiShape,
      label: pluginProvider.name,
      enabled: true,
      configuredCredentials: [],
      pluginProvider,
    };
    rows.set(modelProviderKey(provider), provider);
  }
  for (const provider of configured) {
    if (!modelProviderSetup(provider)) continue;
    const key = modelProviderKey(provider);
    const existing = rows.get(key);
    if (!existing || (existing.configuredCredentials ?? []).length === 0) {
      rows.set(key, withCredentialAvailability(provider));
    }
  }
  return [...rows.values()];
}

function buildModelCatalogProviderInputs(
  configured: ModelProviderAccountInfo[],
  providerRows: ModelProviderAccountInfo[],
): ModelProviderAccountInfo[] {
  const configuredAccounts = configured
    .filter((provider) => modelProviderSetup(provider))
    .map(withCredentialAvailability);
  if (configuredAccounts.length === 0) return providerRows;
  const configuredKeys = new Set(configuredAccounts.map(modelProviderKey));
  return [
    ...configuredAccounts,
    ...providerRows.filter(
      (provider) => !configuredKeys.has(modelProviderKey(provider)),
    ),
  ];
}

function upsertModelProvider(
  providers: ModelProviderAccountInfo[],
  next: ModelProviderAccountInfo,
): ModelProviderAccountInfo[] {
  const key = modelProviderAccountIdentity(next);
  const filtered = providers.filter(
    (provider) => modelProviderAccountIdentity(provider) !== key,
  );
  return [...filtered, next];
}

type ModelProviderPatch = {
  key: string;
  patch: Partial<ModelProviderAccountInfo>;
};

function patchModelProviderList(
  providers: ModelProviderAccountInfo[],
  key: string,
  patch: Partial<ModelProviderAccountInfo>,
  fallbackRows: ModelProviderAccountInfo[] = buildModelProviderRows(providers),
): ModelProviderAccountInfo[] {
  const row = patch.id
    ? (providers.find((provider) => provider.id === patch.id) ??
      fallbackRows.find((provider) => modelProviderKey(provider) === key))
    : fallbackRows.find((provider) => modelProviderKey(provider) === key);
  if (!row) return providers;
  const credentialKeys = patch.credentials
    ? Object.entries(patch.credentials)
        .filter(
          ([, value]) => typeof value === "string" && value.trim().length > 0,
        )
        .map(([credentialKey]) => credentialKey)
    : [];
  return upsertModelProvider(providers, {
    ...row,
    ...patch,
    configuredCredentials: credentialKeys.length
      ? [
          ...new Set([...(row.configuredCredentials ?? []), ...credentialKeys]),
        ].sort()
      : (patch.configuredCredentials ?? row.configuredCredentials),
  });
}

function patchModelProviderLists(
  providers: ModelProviderAccountInfo[],
  patches: ModelProviderPatch[],
  fallbackRows?: ModelProviderAccountInfo[],
): ModelProviderAccountInfo[] {
  return patches.reduce(
    (nextProviders, { key, patch }) =>
      patchModelProviderList(nextProviders, key, patch, fallbackRows),
    providers,
  );
}

function upsertProviderOAuthRow(
  rows: ProviderOAuthInfo[],
  next: ProviderOAuthInfo,
): ProviderOAuthInfo[] {
  return [
    next,
    ...rows.filter(
      (row) =>
        row.providerId !== next.providerId ||
        (row.accountId ?? "") !== (next.accountId ?? ""),
    ),
  ];
}

type ProviderSupportRow = ReturnType<typeof listProviderModelSupport>[number];

type ProviderDraft = {
  accountId?: string;
  apiKeys?: Record<string, string>;
  baseUrl?: string;
  label?: string;
  modelAccessMode?: "all" | "specific";
  supportedModelIds?: string[];
};

const HIDDEN_CREDENTIAL_MASK = "•••• •••• ••••";

const MODEL_ACCESS_OPTIONS: SelectOption<"all" | "specific">[] = [
  {
    value: "all",
    label: "All models",
    description: "Use every model this provider supports.",
  },
  {
    value: "specific",
    label: "Specific models",
    description: "Restrict this account to selected model cards.",
  },
];

function SupportedModelPicker({
  options,
  onSelect,
}: {
  options: SelectOption<string>[];
  onSelect: (value: string) => void;
}) {
  return (
    <SearchableSelect
      ariaLabel="Add supported model"
      emptyMessage="No supported models match."
      listboxLabel="Supported models"
      matchTriggerWidth
      onValueChange={(value) => onSelect(String(value))}
      options={options}
      placeholder="Add model"
      searchAriaLabel="Search supported models"
      searchInputClassName="h-9 pl-9 pr-3 text-xs"
      searchPlaceholder="Search models..."
      triggerClassName="min-h-[34px] justify-between"
    />
  );
}

type ProviderTestModelOption = SelectOption<string> & {
  modelName: string;
  modelKind: string;
  upstreamModel: string;
  apiShape: string;
};

function ModelKindIcon({ kind }: { kind: string }) {
  const className = "h-4 w-4";
  if (kind === "video")
    return <VideoCamera className={className} aria-hidden="true" />;
  if (kind === "audio")
    return <SpeakerHigh className={className} aria-hidden="true" />;
  if (kind === "text")
    return <TextT className={className} aria-hidden="true" />;
  if (kind === "asr")
    return <Microphone className={className} aria-hidden="true" />;
  return <ImageSquare className={className} aria-hidden="true" />;
}

function providerTestModelTriggerLabel(
  option: ProviderTestModelOption,
): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{option.modelName}</span>
      <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-warm-muted px-1.5 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-slate-800 dark:text-stone-300">
        <ModelKindIcon kind={option.modelKind} />
        {option.modelKind}
      </span>
    </span>
  );
}

function providerTestModelOptionDescription(
  option: ProviderTestModelOption,
): ReactNode {
  const route = [option.upstreamModel, option.apiShape]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="inline-flex flex-shrink-0 items-center rounded-md bg-warm-muted px-1.5 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-slate-800 dark:text-stone-300">
        {option.modelKind}
      </span>
      {route ? <span className="truncate">{route}</span> : null}
    </span>
  );
}

function ProviderTestModelPicker({
  value,
  options,
  onValueChange,
}: {
  value: string;
  options: ProviderTestModelOption[];
  onValueChange: (value: string, option: ProviderTestModelOption) => void;
}) {
  const selectedOption = options.find(
    (option) => String(option.value) === String(value),
  );

  return (
    <SearchableSelect
      ariaLabel="Choose test model"
      contentWidth="min(420px, calc(100vw - 24px))"
      emptyMessage="No matching models."
      listboxLabel="Model to test"
      matchTriggerWidth
      onValueChange={(nextValue, option) =>
        onValueChange(String(nextValue), option as ProviderTestModelOption)
      }
      options={options}
      placeholder="Select model"
      searchAriaLabel="Search test models"
      searchInputClassName="h-9 pl-9 pr-3 text-xs"
      searchPlaceholder="Search models, routes, or shapes..."
      triggerLabel={
        selectedOption
          ? providerTestModelTriggerLabel(selectedOption)
          : undefined
      }
      value={value}
    />
  );
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function nextProviderAccountPriority(
  accounts: ModelProviderAccountInfo[],
): number {
  if (accounts.length === 0) return 10;
  return Math.max(...accounts.map((account) => account.priority ?? 1000)) + 10;
}

function providerAccountSort(
  a: ModelProviderAccountInfo,
  b: ModelProviderAccountInfo,
): number {
  const priority = (a.priority ?? 1000) - (b.priority ?? 1000);
  if (priority !== 0) return priority;
  return modelProviderAccountIdentity(a).localeCompare(
    modelProviderAccountIdentity(b),
  );
}

function oauthForProviderAccount(
  rows: ProviderOAuthInfo[],
  providerId: string,
  account?: Pick<ModelProviderAccountInfo, "id"> | null,
): ProviderOAuthInfo | undefined {
  return rows.find(
    (row) =>
      row.providerId === providerId &&
      (row.accountId ?? "") === (account?.id ?? ""),
  );
}

function providerOAuthStatusText(oauth?: ProviderOAuthInfo): string {
  if (!oauth) return "Not connected";
  if (oauth.status === "authorized")
    return oauth.accountLabel
      ? `Connected: ${oauth.accountLabel}`
      : "Connected";
  if (oauth.status === "pending") return "Authorization pending";
  if (oauth.status === "error")
    return oauth.error ? `Error: ${oauth.error}` : "Authorization error";
  return "Not connected";
}

function providerOAuthDisplayName(providerId: string): string {
  return providerId;
}

type SortableProviderKeyRowProps = {
  id: string;
  index: number;
  account: ModelProviderAccountInfo;
  accountLabel: string;
  accountMeta: string;
  expanded: boolean;
  expandedPanel?: ReactNode;
  disabled?: boolean;
  onOpen: () => void;
  onEnabledChange: (checked: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

function SortableProviderKeyRow({
  id,
  index,
  account,
  accountLabel,
  accountMeta,
  expanded,
  expandedPanel,
  disabled = false,
  onOpen,
  onEnabledChange,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: SortableProviderKeyRowProps) {
  const { setNodeRef, style, isDragging, dragHandleProps } = useSortableItem(
    id,
    { draggingZIndex: 20 },
  );

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`overflow-hidden rounded-xl border bg-warm-surface shadow-sm transition-colors ${
        expanded
          ? "border-brand/35 ring-2 ring-brand/10"
          : "border-warm-border hover:bg-warm-muted/30"
      } ${isDragging ? "shadow-lg ring-2 ring-brand/25" : ""}`}
    >
      <Collapsible open={expanded}>
        <div className="grid gap-3 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <IconButton
              label={`Drag ${accountLabel}`}
              size="sm"
              icon={
                <span className="flex flex-col items-center justify-center gap-1">
                  <span className="h-px w-4 rounded-full bg-current" />
                  <span className="h-px w-4 rounded-full bg-current" />
                </span>
              }
              className="h-7 min-h-7 w-5 min-w-5 shrink-0 cursor-grab rounded-md text-stone-400 hover:bg-warm-muted hover:text-stone-600 active:cursor-grabbing dark:text-stone-500 dark:hover:text-stone-200"
              {...dragHandleProps}
            />
            <CollapsibleTrigger asChild>
              <Button
                onClick={onOpen}
                className="flex h-auto min-h-0 min-w-0 flex-1 items-center justify-start gap-3 rounded-lg border-transparent bg-transparent px-0 py-0 text-left shadow-none hover:bg-transparent focus-visible:ring-offset-warm-surface"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-warm-muted text-xs font-semibold text-stone-500 dark:text-stone-300">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {accountLabel}
                  </span>
                  <code className="mt-0.5 block font-mono text-xs text-stone-500 dark:text-stone-400">
                    {accountMeta}
                  </code>
                </span>
              </Button>
            </CollapsibleTrigger>
          </div>
          <div className="flex items-center justify-end gap-1 pl-10 sm:pl-0">
            <IconButton
              label={`Move ${accountLabel} up`}
              disabled={!canMoveUp}
              onClick={(event) => {
                event.stopPropagation();
                onMoveUp();
              }}
              size="sm"
              icon={<ArrowUp className="h-4 w-4" />}
              className="h-7 min-h-7 w-7 min-w-7 rounded-md text-stone-400 hover:bg-warm-muted hover:text-stone-700 disabled:opacity-35 dark:hover:text-stone-200"
            />
            <IconButton
              label={`Move ${accountLabel} down`}
              disabled={!canMoveDown}
              onClick={(event) => {
                event.stopPropagation();
                onMoveDown();
              }}
              size="sm"
              icon={<ArrowDown className="h-4 w-4" />}
              className="h-7 min-h-7 w-7 min-w-7 rounded-md text-stone-400 hover:bg-warm-muted hover:text-stone-700 disabled:opacity-35 dark:hover:text-stone-200"
            />
            <Switch
              aria-label={`Provider enabled for ${accountLabel}`}
              checked={account.enabled !== false}
              disabled={disabled}
              onCheckedChange={onEnabledChange}
            />
            <CollapsibleTrigger asChild>
              <IconButton
                label={`${expanded ? "Collapse" : "Expand"} ${accountLabel}`}
                onClick={onOpen}
                size="sm"
                icon={
                  expanded ? (
                    <CaretDown className="h-4 w-4" />
                  ) : (
                    <CaretRight className="h-4 w-4" />
                  )
                }
                className="h-7 min-h-7 w-7 min-w-7 rounded-md text-stone-400 hover:bg-warm-muted hover:text-stone-700 dark:hover:text-stone-200"
              />
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          {expandedPanel && (
            <div
              className="border-t border-warm-border"
              onClick={(event) => event.stopPropagation()}
            >
              {expandedPanel}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function createProviderAccountId(providerKey: string): string {
  const prefix =
    providerKey.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "provider";
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function modelCardHref(modelId: string): string {
  return `/settings?section=models&model=${encodeURIComponent(modelId)}`;
}

function providerModelsHref(providerKey: string): string {
  return `/settings?section=models&provider=${encodeURIComponent(providerKey)}`;
}

function providerSettingsHref(providerKey: string): string {
  return `/settings?section=providers&provider=${encodeURIComponent(providerKey)}`;
}

/**
 * Group and label models by what they produce.
 *
 * This used to read a `task` field, falling back to a lookup table and only then to `kind`. The
 * field held `speech-to-text`, `text-to-speech` or `music-generation` on 8 of 50 cards, so the
 * filter menu offered a mixture of two vocabularies: TTS and Music beside Image and Video. It is
 * one vocabulary now -- producing one class of output is one action, and the rest is parameters.
 */
function modelKindKey(entry: ModelCatalogEntryInfo): string {
  return entry.model.kind;
}

function modelKindLabel(kind: string): string {
  return `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
}

function supportForProvider(
  supports: ProviderSupportRow[],
  provider: Pick<
    ModelProviderAccountInfo,
    "providerId" | "upstreamId" | "region"
  >,
): ProviderSupportRow | undefined {
  return supports.find(
    (support) =>
      support.providerId === provider.providerId &&
      (!provider.upstreamId || support.upstreamId === provider.upstreamId) &&
      (!provider.region ||
        !support.region ||
        support.region === provider.region),
  );
}

function providerIdForModelRoute(
  route: NonNullable<ModelCatalogEntryInfo["selectedRoute"]>,
): ModelProviderAccountInfo["providerId"] {
  if (route.providerId) return route.providerId;
  if (
    route.upstreamId === "openai" ||
    route.upstreamId === "google-ai-studio" ||
    route.upstreamId === "google-agent-platform" ||
    route.upstreamId === "anthropic" ||
    route.upstreamId === "bfl"
  )
    return "official";
  if (
    route.upstreamId === "local" ||
    route.upstreamId === "mock" ||
    route.upstreamId === "fal" ||
    route.upstreamId === "pika" ||
    route.upstreamId === "replicate" ||
    route.upstreamId === "kling" ||
    route.upstreamId === "minimax" ||
    route.upstreamId === "volcengine" ||
    route.upstreamId === "elevenlabs" ||
    route.upstreamId === "suno"
  ) {
    return route.upstreamId;
  }
  return "custom";
}

function modelRouteProviderKey(
  route: NonNullable<ModelCatalogEntryInfo["selectedRoute"]>,
): string {
  return modelProviderKey({
    providerId: providerIdForModelRoute(route),
    upstreamId: route.upstreamId,
    region: route.region,
  });
}

type ModelProviderLogoId =
  | "local"
  | "openai"
  | "anthropic"
  | "google"
  | "fal"
  | "flux"
  | "replicate"
  | "kling"
  | "minimax"
  | "jimeng"
  | "volcengine"
  | "elevenlabs";

function modelProviderLogo(
  provider: Pick<ModelProviderAccountInfo, "providerId" | "upstreamId">,
): { id: ModelProviderLogoId; src: string } | null {
  if (provider.providerId === "local" || provider.upstreamId === "local") {
    return { id: "local", src: "/brand/providers/local.svg" };
  }
  if (provider.providerId === "official" && provider.upstreamId === "openai") {
    return { id: "openai", src: "/brand/providers/openai.svg" };
  }
  if (
    provider.providerId === "official" &&
    provider.upstreamId === "anthropic"
  ) {
    return { id: "anthropic", src: "/brand/providers/anthropic.svg" };
  }
  if (
    provider.providerId === "official" &&
    (provider.upstreamId === "google-ai-studio" ||
      provider.upstreamId === "google-agent-platform")
  ) {
    return { id: "google", src: "/brand/providers/google.svg" };
  }
  if (provider.providerId === "fal") {
    return { id: "fal", src: "/brand/providers/fal.svg" };
  }
  if (provider.providerId === "official" && provider.upstreamId === "bfl") {
    return { id: "flux", src: "/brand/models/flux.svg" };
  }
  if (provider.providerId === "replicate") {
    return { id: "replicate", src: "/brand/providers/replicate.svg" };
  }
  if (provider.providerId === "kling") {
    return { id: "kling", src: "/brand/providers/kling.svg" };
  }
  if (provider.providerId === "minimax") {
    return { id: "minimax", src: "/brand/providers/minimax.svg" };
  }
  if (provider.providerId === "volcengine") {
    return { id: "volcengine", src: "/brand/providers/volcengine.svg" };
  }
  if (provider.providerId === "elevenlabs") {
    return { id: "elevenlabs", src: "/brand/providers/elevenlabs.svg" };
  }
  return null;
}

function modelProviderFilterLabel(id: string, fallback?: string): string {
  const labels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    fal: "fal.ai",
    bfl: "Black Forest Labs",
    flux: "Black Forest Labs",
    replicate: "Replicate",
    kling: "Kling",
    minimax: "MiniMax",
    jimeng: "Dreamina",
    volcengine: "Volcengine",
    elevenlabs: "ElevenLabs",
    suno: "Suno API",
    local: "Local",
    custom: "Custom",
    mock: "Mock",
  };
  return labels[id] ?? fallback ?? id;
}

type ModelBrand = {
  id:
    | ModelProviderLogoId
    | "flux"
    | "bytedance"
    | "recraft"
    | "clash"
    | "vibevoice"
    | "sensevoice"
    | "piper"
    | "kokoro"
    | "nvidia"
    | "custom";
  label: string;
  src?: string;
};

function modelCardBrand(model: ModelCatalogEntryInfo["model"]): ModelBrand {
  const identity = `${model.id} ${model.name} ${model.provider}`.toLowerCase();
  if (/(parakeet)/.test(identity)) {
    return { id: "nvidia", label: "NVIDIA", src: "/brand/models/nvidia.svg" };
  }
  if (/(vibevoice)/.test(identity)) {
    return {
      id: "vibevoice",
      label: "VibeVoice",
      src: "/brand/models/vibevoice.svg",
    };
  }
  if (/(sensevoice)/.test(identity)) {
    return {
      id: "sensevoice",
      label: "FunAudioLLM",
      src: "/brand/models/sensevoice.svg",
    };
  }
  if (/(kokoro)/.test(identity)) {
    return { id: "kokoro", label: "Kokoro", src: "/brand/models/kokoro.svg" };
  }
  if (/(piper)/.test(identity)) {
    return { id: "piper", label: "Piper", src: "/brand/models/piper.svg" };
  }
  if (/(whisper)/.test(identity)) {
    return {
      id: "openai",
      label: "OpenAI",
      src: "/brand/providers/openai.svg",
    };
  }
  if (/(flux)/.test(identity)) {
    return {
      id: "flux",
      label: "Black Forest Labs",
      src: "/brand/models/flux.svg",
    };
  }
  if (/(seedance)/.test(identity)) {
    return {
      id: "bytedance",
      label: "ByteDance Seed",
      src: "/brand/models/bytedance.svg",
    };
  }
  if (/(recraft)/.test(identity)) {
    return {
      id: "recraft",
      label: "Recraft",
      src: "/brand/models/recraft.svg",
    };
  }
  if (/(clash mock|mock image|mock text)/.test(identity)) {
    return { id: "clash", label: "Clash", src: CLASH_BRAND_ASSETS.mark.src };
  }
  if (/(nano-banana|gemini|veo|google)/.test(identity)) {
    return {
      id: "google",
      label: "Google",
      src: "/brand/providers/google.svg",
    };
  }
  if (/(gpt|openai|sora|dall-e)/.test(identity)) {
    return {
      id: "openai",
      label: "OpenAI",
      src: "/brand/providers/openai.svg",
    };
  }
  if (/(claude|anthropic)/.test(identity)) {
    return {
      id: "anthropic",
      label: "Anthropic",
      src: "/brand/providers/anthropic.svg",
    };
  }
  if (/(elevenlabs)/.test(identity)) {
    return {
      id: "elevenlabs",
      label: "ElevenLabs",
      src: "/brand/providers/elevenlabs.svg",
    };
  }
  if (/(minimax|hailuo)/.test(identity)) {
    return {
      id: "minimax",
      label: "MiniMax",
      src: "/brand/providers/minimax.svg",
    };
  }
  if (/(kling|kuaishou)/.test(identity)) {
    return { id: "kling", label: "Kling", src: "/brand/providers/kling.svg" };
  }
  if (/(jimeng|dreamina)/.test(identity)) {
    return {
      id: "jimeng",
      label: "Dreamina",
      src: "/brand/providers/jimeng.svg",
    };
  }
  if (/(volcengine|volcano|bytedance)/.test(identity)) {
    return {
      id: "volcengine",
      label: "Volcengine",
      src: "/brand/providers/volcengine.svg",
    };
  }
  if (/(replicate)/.test(identity)) {
    return {
      id: "replicate",
      label: "Replicate",
      src: "/brand/providers/replicate.svg",
    };
  }
  if (/(fal\\.ai|\\bfal\\b)/.test(identity)) {
    return { id: "fal", label: "fal", src: "/brand/providers/fal.svg" };
  }
  if (/(local|mlx|whisper|kokoro|piper)/.test(identity)) {
    if (/(local agent)/.test(identity)) {
      return { id: "clash", label: "Clash", src: CLASH_BRAND_ASSETS.mark.src };
    }
    return { id: "local", label: "Local" };
  }
  return { id: "custom", label: model.provider || "Custom" };
}

type ModelProviderStackLogo = {
  id: string;
  label: string;
  src?: string;
};

function modelCardProviderLogos(
  entry: ModelCatalogEntryInfo,
  supports: ProviderSupportRow[] = [],
): ModelProviderStackLogo[] {
  const brand = modelCardBrand(entry.model);
  const candidates: Array<{
    providerId: string;
    upstreamId: string;
    label: string;
  }> = [];
  for (const support of supports) {
    if (!support.models.some((model) => model.id === entry.model.id)) continue;
    candidates.push({
      providerId: support.providerId,
      upstreamId: support.upstreamId,
      label: modelProviderFilterLabel(support.providerId, support.upstreamId),
    });
  }
  for (const route of entry.routes) {
    candidates.push({
      providerId: providerIdForModelRoute(route),
      upstreamId: route.upstreamId,
      label: route.providerId ?? route.upstreamId,
    });
  }
  for (const candidate of entry.candidateProviders) {
    const normalized = candidate.toLowerCase();
    if (normalized === "official") {
      const upstreamId =
        brand.id === "google"
          ? "google-ai-studio"
          : brand.id === "anthropic"
            ? "anthropic"
            : "openai";
      candidates.push({
        providerId: "official",
        upstreamId,
        label: brand.label,
      });
      continue;
    }
    candidates.push({
      providerId: normalized === "google" ? "official" : normalized,
      upstreamId: normalized === "google" ? "google-ai-studio" : normalized,
      label: candidate,
    });
  }

  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const logo = modelProviderLogo(
      candidate as Pick<ModelProviderAccountInfo, "providerId" | "upstreamId">,
    );
    const fallbackId =
      candidate.providerId === "local"
        ? "local"
        : candidate.providerId === "custom"
          ? "custom"
          : candidate.providerId === "mock"
            ? "mock"
            : `${candidate.providerId}-${candidate.upstreamId}`;
    const id = logo?.id ?? fallbackId;
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        label: modelProviderFilterLabel(id, candidate.label),
        ...(logo ? { src: logo.src } : {}),
      },
    ];
  });
}

function modelAcceptsInput(
  entry: ModelCatalogEntryInfo,
  input: "text-only" | "image" | "video" | "audio",
): boolean {
  const promptModalities = new Set(entry.model.input.promptModalities);
  const inputMode = entry.model.input.inputMode;
  const accepts = {
    image:
      promptModalities.has("image") ||
      !!inputMode.images ||
      !!inputMode.startEnd,
    video: promptModalities.has("video") || !!inputMode.videos,
    audio: promptModalities.has("audio") || !!inputMode.audios,
  };
  if (input === "text-only")
    return !accepts.image && !accepts.video && !accepts.audio;
  return accepts[input];
}

interface ModelRoutingSectionProps {
  mode: "providers" | "models";
  providers: ModelProviderAccountInfo[];
  providerAccounts: ModelProviderAccountInfo[];
  catalog: ModelCatalogEntryInfo[];
  providerOAuth: ProviderOAuthInfo[];
  onStartProviderOAuth: (
    providerId: string,
    accountId?: string,
    accountLabel?: string,
  ) => Promise<void>;
  onCompleteProviderOAuth: (
    providerId: string,
    deviceCode?: string,
    accountId?: string,
  ) => Promise<void>;
  onImportLocalProviderToken: (
    providerId: string,
    accountId?: string,
    accountLabel?: string,
  ) => Promise<void>;
  onPatchProvider: (
    key: string,
    patch: Partial<ModelProviderAccountInfo>,
  ) => Promise<ModelProviderAccountInfo[]>;
  onPatchProviders: (
    patches: ModelProviderPatch[],
  ) => Promise<ModelProviderAccountInfo[]>;
  onCreateProvider: (
    provider: ModelProviderAccountInfo,
  ) => Promise<ModelProviderAccountInfo[]>;
  onDeleteProvider: (accountId: string) => Promise<void>;
  onSaveModelCard: (
    modelId: string,
    config: Omit<UserModelCardConfig, "modelId">,
  ) => Promise<UserModelCardConfig>;
  onDeleteModelCard: (modelId: string) => Promise<void>;
  saving: boolean;
  error: string | null;
  localSpeechModelStatuses: Record<string, boolean>;
  onLocalSpeechModelStatusesChange: (
    updater: (current: Record<string, boolean>) => Record<string, boolean>,
  ) => void;
}

function ModelRoutingSection({
  mode,
  providers,
  providerAccounts,
  catalog,
  providerOAuth,
  onStartProviderOAuth,
  onCompleteProviderOAuth,
  onImportLocalProviderToken,
  onPatchProvider,
  onPatchProviders,
  onCreateProvider,
  onDeleteProvider,
  onSaveModelCard,
  onDeleteModelCard,
  saving,
  error,
  localSpeechModelStatuses,
  onLocalSpeechModelStatusesChange,
}: ModelRoutingSectionProps) {
  const feedback = useAppFeedback();
  const navigate = useNavigate();
  const [providerDrafts, setProviderDrafts] = useState<
    Record<string, ProviderDraft>
  >({});
  const [providerTestModelIds, setProviderTestModelIds] = useState<
    Record<string, string>
  >({});
  const [providerTestBusyKey, setProviderTestBusyKey] = useState<string | null>(
    null,
  );
  const [providerTestResults, setProviderTestResults] = useState<
    Record<string, ModelProviderTestResult>
  >({});
  const [savingProviderKey, setSavingProviderKey] = useState<string | null>(
    null,
  );
  const [deletingProviderAccountId, setDeletingProviderAccountId] = useState<
    string | null
  >(null);
  const [providerOAuthBusyKey, setProviderOAuthBusyKey] = useState<
    string | null
  >(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(
    null,
  );
  const [addingProviderKey, setAddingProviderKey] = useState<string | null>(
    null,
  );
  const [editingProviderAccountKey, setEditingProviderAccountKey] = useState<{
    providerKey: string;
    accountKey: string;
  } | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [modelTaskFilters, setModelTaskFilters] = useState<string[]>([]);
  const [modelAvailabilityFilters, setModelAvailabilityFilters] = useState<
    ModelAvailabilityFilter[]
  >([]);
  const [modelServingProviderFilters, setModelServingProviderFilters] =
    useState<string[]>([]);
  const [modelInputFilters, setModelInputFilters] = useState<
    ModelInputFilter[]
  >([]);
  const [modelOriginFilters, setModelOriginFilters] = useState<
    ModelOriginFilter[]
  >([]);
  const [showCustomProviderForm, setShowCustomProviderForm] = useState(false);
  const [customProviderDraft, setCustomProviderDraft] = useState({
    label: "",
    apiShape: "openai-compatible" as
      "openai-compatible" | "anthropic-compatible",
    baseUrl: "",
    apiKey: "",
  });
  const [modelCardDraft, setModelCardDraft] = useState<{
    modelId: string;
    name: string;
    description: string;
    promptGuidance: string;
    providerBindings: Array<{
      providerAccountId: string;
      upstreamModel: string;
    }>;
  }>({
    modelId: "",
    name: "",
    description: "",
    promptGuidance: "",
    providerBindings: [],
  });
  const [localSpeechBusy, setLocalSpeechBusy] = useState<{
    modelId: string;
    action: "install" | "remove";
  } | null>(null);
  const providerKeyInputRef = useRef<HTMLInputElement | null>(null);
  const providerSupports = useMemo(
    () => listProviderModelSupport({ includeMock: true }),
    [],
  );
  const showProviders = mode === "providers";
  const showModels = mode === "models";
  const [searchParams] = useSearchParams();
  const focusedModelId = showModels ? searchParams.get("model") : null;
  const focusedProviderKey = showModels ? searchParams.get("provider") : null;
  const requestedProviderKey = showProviders
    ? searchParams.get("provider")
    : null;
  const focusedModelEntry =
    focusedModelId && focusedModelId !== "new"
      ? (catalog.find((entry) => entry.model.id === focusedModelId) ?? null)
      : null;
  const compatibleTextAccounts = useMemo(
    () =>
      providerAccounts.filter(
        (account) =>
          !!account.id &&
          account.enabled !== false &&
          (account.apiShape === "openai-compatible" ||
            account.apiShape === "anthropic-compatible" ||
            (account.providerId === "official" &&
              (account.upstreamId === "openai" ||
                account.upstreamId === "anthropic"))),
      ),
    [providerAccounts],
  );
  useEffect(() => {
    if (requestedProviderKey) setSelectedProviderKey(requestedProviderKey);
  }, [requestedProviderKey]);
  useEffect(() => {
    if (!focusedModelId) return;
    if (focusedModelId === "new") {
      setModelCardDraft({
        modelId: "",
        name: "",
        description: "",
        promptGuidance: "",
        providerBindings: [],
      });
      return;
    }
    if (!focusedModelEntry) return;
    setModelCardDraft({
      modelId: focusedModelEntry.model.id,
      name: focusedModelEntry.model.name,
      description: focusedModelEntry.model.description ?? "",
      promptGuidance: focusedModelEntry.model.promptGuidance ?? "",
      providerBindings: focusedModelEntry.routes.flatMap((route) =>
        route.accountId
          ? [
              {
                providerAccountId: route.accountId,
                upstreamModel: route.upstreamModel,
              },
            ]
          : [],
      ),
    });
  }, [focusedModelEntry, focusedModelId]);
  useEffect(() => {
    if (!addingProviderKey) return;
    providerKeyInputRef.current?.focus();
  }, [addingProviderKey]);
  const providerAccountsByKey = useMemo(() => {
    const rows = new Map<string, ModelProviderAccountInfo[]>();
    for (const account of providerAccounts) {
      if (!modelProviderSetup(account)) continue;
      const key = modelProviderKey(account);
      rows.set(key, [
        ...(rows.get(key) ?? []),
        withCredentialAvailability(account),
      ]);
    }
    for (const [key, accounts] of rows) {
      rows.set(key, [...accounts].sort(providerAccountSort));
    }
    return rows;
  }, [providerAccounts]);
  const commitProviderDraft = useCallback(
    async (
      key: string,
      setup: NonNullable<ReturnType<typeof modelProviderSetup>>,
      options: {
        createAccount?: boolean;
        accountId?: string;
        label?: string;
        account?: ModelProviderAccountInfo;
        priority?: number;
      } = {},
    ) => {
      const draft = providerDrafts[key] ?? {};
      const credentialDrafts = modelProviderCredentialFields(setup)
        .map(
          (credential) =>
            [
              credential.key,
              draft.apiKeys?.[credential.key]?.trim() ?? "",
            ] as const,
        )
        .filter(([, value]) => value.length > 0);
      const label = options.label?.trim();
      const hasModelAccessDraft =
        draft.modelAccessMode !== undefined ||
        draft.supportedModelIds !== undefined;
      const currentModelAccessMode =
        (options.account?.supportedModelIds ?? []).length > 0
          ? "specific"
          : "all";
      const nextModelAccessMode =
        draft.modelAccessMode ?? currentModelAccessMode;
      const nextSupportedModelIds =
        nextModelAccessMode === "all"
          ? []
          : (draft.supportedModelIds ??
            options.account?.supportedModelIds ??
            []);
      const isAuthenticatedAccountDraft =
        !!modelProviderAccountAuthId(setup) && !!options.createAccount;
      if (
        credentialDrafts.length === 0 &&
        !draft.baseUrl?.trim() &&
        !label &&
        !hasModelAccessDraft &&
        !isAuthenticatedAccountDraft
      )
        return;
      setSavingProviderKey(key);
      try {
        const credentials = Object.fromEntries(credentialDrafts);
        if (setup.baseUrlKey && draft.baseUrl?.trim())
          credentials[setup.baseUrlKey] = draft.baseUrl.trim();
        await onPatchProvider(key, {
          ...(options.account?.id ? { id: options.account.id } : {}),
          ...(options.createAccount
            ? { id: options.accountId ?? createProviderAccountId(key) }
            : {}),
          ...(options.createAccount ? { enabled: true } : {}),
          ...(options.priority !== undefined
            ? { priority: options.priority }
            : {}),
          ...(label ? { label } : {}),
          ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
          ...(hasModelAccessDraft
            ? { supportedModelIds: nextSupportedModelIds }
            : {}),
        });
        setProviderDrafts((prev) => ({ ...prev, [key]: {} }));
        return true;
      } catch {
        return false;
      } finally {
        setSavingProviderKey(null);
      }
    },
    [onPatchProvider, providerDrafts],
  );

  const reorderProviderAccounts = useCallback(
    (
      key: string,
      accounts: ModelProviderAccountInfo[],
      orderedAccountIds: string[],
    ) => {
      const accountById = new Map(
        accounts.map((account) => [
          modelProviderAccountIdentity(account),
          account,
        ]),
      );
      const ordered = orderedAccountIds
        .map((accountId) => accountById.get(accountId))
        .filter((account): account is ModelProviderAccountInfo => !!account);
      if (ordered.length !== accounts.length) return;
      void onPatchProviders(
        ordered.map((account, index) => ({
          key,
          patch: {
            ...(account.id ? { id: account.id } : {}),
            ...(account.label ? { label: account.label } : {}),
            priority: (index + 1) * 10,
          },
        })),
      );
    },
    [onPatchProviders],
  );

  const providerViewRows = useMemo(
    () =>
      providers
        .map((provider) => {
          const key = modelProviderKey(provider);
          const setup = modelProviderSetup(provider);
          const requiredKeys = requiredModelProviderCredentials(provider);
          const credentialFields = setup
            ? modelProviderCredentialFields(setup)
            : [];
          const accounts = providerAccountsByKey.get(key) ?? [];
          const accountRows =
            accounts.length > 0
              ? accounts
              : (provider.configuredCredentials ?? []).length > 0
                ? [provider]
                : [];
          const configuredKeys = [
            ...new Set([
              ...(provider.configuredCredentials ?? []),
              ...accountRows.flatMap(
                (account) => account.configuredCredentials ?? [],
              ),
            ]),
          ].sort();
          const hasBaseUrl = setup?.baseUrlKey
            ? configuredKeys.includes(setup.baseUrlKey)
            : false;
          const accountAuthProviderId = setup
            ? modelProviderAccountAuthId(setup)
            : undefined;
          const oauth = accountAuthProviderId
            ? oauthForProviderAccount(providerOAuth, accountAuthProviderId)
            : undefined;
          const hasRequiredOAuth = accountAuthProviderId
            ? accountRows.some((account) =>
                account.availableOAuth?.includes(accountAuthProviderId),
              )
            : false;
          const hasRequiredCredentials =
            credentialFields.length === 0
              ? accountRows.length > 0
              : setup?.credentialRequirements
                ? accountRows.some(
                    (account) =>
                      providerCredentialRequirementState(
                        setup,
                        new Set(account.configuredCredentials ?? []),
                      ).valid,
                  )
                : setup?.requiresAllCredentials
                  ? accountRows.some((account) =>
                      credentialFields.every((credential) =>
                        account.configuredCredentials?.includes(credential.key),
                      ),
                    )
                  : accountRows.some((account) =>
                      credentialFields.some((credential) =>
                        account.configuredCredentials?.includes(credential.key),
                      ),
                    );
          const support = supportForProvider(providerSupports, provider);
          const title = setup?.title ?? modelProviderLabel(provider);
          const searchText = [
            title,
            setup?.description,
            modelProviderLabel(provider),
            support?.models.map((model) => model.name).join(" "),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return {
            provider,
            key,
            setup,
            requiredKeys,
            configuredKeys,
            accounts: accountRows,
            oauth,
            hasBaseUrl,
            support,
            title,
            searchText,
            configured: accountAuthProviderId
              ? hasRequiredOAuth
              : hasRequiredCredentials,
          };
        })
        .filter(
          (row) =>
            !providerQuery.trim() ||
            row.searchText.includes(providerQuery.trim().toLowerCase()),
        )
        .sort((a, b) => {
          if (a.configured !== b.configured) return a.configured ? -1 : 1;
          return (a.provider.priority ?? 999) - (b.provider.priority ?? 999);
        }),
    [
      providerAccountsByKey,
      providerOAuth,
      providerQuery,
      providerSupports,
      providers,
    ],
  );
  const readyProviderCount = providerViewRows.filter(
    (row) => row.configured,
  ).length;
  const hostedModelCount = providerViewRows.reduce(
    (count, row) => count + (row.support?.models.length ?? 0),
    0,
  );
  const configuredProviderRows = providerViewRows.filter(
    (row) => row.configured,
  );
  const availableProviderRows = providerViewRows.filter(
    (row) => !row.configured,
  );
  const selectedProviderRow =
    providerViewRows.find((row) => row.key === selectedProviderKey) ?? null;
  const focusedModelSupportedProviderRows = focusedModelEntry
    ? providerViewRows.filter(
        (row) =>
          focusedModelEntry.routes.some(
            (route) => modelRouteProviderKey(route) === row.key,
          ) ||
          row.support?.models.some(
            (model) => model.id === focusedModelEntry.model.id,
          ),
      )
    : [];
  const focusedModelConfiguredProviderRows =
    focusedModelSupportedProviderRows.filter(
      (row) =>
        row.configured &&
        row.accounts.some(
          (account) =>
            !account.supportedModelIds?.length ||
            account.supportedModelIds.includes(focusedModelEntry!.model.id),
        ),
    );
  const focusedModelUnconfiguredProviderRows =
    focusedModelSupportedProviderRows.filter(
      (row) =>
        !focusedModelConfiguredProviderRows.some(
          (configuredRow) => configuredRow.key === row.key,
        ),
    );
  const focusedModelUsesLocalRuntime =
    !!focusedModelEntry && isLocalSpeechModelEntry(focusedModelEntry);
  const focusedModelLocalRuntimeReady =
    !!focusedModelEntry &&
    focusedModelUsesLocalRuntime &&
    localSpeechModelStatuses[focusedModelEntry.model.id] === true;
  const focusedProviderRow = focusedProviderKey
    ? (providerViewRows.find((row) => row.key === focusedProviderKey) ?? null)
    : null;
  const focusedProviderModelIds = useMemo(
    () =>
      new Set(
        focusedProviderRow?.support?.models.map((model) => model.id) ?? [],
      ),
    [focusedProviderRow],
  );
  const modelTaskOptions = useMemo(
    () => [...new Set(catalog.map(modelKindKey))].sort(),
    [catalog],
  );
  const modelTaskFilterOptions = useMemo(
    () =>
      modelTaskOptions.map((kind) => ({
        value: kind,
        label: modelKindLabel(kind),
      })),
    [modelTaskOptions],
  );
  const modelSupportedProviderLogos = useMemo(
    () =>
      new Map(
        catalog.map(
          (entry) =>
            [
              entry.model.id,
              modelCardProviderLogos(entry, providerSupports),
            ] as const,
        ),
      ),
    [catalog, providerSupports],
  );
  const modelServingProviderOptions = useMemo(() => {
    const providersById = new Map<string, string>();
    for (const logos of modelSupportedProviderLogos.values()) {
      for (const provider of logos)
        providersById.set(provider.id, provider.label);
    }
    return [...providersById]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [modelSupportedProviderLogos]);
  const modelNeedsProvider = useCallback(
    (entry: ModelCatalogEntryInfo) =>
      !entry.selectedRoute ||
      entry.missingCredentials.length > 0 ||
      entry.tier !== "available",
    [],
  );
  const modelIsEnabled = useCallback(
    (entry: ModelCatalogEntryInfo) => {
      if (isLocalSpeechModelEntry(entry)) {
        return localSpeechModelStatuses[entry.model.id] === true;
      }
      return !modelNeedsProvider(entry);
    },
    [localSpeechModelStatuses, modelNeedsProvider],
  );
  const enabledModelCount = useMemo(
    () => catalog.filter(modelIsEnabled).length,
    [catalog, modelIsEnabled],
  );
  const unavailableModelCount = catalog.length - enabledModelCount;
  const filteredModelCatalog = useMemo(
    () =>
      catalog
        .filter(
          (entry) =>
            !focusedProviderRow || focusedProviderModelIds.has(entry.model.id),
        )
        .filter((entry) => {
          if (!modelQuery.trim()) return true;
          const text = [
            entry.model.name,
            entry.model.id,
            entry.model.kind,
            entry.candidateProviders.join(" "),
          ]
            .join(" ")
            .toLowerCase();
          return text.includes(modelQuery.trim().toLowerCase());
        })
        .filter((entry) =>
          modelTaskFilters.every(
            (taskFilter) => modelKindKey(entry) === taskFilter,
          ),
        )
        .filter((entry) =>
          modelAvailabilityFilters.every((availabilityFilter) =>
            availabilityFilter === "enabled"
              ? modelIsEnabled(entry)
              : !modelIsEnabled(entry),
          ),
        )
        .filter((entry) =>
          modelServingProviderFilters.every((providerFilter) =>
            modelSupportedProviderLogos
              .get(entry.model.id)
              ?.some((provider) => provider.id === providerFilter),
          ),
        )
        .filter((entry) =>
          modelInputFilters.every((inputFilter) =>
            modelAcceptsInput(entry, inputFilter),
          ),
        )
        .filter((entry) =>
          modelOriginFilters.every((originFilter) =>
            originFilter === "custom"
              ? entry.model.custom === true
              : entry.model.custom !== true,
          ),
        ),
    [
      catalog,
      focusedProviderModelIds,
      focusedProviderRow,
      modelAvailabilityFilters,
      modelInputFilters,
      modelIsEnabled,
      modelOriginFilters,
      modelQuery,
      modelServingProviderFilters,
      modelSupportedProviderLogos,
      modelTaskFilters,
    ],
  );
  const visibleFilteredModelCatalog = filteredModelCatalog;
  const enabledModelCatalog =
    visibleFilteredModelCatalog.filter(modelIsEnabled);
  const unavailableModelCatalog = visibleFilteredModelCatalog.filter(
    (entry) => !modelIsEnabled(entry),
  );
  useEffect(() => {
    if (!showModels || !focusedModelId) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`model-card-${focusedModelId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedModelId, showModels, filteredModelCatalog.length]);
  const mutateLocalSpeechModel = useCallback(
    async (entry: ModelCatalogEntryInfo, action: "install" | "remove") => {
      const capability = localSpeechCapability(entry);
      const model = localSpeechModelValue(entry);
      if (!capability || !model) return;
      const label = capability === "speech-to-text" ? "ASR" : "TTS";
      const actionLabel =
        action === "install"
          ? capability === "speech-to-text"
            ? "deploy"
            : "download"
          : "remove";
      setLocalSpeechBusy({ modelId: entry.model.id, action });
      try {
        const res = await fetch(
          runtimeApiUrl(`/api/v1/local/audio/${action}`),
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ capability, model }),
          },
        );
        if (!res.ok) {
          const json = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(json?.error ?? `HTTP ${res.status}`);
        }
        await res.json();
        const available = await fetchLocalSpeechModelStatus(capability, model);
        if (action === "install" && !available) {
          throw new Error(
            `The local ${label} runtime did not report this model as ready after ${actionLabel}.`,
          );
        }
        onLocalSpeechModelStatusesChange((current) => ({
          ...current,
          [entry.model.id]: available,
        }));
        feedback.notify({
          variant: "success",
          title:
            action === "install"
              ? `Local ${label} model ${actionLabel === "deploy" ? "deployed" : "downloaded"}`
              : `Local ${label} model removed`,
        });
      } catch (err) {
        feedback.notify({
          variant: "error",
          title: `Could not ${actionLabel} local ${label} model`,
          message: displayErrorMessage(err),
        });
      } finally {
        setLocalSpeechBusy(null);
      }
    },
    [feedback, onLocalSpeechModelStatusesChange],
  );
  const renderModelCard = (entry: ModelCatalogEntryInfo) => {
    const needsProvider = !modelIsEnabled(entry);
    const focused = focusedModelId === entry.model.id;
    const brand = modelCardBrand(entry.model);
    const supportedProviderLogos =
      modelSupportedProviderLogos.get(entry.model.id) ?? [];
    const localSpeechCapabilityValue = localSpeechCapability(entry);
    const localSpeechBusyForModel = localSpeechBusy?.modelId === entry.model.id;
    const localSpeechInstalled =
      !!localSpeechCapabilityValue &&
      localSpeechModelStatuses[entry.model.id] === true;
    const localSpeechIsAsr = localSpeechCapabilityValue === "speech-to-text";
    const KindIcon = transcribesAudioToText(entry.model)
      ? Microphone
      : entry.model.kind === "image"
        ? ImageSquare
        : entry.model.kind === "video"
          ? VideoCamera
          : entry.model.kind === "audio"
            ? SpeakerHigh
            : TextT;
    return (
      <SettingsRow
        as="article"
        key={entry.model.id}
        id={`model-card-${entry.model.id}`}
        data-model-state={needsProvider ? "unavailable" : "enabled"}
        className={`group/model-card relative overflow-hidden transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-ring ${
          focused
            ? "border-ring bg-accent ring-2 ring-ring/15"
            : needsProvider
              ? "bg-muted/40"
              : ""
        }`}
      >
        <Link
          to={modelCardHref(entry.model.id)}
          aria-label={`Configure ${entry.model.name}`}
          className="block min-h-[148px] p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] bg-white p-2.5 shadow-[0_4px_14px_rgba(31,26,23,0.08)] dark:border-white/10 dark:bg-white">
              {brand.src ? (
                <img
                  src={brand.src}
                  alt=""
                  aria-hidden="true"
                  data-model-logo={brand.id}
                  draggable={false}
                  className="h-full w-full object-contain"
                />
              ) : (
                <KindIcon
                  data-model-logo={brand.id}
                  aria-hidden="true"
                  className="h-6 w-6 text-brand"
                />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="truncate text-[15px] font-semibold leading-5 text-slate-900 dark:text-slate-50">
                    {entry.model.name}
                  </h4>
                  <p className="mt-0.5 truncate text-[11px] font-medium text-stone-400 dark:text-stone-500">
                    {brand.label}
                  </p>
                </div>
                <CaretRight className="mt-0.5 h-4 w-4 shrink-0 text-stone-400 transition-transform group-hover/model-card:translate-x-0.5 group-hover/model-card:text-brand" />
              </div>
              <p className="mt-3 line-clamp-2 min-h-8 text-xs leading-4 text-stone-600 dark:text-stone-300">
                {entry.model.description || entry.model.id}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="truncate font-mono text-[10px] text-stone-400 dark:text-stone-500">
              {entry.model.id}
            </span>
            <span className="flex shrink-0 items-center gap-2.5">
              {supportedProviderLogos.length > 0 && (
                <span
                  aria-label={`Supported providers: ${supportedProviderLogos.map((provider) => provider.label).join(", ")}`}
                  className="flex flex-row-reverse items-center"
                >
                  {supportedProviderLogos.map((provider, index) => (
                    <span
                      key={provider.id}
                      title={provider.label}
                      className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-warm-surface bg-white p-1 shadow-sm ${
                        index === 0 ? "" : "-mr-1.5"
                      }`}
                    >
                      {provider.src ? (
                        <img
                          src={provider.src}
                          alt=""
                          aria-hidden="true"
                          data-model-provider-logo={provider.id}
                          draggable={false}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span
                          data-model-provider-logo={provider.id}
                          aria-hidden="true"
                          className="text-[8px] font-bold uppercase text-stone-600"
                        >
                          {provider.label.slice(0, 1)}
                        </span>
                      )}
                    </span>
                  ))}
                </span>
              )}
              <span className="flex items-center gap-1.5 rounded-full bg-warm-muted px-2 py-1 text-[10px] font-medium capitalize text-stone-600 dark:text-stone-300">
                <KindIcon className="h-3 w-3" aria-hidden="true" />
                {modelKindLabel(entry.model.kind)}
              </span>
            </span>
          </div>
        </Link>
        {localSpeechCapabilityValue && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-warm-border px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                  {localSpeechIsAsr ? "Local deploy" : "Local download"}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    localSpeechBusyForModel
                      ? "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
                      : localSpeechInstalled
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                        : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                  }`}
                >
                  {localSpeechBusyForModel
                    ? localSpeechBusy?.action === "remove"
                      ? "Removing"
                      : localSpeechIsAsr
                        ? "Deploying"
                        : "Downloading"
                    : localSpeechInstalled
                      ? localSpeechIsAsr
                        ? "Deployed"
                        : "Downloaded"
                      : localSpeechIsAsr
                        ? "Not deployed"
                        : "Not downloaded"}
                </span>
              </div>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                Uses local model cache.
              </p>
            </div>
            <Button
              aria-label={
                localSpeechInstalled
                  ? `Remove local ${localSpeechIsAsr ? "ASR" : "TTS"} model`
                  : `${localSpeechIsAsr ? "Deploy" : "Download"} local ${localSpeechIsAsr ? "ASR" : "TTS"} model`
              }
              disabled={localSpeechBusyForModel}
              onClick={() => {
                void mutateLocalSpeechModel(
                  entry,
                  localSpeechInstalled ? "remove" : "install",
                );
              }}
              size="sm"
            >
              {localSpeechBusyForModel
                ? localSpeechBusy?.action === "remove"
                  ? "Removing..."
                  : localSpeechIsAsr
                    ? "Deploying..."
                    : "Downloading..."
                : localSpeechInstalled
                  ? "Remove"
                  : localSpeechIsAsr
                    ? "Deploy"
                    : "Download"}
            </Button>
          </div>
        )}
      </SettingsRow>
    );
  };
  const renderProviderIcon = (
    provider: Pick<ModelProviderAccountInfo, "providerId" | "upstreamId">,
    title: string,
  ) => {
    const logo = modelProviderLogo(provider);
    if (!logo) {
      return (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-warm-border bg-warm-surface text-[10px] font-bold text-brand">
          {title.slice(0, 2).toUpperCase()}
        </span>
      );
    }
    return (
      <Tooltip label={`${title} logo`}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-white p-1 dark:bg-white">
          <img
            src={logo.src}
            alt=""
            aria-hidden="true"
            data-provider-logo={logo.id}
            draggable={false}
            className="h-full w-full object-contain"
          />
        </span>
      </Tooltip>
    );
  };
  const providerCredentialAccountCount = (
    row: (typeof providerViewRows)[number],
  ) => {
    const setup = row.setup;
    const credentialFields = setup ? modelProviderCredentialFields(setup) : [];
    if (credentialFields.length === 0 && row.accounts.length > 0)
      return row.accounts.length;
    const credentialAccounts = row.accounts.filter((account) =>
      credentialFields.some((credential) =>
        account.configuredCredentials?.includes(credential.key),
      ),
    );
    if (credentialAccounts.length > 0) return credentialAccounts.length;
    return row.configuredKeys.length > 0 ? 1 : 0;
  };

  const providerStatusLabel = (row: (typeof providerViewRows)[number]) => {
    if (row.oauth?.status === "pending") return "Pending";
    if (!row.configured) return "Not configured";
    const accountAuthProviderId = row.setup
      ? modelProviderAccountAuthId(row.setup)
      : undefined;
    if (accountAuthProviderId) {
      const accountCount =
        row.accounts.filter((account) =>
          account.availableOAuth?.includes(accountAuthProviderId),
        ).length ||
        row.accounts.length ||
        1;
      return `${accountCount} account${accountCount === 1 ? "" : "s"}`;
    }
    const keyCount = providerCredentialAccountCount(row) || 1;
    return `${keyCount} key${keyCount === 1 ? "" : "s"}`;
  };

  const renderProviderRow = (row: (typeof providerViewRows)[number]) => {
    const statusLabel = providerStatusLabel(row);
    return (
      <SettingsRow as="li" key={row.key}>
        <Button
          aria-label={`Open ${row.title} BYOK settings`}
          onClick={() => setSelectedProviderKey(row.key)}
          className="grid h-auto min-h-0 w-full gap-2.5 rounded-[calc(var(--settings-row-radius)-1px)] border-transparent bg-transparent px-2.5 py-1.5 text-left shadow-none hover:bg-accent/60 focus-visible:ring-inset sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {renderProviderIcon(row.provider, row.title)}
            <span className="truncate text-sm font-medium text-foreground">
              {row.title}
            </span>
          </span>
          <span className="flex shrink-0 items-center justify-between gap-2 pl-12 text-sm text-muted-foreground sm:justify-end sm:pl-0">
            <span>{statusLabel}</span>
            <CaretRight
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
          </span>
        </Button>
      </SettingsRow>
    );
  };

  const renderProviderDetail = (row: (typeof providerViewRows)[number]) => {
    const draft = providerDrafts[row.key] ?? {};
    const setup = row.setup;
    if (!setup) return null;
    const credentialFields = modelProviderCredentialFields(setup);
    const oauthProviderId = setup.oauthProviderId;
    const localTokenImport = setup.localTokenImport;
    const accountAuthProviderId = modelProviderAccountAuthId(setup);
    const supportedModelsHref = row.support?.models.length
      ? providerModelsHref(row.key)
      : "/settings?section=models";
    const setupCredentialKeys = new Set([
      ...credentialFields.map((credential) => credential.key),
      ...(setup.baseUrlKey ? [setup.baseUrlKey] : []),
    ]);
    const configuredAccounts = row.accounts.filter((account) =>
      (account.configuredCredentials ?? []).some((credentialKey) =>
        setupCredentialKeys.has(credentialKey),
      ),
    );
    const savedAccounts = (
      accountAuthProviderId
        ? row.accounts
        : credentialFields.length === 0
          ? row.accounts
          : configuredAccounts.length > 0
            ? configuredAccounts
            : row.configuredKeys.some((credentialKey) =>
                  setupCredentialKeys.has(credentialKey),
                )
              ? [row.provider]
              : []
    ).sort(providerAccountSort);
    const editingAccountKey =
      editingProviderAccountKey?.providerKey === row.key
        ? editingProviderAccountKey.accountKey
        : null;
    const editingAccount = editingAccountKey
      ? (savedAccounts.find(
          (account) =>
            modelProviderAccountIdentity(account) === editingAccountKey,
        ) ?? null)
      : null;
    const editingAccountIndex = editingAccount
      ? savedAccounts.findIndex(
          (account) =>
            modelProviderAccountIdentity(account) ===
            modelProviderAccountIdentity(editingAccount),
        )
      : -1;
    const editingAccountLabel = editingAccount
      ? (editingAccount.label ?? `API key ${editingAccountIndex + 1}`)
      : null;
    const isAddingPrioritizedKey = addingProviderKey === row.key;
    const newKeyNumber = savedAccounts.length + 1;
    const hasCredentialDraft =
      credentialFields.some((credential) =>
        draft.apiKeys?.[credential.key]?.trim(),
      ) || !!draft.baseUrl?.trim();
    const effectiveCredentialKeys = new Set(
      editingAccount?.configuredCredentials ?? [],
    );
    for (const credential of credentialFields) {
      if (draft.apiKeys?.[credential.key]?.trim())
        effectiveCredentialKeys.add(credential.key);
    }
    if (setup.baseUrlKey && draft.baseUrl?.trim())
      effectiveCredentialKeys.add(setup.baseUrlKey);
    const credentialRequirementState = providerCredentialRequirementState(
      setup,
      effectiveCredentialKeys,
    );
    const credentialConfigurationInvalid = !credentialRequirementState.valid;
    const editingSupportedModelIds = editingAccount?.supportedModelIds ?? [];
    const editingModelAccessMode: "all" | "specific" =
      editingSupportedModelIds.length > 0 ? "specific" : "all";
    const draftSupportedModelIds =
      draft.supportedModelIds ?? editingSupportedModelIds;
    const modelAccessMode: "all" | "specific" =
      draft.modelAccessMode ?? editingModelAccessMode;
    const hasModelAccessDraft =
      (draft.modelAccessMode !== undefined &&
        draft.modelAccessMode !== editingModelAccessMode) ||
      (draft.supportedModelIds !== undefined &&
        !sameStringArray(draft.supportedModelIds, editingSupportedModelIds));
    const hasProviderDraft =
      hasCredentialDraft ||
      (!!editingAccount && !!draft.label?.trim()) ||
      hasModelAccessDraft ||
      (isAddingPrioritizedKey && !!accountAuthProviderId);
    const providerTestKey = editingAccount
      ? modelProviderAccountIdentity(editingAccount)
      : `new:${row.key}`;
    const selectedSupportedModelIds = new Set(draftSupportedModelIds);
    const modelAccessInvalid =
      modelAccessMode === "specific" && draftSupportedModelIds.length === 0;
    const clearProviderTestResult = () =>
      setProviderTestResults((prev) => {
        if (!(providerTestKey in prev)) return prev;
        const { [providerTestKey]: _result, ...rest } = prev;
        return rest;
      });
    const updateProviderDraft = (patch: Partial<ProviderDraft>) => {
      clearProviderTestResult();
      setProviderDrafts((prev) => ({
        ...prev,
        [row.key]: {
          ...prev[row.key],
          ...patch,
        },
      }));
    };
    const updateCredentialDraft = (credentialKey: string, value: string) => {
      clearProviderTestResult();
      setProviderDrafts((prev) => ({
        ...prev,
        [row.key]: {
          ...prev[row.key],
          apiKeys: {
            ...prev[row.key]?.apiKeys,
            [credentialKey]: value,
          },
        },
      }));
    };
    const setSupportedModelIdsDraft = (ids: string[]) =>
      updateProviderDraft({
        modelAccessMode: "specific",
        supportedModelIds: ids,
      });
    const clearProviderDraft = () =>
      setProviderDrafts((prev) => ({ ...prev, [row.key]: {} }));
    const closeProviderKeyEditor = () => {
      setAddingProviderKey(null);
      setEditingProviderAccountKey(null);
      clearProviderDraft();
    };
    const openPrioritizedKeyEditor = () => {
      setEditingProviderAccountKey(null);
      setProviderDrafts((prev) => ({
        ...prev,
        [row.key]: accountAuthProviderId
          ? { accountId: createProviderAccountId(row.key) }
          : {},
      }));
      setAddingProviderKey(row.key);
    };
    const openExistingKeyEditor = (account: ModelProviderAccountInfo) => {
      setAddingProviderKey(null);
      clearProviderDraft();
      setEditingProviderAccountKey({
        providerKey: row.key,
        accountKey: modelProviderAccountIdentity(account),
      });
    };
    const saveDraft = async () => {
      if (!setup || !hasProviderDraft) return false;
      const createAccount = isAddingPrioritizedKey;
      if (
        isAddingPrioritizedKey &&
        !hasCredentialDraft &&
        !accountAuthProviderId
      )
        return false;
      if (modelAccessInvalid || credentialConfigurationInvalid) return false;
      const saved = await commitProviderDraft(row.key, setup, {
        createAccount,
        accountId: draft.accountId,
        account: editingAccount ?? undefined,
        priority: createAccount
          ? nextProviderAccountPriority(savedAccounts)
          : undefined,
        label: isAddingPrioritizedKey
          ? createAccount
            ? draft.label?.trim() ||
              (accountAuthProviderId
                ? `${row.title} account ${newKeyNumber}`
                : undefined)
            : draft.label?.trim()
          : draft.label?.trim(),
      });
      if (saved) {
        setAddingProviderKey((prev) => (prev === row.key ? null : prev));
        if (isAddingPrioritizedKey) {
          setEditingProviderAccountKey((prev) =>
            prev?.providerKey === row.key ? null : prev,
          );
        }
      }
      return saved;
    };
    const moveSavedAccount = (fromIndex: number, toIndex: number) => {
      const ordered = moveItem(savedAccounts, fromIndex, toIndex);
      if (!ordered) return;
      void onPatchProviders(
        ordered.map((account, index) => ({
          key: row.key,
          patch: {
            ...(account.id ? { id: account.id } : {}),
            ...(account.label ? { label: account.label } : {}),
            priority: (index + 1) * 10,
          },
        })),
      );
    };
    const accountNoun = accountAuthProviderId ? "account" : "API key";
    const editorTitle =
      editingAccountLabel ??
      (accountAuthProviderId ? "New account" : "New key");
    const editorNumber = editingAccount
      ? editingAccountIndex + 1
      : newKeyNumber;
    const editorAriaLabel = editingAccountLabel
      ? `${editingAccountLabel} ${row.title} ${accountNoun}`
      : `New ${row.title} ${accountNoun}`;
    const allProviderModels = [
      ...new Map(
        (row.support?.models ?? []).map((model) => [model.id, model]),
      ).values(),
    ];
    const allProviderModelOptions =
      allProviderModels.map<ProviderTestModelOption>((model) => {
        const option: ProviderTestModelOption = {
          value: model.id,
          modelName: model.name,
          modelKind: model.kind,
          upstreamModel: model.upstreamModel,
          apiShape: model.apiShape,
          icon: <ModelKindIcon kind={model.kind} />,
          label: model.name,
          description: "",
          searchText: [model.id, ...(model.aliases ?? [])].join(" "),
        };
        option.description = providerTestModelOptionDescription(option);
        return option;
      });
    const supportedModelOptions = allProviderModels
      .filter((model) => !selectedSupportedModelIds.has(model.id))
      .map<SelectOption<string>>((model) => ({
        value: model.id,
        label: model.name,
        description: model.id,
        searchText: (model.aliases ?? []).join(" "),
      }));
    const providerTestOptions = allProviderModelOptions.filter(
      (option) =>
        modelAccessMode !== "specific" ||
        selectedSupportedModelIds.has(option.value),
    );
    const selectedSupportedModels = draftSupportedModelIds
      .map((id) => allProviderModels.find((model) => model.id === id))
      .filter(
        (model): model is NonNullable<typeof row.support>["models"][number] =>
          !!model,
      );
    const defaultProviderTestModelId =
      providerTestOptions.find((option) => option.value === "nano-banana-2")
        ?.value ??
      providerTestOptions[0]?.value ??
      "";
    const selectedProviderTestModelId = providerTestOptions.some(
      (option) => option.value === providerTestModelIds[providerTestKey],
    )
      ? providerTestModelIds[providerTestKey]
      : defaultProviderTestModelId;
    const providerTestResult = providerTestResults[providerTestKey];
    const canRunProviderTest =
      !!editingAccount && providerTestOptions.length > 0;
    const providerTestDisabled =
      providerTestBusyKey === providerTestKey ||
      !selectedProviderTestModelId ||
      hasProviderDraft ||
      saving;
    const editingOAuth =
      accountAuthProviderId && editingAccount
        ? oauthForProviderAccount(
            providerOAuth,
            accountAuthProviderId,
            editingAccount,
          )
        : undefined;
    const editingOAuthBusyKey =
      accountAuthProviderId && editingAccount?.id
        ? `${accountAuthProviderId}:${editingAccount.id}`
        : null;
    const editingOAuthBusy = editingOAuthBusyKey
      ? providerOAuthBusyKey === editingOAuthBusyKey
      : false;
    const runProviderTest = async () => {
      if (
        !canRunProviderTest ||
        providerTestDisabled ||
        !editingAccount ||
        !selectedProviderTestModelId
      )
        return;
      setProviderTestBusyKey(providerTestKey);
      try {
        const result = await testModelProvider({
          provider: editingAccount,
          modelId: selectedProviderTestModelId,
          live: true,
        });
        setProviderTestResults((prev) => ({
          ...prev,
          [providerTestKey]: result,
        }));
      } catch (err) {
        setProviderTestResults((prev) => ({
          ...prev,
          [providerTestKey]: {
            ok: false,
            providerId: editingAccount.providerId,
            ...(editingAccount.upstreamId
              ? { upstreamId: editingAccount.upstreamId }
              : {}),
            ...(editingAccount.region ? { region: editingAccount.region } : {}),
            modelId: selectedProviderTestModelId,
            message: displayErrorMessage(err),
          },
        }));
      } finally {
        setProviderTestBusyKey(null);
      }
    };
    const canDeleteAccount = !!editingAccount?.id;
    const deleteSavedAccount = async () => {
      if (!editingAccount?.id) return;
      setDeletingProviderAccountId(editingAccount.id);
      try {
        await onDeleteProvider(editingAccount.id);
        setProviderTestResults((prev) => {
          const { [providerTestKey]: _result, ...rest } = prev;
          return rest;
        });
        closeProviderKeyEditor();
      } finally {
        setDeletingProviderAccountId(null);
      }
    };
    const handleProviderKeyEditorSubmit = (
      event: FormEvent<HTMLFormElement>,
    ) => {
      event.preventDefault();
      if (modelAccessInvalid || savingProviderKey === row.key || saving) return;
      void saveDraft();
    };
    const renderProviderKeyEditor = ({
      includeHeader,
    }: {
      includeHeader: boolean;
    }) => (
      <div
        role="group"
        aria-label={editorAriaLabel}
        className={
          includeHeader
            ? "overflow-hidden rounded-xl border border-warm-border bg-warm-surface shadow-sm"
            : "bg-warm-surface"
        }
      >
        {includeHeader && (
          <div className="flex items-center justify-between gap-3 border-b border-warm-border px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-warm-muted text-xs font-semibold text-stone-500 dark:text-stone-300">
                {editorNumber}
              </span>
              <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                {editorTitle}
              </span>
            </div>
            <IconButton
              label={`Collapse ${editorTitle}`}
              onClick={closeProviderKeyEditor}
              size="sm"
              icon={<CaretDown className="h-4 w-4" />}
              className="rounded-md text-stone-400 hover:bg-warm-muted hover:text-stone-700 dark:hover:text-stone-200"
            />
          </div>
        )}
        <form
          onSubmit={handleProviderKeyEditorSubmit}
          className="space-y-4 px-4 py-4"
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">
              Name (optional)
            </span>
            <Input
              aria-label={`${row.title} ${accountAuthProviderId ? "account" : "key"} name`}
              type="text"
              value={draft.label ?? ""}
              onChange={(e) => updateProviderDraft({ label: e.target.value })}
              placeholder={editingAccountLabel ?? "e.g. Production, Team A"}
              controlSize="lg"
            />
          </label>
          {credentialFields.map((credential, index) => (
            <label key={credential.key} className="block">
              <span className="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">
                {credential.label}
              </span>
              {credential.options ? (
                // Not every account fact is a secret to paste. A closed set is
                // rendered as a choice: masking it would hide the answer from the
                // person checking it, and a text field would invite a typo in the
                // one character that separates two services.
                <SelectMenu
                  ariaLabel={
                    credential.ariaLabel ?? `${setup.title} ${credential.label}`
                  }
                  value={
                    draft.apiKeys?.[credential.key] ??
                    credential.defaultValue ??
                    credential.options[0]?.value ??
                    ""
                  }
                  onValueChange={(value) =>
                    updateCredentialDraft(credential.key, value)
                  }
                  options={credential.options}
                  variant="field"
                />
              ) : (
                <span className="relative block">
                  <Input
                    aria-label={
                      credential.ariaLabel ??
                      `${setup.title} ${credential.label}`
                    }
                    type="password"
                    value={draft.apiKeys?.[credential.key] ?? ""}
                    onChange={(e) =>
                      updateCredentialDraft(credential.key, e.target.value)
                    }
                    placeholder={
                      editingAccount
                        ? "Saved credential"
                        : (credential.placeholder ??
                          (index === 0 && savedAccounts.length > 0
                            ? "Paste another API key"
                            : "Paste API key"))
                    }
                    autoComplete="new-password"
                    ref={index === 0 ? providerKeyInputRef : undefined}
                    controlSize="lg"
                    className="pr-10"
                  />
                  <Eye
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
                    aria-hidden="true"
                  />
                </span>
              )}
            </label>
          ))}
          {setup.baseUrlKey && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">
                Base URL
              </span>
              <Input
                aria-label={`${setup.title} base URL`}
                type="url"
                value={draft.baseUrl ?? ""}
                onChange={(e) =>
                  updateProviderDraft({ baseUrl: e.target.value })
                }
                placeholder={
                  row.hasBaseUrl ? "Saved base URL" : setup.baseUrlPlaceholder
                }
                controlSize="lg"
              />
            </label>
          )}
          {hasCredentialDraft && credentialRequirementState.message && (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              {credentialRequirementState.message}
            </p>
          )}
          {accountAuthProviderId && editingAccount?.id && (
            <div className="rounded-xl border border-warm-border bg-warm-muted/20 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                    Authorization
                  </div>
                  <p className="mt-1 text-xs font-medium text-stone-500 dark:text-stone-400">
                    {providerOAuthStatusText(editingOAuth)}
                  </p>
                  {editingOAuth?.verificationUri && (
                    <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
                      Open {editingOAuth.verificationUri}
                      {editingOAuth.userCode
                        ? ` and enter ${editingOAuth.userCode}`
                        : ""}
                      .
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {oauthProviderId && (
                    <Button
                      disabled={editingOAuthBusy}
                      size="sm"
                      onClick={async () => {
                        if (!editingOAuthBusyKey || !editingAccount.id) return;
                        setProviderOAuthBusyKey(editingOAuthBusyKey);
                        try {
                          await onStartProviderOAuth(
                            oauthProviderId,
                            editingAccount.id,
                            draft.label?.trim() || editingAccount.label,
                          );
                        } finally {
                          setProviderOAuthBusyKey(null);
                        }
                      }}
                    >
                      {editingOAuth?.status === "pending"
                        ? "Restart authorization"
                        : editingOAuth?.status === "authorized"
                          ? "Reconnect"
                          : "Connect"}
                    </Button>
                  )}
                  {oauthProviderId &&
                    editingOAuth?.status === "pending" &&
                    editingOAuth.flow !== "browser" && (
                      <Button
                        disabled={editingOAuthBusy}
                        variant="primary"
                        size="sm"
                        onClick={async () => {
                          if (!editingOAuthBusyKey || !editingAccount.id)
                            return;
                          setProviderOAuthBusyKey(editingOAuthBusyKey);
                          try {
                            await onCompleteProviderOAuth(
                              oauthProviderId,
                              editingOAuth.deviceCode,
                              editingAccount.id,
                            );
                          } finally {
                            setProviderOAuthBusyKey(null);
                          }
                        }}
                      >
                        Complete
                      </Button>
                    )}
                  {localTokenImport && (
                    <Button
                      disabled={editingOAuthBusy}
                      size="sm"
                      onClick={async () => {
                        if (!editingOAuthBusyKey || !editingAccount.id) return;
                        setProviderOAuthBusyKey(editingOAuthBusyKey);
                        try {
                          await onImportLocalProviderToken(
                            localTokenImport.providerId,
                            editingAccount.id,
                            draft.label?.trim() || editingAccount.label,
                          );
                        } finally {
                          setProviderOAuthBusyKey(null);
                        }
                      }}
                    >
                      {localTokenImport.label}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          {accountAuthProviderId && !editingAccount && (
            <div className="rounded-xl border border-warm-border bg-warm-muted/20 p-3 text-xs font-medium text-stone-500 dark:text-stone-400">
              Save this account before starting authorization.
            </div>
          )}
          {allProviderModelOptions.length > 0 && (
            <div className="rounded-xl border border-warm-border bg-warm-muted/20 p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-start">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                    Model access
                  </div>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    Choose which supported model cards this account can serve.
                  </p>
                </div>
                <SelectMenu
                  value={modelAccessMode}
                  options={MODEL_ACCESS_OPTIONS}
                  onValueChange={(value) => {
                    updateProviderDraft({
                      modelAccessMode: value,
                      supportedModelIds:
                        value === "specific" ? [...draftSupportedModelIds] : [],
                    });
                  }}
                  ariaLabel="Model access"
                  variant="field"
                  menuWidth="trigger"
                />
              </div>
              {modelAccessMode === "specific" && (
                <div className="mt-3 space-y-3">
                  {selectedSupportedModels.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedSupportedModels.map((model) => (
                        <span
                          key={model.id}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-warm-border bg-warm-surface px-2.5 py-1 text-xs font-medium text-slate-800 dark:text-slate-100"
                        >
                          <span className="truncate">{model.name}</span>
                          <IconButton
                            label={`Remove ${model.name}`}
                            onClick={() =>
                              setSupportedModelIdsDraft(
                                draftSupportedModelIds.filter(
                                  (id) => id !== model.id,
                                ),
                              )
                            }
                            size="sm"
                            icon={<X className="h-3.5 w-3.5" />}
                            className="h-5 min-h-5 w-5 min-w-5 rounded text-stone-400 hover:bg-warm-muted hover:text-slate-700 dark:hover:text-slate-100"
                          />
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      Add at least one model before saving this restriction.
                    </p>
                  )}
                  <SupportedModelPicker
                    options={supportedModelOptions}
                    onSelect={(value) =>
                      setSupportedModelIdsDraft([
                        ...draftSupportedModelIds,
                        value,
                      ])
                    }
                  />
                </div>
              )}
            </div>
          )}
          {canRunProviderTest && (
            <div className="rounded-xl border border-warm-border bg-warm-muted/25 p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="min-w-0">
                  <span className="mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400">
                    Model to test
                  </span>
                  <ProviderTestModelPicker
                    value={selectedProviderTestModelId}
                    options={providerTestOptions}
                    onValueChange={(value) => {
                      setProviderTestModelIds((prev) => ({
                        ...prev,
                        [providerTestKey]: String(value),
                      }));
                      setProviderTestResults((prev) => {
                        const { [providerTestKey]: _result, ...rest } = prev;
                        return rest;
                      });
                    }}
                  />
                </div>
                <Button
                  aria-label="Run provider test"
                  size="sm"
                  disabled={providerTestDisabled}
                  onClick={() => {
                    void runProviderTest();
                  }}
                >
                  {providerTestBusyKey === providerTestKey
                    ? "Testing..."
                    : "Run test"}
                </Button>
              </div>
              {providerTestResult && (
                <div className="mt-3 space-y-3">
                  <p
                    className={`text-xs font-medium ${
                      providerTestResult.ok
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-amber-700 dark:text-amber-300"
                    }`}
                  >
                    {providerTestResult.message}
                  </p>
                  {(providerTestResult.input || providerTestResult.output) && (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {providerTestResult.input && (
                        <div className="min-w-0">
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                            Input
                          </div>
                          <pre
                            aria-label="Provider test input"
                            className={`${settingsCodeBlockClass} whitespace-pre-wrap break-words text-xs leading-5`}
                          >
                            {formatProviderTestPayload(
                              providerTestResult.input,
                            )}
                          </pre>
                        </div>
                      )}
                      {providerTestResult.output && (
                        <div className="min-w-0">
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                            Output
                          </div>
                          <pre
                            aria-label="Provider test output"
                            className={`${settingsCodeBlockClass} whitespace-pre-wrap break-words text-xs leading-5`}
                          >
                            {formatProviderTestPayload(
                              providerTestResult.output,
                            )}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {(includeHeader ||
            hasProviderDraft ||
            savingProviderKey === row.key ||
            canDeleteAccount) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                {canDeleteAccount && (
                  <Button
                    onClick={() => {
                      void deleteSavedAccount();
                    }}
                    disabled={
                      deletingProviderAccountId === editingAccount?.id || saving
                    }
                    variant="destructive"
                    size="sm"
                    leftIcon={<Trash className="h-4 w-4" />}
                    className={settingsHoverActionClass}
                  >
                    {deletingProviderAccountId === editingAccount?.id
                      ? "Removing..."
                      : "Remove key"}
                  </Button>
                )}
              </div>
              <div className="flex justify-end gap-2">
                {includeHeader && (
                  <Button onClick={closeProviderKeyEditor} size="sm">
                    Cancel
                  </Button>
                )}
                {(hasProviderDraft || savingProviderKey === row.key) && (
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={
                      modelAccessInvalid ||
                      credentialConfigurationInvalid ||
                      savingProviderKey === row.key ||
                      saving
                    }
                  >
                    {savingProviderKey === row.key ? "Saving..." : "Save"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </form>
      </div>
    );
    return (
      <div className="space-y-6">
        <div className="border-b border-warm-border pb-6">
          <Button
            aria-label="Back to BYOK"
            onClick={() => {
              setSelectedProviderKey(null);
              setAddingProviderKey(null);
              setEditingProviderAccountKey(null);
            }}
            size="sm"
            leftIcon={<ArrowLeft className="h-4 w-4" />}
            className="mb-5 h-auto min-h-0 gap-2 border-transparent bg-transparent px-0 py-0 text-sm font-medium text-stone-500 shadow-none hover:bg-transparent hover:text-slate-950 dark:text-stone-300 dark:hover:text-slate-50"
          >
            <span>BYOK</span>
            <CaretRight
              className="h-3.5 w-3.5 text-stone-400"
              aria-hidden="true"
            />
            <span className="text-slate-900 dark:text-slate-50">
              {row.title}
            </span>
          </Button>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              {renderProviderIcon(row.provider, row.title)}
              <div className="min-w-0">
                <h2 className="font-display text-xl font-bold text-slate-900 dark:text-slate-50">
                  {row.title}
                </h2>
                <Link
                  to={supportedModelsHref}
                  aria-label="View supported models"
                  className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-stone-500 transition-colors hover:text-brand dark:text-stone-300 dark:hover:text-brand-light"
                >
                  View supported models
                  <CaretRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        </div>

        {setup && (
          <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
            <aside className="text-sm text-stone-500 dark:text-stone-400">
              <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-50">
                <Key className="h-4 w-4" aria-hidden="true" />
                <span>
                  {accountAuthProviderId
                    ? "Provider Accounts"
                    : "Provider Keys"}
                </span>
              </div>
              <p className="mt-3 leading-7">
                {accountAuthProviderId
                  ? "Add and authorize provider accounts. Drag an account by its handle to reorder priority."
                  : "Add and configure your API keys. Drag a key by its handle to reorder priority."}
              </p>
            </aside>
            <div className="space-y-9">
              <section className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                      Prioritized
                    </h3>
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                      Attempted in order, before falling back to Clash-hosted
                      endpoints.
                    </p>
                  </div>
                  <Button
                    aria-label={`Add prioritized ${row.title} ${accountAuthProviderId ? "account" : "key"}`}
                    onClick={openPrioritizedKeyEditor}
                    size="sm"
                    leftIcon={<Plus className="h-3.5 w-3.5" />}
                  >
                    {accountAuthProviderId ? "Add account" : "Add key"}
                  </Button>
                </div>
                <div className="space-y-3">
                  {savedAccounts.length > 0 && (
                    <SortableList
                      items={savedAccounts.map(modelProviderAccountIdentity)}
                      onReorder={(orderedAccountIds) =>
                        reorderProviderAccounts(
                          row.key,
                          savedAccounts,
                          orderedAccountIds,
                        )
                      }
                    >
                      <SettingsCollection
                        as="ul"
                        aria-label={`${row.title} prioritized ${accountAuthProviderId ? "accounts" : "keys"}`}
                      >
                        {savedAccounts.map((account, index) => {
                          const accountKey =
                            modelProviderAccountIdentity(account);
                          const accountLabel =
                            account.label ??
                            `${accountAuthProviderId ? "Account" : "API key"} ${index + 1}`;
                          const accountOAuth = accountAuthProviderId
                            ? oauthForProviderAccount(
                                providerOAuth,
                                accountAuthProviderId,
                                account,
                              )
                            : undefined;
                          const accountMeta = accountAuthProviderId
                            ? providerOAuthStatusText(accountOAuth)
                            : HIDDEN_CREDENTIAL_MASK;
                          const expanded = editingAccountKey === accountKey;
                          return (
                            <SortableProviderKeyRow
                              key={accountKey}
                              id={accountKey}
                              index={index}
                              account={account}
                              accountLabel={accountLabel}
                              accountMeta={accountMeta}
                              expanded={expanded}
                              expandedPanel={
                                expanded
                                  ? renderProviderKeyEditor({
                                      includeHeader: false,
                                    })
                                  : undefined
                              }
                              disabled={saving}
                              onOpen={() => {
                                if (expanded) closeProviderKeyEditor();
                                else openExistingKeyEditor(account);
                              }}
                              onEnabledChange={(checked) => {
                                void onPatchProvider(row.key, {
                                  ...(account.id ? { id: account.id } : {}),
                                  ...(account.label
                                    ? { label: account.label }
                                    : {}),
                                  enabled: checked,
                                });
                              }}
                              onMoveUp={() =>
                                moveSavedAccount(index, index - 1)
                              }
                              onMoveDown={() =>
                                moveSavedAccount(index, index + 1)
                              }
                              canMoveUp={index > 0}
                              canMoveDown={index < savedAccounts.length - 1}
                            />
                          );
                        })}
                      </SettingsCollection>
                    </SortableList>
                  )}

                  {savedAccounts.length === 0 && !isAddingPrioritizedKey && (
                    <div className="flex min-h-20 items-center justify-center rounded-xl border border-dashed border-warm-border bg-warm-muted/20 px-4 py-5 text-sm font-medium text-stone-500 dark:text-stone-400">
                      <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                      Add a prioritized{" "}
                      {accountAuthProviderId ? "account" : "key"}
                    </div>
                  )}

                  {isAddingPrioritizedKey &&
                    renderProviderKeyEditor({ includeHeader: true })}
                </div>
              </section>
              {savingProviderKey === row.key && (
                <div
                  className="text-xs font-medium text-stone-500 dark:text-stone-400"
                  aria-live="polite"
                >
                  Saving {modelProviderLabel(row.provider)} credentials…
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const saveCustomProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = customProviderDraft.label.trim();
    const baseUrl = customProviderDraft.baseUrl.trim();
    const apiKey = customProviderDraft.apiKey.trim();
    if (!label || !baseUrl || !apiKey) return;
    const id =
      typeof globalThis.crypto?.randomUUID === "function"
        ? `custom-${globalThis.crypto.randomUUID()}`
        : `custom-${Date.now()}`;
    await onCreateProvider({
      id,
      providerId: "custom",
      upstreamId:
        customProviderDraft.apiShape === "openai-compatible"
          ? "openai"
          : "anthropic",
      apiShape: customProviderDraft.apiShape,
      label,
      enabled: true,
      credentials: { apiKey, baseUrl },
    });
    setCustomProviderDraft({
      label: "",
      apiShape: "openai-compatible",
      baseUrl: "",
      apiKey: "",
    });
    setShowCustomProviderForm(false);
  };

  const renderCustomProviderForm = () => (
    <form
      onSubmit={(event) => {
        void saveCustomProvider(event);
      }}
      className="space-y-5 rounded-2xl border border-brand/25 bg-brand-light/20 p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
            Custom text provider
          </h3>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Connect one endpoint that follows the OpenAI or Anthropic text
            protocol.
          </p>
        </div>
        <IconButton
          label="Cancel custom provider"
          onClick={() => setShowCustomProviderForm(false)}
          size="sm"
          icon={<X className="h-4 w-4" />}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
          <span>Provider name</span>
          <Input
            aria-label="Provider name"
            value={customProviderDraft.label}
            onChange={(event) =>
              setCustomProviderDraft((current) => ({
                ...current,
                label: event.target.value,
              }))
            }
            placeholder="Editorial proxy"
            controlSize="lg"
          />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
          <span>Text protocol</span>
          <SelectMenu
            ariaLabel="Text protocol"
            value={customProviderDraft.apiShape}
            options={TEXT_PROTOCOL_OPTIONS}
            onValueChange={(value) =>
              setCustomProviderDraft((current) => ({
                ...current,
                apiShape: value,
              }))
            }
            variant="field"
          />
        </label>
      </div>
      <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
        <span>Base URL</span>
        <Input
          aria-label="Base URL"
          value={customProviderDraft.baseUrl}
          onChange={(event) =>
            setCustomProviderDraft((current) => ({
              ...current,
              baseUrl: event.target.value,
            }))
          }
          placeholder={
            customProviderDraft.apiShape === "openai-compatible"
              ? "https://provider.example/v1"
              : "https://provider.example"
          }
          controlSize="lg"
          className="font-mono"
        />
      </label>
      <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
        <span>API key</span>
        <Input
          aria-label="API key"
          type="password"
          autoComplete="new-password"
          value={customProviderDraft.apiKey}
          onChange={(event) =>
            setCustomProviderDraft((current) => ({
              ...current,
              apiKey: event.target.value,
            }))
          }
          controlSize="lg"
          className="font-mono"
        />
      </label>
      <SettingsActions>
        <Button
          type="submit"
          aria-label="Save custom provider"
          variant="primary"
          disabled={
            saving ||
            !customProviderDraft.label.trim() ||
            !customProviderDraft.baseUrl.trim() ||
            !customProviderDraft.apiKey.trim()
          }
        >
          {saving ? "Saving…" : "Save provider"}
        </Button>
      </SettingsActions>
    </form>
  );

  const focusedModelProviderAccounts = focusedModelEntry
    ? providerAccounts
        .filter((account) => !!account.id && account.enabled !== false)
        .filter((account) =>
          focusedModelEntry.routes.some(
            (route) =>
              (!route.accountId || route.accountId === account.id) &&
              route.providerId === account.providerId &&
              route.upstreamId === account.upstreamId &&
              (!route.region ||
                !account.region ||
                route.region === account.region),
          ),
        )
        .sort((a, b) => {
          const aPriority =
            a.modelPriorities?.[focusedModelEntry.model.id] ??
            a.priority ??
            1000;
          const bPriority =
            b.modelPriorities?.[focusedModelEntry.model.id] ??
            b.priority ??
            1000;
          return aPriority - bPriority;
        })
    : [];

  const modelAccountLabel = (account: ModelProviderAccountInfo) =>
    account.label ??
    modelProviderSetup(account)?.title ??
    modelProviderLabel(account);

  const toggleModelBinding = (
    account: ModelProviderAccountInfo,
    checked: boolean,
  ) => {
    if (!account.id) return;
    setModelCardDraft((current) => ({
      ...current,
      providerBindings: checked
        ? [
            ...current.providerBindings,
            {
              providerAccountId: account.id!,
              upstreamModel: current.modelId.trim() || "",
            },
          ]
        : current.providerBindings.filter(
            (binding) => binding.providerAccountId !== account.id,
          ),
    }));
  };

  const renderModelDetail = () => {
    const creating = focusedModelId === "new";
    const entry = focusedModelEntry;
    if (!creating && !entry) {
      return (
        <div className="rounded-xl border border-dashed border-warm-border p-8 text-center text-sm text-stone-600 dark:text-stone-300">
          This model card is no longer available.
        </div>
      );
    }
    const custom = creating || entry?.model.custom === true;
    const detailBrand = entry ? modelCardBrand(entry.model) : null;
    const providerOrderAccounts = custom
      ? modelCardDraft.providerBindings.flatMap((binding) => {
          const account = compatibleTextAccounts.find(
            (candidate) => candidate.id === binding.providerAccountId,
          );
          return account ? [account] : [];
        })
      : focusedModelProviderAccounts;
    const moveFocusedProvider = (fromIndex: number, toIndex: number) => {
      const ordered = moveItem(providerOrderAccounts, fromIndex, toIndex);
      if (!ordered) return;
      if (custom) {
        const bindings = new Map(
          modelCardDraft.providerBindings.map((binding) => [
            binding.providerAccountId,
            binding,
          ]),
        );
        setModelCardDraft((current) => ({
          ...current,
          providerBindings: ordered.flatMap((account) => {
            const binding = account.id ? bindings.get(account.id) : undefined;
            return binding ? [binding] : [];
          }),
        }));
        return;
      }
      void onPatchProviders(
        ordered.flatMap((account, index) =>
          account.id
            ? [
                {
                  key: modelProviderKey(account),
                  patch: {
                    id: account.id,
                    modelPriorities: {
                      ...(account.modelPriorities ?? {}),
                      [entry!.model.id]: (index + 1) * 10,
                    },
                  },
                },
              ]
            : [],
        ),
      );
    };
    const saveFocusedModel = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const modelId = creating
        ? modelCardDraft.modelId.trim()
        : entry!.model.id;
      if (!modelId) return;
      await onSaveModelCard(modelId, {
        custom,
        ...(custom ? { name: modelCardDraft.name.trim() } : {}),
        kind: "text",
        description: modelCardDraft.description.trim(),
        promptGuidance: modelCardDraft.promptGuidance.trim(),
        providerBindings: custom ? modelCardDraft.providerBindings : [],
      });
      if (creating) {
        navigate(
          `/settings?section=models&model=${encodeURIComponent(modelId)}`,
          { replace: true },
        );
      }
    };
    const renderSupportedProviderRow = (
      row: (typeof providerViewRows)[number],
      state: "configured" | "unconfigured",
    ) => (
      <SettingsRow
        as="li"
        key={row.key}
        className="flex items-center gap-2.5 px-2.5 py-1.5"
      >
        {renderProviderIcon(row.provider, row.title)}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--settings-type-size)] font-semibold leading-[var(--settings-type-line)] text-slate-900 dark:text-slate-50">
            {row.title}
          </p>
          <p className="text-xs leading-4 text-stone-500 dark:text-stone-400">
            {state === "configured"
              ? "Ready for this model"
              : "Supported · setup required"}
          </p>
        </div>
        <Link
          to={providerSettingsHref(row.key)}
          aria-label={`Configure ${row.title}`}
          className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-warm-border px-2 text-xs font-medium text-stone-700 transition-colors hover:border-brand/35 hover:text-brand dark:text-stone-200"
        >
          Configure
          <CaretRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </SettingsRow>
    );
    const renderLocalRuntimeRow = (
      localEntry: ModelCatalogEntryInfo,
      ready: boolean,
    ) => {
      const busy = localSpeechBusy?.modelId === localEntry.model.id;
      return (
        <SettingsRow
          as="li"
          key="local-runtime"
          className="flex items-center gap-2.5 px-2.5 py-1.5"
        >
          {renderProviderIcon(
            { providerId: "local", upstreamId: "local" },
            "Local runtime",
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[length:var(--settings-type-size)] font-semibold leading-[var(--settings-type-line)] text-slate-900 dark:text-slate-50">
              Local runtime
            </p>
            <p className="text-xs leading-4 text-stone-500 dark:text-stone-400">
              {ready ? "Downloaded and ready" : "Download required"}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            aria-label={`${ready ? "Remove" : "Download"} ${localEntry.model.name}`}
            disabled={busy}
            onClick={() => {
              void mutateLocalSpeechModel(
                localEntry,
                ready ? "remove" : "install",
              );
            }}
          >
            {busy
              ? localSpeechBusy?.action === "remove"
                ? "Removing…"
                : "Downloading…"
              : ready
                ? "Remove"
                : "Download"}
          </Button>
        </SettingsRow>
      );
    };
    return (
      <form
        onSubmit={(event) => {
          void saveFocusedModel(event);
        }}
        className="space-y-5"
      >
        <div className="flex items-start gap-3 border-b border-warm-border pb-4">
          <Link
            to="/settings?section=models"
            aria-label="Models"
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warm-border text-stone-600 transition-colors hover:border-brand/35 hover:text-brand dark:text-stone-300"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          {detailBrand && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-black/[0.06] bg-white p-2 dark:border-white/10 dark:bg-white">
              {detailBrand.src ? (
                <img
                  src={detailBrand.src}
                  alt=""
                  aria-hidden="true"
                  data-model-logo={detailBrand.id}
                  className="h-full w-full object-contain"
                />
              ) : (
                <span
                  aria-hidden="true"
                  data-model-logo={detailBrand.id}
                  className="text-lg font-black text-slate-900"
                >
                  {detailBrand.label.slice(0, 2).toUpperCase()}
                </span>
              )}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">
              {creating
                ? "Text model"
                : `${modelKindLabel(modelKindKey(entry!))} model`}
            </p>
            <h2 className="mt-0.5 font-display text-lg font-bold text-slate-900 dark:text-slate-50">
              {creating ? "New text model" : entry!.model.name}
            </h2>
            {!creating && (
              <p className="mt-1 font-mono text-xs text-stone-500 dark:text-stone-400">
                {entry!.model.id}
              </p>
            )}
          </div>
        </div>

        {creating && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
              <span>Model ID</span>
              <Input
                aria-label="Model ID"
                value={modelCardDraft.modelId}
                onChange={(event) =>
                  setModelCardDraft((current) => ({
                    ...current,
                    modelId: event.target.value
                      .trimStart()
                      .toLowerCase()
                      .replace(/[^a-z0-9._/-]/g, "-"),
                  }))
                }
                placeholder="editorial-pro"
                controlSize="lg"
                className="font-mono"
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
              <span>Model name</span>
              <Input
                aria-label="Model name"
                value={modelCardDraft.name}
                onChange={(event) =>
                  setModelCardDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Editorial Pro"
                controlSize="lg"
              />
            </label>
          </div>
        )}

        <div className="space-y-3.5">
          <SettingsFieldGroup label="Model description">
            <Textarea
              aria-label="Model description"
              value={modelCardDraft.description}
              onChange={(event) =>
                setModelCardDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              rows={3}
              placeholder="What this model is best at."
              controlSize="default"
              className="resize-y leading-5"
            />
          </SettingsFieldGroup>
          <SettingsFieldGroup label="Prompt guidance">
            <Textarea
              aria-label="Prompt guidance"
              value={modelCardDraft.promptGuidance}
              onChange={(event) =>
                setModelCardDraft((current) => ({
                  ...current,
                  promptGuidance: event.target.value,
                }))
              }
              rows={3}
              placeholder="Explain how collaborators and agents should prompt this model."
              controlSize="default"
              className="resize-y leading-5"
            />
          </SettingsFieldGroup>
        </div>

        {custom && (
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Compatible providers
              </h3>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                Mount this model to one or more compatible text endpoints.
              </p>
            </div>
            {compatibleTextAccounts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-warm-border p-5 text-sm text-stone-600 dark:text-stone-300">
                Add an OpenAI-compatible or Anthropic-compatible provider first.
              </div>
            ) : (
              <div className="space-y-2">
                {compatibleTextAccounts.map((account) => {
                  const label = modelAccountLabel(account);
                  const binding = modelCardDraft.providerBindings.find(
                    (candidate) => candidate.providerAccountId === account.id,
                  );
                  return (
                    <div
                      key={account.id}
                      className="rounded-xl border border-warm-border bg-warm-surface p-4"
                    >
                      <label className="flex items-center gap-3 text-sm font-medium text-slate-900 dark:text-slate-50">
                        <Switch
                          aria-label={`Use ${label}`}
                          checked={!!binding}
                          onCheckedChange={(checked) =>
                            toggleModelBinding(account, checked)
                          }
                        />
                        <span className="flex-1">{label}</span>
                        <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                          {account.apiShape ?? account.upstreamId}
                        </span>
                      </label>
                      {binding && (
                        <Input
                          aria-label={`${label} upstream model`}
                          value={binding.upstreamModel}
                          onChange={(event) =>
                            setModelCardDraft((current) => ({
                              ...current,
                              providerBindings: current.providerBindings.map(
                                (candidate) =>
                                  candidate.providerAccountId === account.id
                                    ? {
                                        ...candidate,
                                        upstreamModel: event.target.value,
                                      }
                                    : candidate,
                              ),
                            }))
                          }
                          placeholder="Provider model identifier"
                          controlSize="lg"
                          className="mt-3 font-mono"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {!creating && !custom && (
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Supported providers
              </h3>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                {focusedModelUsesLocalRuntime
                  ? "Download this model into the managed local cache. Readiness is verified from the runtime."
                  : "Configure any supported provider, then order ready accounts below."}
              </p>
            </div>
            <SettingsCollection
              as="ul"
              aria-label={`${entry!.model.name} supported providers`}
            >
              {focusedModelConfiguredProviderRows.map((row) =>
                renderSupportedProviderRow(row, "configured"),
              )}
              {focusedModelLocalRuntimeReady &&
                renderLocalRuntimeRow(entry!, true)}
              {focusedModelUnconfiguredProviderRows.map((row) =>
                renderSupportedProviderRow(row, "unconfigured"),
              )}
              {focusedModelUsesLocalRuntime &&
                !focusedModelLocalRuntimeReady &&
                renderLocalRuntimeRow(entry!, false)}
              {focusedModelConfiguredProviderRows.length === 0 &&
              focusedModelUnconfiguredProviderRows.length === 0 &&
              !focusedModelUsesLocalRuntime ? (
                <SettingsEmptyState as="li">
                  No supported providers are available.
                </SettingsEmptyState>
              ) : null}
            </SettingsCollection>
          </section>
        )}

        {!creating && !focusedModelUsesLocalRuntime && (
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Provider order
              </h3>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                The first ready provider handles this model.
              </p>
            </div>
            <SettingsCollection
              as="ul"
              aria-label={`${entry!.model.name} provider order`}
            >
              {providerOrderAccounts.length > 0 ? (
                providerOrderAccounts.map((account, index) => (
                  <SettingsRow
                    as="li"
                    key={account.id ?? modelProviderAccountIdentity(account)}
                    className="flex items-center gap-2.5 px-2.5 py-1.5"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-warm-muted text-[10px] font-bold text-stone-600 dark:text-stone-300">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                        {modelAccountLabel(account)}
                      </p>
                      <p className="truncate text-xs text-stone-500 dark:text-stone-400">
                        {account.apiShape ?? modelProviderLabel(account)}
                      </p>
                    </div>
                    <IconButton
                      label={`Move ${modelAccountLabel(account)} up`}
                      disabled={saving || index === 0}
                      onClick={() => moveFocusedProvider(index, index - 1)}
                      size="sm"
                      icon={<ArrowUp className="h-4 w-4" />}
                    />
                    <IconButton
                      label={`Move ${modelAccountLabel(account)} down`}
                      disabled={
                        saving || index === providerOrderAccounts.length - 1
                      }
                      onClick={() => moveFocusedProvider(index, index + 1)}
                      size="sm"
                      icon={<ArrowDown className="h-4 w-4" />}
                    />
                  </SettingsRow>
                ))
              ) : (
                <SettingsEmptyState as="li">
                  No compatible provider account is configured.
                </SettingsEmptyState>
              )}
            </SettingsCollection>
          </section>
        )}

        {error && <InlineAlert tone="error" title={error} />}
        <SettingsActions className="justify-between pt-2">
          <div>
            {custom && !creating && (
              <Button
                type="button"
                variant="destructive"
                disabled={saving}
                onClick={() => {
                  void onDeleteModelCard(entry!.model.id).then(() => {
                    navigate("/settings?section=models", { replace: true });
                  });
                }}
                className="h-auto min-h-0 border-transparent bg-transparent px-0 py-2 text-sm shadow-none"
              >
                Remove custom model
              </Button>
            )}
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            aria-label={custom ? "Save text model" : "Save model card"}
            disabled={
              saving ||
              (custom &&
                (!modelCardDraft.modelId.trim() ||
                  !modelCardDraft.name.trim() ||
                  modelCardDraft.providerBindings.length === 0 ||
                  modelCardDraft.providerBindings.some(
                    (binding) => !binding.upstreamModel.trim(),
                  )))
            }
          >
            {saving
              ? "Saving…"
              : custom
                ? "Save text model"
                : "Save model card"}
          </Button>
        </SettingsActions>
      </form>
    );
  };

  return (
    <SettingsSectionLayout>
      {showModels && !focusedModelId && (
        <SettingsSectionHeader
          icon={<Cube className="size-5" weight="bold" />}
          title="Models"
          description={
            focusedProviderRow
              ? `Models supported by ${focusedProviderRow.title}`
              : "Supported models and available providers"
          }
          action={
            focusedProviderRow ? (
              <Link
                to="/settings?section=models"
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Show all
              </Link>
            ) : (
              <Link
                to="/settings?section=models&model=new"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground shadow-xs hover:bg-accent"
              >
                <Plus className="h-3.5 w-3.5" />
                Add text model
              </Link>
            )
          }
        />
      )}

      {showModels && !focusedModelId && (
        <div
          role="group"
          aria-label="Model availability summary"
          className="mb-6 grid grid-cols-3 gap-2"
        >
          <SettingsPanel
            role="status"
            aria-label="Enabled models"
            className="px-3 py-2"
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Enabled
            </div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {enabledModelCount}
            </div>
          </SettingsPanel>
          <SettingsPanel
            role="status"
            aria-label="Unavailable models"
            className="px-3 py-2"
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Unavailable
            </div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {unavailableModelCount}
            </div>
          </SettingsPanel>
          <SettingsPanel
            role="status"
            aria-label="All models"
            className="px-3 py-2"
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              All
            </div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {catalog.length}
            </div>
          </SettingsPanel>
        </div>
      )}

      <div className="space-y-8">
        {showModels && focusedModelId && renderModelDetail()}
        {showProviders &&
          (selectedProviderRow ? (
            renderProviderDetail(selectedProviderRow)
          ) : (
            <div className="space-y-6">
              <SettingsSectionHeader
                icon={<PlugsConnected className="size-5" weight="bold" />}
                title="Providers"
                description="Use your own provider API keys in Clash."
                action={
                  <SearchField
                    query={providerQuery}
                    onQueryChange={setProviderQuery}
                    searchLabel="Search providers"
                    className="w-72"
                  />
                }
              />
              {saving && (
                <span
                  role="status"
                  aria-label="Provider save status"
                  aria-live="polite"
                  className="rounded-lg border border-border bg-muted px-3 py-1 text-xs font-medium text-foreground shadow-xs"
                >
                  Saving provider settings…
                </span>
              )}

              {configuredProviderRows.length > 0 && (
                <SettingsCollection
                  as="ul"
                  aria-label="Configured BYOK providers"
                >
                  {configuredProviderRows.map(renderProviderRow)}
                </SettingsCollection>
              )}

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  Available
                </h3>
                <SettingsCollection
                  as="ul"
                  aria-label="Available BYOK providers"
                >
                  {availableProviderRows.length > 0 ? (
                    availableProviderRows.map(renderProviderRow)
                  ) : (
                    <SettingsRow
                      as="li"
                      className="px-4 py-8 text-center text-sm text-muted-foreground"
                    >
                      No providers match this search.
                    </SettingsRow>
                  )}
                </SettingsCollection>
              </section>

              {showCustomProviderForm ? (
                renderCustomProviderForm()
              ) : (
                <Button
                  aria-label="Add custom provider"
                  onClick={() => setShowCustomProviderForm(true)}
                  className="flex h-auto min-h-0 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-brand/35 bg-brand-light/15 px-4 py-4 text-sm font-semibold text-brand shadow-none hover:bg-brand-light/35"
                >
                  <Plus className="h-4 w-4" />
                  Add custom provider
                </Button>
              )}

              {error && (
                <InlineAlert tone="error" title={error} className="mt-3" />
              )}
            </div>
          ))}

        {showModels && !focusedModelId && (
          <div className="flex flex-col">
            <div
              data-slot="models-sticky-controls"
              className="sticky top-0 z-20 -mx-2 bg-background px-2 py-4"
            >
              <SearchFilterToolbar
                query={modelQuery}
                onQueryChange={setModelQuery}
                searchLabel="Search models"
                spacing="none"
                filterGroups={[
                  {
                    id: "type",
                    label: "Type",
                    options: modelTaskFilterOptions,
                    selectedValues: modelTaskFilters,
                    onSelectedValuesChange: setModelTaskFilters,
                  },
                  {
                    id: "availability",
                    label: "Availability",
                    options: MODEL_AVAILABILITY_FILTER_OPTIONS,
                    selectedValues: modelAvailabilityFilters,
                    onSelectedValuesChange: (values) =>
                      setModelAvailabilityFilters(
                        values.filter(
                          (value): value is ModelAvailabilityFilter =>
                            value === "enabled" || value === "unavailable",
                        ),
                      ),
                  },
                  {
                    id: "provider",
                    label: "Provider",
                    options: modelServingProviderOptions,
                    selectedValues: modelServingProviderFilters,
                    onSelectedValuesChange: setModelServingProviderFilters,
                  },
                  {
                    id: "input",
                    label: "Input",
                    options: MODEL_INPUT_FILTER_OPTIONS,
                    selectedValues: modelInputFilters,
                    onSelectedValuesChange: (values) =>
                      setModelInputFilters(
                        values.filter(
                          (value): value is ModelInputFilter =>
                            value === "text-only" ||
                            value === "image" ||
                            value === "video" ||
                            value === "audio",
                        ),
                      ),
                  },
                  {
                    id: "origin",
                    label: "Origin",
                    options: MODEL_ORIGIN_FILTER_OPTIONS,
                    selectedValues: modelOriginFilters,
                    onSelectedValuesChange: (values) =>
                      setModelOriginFilters(
                        values.filter(
                          (value): value is ModelOriginFilter =>
                            value === "built-in" || value === "custom",
                        ),
                      ),
                  },
                ]}
              />
            </div>

            <div className="space-y-8">
              {visibleFilteredModelCatalog.length === 0 ? (
                <div className="rounded-xl border border-dashed border-warm-border py-8 text-center text-sm text-stone-600 dark:text-stone-300">
                  No model cards match these filters.
                </div>
              ) : (
                <>
                  <section
                    aria-labelledby="enabled-models-heading"
                    className="space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h3
                        id="enabled-models-heading"
                        className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-50"
                      >
                        <span
                          className="h-2 w-2 rounded-full bg-emerald-500"
                          aria-hidden="true"
                        />
                        Enabled
                      </h3>
                      <span className="text-xs tabular-nums text-stone-400">
                        {enabledModelCatalog.length}
                      </span>
                    </div>
                    {enabledModelCatalog.length > 0 ? (
                      <SettingsCollection
                        layout="grid"
                        className="md:grid-cols-2 2xl:grid-cols-3"
                      >
                        {enabledModelCatalog.map((entry) =>
                          renderModelCard(entry),
                        )}
                      </SettingsCollection>
                    ) : (
                      <div className="rounded-xl border border-dashed border-warm-border px-4 py-6 text-center text-xs text-stone-500 dark:text-stone-400">
                        No enabled models match these filters.
                      </div>
                    )}
                  </section>

                  <section
                    aria-labelledby="unavailable-models-heading"
                    className="space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h3
                        id="unavailable-models-heading"
                        className="flex items-center gap-2 text-sm font-semibold text-stone-600 dark:text-stone-300"
                      >
                        <span
                          className="h-2 w-2 rounded-full bg-stone-300 dark:bg-stone-600"
                          aria-hidden="true"
                        />
                        Unavailable
                      </h3>
                      <span className="text-xs tabular-nums text-stone-400">
                        {unavailableModelCatalog.length}
                      </span>
                    </div>
                    {unavailableModelCatalog.length > 0 ? (
                      <SettingsCollection
                        layout="grid"
                        className="md:grid-cols-2 2xl:grid-cols-3"
                      >
                        {unavailableModelCatalog.map((entry) =>
                          renderModelCard(entry),
                        )}
                      </SettingsCollection>
                    ) : (
                      <div className="rounded-xl border border-dashed border-warm-border px-4 py-6 text-center text-xs text-stone-500 dark:text-stone-400">
                        No unavailable models match these filters.
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </SettingsSectionLayout>
  );
}

/**
 * Sync — local daemon cloud sync mode.
 */
interface LocalSyncConfig {
  mode: "local-only" | "cloud-sync";
  remote_loro: {
    enabled: boolean;
    url: string | null;
    has_token: boolean;
    source: "none" | "env" | "config";
  };
  capabilities?: LocalSyncCapabilities;
}

interface LocalSyncCapabilities {
  canvas: boolean;
  asset_metadata: boolean;
  revision_content: boolean;
  project_metadata: boolean;
}

function defaultLocalSyncCapabilities(): LocalSyncCapabilities {
  return {
    canvas: false,
    asset_metadata: false,
    revision_content: false,
    project_metadata: false,
  };
}

function normalizeLocalSyncCapabilities(
  value: LocalSyncConfig["capabilities"],
): LocalSyncCapabilities {
  return {
    ...defaultLocalSyncCapabilities(),
    ...(value ?? {}),
  };
}

function SyncSection() {
  const rt = useClashRuntime();
  const feedback = useAppFeedback();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingRuntimeId, setRemovingRuntimeId] = useState<string | null>(
    null,
  );
  const [mode, setMode] = useState<"local-only" | "cloud-sync">("local-only");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [source, setSource] = useState<"none" | "env" | "config">("none");
  const [capabilities, setCapabilities] = useState<LocalSyncCapabilities>(() =>
    defaultLocalSyncCapabilities(),
  );
  const syncVersionRef = useRef(0);

  const markDirty = useCallback(() => {
    syncVersionRef.current += 1;
    setDirty(true);
    setError(null);
  }, []);

  const applyConfig = useCallback((config: LocalSyncConfig) => {
    setMode(config.mode);
    setRemoteUrl(config.remote_loro.url ?? "");
    setRemoteToken("");
    setHasToken(config.remote_loro.has_token);
    setSource(config.remote_loro.source);
    setCapabilities(normalizeLocalSyncCapabilities(config.capabilities));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(runtimeApiUrl("/api/v1/local/sync"), { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as LocalSyncConfig;
      })
      .then((config) => {
        if (cancelled) return;
        applyConfig(config);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  useEffect(() => {
    if (loading || !dirty) return;
    if (mode === "cloud-sync" && !remoteUrl.trim()) return;
    const version = syncVersionRef.current;
    const timer = window.setTimeout(() => {
      setSaving(true);
      setError(null);
      const body: Record<string, unknown> = {
        mode,
        remote_loro_url: mode === "cloud-sync" ? remoteUrl.trim() : null,
        capabilities:
          mode === "cloud-sync" ? capabilities : defaultLocalSyncCapabilities(),
      };
      if (remoteToken.trim()) body.remote_loro_token = remoteToken.trim();
      void fetch(runtimeApiUrl("/api/v1/local/sync"), {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          if (!res.ok) {
            const json = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            throw new Error(json?.error ?? `HTTP ${res.status}`);
          }
          return (await res.json()) as LocalSyncConfig;
        })
        .then((config) => {
          if (syncVersionRef.current !== version) return;
          setDirty(false);
          applyConfig(config);
          feedback.notify({
            variant: "success",
            title: "Sync settings saved",
          });
        })
        .catch((err) => {
          if (syncVersionRef.current !== version) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (syncVersionRef.current === version) setSaving(false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    applyConfig,
    capabilities,
    dirty,
    feedback,
    loading,
    mode,
    remoteToken,
    remoteUrl,
  ]);

  const onRemoveRuntime = useCallback(
    async (id: string, label: string) => {
      if (
        !confirm(
          `Remove ${label}? The daemon on that machine will stop being authorized.`,
        )
      )
        return;
      setRemovingRuntimeId(id);
      try {
        const res = await fetch(runtimeApiUrl(`/api/v1/runtimes/${id}`), {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await rt.refresh();
      } catch (e) {
        feedback.notify({
          variant: "error",
          title: "Could not remove runtime",
          message: displayErrorMessage(e),
          actionLabel: "Open Sync",
          actionHref: "/settings?section=sync",
        });
      } finally {
        setRemovingRuntimeId(null);
      }
    },
    [feedback, rt],
  );


  return (
    <SettingsSectionLayout aria-labelledby="sync-heading">
      <SettingsSectionHeader
        title="Sync"
        titleId="sync-heading"
        description="Connection details for project cloud admission. Each project controls its own sync admission."
        icon={<CloudArrowUp className="size-4" weight="bold" />}
        action={
          <span className="rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
            {mode === "cloud-sync" ? "Cloud endpoint" : "No default endpoint"}
          </span>
        }
      />

      {loading ? (
        <SettingsFormSkeleton
          ariaLabel="Loading sync settings"
          variant="sync"
        />
      ) : (
        <SettingsAnimatedBody className="space-y-4">
          <RadioGroup
            aria-label="Default cloud connection"
            value={mode}
            onValueChange={(nextMode) => {
              if (nextMode === "local-only" || nextMode === "cloud-sync") {
                setMode(nextMode);
                markDirty();
              }
            }}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <RadioGroupItem
              value="local-only"
              className="rounded-[var(--settings-row-radius)] p-3 data-[state=checked]:bg-[var(--control-bg-open)]"
            >
              <span className="block text-sm font-semibold text-slate-900 dark:text-slate-50">
                No default endpoint
              </span>
              <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
                No default endpoint for new project admissions.
              </span>
            </RadioGroupItem>
            <RadioGroupItem
              value="cloud-sync"
              className="rounded-[var(--settings-row-radius)] p-3 data-[state=checked]:bg-[var(--control-bg-open)]"
            >
              <span className="block text-sm font-semibold text-slate-900 dark:text-slate-50">
                Cloud endpoint
              </span>
              <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
                Configure the cloud connection for project admission.
              </span>
            </RadioGroupItem>
          </RadioGroup>

          <SettingsPanel className="space-y-3 p-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
                Remote Loro URL
              </span>
              <Input
                aria-label="Remote Loro URL"
                type="url"
                value={remoteUrl}
                onChange={(e) => {
                  setRemoteUrl(e.target.value);
                  markDirty();
                }}
                placeholder="https://api.example.com"
                disabled={mode !== "cloud-sync"}
                controlSize="lg"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
                Remote Loro token
              </span>
              <Input
                aria-label="Remote Loro token"
                type="password"
                value={remoteToken}
                onChange={(e) => {
                  setRemoteToken(e.target.value);
                  markDirty();
                }}
                placeholder={hasToken ? "Token saved" : "Bearer token"}
                disabled={mode !== "cloud-sync"}
                controlSize="lg"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
              <span>{hasToken ? "Token saved" : "No token saved"}</span>
              <span>·</span>
              <span>Source: {source}</span>
            </div>
          </SettingsPanel>

          {error && <InlineAlert tone="error" title={error} />}
          {saving && (
            <div
              className="text-sm font-medium text-stone-500 dark:text-stone-400"
              aria-live="polite"
            >
              Saving sync settings…
            </div>
          )}

          <div className="mt-7 border-t border-warm-border pt-5">
            <div className="mb-3">
              <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-50">
                Runtime machines
              </h3>
              <p className="text-xs text-stone-600 dark:text-stone-300">
                Machines currently authorized to sync runtime state with this
                workspace.
              </p>
            </div>
            {rt.runtimes.length === 0 ? (
              <div className="rounded-xl border border-dashed border-warm-border p-6 text-center">
                <p className="text-sm text-stone-600 dark:text-stone-300">
                  No runtime machines connected.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {rt.runtimes.map((runtime) => {
                  const online = runtime.status === "online";
                  const label =
                    runtime.hostname || runtime.machine_id.slice(0, 12);
                  const lastBeat = runtime.last_heartbeat
                    ? new Date(runtime.last_heartbeat * 1000).toLocaleString()
                    : "never";
                  return (
                    <SettingsRow
                      key={runtime.id}
                      className="flex items-start justify-between gap-3 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-stone-300"}`}
                          />
                          <span className="font-medium text-slate-900 dark:text-slate-50">
                            {label}
                          </span>
                          <span className="text-xs text-stone-500 dark:text-stone-400">
                            {runtime.os} · v{runtime.version}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-stone-600 dark:text-stone-300">
                          Agents:{" "}
                          {runtime.agents.length === 0
                            ? "none"
                            : runtime.agents
                                .map((agent) => agent.label ?? agent.id)
                                .join(", ")}
                        </div>
                        <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                          Last seen: {lastBeat}
                        </div>
                      </div>
                      <Button
                        aria-label={`Remove ${label} runtime`}
                        onClick={() => {
                          void onRemoveRuntime(runtime.id, label);
                        }}
                        disabled={removingRuntimeId === runtime.id}
                        size="sm"
                        variant="destructive"
                        className="h-auto min-h-0 border-transparent bg-transparent px-0 py-0 text-xs text-stone-500 shadow-none hover:bg-transparent hover:text-red-600 disabled:opacity-50 dark:text-stone-400 dark:hover:text-red-400"
                      >
                        {removingRuntimeId === runtime.id
                          ? "Removing..."
                          : "Remove"}
                      </Button>
                    </SettingsRow>
                  );
                })}
              </div>
            )}
          </div>
        </SettingsAnimatedBody>
      )}
    </SettingsSectionLayout>
  );
}

type PublicStorageMode = "disabled" | "byos" | "managed";
type PublicStorageProvider = "r2" | "aws-s3" | "tos" | "custom-s3";

interface PublicStorageConfig {
  capability: "public-asset-storage";
  mode: PublicStorageMode;
  available: boolean;
  provider: PublicStorageProvider | null;
  account_id: string | null;
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  key_prefix: string;
  force_path_style: boolean;
  has_access_key_id: boolean;
  has_secret_access_key: boolean;
  has_session_token: boolean;
  managed: { available: boolean; authenticated: boolean };
}

const PUBLIC_STORAGE_PROVIDER_OPTIONS: SelectOption<PublicStorageProvider>[] = [
  { value: "r2", label: "Cloudflare R2" },
  { value: "aws-s3", label: "AWS S3" },
  { value: "tos", label: "Volcengine TOS" },
  { value: "custom-s3", label: "Custom S3-compatible" },
];

function PublicStorageSection() {
  const feedback = useAppFeedback();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicStorageConfig | null>(null);
  const [mode, setMode] = useState<PublicStorageMode>("disabled");
  const [provider, setProvider] = useState<PublicStorageProvider>("r2");
  const [accountId, setAccountId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("auto");
  const [keyPrefix, setKeyPrefix] = useState("clash-temporary");
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");

  const applyConfig = useCallback((next: PublicStorageConfig) => {
    setConfig(next);
    setMode(next.mode);
    setProvider(next.provider ?? "r2");
    setAccountId(next.account_id ?? "");
    setEndpoint(next.endpoint ?? "");
    setBucket(next.bucket ?? "");
    setRegion(
      next.region ?? (next.provider === "r2" || !next.provider ? "auto" : ""),
    );
    setKeyPrefix(next.key_prefix || "clash-temporary");
    setForcePathStyle(next.force_path_style);
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(runtimeApiUrl("/api/v1/local/public-storage"), {
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as PublicStorageConfig;
      })
      .then((next) => {
        if (!cancelled) applyConfig(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(displayErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  const credentialsReady = Boolean(
    (accessKeyId.trim() || config?.has_access_key_id) &&
    (secretAccessKey.trim() || config?.has_secret_access_key),
  );
  const locationReady =
    provider === "r2"
      ? Boolean(accountId.trim())
      : provider === "custom-s3"
        ? Boolean(endpoint.trim() && region.trim())
        : Boolean(region.trim());
  const canSave =
    !saving &&
    (mode === "disabled" ||
      (mode === "managed" &&
        Boolean(config?.managed.available && config.managed.authenticated)) ||
      (mode === "byos" &&
        Boolean(bucket.trim() && locationReady && credentialsReady)));

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSave) return;
      setSaving(true);
      setError(null);
      const body: Record<string, unknown> =
        mode === "byos"
          ? {
              mode,
              provider,
              account_id: accountId.trim() || null,
              endpoint: endpoint.trim() || null,
              bucket: bucket.trim(),
              region: provider === "r2" ? "auto" : region.trim(),
              key_prefix: keyPrefix.trim() || "clash-temporary",
              force_path_style: provider === "custom-s3" && forcePathStyle,
              ...(accessKeyId.trim()
                ? { access_key_id: accessKeyId.trim() }
                : {}),
              ...(secretAccessKey.trim()
                ? { secret_access_key: secretAccessKey.trim() }
                : {}),
              ...(sessionToken.trim()
                ? { session_token: sessionToken.trim() }
                : {}),
            }
          : { mode };
      try {
        const response = await fetch(
          runtimeApiUrl("/api/v1/local/public-storage"),
          {
            method: "PATCH",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const payload = (await response.json().catch(() => null)) as
          (PublicStorageConfig & { error?: string }) | null;
        if (!response.ok || !payload)
          throw new Error(payload?.error ?? `HTTP ${response.status}`);
        applyConfig(payload);
        feedback.notify({ variant: "success", title: "Public storage saved" });
      } catch (caught) {
        const message = displayErrorMessage(caught);
        setError(message);
        feedback.notify({
          variant: "error",
          title: "Could not save public storage",
          message,
        });
      } finally {
        setSaving(false);
      }
    },
    [
      accessKeyId,
      accountId,
      applyConfig,
      bucket,
      canSave,
      endpoint,
      feedback,
      forcePathStyle,
      keyPrefix,
      mode,
      provider,
      region,
      secretAccessKey,
      sessionToken,
    ],
  );

  const testConnection = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      const response = await fetch(
        runtimeApiUrl("/api/v1/local/public-storage/test"),
        {
          method: "POST",
          credentials: "include",
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      feedback.notify({
        variant: "success",
        title: "Public storage is reachable",
      });
    } catch (caught) {
      const message = displayErrorMessage(caught);
      setError(message);
      feedback.notify({
        variant: "error",
        title: "Public storage test failed",
        message,
      });
    } finally {
      setTesting(false);
    }
  }, [feedback]);

  return (
    <section>
      <div className="mb-5 flex items-center gap-3">
        <CloudArrowUp
          className="h-5 w-5 text-stone-600 dark:text-stone-300"
          weight="bold"
        />
        <div className="flex-1">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
            Public storage
          </h2>
          <p className="text-sm text-stone-600 dark:text-stone-300">
            Publishes short-lived signed URLs when a model provider requires an
            internet-reachable asset.
          </p>
        </div>
        {config ? (
          <span className="rounded-lg border border-warm-border bg-warm-muted px-3 py-1 text-xs font-medium text-stone-700 dark:text-stone-200">
            {config.available ? "Ready" : "Not configured"}
          </span>
        ) : null}
      </div>

      {loading ? (
        <SettingsFormSkeleton
          ariaLabel="Loading public storage settings"
          variant="sync"
        />
      ) : (
        <form
          onSubmit={(event) => {
            void save(event);
          }}
          className="space-y-4"
        >
          <RadioGroup
            aria-label="Public storage mode"
            value={mode}
            onValueChange={(value) => {
              if (
                value === "disabled" ||
                value === "byos" ||
                value === "managed"
              )
                setMode(value);
            }}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <RadioGroupItem value="disabled" className="rounded-xl p-4">
              <span className="block text-sm font-semibold text-slate-900 dark:text-slate-50">
                Disabled
              </span>
              <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
                Functions that require public storage stay unavailable.
              </span>
            </RadioGroupItem>
            <RadioGroupItem value="byos" className="rounded-xl p-4">
              <span className="block text-sm font-semibold text-slate-900 dark:text-slate-50">
                Use my storage
              </span>
              <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
                R2, S3, TOS, or another S3-compatible service.
              </span>
            </RadioGroupItem>
            {config?.managed.available && config.managed.authenticated ? (
              <RadioGroupItem value="managed" className="rounded-xl p-4">
                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Clash managed
                </span>
                <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
                  Storage included with your signed-in Clash account.
                </span>
              </RadioGroupItem>
            ) : null}
          </RadioGroup>

          {mode === "byos" ? (
            <div className="space-y-4 rounded-xl border border-warm-border bg-warm-surface p-4">
              <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                <span>Storage provider</span>
                <SelectMenu
                  ariaLabel="Storage provider"
                  value={provider}
                  options={PUBLIC_STORAGE_PROVIDER_OPTIONS}
                  onValueChange={(value) => {
                    setProvider(value);
                    if (value === "r2") setRegion("auto");
                    if (value === "tos") setForcePathStyle(false);
                  }}
                  variant="field"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                {provider === "r2" ? (
                  <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                    <span>Account ID</span>
                    <Input
                      aria-label="Account ID"
                      value={accountId}
                      onChange={(event) => setAccountId(event.target.value)}
                      controlSize="lg"
                      className="font-mono"
                    />
                  </label>
                ) : null}
                {provider === "custom-s3" ? (
                  <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                    <span>Endpoint</span>
                    <Input
                      aria-label="Endpoint"
                      type="url"
                      value={endpoint}
                      onChange={(event) => setEndpoint(event.target.value)}
                      placeholder="https://objects.example.com"
                      controlSize="lg"
                      className="font-mono"
                    />
                  </label>
                ) : null}
                <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                  <span>Bucket</span>
                  <Input
                    aria-label="Bucket"
                    value={bucket}
                    onChange={(event) => setBucket(event.target.value)}
                    controlSize="lg"
                    className="font-mono"
                  />
                </label>
                {provider !== "r2" ? (
                  <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                    <span>Region</span>
                    <Input
                      aria-label="Region"
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                      placeholder={
                        provider === "tos" ? "cn-beijing" : "us-east-1"
                      }
                      controlSize="lg"
                      className="font-mono"
                    />
                  </label>
                ) : null}
                <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                  <span>Access key ID</span>
                  <Input
                    aria-label="Access key ID"
                    type="password"
                    autoComplete="new-password"
                    value={accessKeyId}
                    onChange={(event) => setAccessKeyId(event.target.value)}
                    placeholder={
                      config?.has_access_key_id
                        ? "Saved; leave blank to keep"
                        : ""
                    }
                    controlSize="lg"
                    className="font-mono"
                  />
                </label>
                <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                  <span>Secret access key</span>
                  <Input
                    aria-label="Secret access key"
                    type="password"
                    autoComplete="new-password"
                    value={secretAccessKey}
                    onChange={(event) => setSecretAccessKey(event.target.value)}
                    placeholder={
                      config?.has_secret_access_key
                        ? "Saved; leave blank to keep"
                        : ""
                    }
                    controlSize="lg"
                    className="font-mono"
                  />
                </label>
                {provider === "aws-s3" || provider === "custom-s3" ? (
                  <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                    <span>Session token (optional)</span>
                    <Input
                      aria-label="Session token"
                      type="password"
                      autoComplete="new-password"
                      value={sessionToken}
                      onChange={(event) => setSessionToken(event.target.value)}
                      placeholder={
                        config?.has_session_token
                          ? "Saved; leave blank to keep"
                          : ""
                      }
                      controlSize="lg"
                      className="font-mono"
                    />
                  </label>
                ) : null}
                <label className="block space-y-1.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                  <span>Key prefix</span>
                  <Input
                    aria-label="Key prefix"
                    value={keyPrefix}
                    onChange={(event) => setKeyPrefix(event.target.value)}
                    controlSize="lg"
                    className="font-mono"
                  />
                </label>
              </div>

              {provider === "custom-s3" ? (
                <label className="flex items-center gap-3 text-sm font-medium text-slate-900 dark:text-slate-50">
                  <Switch
                    aria-label="Use path-style URLs"
                    checked={forcePathStyle}
                    onCheckedChange={setForcePathStyle}
                  />
                  <span>Use path-style URLs</span>
                </label>
              ) : null}
              {provider === "tos" ? (
                <p className="text-xs leading-5 text-stone-600 dark:text-stone-300">
                  Clash uses TOS&apos;s documented S3-compatible endpoint and
                  virtual-hosted addressing for the selected region.
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? <InlineAlert tone="error" title={error} /> : null}
          <SettingsActions>
            <Button
              type="button"
              aria-label="Test public storage"
              onClick={() => {
                void testConnection();
              }}
              disabled={!config?.available || testing || saving}
            >
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button
              type="submit"
              variant="primary"
              aria-label="Save public storage"
              disabled={!canSave}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </SettingsActions>
        </form>
      )}
    </section>
  );
}

interface LocalSpeechSetup {
  runtime: "builtin-rpc";
  status: "disabled" | "needs-install" | "ready";
  available: boolean;
  default_base_url: string | null;
  commands: string[];
  message?: string;
}

interface LocalAudioConfig {
  asr: {
    capability?: "speech-to-text";
    enabled: boolean;
    provider: string;
    base_url: string | null;
    model: string;
    has_api_key: boolean;
    ready: boolean;
    setup: LocalSpeechSetup & { provider: string };
  };
  tts?: {
    capability?: "text-to-speech";
    enabled: boolean;
    provider: "builtin-piper";
    base_url: null;
    model: string;
    has_api_key: false;
    ready: boolean;
    setup: LocalSpeechSetup & { provider: "piper" };
  };
}

function isVoiceInputModelEntry(entry: ModelCatalogEntryInfo): boolean {
  if (isLocalAsrModelEntry(entry)) return true;
  return (
    (entry.model.kind as string) === "text" && modelAcceptsInput(entry, "audio")
  );
}

function isGlobalModelEnabled(
  entry: ModelCatalogEntryInfo,
  localSpeechModelStatuses: Record<string, boolean>,
): boolean {
  if (isLocalSpeechModelEntry(entry)) {
    return localSpeechModelStatuses[entry.model.id] === true;
  }
  return (
    !!entry.selectedRoute &&
    entry.missingCredentials.length === 0 &&
    entry.tier === "available"
  );
}

function ttsModelValue(entry: ModelCatalogEntryInfo): string {
  if (entry.selectedRoute?.upstreamModel)
    return entry.selectedRoute.upstreamModel;
  const defaultParams = entry.model.defaultParams as
    Record<string, unknown> | undefined;
  const defaultModel = defaultParams?.tts_model;
  return typeof defaultModel === "string" && defaultModel.trim()
    ? defaultModel.trim()
    : entry.model.id;
}

function localSpeechModelValue(entry: ModelCatalogEntryInfo): string {
  return isLocalTtsModelEntry(entry)
    ? ttsModelValue(entry)
    : asrModelValue(entry);
}

async function fetchLocalAudioConfig(): Promise<LocalAudioConfig> {
  const res = await fetch(
    runtimeApiUrl("/api/v1/local/audio/voice-input?probe=false"),
    {
      credentials: "include",
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LocalAudioConfig;
}

type MediaAnalysisResolution = "low" | "medium" | "high";

interface LocalMediaAnalysisSettings {
  videoEnabled: boolean;
  modelId: string | null;
  allowedCategories: string[] | null;
  video: {
    fps: number;
    mediaResolution: MediaAnalysisResolution;
    boundaryRefinement: {
      enabled: boolean;
      fps: number;
      safetyMarginSeconds: number;
    };
  };
}

interface LocalMediaAnalysisResponse extends LocalMediaAnalysisSettings {
  modelOptions: Array<{
    id: string;
    name: string;
    provider: string;
    route: string;
    sourceKinds: Array<"image" | "video" | "audio">;
  }>;
  categoryOptions: Array<{
    id: string;
    title: string;
    sourceMediaKinds: Array<"image" | "video" | "audio">;
  }>;
}

async function fetchLocalMediaAnalysisSettings(): Promise<LocalMediaAnalysisResponse> {
  const query = new URLSearchParams({ sourceKind: "video" });
  const response = await fetch(
    runtimeApiUrl(`/api/v1/local/media-analysis?${query.toString()}`),
    {
      credentials: "include",
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as LocalMediaAnalysisResponse;
}

async function saveLocalMediaAnalysisSettings(
  settings: LocalMediaAnalysisSettings,
): Promise<LocalMediaAnalysisSettings> {
  const response = await fetch(runtimeApiUrl("/api/v1/local/media-analysis"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(settings),
  });
  const body = (await response.json().catch(() => null)) as
    (LocalMediaAnalysisSettings & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  if (!body)
    throw new Error("Media analysis settings returned an empty response.");
  return body;
}

async function fetchLocalSpeechModelStatus(
  capability: LocalSpeechCapability,
  model: string,
): Promise<boolean> {
  const query = new URLSearchParams({ capability, model });
  const res = await fetch(
    runtimeApiUrl(`/api/v1/local/audio/models/status?${query.toString()}`),
    {
      credentials: "include",
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    available?: boolean;
    asr?: LocalAudioConfig["asr"];
    tts?: LocalAudioConfig["tts"];
  };
  if (typeof json.available === "boolean") return json.available;
  return capability === "speech-to-text"
    ? json.asr?.model === model && json.asr.setup.available
    : json.tts?.model === model && json.tts.setup.available;
}

interface LocalSpeechSettingsCardProps {
  title: string;
  description: string;
  switchLabel: string;
  modelLabel: string;
  enabled: boolean;
  saving: boolean;
  blockingReason?: string;
  modelOptions: SelectOption<string>[];
  modelValue: string;
  onEnabledChange: (next: boolean) => void;
  onModelChange: (next: string) => void;
  onConfigure: () => void;
}

function LocalSpeechSettingsCard({
  title,
  description,
  switchLabel,
  modelLabel,
  enabled,
  saving,
  blockingReason,
  modelOptions,
  modelValue,
  onEnabledChange,
  onModelChange,
  onConfigure,
}: LocalSpeechSettingsCardProps) {
  const switchDisabledReason = saving
    ? "Saving voice input settings."
    : blockingReason;
  const switchReasonId = switchDisabledReason
    ? `audio-${modelLabel.toLowerCase().replaceAll(" ", "-")}-switch-reason`
    : undefined;
  const hasModel = modelOptions.length > 0;
  const selectedModelValue = modelOptions.some(
    (option) => option.value === modelValue,
  )
    ? modelValue
    : (modelOptions[0]?.value ?? modelValue);
  const control = (
    <Switch
      checked={enabled}
      onCheckedChange={onEnabledChange}
      disabled={saving}
      aria-label={switchLabel}
      aria-describedby={switchReasonId}
    />
  );

  return (
    <div className="rounded-xl border border-warm-border bg-warm-surface p-4">
      <div className="flex items-start justify-between gap-4 border-b border-warm-border pb-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            {title}
          </h3>
          <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
            {description}
          </p>
        </div>
        {switchDisabledReason ? (
          <Tooltip label={switchDisabledReason}>{control}</Tooltip>
        ) : (
          control
        )}
        {switchDisabledReason && (
          <span id={switchReasonId} className="sr-only">
            {switchDisabledReason}
          </span>
        )}
      </div>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
          {modelLabel}
        </span>
        {hasModel && !blockingReason ? (
          <SelectMenu
            value={selectedModelValue}
            options={modelOptions}
            onValueChange={(next) => onModelChange(String(next))}
            ariaLabel={modelLabel}
            variant="field"
            menuWidth="trigger"
            className="w-full"
          />
        ) : (
          <Button
            aria-label={modelLabel}
            onClick={onConfigure}
            className="h-10 w-full justify-between text-muted-foreground"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {hasModel ? selectedModelValue : "Select"}
            </span>
            <CaretDown
              className="h-3.5 w-3.5 flex-shrink-0 text-stone-500 dark:text-stone-400"
              aria-hidden="true"
            />
          </Button>
        )}
      </label>
      {switchDisabledReason && (
        <p className="mt-2 text-xs text-stone-600 dark:text-stone-300">
          {switchDisabledReason}
        </p>
      )}
    </div>
  );
}

const MEDIA_ANALYSIS_FPS_OPTIONS: SelectOption<number>[] = [
  { value: 0.5, label: "0.5 FPS" },
  { value: 1, label: "1 FPS" },
  { value: 2, label: "2 FPS" },
  { value: 4, label: "4 FPS" },
];

const MEDIA_ANALYSIS_REVIEW_FPS_OPTIONS: SelectOption<number>[] = [
  { value: 8, label: "8 FPS" },
  { value: 12, label: "12 FPS" },
  { value: 24, label: "24 FPS" },
];

const MEDIA_ANALYSIS_RESOLUTION_OPTIONS: SelectOption<MediaAnalysisResolution>[] =
  [
    { value: "low", label: "Low — fastest" },
    { value: "medium", label: "Medium — balanced" },
    { value: "high", label: "High — small text and details" },
  ];

const MEDIA_ANALYSIS_MARGIN_OPTIONS: SelectOption<number>[] = [
  { value: 0.25, label: "0.25 seconds" },
  { value: 0.5, label: "0.5 seconds" },
  { value: 0.75, label: "0.75 seconds" },
  { value: 1, label: "1 second" },
];

function MediaAnalysisSection() {
  const feedback = useAppFeedback();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [options, setOptions] = useState<
    Pick<LocalMediaAnalysisResponse, "modelOptions" | "categoryOptions">
  >({
    modelOptions: [],
    categoryOptions: [],
  });
  const [settings, setSettings] = useState<LocalMediaAnalysisSettings | null>(
    null,
  );

  const applyResponse = useCallback((response: LocalMediaAnalysisResponse) => {
    const videoCategories = response.categoryOptions.filter(
      (category) =>
        category.sourceMediaKinds.length === 0 ||
        category.sourceMediaKinds.includes("video"),
    );
    const availableModel = response.modelOptions.some(
      (model) => model.id === response.modelId,
    )
      ? response.modelId
      : (response.modelOptions[0]?.id ?? null);
    setOptions({
      modelOptions: response.modelOptions,
      categoryOptions: videoCategories,
    });
    setSettings({
      videoEnabled: response.videoEnabled && availableModel !== null,
      modelId: availableModel,
      allowedCategories:
        response.allowedCategories ??
        videoCategories.map((category) => category.id),
      video: response.video,
    });
    setDirty(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchLocalMediaAnalysisSettings()
      .then((response) => {
        if (!cancelled) applyResponse(response);
      })
      .catch((error) => {
        if (cancelled) return;
        feedback.notify({
          variant: "error",
          title: "Could not load media analysis settings",
          message: displayErrorMessage(error),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyResponse, feedback]);

  const updateSettings = useCallback(
    (
      update: (
        current: LocalMediaAnalysisSettings,
      ) => LocalMediaAnalysisSettings,
    ) => {
      setSettings((current) => (current ? update(current) : current));
      setDirty(true);
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const saved = await saveLocalMediaAnalysisSettings(settings);
      setSettings(saved);
      setDirty(false);
      feedback.notify({
        variant: "success",
        title: "Media analysis settings saved",
        message: "New agent analysis runs will use these controls.",
      });
    } catch (error) {
      feedback.notify({
        variant: "error",
        title: "Could not save media analysis settings",
        message: displayErrorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  }, [feedback, settings]);

  const modelOptions = useMemo<SelectOption<string>[]>(
    () =>
      options.modelOptions.map((model) => ({
        value: model.id,
        label: model.name,
        description: `${model.provider} · ${model.route}`,
      })),
    [options.modelOptions],
  );

  if (loading || !settings) {
    return (
      <section>
        <SettingsFormSkeleton
          ariaLabel="Loading media analysis settings"
          variant="audio"
        />
      </section>
    );
  }

  const selectedCategories = new Set(settings.allowedCategories ?? []);
  const hasVideoModel = modelOptions.length > 0;

  return (
    <SettingsSectionLayout>
      <SettingsSectionHeader
        icon={<VideoCamera className="size-5" weight="bold" />}
        title="Media analysis"
        description="Let agents inspect video and fill selected metadata with a video-capable model."
        action={
          <Switch
            aria-label="Enable video analysis"
            checked={settings.videoEnabled}
            disabled={!hasVideoModel || saving}
            onCheckedChange={(checked) =>
              updateSettings((current) => ({
                ...current,
                videoEnabled: checked,
              }))
            }
          />
        }
      />

      <SettingsAnimatedBody className="space-y-4">
        <SettingsPanel className="p-4">
          <SettingsFieldGroup label="Video model">
            {hasVideoModel && settings.modelId ? (
              <SelectMenu
                value={settings.modelId}
                options={modelOptions}
                onValueChange={(modelId) =>
                  updateSettings((current) => ({ ...current, modelId }))
                }
                ariaLabel="Video model"
                variant="field"
                menuWidth="trigger"
                className="w-full"
              />
            ) : (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                No enabled model has a configured Provider route and video
                input.
                <Link
                  to="/settings?section=models"
                  className="ml-1 font-medium text-primary hover:underline"
                >
                  Configure models
                </Link>
              </div>
            )}
          </SettingsFieldGroup>
        </SettingsPanel>

        <SettingsPanel as="fieldset" className="p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">
            Metadata agents may request
          </legend>
          <p className="mb-3 text-xs leading-4 text-muted-foreground">
            The agent chooses from this allowed set for each analysis run.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.categoryOptions.map((category) => (
              <label
                key={category.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground hover:bg-accent"
              >
                <Checkbox
                  aria-label={category.title}
                  checked={selectedCategories.has(category.id)}
                  onCheckedChange={(checked) =>
                    updateSettings((current) => {
                      const next = new Set(current.allowedCategories ?? []);
                      if (checked === true) next.add(category.id);
                      else next.delete(category.id);
                      return { ...current, allowedCategories: [...next] };
                    })
                  }
                />
                <span>{category.title}</span>
              </label>
            ))}
          </div>
        </SettingsPanel>

        <SettingsPanel className="p-4">
          <SettingsFieldGroup
            label="First pass"
            description="Higher sampling and detail improve fast motion or small text, with more latency and tokens."
          >
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label>
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Frame sampling
                </span>
                <SelectMenu
                  value={settings.video.fps}
                  options={MEDIA_ANALYSIS_FPS_OPTIONS}
                  onValueChange={(fps) =>
                    updateSettings((current) => ({
                      ...current,
                      video: { ...current.video, fps },
                    }))
                  }
                  ariaLabel="First-pass frame sampling"
                  variant="field"
                  menuWidth="trigger"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Media detail
                </span>
                <SelectMenu
                  value={settings.video.mediaResolution}
                  options={MEDIA_ANALYSIS_RESOLUTION_OPTIONS}
                  onValueChange={(mediaResolution) =>
                    updateSettings((current) => ({
                      ...current,
                      video: { ...current.video, mediaResolution },
                    }))
                  }
                  ariaLabel="Media detail"
                  variant="field"
                  menuWidth="trigger"
                />
              </label>
            </div>
          </SettingsFieldGroup>
        </SettingsPanel>

        <SettingsPanel className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">
                Boundary review
              </h3>
              <p className="mt-1 text-xs leading-4 text-muted-foreground">
                Recheck only proposed scene boundaries in a short,
                higher-sampled window.
              </p>
            </div>
            <Switch
              aria-label="Refine scene boundaries"
              checked={settings.video.boundaryRefinement.enabled}
              onCheckedChange={(enabled) =>
                updateSettings((current) => ({
                  ...current,
                  video: {
                    ...current.video,
                    boundaryRefinement: {
                      ...current.video.boundaryRefinement,
                      enabled,
                    },
                  },
                }))
              }
            />
          </div>
          {settings.video.boundaryRefinement.enabled && (
            <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <label>
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Review sampling
                </span>
                <SelectMenu
                  value={settings.video.boundaryRefinement.fps}
                  options={MEDIA_ANALYSIS_REVIEW_FPS_OPTIONS}
                  onValueChange={(fps) =>
                    updateSettings((current) => ({
                      ...current,
                      video: {
                        ...current.video,
                        boundaryRefinement: {
                          ...current.video.boundaryRefinement,
                          fps,
                        },
                      },
                    }))
                  }
                  ariaLabel="Boundary review sampling"
                  variant="field"
                  menuWidth="trigger"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Safety margin per side
                </span>
                <SelectMenu
                  value={settings.video.boundaryRefinement.safetyMarginSeconds}
                  options={MEDIA_ANALYSIS_MARGIN_OPTIONS}
                  onValueChange={(safetyMarginSeconds) =>
                    updateSettings((current) => ({
                      ...current,
                      video: {
                        ...current.video,
                        boundaryRefinement: {
                          ...current.video.boundaryRefinement,
                          safetyMarginSeconds,
                        },
                      },
                    }))
                  }
                  ariaLabel="Boundary safety margin"
                  variant="field"
                  menuWidth="trigger"
                />
              </label>
            </div>
          )}
        </SettingsPanel>

        <SettingsActions className="justify-between">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {saving
              ? "Saving media analysis settings…"
              : dirty
                ? "Unsaved changes"
                : "Settings are saved"}
          </p>
          <Button
            variant="primary"
            size="sm"
            aria-label="Save media analysis settings"
            onClick={handleSave}
            disabled={
              !dirty ||
              saving ||
              !settings.modelId ||
              settings.allowedCategories?.length === 0
            }
          >
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </SettingsActions>
      </SettingsAnimatedBody>
    </SettingsSectionLayout>
  );
}

function AudioSection({
  voiceInputModels,
  localSpeechModelStatuses,
}: {
  voiceInputModels: ModelCatalogEntryInfo[];
  localSpeechModelStatuses: Record<string, boolean>;
}) {
  const feedback = useAppFeedback();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [asrEnabled, setAsrEnabled] = useState(false);
  const [asrModel, setAsrModel] = useState("");
  const [setupDialog, setSetupDialog] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const audioVersionRef = useRef(0);
  const asrModelOptions = useMemo<SelectOption<string>[]>(
    () =>
      voiceInputModels
        .filter((entry) =>
          isGlobalModelEnabled(entry, localSpeechModelStatuses),
        )
        .map((entry) => ({
          value: entry.model.id,
          label: entry.model.name,
        })),
    [localSpeechModelStatuses, voiceInputModels],
  );
  const hasAvailableVoiceInputModel = asrModelOptions.length > 0;
  const voiceInputAvailabilityResolved = useMemo(
    () =>
      voiceInputModels.every(
        (entry) =>
          !isLocalSpeechModelEntry(entry) ||
          localSpeechModelStatuses[entry.model.id] !== undefined,
      ),
    [localSpeechModelStatuses, voiceInputModels],
  );

  const markDirty = useCallback(() => {
    audioVersionRef.current += 1;
    setDirty(true);
  }, []);

  const applyConfig = useCallback(
    (config: LocalAudioConfig) => {
      setAsrEnabled(config.asr.enabled);
      const configuredEntry = voiceInputModels.find(
        (entry) =>
          entry.model.id === config.asr.model ||
          asrModelValue(entry) === config.asr.model,
      );
      setAsrModel(configuredEntry?.model.id ?? config.asr.model);
    },
    [voiceInputModels],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchLocalAudioConfig()
      .then((config) => {
        if (cancelled) return;
        applyConfig(config);
      })
      .catch((err) => {
        if (cancelled) return;
        feedback.notify({
          variant: "error",
          title: "Could not load voice input settings",
          message: displayErrorMessage(err),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyConfig, feedback]);

  useEffect(() => {
    if (loading || !voiceInputAvailabilityResolved) return;
    if (asrModelOptions.some((option) => option.value === asrModel)) return;
    if (asrModelOptions.length > 0) {
      setAsrModel(asrModelOptions[0]!.value);
    } else if (asrEnabled) {
      setAsrEnabled(false);
    } else {
      return;
    }
    markDirty();
  }, [
    asrEnabled,
    asrModel,
    asrModelOptions,
    loading,
    markDirty,
    voiceInputAvailabilityResolved,
  ]);

  useEffect(() => {
    if (loading || !dirty) return;
    const version = audioVersionRef.current;
    const timer = window.setTimeout(() => {
      setSaving(true);
      const body: Record<string, unknown> = {
        asr_enabled: asrEnabled,
        asr_model: asrModel.trim(),
      };
      void fetch(runtimeApiUrl("/api/v1/local/audio"), {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          if (!res.ok) {
            const json = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            throw new Error(json?.error ?? `HTTP ${res.status}`);
          }
          return (await res.json()) as LocalAudioConfig;
        })
        .then((config) => {
          if (audioVersionRef.current !== version) return;
          setDirty(false);
          applyConfig(config);
          feedback.notify({
            variant: "success",
            title: "Voice input settings saved",
          });
        })
        .catch((err) => {
          if (audioVersionRef.current !== version) return;
          feedback.notify({
            variant: "error",
            title: "Could not save voice input settings",
            message: displayErrorMessage(err),
          });
        })
        .finally(() => {
          if (audioVersionRef.current === version) setSaving(false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [applyConfig, asrEnabled, asrModel, dirty, feedback, loading]);

  const asrBlockingReason = !hasAvailableVoiceInputModel
    ? "Enable an audio-capable model in Models before enabling voice input."
    : undefined;
  const openAsrSetupDialog = useCallback(() => {
    setSetupDialog({
      title: "Configure voice input model",
      message:
        "Enable a model that accepts audio and returns text. Local and cloud routes are both supported.",
    });
  }, []);
  const handleAsrEnabledChange = useCallback(
    (next: boolean) => {
      if (next && asrBlockingReason) {
        openAsrSetupDialog();
        return;
      }
      setAsrEnabled(next);
      markDirty();
    },
    [asrBlockingReason, markDirty, openAsrSetupDialog],
  );
  return (
    <section>
      <div className="mb-5 flex items-center gap-3">
        <Microphone
          className="h-5 w-5 text-stone-600 dark:text-stone-300"
          weight="bold"
        />
        <div className="flex-1">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
            Microphone transcription
          </h2>
          <p className="text-sm text-stone-600 dark:text-stone-300">
            Transcribe with any enabled audio-capable model.
          </p>
        </div>
      </div>

      {loading ? (
        <SettingsFormSkeleton
          ariaLabel="Loading audio settings"
          variant="audio"
        />
      ) : (
        <SettingsAnimatedBody>
          <div className="max-w-2xl">
            <LocalSpeechSettingsCard
              title="Voice input"
              description="Transcribe microphone clips before sending."
              switchLabel="Enable voice input"
              modelLabel="ASR model"
              enabled={asrEnabled}
              saving={saving}
              blockingReason={asrBlockingReason}
              modelOptions={asrModelOptions}
              modelValue={asrModel}
              onEnabledChange={handleAsrEnabledChange}
              onModelChange={(next) => {
                setAsrModel(next);
                markDirty();
              }}
              onConfigure={openAsrSetupDialog}
            />
          </div>

          {saving && (
            <div
              className="text-sm font-medium text-stone-500 dark:text-stone-400"
              aria-live="polite"
            >
              Saving audio settings…
            </div>
          )}
        </SettingsAnimatedBody>
      )}
      <Dialog
        open={!!setupDialog}
        onClose={() => setSetupDialog(null)}
        title={setupDialog?.title ?? "Configure local speech model"}
        description={setupDialog?.message}
        size="sm"
      >
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button onClick={() => setSetupDialog(null)} size="sm">
            Cancel
          </Button>
          <Link
            to="/settings?section=models"
            onClick={() => setSetupDialog(null)}
            className={buttonVariants({ variant: "primary", size: "sm" })}
          >
            Open Models
          </Link>
        </div>
      </Dialog>
    </section>
  );
}

/**
 * Agents — install, authenticate, and enable the local ACP harnesses Copilot can use.
 */
function AgentsSection() {
  const rt = useClashRuntime();
  const feedback = useAppFeedback();
  const [harnesses, setHarnesses] = useState<LocalHarnessInfo[]>([]);
  const [harnessLoading, setHarnessLoading] = useState(true);
  const [harnessLoadingMessage, setHarnessLoadingMessage] = useState(
    "Checking installed agents…",
  );
  const savingHarnesses = useHarnessOperations();
  const [authLaunches, setAuthLaunches] = useState<
    Record<string, AuthLaunchState>
  >({});
  const [authFieldValues, setAuthFieldValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const authOpeningTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout> | undefined>
  >({});
  const authProbeTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout> | undefined>
  >({});
  const [uninstallHarnessTarget, setUninstallHarnessTarget] =
    useState<LocalHarnessInfo | null>(null);
  const [agentServers, setAgentServers] = useState<LocalAgentServersConfig>({});
  const [agentServersSaving, setAgentServersSaving] = useState(false);
  const [customAgentDialogOpen, setCustomAgentDialogOpen] = useState(false);
  const [customAgentOriginalName, setCustomAgentOriginalName] = useState<
    string | null
  >(null);
  const [customAgentStarterId, setCustomAgentStarterId] = useState<string>(
    CUSTOM_AGENT_SERVER_STARTERS[0].id,
  );
  const [customAgentName, setCustomAgentName] = useState<string>(
    CUSTOM_AGENT_SERVER_STARTERS[0].name,
  );
  const [customAgentCommand, setCustomAgentCommand] = useState<string>(
    CUSTOM_AGENT_SERVER_STARTERS[0].command,
  );
  const [customAgentArgsText, setCustomAgentArgsText] = useState(
    formatArgsText(CUSTOM_AGENT_SERVER_STARTERS[0].args),
  );
  const [customAgentEnvText, setCustomAgentEnvText] = useState(
    formatEnvText(CUSTOM_AGENT_SERVER_STARTERS[0].env),
  );
  const [customAgentError, setCustomAgentError] = useState<string | null>(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(
    null,
  );

  const setHarnessSavingAction = useCallback(
    (harnessId: string, action: HarnessSavingAction) => {
      setHarnessOperation(harnessId, action);
    },
    [],
  );

  const clearHarnessSavingAction = useCallback(
    (harnessId: string, expectedAction?: HarnessSavingAction) => {
      clearHarnessOperation(harnessId, expectedAction);
    },
    [],
  );

  const clearAuthTimers = useCallback((harnessId: string) => {
    const openingTimer = authOpeningTimersRef.current[harnessId];
    if (openingTimer) clearTimeout(openingTimer);
    delete authOpeningTimersRef.current[harnessId];
    const probeTimer = authProbeTimersRef.current[harnessId];
    if (probeTimer) clearTimeout(probeTimer);
    delete authProbeTimersRef.current[harnessId];
  }, []);

  const loadHarnesses = useCallback(
    async (
      opts: {
        refresh?: boolean;
        probe?: "auth" | "config";
        showGlobalLoading?: boolean;
        loadingMessage?: string;
      } = {},
    ): Promise<LocalHarnessInfo[]> => {
      const showGlobalLoading = opts.showGlobalLoading ?? true;
      if (showGlobalLoading) {
        setHarnessLoadingMessage(
          opts.loadingMessage ??
            (opts.probe === "auth"
              ? "Checking agent auth…"
              : opts.probe === "config"
                ? "Checking agent model options…"
                : "Checking installed agents…"),
        );
        setHarnessLoading(true);
      }
      try {
        const query = new URLSearchParams();
        if (opts.probe) query.set("probe", opts.probe);
        if (opts.refresh) query.set("refresh", "1");
        const path = query.toString()
          ? `/api/v1/local/harnesses?${query.toString()}`
          : "/api/v1/local/harnesses";
        const res = await fetch(runtimeApiUrl(path), {
          method: "GET",
          credentials: "include",
        });
        if (res.status === 404) {
          setHarnesses([]);
          return [];
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { harnesses?: LocalHarnessInfo[] };
        const nextHarnesses = json.harnesses ?? [];
        setHarnesses(nextHarnesses);
        return nextHarnesses;
      } catch (e) {
        feedback.notify({
          variant: "error",
          title: "Could not load agents",
          message: displayErrorMessage(e),
          actionLabel: "Retry",
          onAction: () => {
            void loadHarnesses({
              probe: "auth",
              refresh: true,
              loadingMessage: "Checking agent auth and models…",
            });
            void rt.refresh({ probe: "config", refresh: true });
          },
        });
        return [];
      } finally {
        if (showGlobalLoading) setHarnessLoading(false);
      }
    },
    [feedback, rt.refresh],
  );

  const loadAgentServers = useCallback(async () => {
    try {
      const res = await fetch(runtimeApiUrl("/api/v1/local/agent-servers"), {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        agent_servers?: LocalAgentServersConfig;
      };
      setAgentServers(json.agent_servers ?? {});
    } catch {
      // Older local APIs may not expose editable custom agent servers.
    }
  }, []);

  useEffect(() => {
    void loadHarnesses({
      probe: "auth",
      loadingMessage: "Checking installed agent auth…",
    });
    void loadAgentServers();
  }, [loadHarnesses, loadAgentServers]);

  useEffect(
    () => () => {
      for (const timer of Object.values(authOpeningTimersRef.current)) {
        if (timer) clearTimeout(timer);
      }
      for (const timer of Object.values(authProbeTimersRef.current)) {
        if (timer) clearTimeout(timer);
      }
    },
    [],
  );

  useEffect(() => {
    const handleHarnessUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          id?: unknown;
          installedVersion?: unknown;
        }>
      ).detail;
      if (typeof detail?.id !== "string") return;
      setHarnesses((current) =>
        current.map((harness) =>
          harness.id === detail.id
            ? {
                ...harness,
                ...(typeof detail.installedVersion === "string"
                  ? { installedVersion: detail.installedVersion }
                  : {}),
                updateAvailable: false,
              }
            : harness,
        ),
      );
    };
    window.addEventListener(HARNESS_UPDATED_EVENT, handleHarnessUpdated);
    return () =>
      window.removeEventListener(HARNESS_UPDATED_EVENT, handleHarnessUpdated);
  }, []);

  const onRecheckHarnesses = useCallback(
    async (harnessId?: string) => {
      const scopedHarness = harnessId
        ? harnesses.find((candidate) => candidate.id === harnessId)
        : null;
      if (scopedHarness) setHarnessSavingAction(scopedHarness.id, "probe");
      try {
        await Promise.all([
          loadHarnesses({
            probe: "auth",
            refresh: true,
            showGlobalLoading: !scopedHarness,
            loadingMessage: "Checking agent auth and models…",
          }),
          rt.refresh({ probe: "config", refresh: true }),
        ]);
      } catch (e) {
        feedback.notify({
          variant: "error",
          title: "Could not check agents",
          message: displayErrorMessage(e),
          actionLabel: "Open Agents",
          actionHref: "/settings?section=agents",
        });
      } finally {
        if (scopedHarness) {
          clearHarnessSavingAction(scopedHarness.id, "probe");
        }
      }
    },
    [
      clearHarnessSavingAction,
      feedback,
      harnesses,
      loadHarnesses,
      rt.refresh,
      setHarnessSavingAction,
    ],
  );

  const scheduleAuthProbe = useCallback(
    (harnessId: string, label: string, attempt = 0) => {
      const existingTimer = authProbeTimersRef.current[harnessId];
      if (existingTimer) clearTimeout(existingTimer);
      authProbeTimersRef.current[harnessId] = setTimeout(() => {
        delete authProbeTimersRef.current[harnessId];
        void (async () => {
          const nextHarnesses = await loadHarnesses({
            probe: "auth",
            refresh: true,
          });
          const harness = nextHarnesses.find(
            (candidate) => candidate.id === harnessId,
          );
          if (harness?.available && !harnessAuthBlocksEnable(harness)) {
            clearAuthTimers(harnessId);
            setAuthLaunches((current) => {
              const { [harnessId]: _removed, ...rest } = current;
              return rest;
            });
            await rt.refresh({ probe: "config", refresh: true });
            return;
          }
          if (attempt + 1 >= AUTH_RECHECK_MAX_ATTEMPTS) {
            setAuthLaunches((current) => ({
              ...current,
              [harnessId]: {
                ...(current[harnessId] ?? { status: "attention" as const }),
                status: "attention",
                message: `Still waiting for ${label} auth.`,
              },
            }));
            return;
          }
          setAuthLaunches((current) => ({
            ...current,
            [harnessId]: {
              ...(current[harnessId] ?? { status: "waiting" as const }),
              status: "waiting",
              message: `Waiting for ${label} auth…`,
            },
          }));
          scheduleAuthProbe(harnessId, label, attempt + 1);
        })();
      }, AUTH_RECHECK_INTERVAL_MS);
    },
    [clearAuthTimers, loadHarnesses, rt.refresh],
  );

  const saveHarnessEnablement = async (
    baseHarnesses: LocalHarnessInfo[],
    harnessId: string,
    enabled: boolean,
  ): Promise<LocalHarnessInfo[]> => {
    const nextEnabled = new Set(
      baseHarnesses
        .filter((harness) => harness.enabled)
        .map((harness) => harness.id),
    );
    if (enabled) nextEnabled.add(harnessId);
    else nextEnabled.delete(harnessId);
    const res = await fetch(runtimeApiUrl("/api/v1/local/harnesses"), {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled_harness_ids: Array.from(nextEnabled) }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    const json = (await res.json()) as { harnesses?: LocalHarnessInfo[] };
    return json.harnesses ?? [];
  };

  const onToggleHarness = async (harnessId: string, enabled: boolean) => {
    const previousHarnesses = harnesses;
    const target = previousHarnesses.find(
      (harness) => harness.id === harnessId,
    );
    if (enabled && (!target?.available || harnessAuthBlocksEnable(target))) {
      feedback.notify({
        variant: "error",
        title: `Could not enable ${target?.label ?? "agent"}`,
        message:
          target?.auth?.message ??
          "Install and check auth before enabling this agent.",
        actionLabel: "Check again",
        onAction: () => {
          void onRecheckHarnesses();
        },
      });
      return;
    }
    const optimisticHarnesses = previousHarnesses.map((harness) =>
      harness.id === harnessId ? { ...harness, enabled } : harness,
    );
    setHarnesses(optimisticHarnesses);
    setHarnessSavingAction(harnessId, "toggle");
    try {
      const savedHarnesses = await saveHarnessEnablement(
        optimisticHarnesses,
        harnessId,
        enabled,
      );
      setHarnesses(savedHarnesses);
      if (enabled && !target?.auth) {
        setHarnessSavingAction(harnessId, "probe");
        await Promise.all([
          loadHarnesses({
            probe: "auth",
            refresh: true,
            loadingMessage: "Checking agent auth and models…",
          }),
          rt.refresh({ probe: "config", refresh: true }),
        ]);
      }
    } catch (e) {
      const harness = harnesses.find((candidate) => candidate.id === harnessId);
      let refreshedAfterFailure = false;
      if (enabled) {
        setHarnessSavingAction(harnessId, "probe");
        const nextHarnesses = await loadHarnesses({
          probe: "auth",
          refresh: true,
        });
        refreshedAfterFailure = nextHarnesses.some(
          (candidate) => candidate.id === harnessId,
        );
        await rt.refresh({ probe: "config", refresh: true });
      }
      if (!refreshedAfterFailure) {
        setHarnesses(previousHarnesses);
      }
      feedback.notify({
        variant: "error",
        title: `Could not ${enabled ? "enable" : "disable"} ${harness?.label ?? "agent"}`,
        message: displayErrorMessage(e),
        actionLabel: "Check again",
        onAction: () => {
          void onRecheckHarnesses();
        },
      });
    } finally {
      clearHarnessSavingAction(harnessId);
    }
  };

  const installHarnessRequest = async (
    harnessId: string,
  ): Promise<LocalHarnessInfo[]> => {
    const res = await fetch(
      runtimeApiUrl(
        `/api/v1/local/harnesses/${encodeURIComponent(harnessId)}/install`,
      ),
      {
        method: "POST",
        credentials: "include",
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    const json = (await res.json()) as { harnesses?: LocalHarnessInfo[] };
    return json.harnesses ?? [];
  };

  const onInstallHarness = async (harnessId: string) => {
    const harnessLabel =
      harnesses.find((candidate) => candidate.id === harnessId)?.label ??
      "agent";
    let installed = false;
    setHarnessSavingAction(harnessId, "install");
    try {
      const nextHarnesses = await installHarnessRequest(harnessId);
      setHarnesses((current) =>
        mergeHarnessResult(current, nextHarnesses, harnessId),
      );
      installed = true;

      setHarnessSavingAction(harnessId, "probe");
      const [probedHarnesses] = await Promise.all([
        loadHarnesses({
          probe: "auth",
          refresh: true,
          showGlobalLoading: false,
        }),
        rt.refresh({ probe: "config", refresh: true }),
      ]);
      const setupHarnesses =
        probedHarnesses.length > 0 ? probedHarnesses : nextHarnesses;
      const installedHarness = setupHarnesses.find(
        (candidate) => candidate.id === harnessId,
      );
      if (
        installedHarness?.available &&
        !harnessAuthBlocksEnable(installedHarness)
      ) {
        setHarnessSavingAction(harnessId, "toggle");
        const enabledHarnesses = await saveHarnessEnablement(
          setupHarnesses,
          harnessId,
          true,
        );
        setHarnesses((current) =>
          mergeHarnessResult(current, enabledHarnesses, harnessId),
        );
        await rt.refresh({ probe: "config", refresh: true });
      }
    } catch (e) {
      const harness = harnesses.find((candidate) => candidate.id === harnessId);
      feedback.notify({
        variant: "error",
        title: installed
          ? `Could not finish setting up ${harness?.label ?? harnessLabel}`
          : `Could not install ${harness?.label ?? harnessLabel}`,
        message: displayErrorMessage(e),
        actionLabel: "Check again",
        onAction: () => {
          void onRecheckHarnesses();
        },
      });
    } finally {
      clearHarnessSavingAction(harnessId);
    }
  };

  const onUninstallHarness = async (harnessId: string) => {
    setHarnessSavingAction(harnessId, "uninstall");
    try {
      const res = await fetch(
        runtimeApiUrl(
          `/api/v1/local/harnesses/${encodeURIComponent(harnessId)}/install`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { harnesses?: LocalHarnessInfo[] };
      setHarnesses((current) =>
        mergeHarnessResult(current, json.harnesses ?? [], harnessId),
      );
      setUninstallHarnessTarget(null);
      await rt.refresh({ probe: "config", refresh: true });
    } catch (e) {
      const harness =
        harnesses.find((candidate) => candidate.id === harnessId) ??
        uninstallHarnessTarget;
      feedback.notify({
        variant: "error",
        title: `Could not uninstall ${harness?.label ?? "agent"}`,
        message: displayErrorMessage(e),
        actionLabel: "Check again",
        onAction: () => {
          void onRecheckHarnesses();
        },
      });
    } finally {
      clearHarnessSavingAction(harnessId);
    }
  };

  const onUpgradeHarness = async (harnessId: string) => {
    setHarnessSavingAction(harnessId, "upgrade");
    try {
      const res = await fetch(
        runtimeApiUrl(
          `/api/v1/local/harnesses/${encodeURIComponent(harnessId)}/upgrade`,
        ),
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { harnesses?: LocalHarnessInfo[] };
      const nextHarnesses = json.harnesses ?? [];
      const updatedHarness = nextHarnesses.find(
        (candidate) => candidate.id === harnessId,
      );
      setHarnesses((current) =>
        mergeHarnessResult(current, nextHarnesses, harnessId),
      );
      window.dispatchEvent(
        new CustomEvent(HARNESS_UPDATED_EVENT, {
          detail: {
            id: harnessId,
            label: updatedHarness?.label,
            installedVersion: updatedHarness?.installedVersion,
          },
        }),
      );
      await rt.refresh({ probe: "config", refresh: true });
    } catch (e) {
      const harness = harnesses.find((candidate) => candidate.id === harnessId);
      feedback.notify({
        variant: "error",
        title: `Could not upgrade ${harness?.label ?? "agent"}`,
        message: displayErrorMessage(e),
        actionLabel: "Check again",
        onAction: () => {
          void onRecheckHarnesses();
        },
      });
    } finally {
      clearHarnessSavingAction(harnessId);
    }
  };

  const onAuthenticateHarness = async (
    harnessId: string,
    methodId?: string,
    values?: Record<string, string>,
  ) => {
    const harness = harnesses.find((candidate) => candidate.id === harnessId);
    const label = harness?.label ?? "agent";
    const authMethod = methodId
      ? harness?.auth?.methods?.find((candidate) => candidate.id === methodId)
      : harness?.auth?.methods?.[0];
    const methodLabel = authMethod?.name ?? authMethod?.id ?? null;
    if (authMethodIsEnvVar(authMethod)) {
      const variableNames = authMethodVariableNames(authMethod);
      const variableText =
        variableNames.length > 0
          ? `Set ${variableNames.join(", ")} in your agent environment, then check again.`
          : "Set the required credentials in your agent environment, then check again.";
      feedback.notify({
        variant: "info",
        title: `Configure ${label} credentials`,
        message: variableText,
        actionLabel: "Check again",
        onAction: () => {
          void onRecheckHarnesses(harnessId);
        },
      });
      return;
    }
    const authNoun = authMethodIsTerminal(authMethod) ? "setup" : "sign in";
    clearAuthTimers(harnessId);
    setAuthLaunches((current) => ({
      ...current,
      [harnessId]: {
        status: "opening",
        ...(methodId ? { methodId } : {}),
        ...(methodLabel ? { methodLabel } : {}),
        message: `Opening ${label} ${authNoun}…`,
      },
    }));
    setHarnessSavingAction(harnessId, "auth");
    const authAbortController = new AbortController();
    authOpeningTimersRef.current[harnessId] = setTimeout(() => {
      delete authOpeningTimersRef.current[harnessId];
      clearHarnessSavingAction(harnessId, "auth");
      setAuthLaunches((current) => ({
        ...current,
        [harnessId]: {
          ...(current[harnessId] ?? {}),
          status: "waiting",
          ...(methodId ? { methodId } : {}),
          ...(methodLabel ? { methodLabel } : {}),
          message: `Waiting for ${label} auth…`,
        },
      }));
      scheduleAuthProbe(harnessId, label);
      authAbortController.abort();
    }, AUTH_LAUNCH_OPENING_TIMEOUT_MS);
    try {
      const res = await fetch(
        runtimeApiUrl(
          `/api/v1/local/harnesses/${encodeURIComponent(harnessId)}/authenticate`,
        ),
        {
          method: "POST",
          credentials: "include",
          signal: authAbortController.signal,
          ...(methodId || values
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  ...(methodId ? { method_id: methodId } : {}),
                  ...(values ? { values } : {}),
                }),
              }
            : {}),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { harnesses?: LocalHarnessInfo[] };
      const nextHarnesses = json.harnesses ?? [];
      setHarnesses((current) =>
        mergeHarnessResult(current, nextHarnesses, harnessId),
      );
      const openingTimer = authOpeningTimersRef.current[harnessId];
      if (openingTimer) clearTimeout(openingTimer);
      delete authOpeningTimersRef.current[harnessId];
      const authenticatedHarness = nextHarnesses.find(
        (candidate) => candidate.id === harnessId,
      );
      if (
        authenticatedHarness?.available &&
        !harnessAuthBlocksEnable(authenticatedHarness)
      ) {
        setAuthFieldValues((current) => {
          const prefix = `${harnessId}:`;
          return Object.fromEntries(
            Object.entries(current).filter(([key]) => !key.startsWith(prefix)),
          );
        });
        clearAuthTimers(harnessId);
        setAuthLaunches((current) => {
          const { [harnessId]: _removed, ...rest } = current;
          return rest;
        });
        await rt.refresh({ probe: "config", refresh: true });
        return;
      }
      setAuthLaunches((current) => ({
        ...current,
        [harnessId]: {
          ...(current[harnessId] ?? {}),
          status: "waiting",
          ...(methodId ? { methodId } : {}),
          ...(methodLabel ? { methodLabel } : {}),
          message: `Waiting for ${label} auth…`,
        },
      }));
      scheduleAuthProbe(harnessId, label);
    } catch (e) {
      if (isAbortError(e)) {
        return;
      }
      clearAuthTimers(harnessId);
      setAuthLaunches((current) => {
        const { [harnessId]: _removed, ...rest } = current;
        return rest;
      });
      feedback.notify({
        variant: "error",
        title: authMethodIsTerminal(authMethod)
          ? `Could not open ${label} setup`
          : `Could not start ${label} sign in`,
        message: displayErrorMessage(e),
        actionLabel: "Check again",
        onAction: () => {
          void onRecheckHarnesses();
        },
      });
    } finally {
      clearHarnessSavingAction(harnessId, "auth");
    }
  };

  const applyCustomAgentStarter = useCallback((starterId: string) => {
    const starter =
      CUSTOM_AGENT_SERVER_STARTERS.find(
        (candidate) => candidate.id === starterId,
      ) ?? CUSTOM_AGENT_SERVER_STARTERS[0];
    setCustomAgentStarterId(starter.id);
    setCustomAgentName(starter.name);
    setCustomAgentCommand(starter.command);
    setCustomAgentArgsText(formatArgsText(starter.args));
    setCustomAgentEnvText(formatEnvText(starter.env));
    setCustomAgentError(null);
  }, []);

  const openAddCustomAgentDialog = useCallback(() => {
    setCustomAgentOriginalName(null);
    applyCustomAgentStarter(CUSTOM_AGENT_SERVER_STARTERS[0].id);
    setCustomAgentDialogOpen(true);
  }, [applyCustomAgentStarter]);

  const openEditCustomAgentDialog = useCallback(
    (name: string, server: LocalAgentServersConfig[string]) => {
      setCustomAgentOriginalName(name);
      setCustomAgentStarterId("custom");
      setCustomAgentName(name);
      setCustomAgentCommand(server.command);
      setCustomAgentArgsText(formatArgsText(server.args));
      setCustomAgentEnvText(formatEnvText(server.env));
      setCustomAgentError(null);
      setCustomAgentDialogOpen(true);
    },
    [],
  );

  const saveAgentServers = useCallback(
    async (nextAgentServers: LocalAgentServersConfig) => {
      setAgentServersSaving(true);
      try {
        const res = await fetch(runtimeApiUrl("/api/v1/local/agent-servers"), {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent_servers: nextAgentServers }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          agent_servers?: LocalAgentServersConfig;
          harnesses?: LocalHarnessInfo[];
        };
        setAgentServers(json.agent_servers ?? {});
        setHarnesses(json.harnesses ?? []);
        await rt.refresh({ probe: "config", refresh: true });
        feedback.notify({
          variant: "success",
          title: "Custom agent servers saved",
        });
      } catch (e) {
        throw e;
      } finally {
        setAgentServersSaving(false);
      }
    },
    [feedback, rt],
  );

  const onSaveCustomAgentServer = async () => {
    const name = customAgentName.trim();
    const command = customAgentCommand.trim();
    if (!name) {
      setCustomAgentError("Agent server name is required.");
      return;
    }
    if (!command) {
      setCustomAgentError("Command is required.");
      return;
    }

    let env: Record<string, string> = {};
    try {
      const rawEnv = customAgentEnvText.trim();
      const parsedEnv = rawEnv ? (JSON.parse(rawEnv) as unknown) : {};
      if (
        !parsedEnv ||
        typeof parsedEnv !== "object" ||
        Array.isArray(parsedEnv)
      ) {
        throw new Error("Environment must be a JSON object.");
      }
      env = {};
      for (const [key, value] of Object.entries(parsedEnv)) {
        if (typeof value !== "string")
          throw new Error("Environment values must be strings.");
        env[key] = value;
      }
    } catch (error) {
      setCustomAgentError(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const nextAgentServers: LocalAgentServersConfig = { ...agentServers };
    if (customAgentOriginalName && customAgentOriginalName !== name) {
      delete nextAgentServers[customAgentOriginalName];
    }
    nextAgentServers[name] = {
      type: "custom",
      command,
      args: parseArgsText(customAgentArgsText),
      env,
    };

    try {
      await saveAgentServers(nextAgentServers);
      setCustomAgentDialogOpen(false);
    } catch (error) {
      setCustomAgentError(displayErrorMessage(error));
    }
  };

  const onRemoveCustomAgentServer = async (name: string) => {
    const nextAgentServers: LocalAgentServersConfig = { ...agentServers };
    delete nextAgentServers[name];
    try {
      await saveAgentServers(nextAgentServers);
    } catch (error) {
      feedback.notify({
        variant: "error",
        title: "Could not remove custom agent server",
        message: displayErrorMessage(error),
        actionLabel: "Open Agents",
        actionHref: "/settings?section=agents",
      });
    }
  };

  const localHarnessIds = useMemo(
    () => new Set(harnesses.map((harness) => harness.id)),
    [harnesses],
  );
  const localRuntimeId = useMemo(() => {
    const matchingRuntime = rt.runtimes.find((runtime) =>
      runtime.agents.some((agent) => localHarnessIds.has(agent.id)),
    );
    return (
      matchingRuntime?.id ??
      rt.runtimes.find((runtime) => runtime.status === "online")?.id ??
      rt.runtimes[0]?.id ??
      "local-agent-runtime"
    );
  }, [localHarnessIds, rt.runtimes]);

  const runtimeGroups = useMemo(() => {
    const configuredHarnessCount = harnesses.filter(harnessIsConfigured).length;
    if (rt.runtimes.length === 0) {
      return [
        {
          id: "local-agent-runtime",
          label: "Local runtime",
          status: harnessLoading ? "Checking" : "Local",
          online: true,
          agentCount: configuredHarnessCount,
          localControls: true,
          runtime: null,
        },
      ];
    }

    return rt.runtimes.map((runtime) => {
      const localControls = runtime.id === localRuntimeId;
      return {
        id: runtime.id,
        label: runtime.hostname || runtime.machine_id.slice(0, 12),
        status: runtime.status === "online" ? "Online" : "Offline",
        online: runtime.status === "online",
        agentCount: localControls
          ? configuredHarnessCount
          : runtime.agents.length,
        localControls,
        runtime,
      };
    });
  }, [harnessLoading, harnesses, localRuntimeId, rt.runtimes]);

  const defaultRuntimeGroup =
    runtimeGroups.find((group) => group.localControls) ??
    runtimeGroups.find((group) => group.online) ??
    runtimeGroups[0];
  const selectedRuntimeGroup =
    runtimeGroups.find((group) => group.id === selectedRuntimeId) ??
    defaultRuntimeGroup;

  useEffect(() => {
    if (
      selectedRuntimeId &&
      runtimeGroups.some((group) => group.id === selectedRuntimeId)
    ) {
      return;
    }
    setSelectedRuntimeId(defaultRuntimeGroup?.id ?? null);
  }, [defaultRuntimeGroup?.id, runtimeGroups, selectedRuntimeId]);

  const harnessCheckTooltip = harnessLoading
    ? harnessLoadingMessage
    : "Check installed agents, auth, and model options again.";

  return (
    <SettingsSectionLayout aria-labelledby="agents-heading">
      <SettingsSectionHeader
        title="Agents"
        titleId="agents-heading"
        description="Install, authenticate, and enable local agents for Copilot."
        icon={<Plug className="h-4 w-4" weight="bold" />}
        action={
          <Tooltip label={harnessCheckTooltip}>
            <Button
              size="sm"
              onClick={() => {
                void onRecheckHarnesses();
              }}
              disabled={harnessLoading}
              className="min-w-[6.75rem]"
            >
              {harnessLoading ? "Checking..." : "Check again"}
            </Button>
          </Tooltip>
        }
      />

      <TabProvider
        selectedId={selectedRuntimeGroup?.id ?? null}
        setSelectedId={(runtimeId) => {
          if (typeof runtimeId === "string") setSelectedRuntimeId(runtimeId);
        }}
        orientation="horizontal"
        focusLoop
      >
        <TabList
          aria-label="Runtime machines"
          className="flex max-w-full items-center gap-1 overflow-x-auto border-b border-border pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {runtimeGroups.map((group) => {
            const selected = group.id === selectedRuntimeGroup?.id;
            const agentCountLabel = `${group.agentCount} configured agent${group.agentCount === 1 ? "" : "s"}`;
            return (
              <Tab
                key={group.id}
                id={group.id}
                aria-label={`${group.label}, ${group.status}, ${agentCountLabel}`}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                  selected
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    group.online ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                  aria-hidden="true"
                />
                <span>{group.label}</span>
                <span className="text-[10px] text-muted-foreground">
                  {group.agentCount}
                </span>
              </Tab>
            );
          })}
        </TabList>
      </TabProvider>

      {selectedRuntimeGroup ? (
        <SettingsCollection
          data-runtime-group-id={selectedRuntimeGroup.id}
          aria-label={`${selectedRuntimeGroup.label} agents`}
        >
          {selectedRuntimeGroup.localControls ? (
            <>
              {harnessLoading && (
                <div
                  className="border-b border-warm-border px-4 py-2 text-xs text-stone-500 dark:text-stone-400"
                  aria-live="polite"
                >
                  {harnessLoadingMessage}
                </div>
              )}

              {harnessLoading && harnesses.length === 0 && (
                <AgentRowsSkeleton ariaLabel="Loading agents" />
              )}

              {!harnessLoading && harnesses.length === 0 && (
                <div className="px-4 py-5 text-sm text-stone-600 dark:text-stone-300">
                  No local agents discovered for this runtime.
                </div>
              )}

              {harnesses.length > 0 && (
                <SettingsAnimatedBody className="grid gap-[var(--settings-row-gap)]">
                  {harnesses.map((harness) => {
                    const savingAction = savingHarnesses[harness.id] ?? null;
                    const authLaunch = authLaunches[harness.id] ?? null;
                    const authOpening = authLaunch?.status === "opening";
                    const authWaiting = authLaunch?.status === "waiting";
                    const authAttention = authLaunch?.status === "attention";
                    const busy = savingAction != null;
                    const versionLine = formatHarnessVersionLine(harness);
                    const canInstall =
                      !harness.available &&
                      !harness.installed &&
                      harness.installable;
                    const canUninstall =
                      harness.installed && harness.installable;
                    const canUpgrade =
                      harness.installed &&
                      harness.installable &&
                      harness.updateAvailable;
                    const needsAuth =
                      harness.available &&
                      harness.auth?.status === "needs-auth";
                    const authMethods = needsAuth
                      ? (harness.auth?.methods ?? [])
                      : [];
                    const fieldAuthMethods = authMethods.filter(
                      (method) =>
                        method.form === "fields" &&
                        (method.vars?.length ?? 0) > 0,
                    );
                    const launchAuthMethods = authMethods.filter(
                      (method) =>
                        method.form !== "fields" ||
                        (method.vars?.length ?? 0) === 0,
                    );
                    const authMethodDescription =
                      authMethods.length === 1
                        ? authMethods[0]?.description
                        : null;
                    const hasTerminalAuthMethod = authMethods.some((method) =>
                      authMethodIsTerminal(method),
                    );
                    const hasEnvVarAuthMethod = authMethods.some((method) =>
                      authMethodIsEnvVar(method),
                    );
                    const envVarAuthNames = authMethods.flatMap((method) =>
                      authMethodIsEnvVar(method)
                        ? authMethodVariableNames(method)
                        : [],
                    );
                    const busyMessage = harnessBusyMessage(
                      harness.label,
                      savingAction,
                    );
                    const busyStatusLabel =
                      harnessBusyStatusLabel(savingAction);
                    const activeAuthMethod = authLaunch?.methodId
                      ? authMethods.find(
                          (method) => method.id === authLaunch.methodId,
                        )
                      : authMethods[0];
                    const authOpeningStatusLabel = authMethodIsTerminal(
                      activeAuthMethod,
                    )
                      ? "Opening setup…"
                      : "Opening sign in…";
                    const status = busyStatusLabel
                      ? {
                          label: busyStatusLabel,
                          className:
                            "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
                        }
                      : authOpening
                        ? {
                            label: authOpeningStatusLabel,
                            className:
                              "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
                          }
                        : authWaiting
                          ? {
                              label: "Waiting for auth…",
                              className:
                                "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
                            }
                          : authAttention
                            ? {
                                label: "Auth still pending",
                                className:
                                  "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
                              }
                            : harnessStatus(harness);
                    const authBlocked =
                      harness.available && harnessAuthBlocksEnable(harness);
                    const switchChecked = harness.enabled;
                    const showEnableSwitch =
                      (harness.available || harness.enabled) &&
                      (!authBlocked || harness.enabled);
                    const switchDisabled =
                      busy ||
                      (!harness.enabled && (authBlocked || !harness.available));
                    const switchDisabledReason = busy
                      ? `${harness.label} is ${
                          savingAction === "install"
                            ? "installing"
                            : savingAction === "upgrade"
                              ? "upgrading"
                              : savingAction === "uninstall"
                                ? "uninstalling"
                                : "checking"
                        }.`
                      : authBlocked
                        ? hasEnvVarAuthMethod
                          ? `Configure ${harness.label} credentials before enabling.`
                          : needsAuth
                            ? `Authenticate ${harness.label} before enabling.`
                            : `Check ${harness.label} auth before enabling.`
                        : !harness.available && !harness.enabled
                          ? `Install ${harness.label} before enabling.`
                          : undefined;
                    const switchReasonId = switchDisabledReason
                      ? `agent-switch-reason-${harness.id}`
                      : undefined;
                    const authRetryTooltip =
                      savingAction === "probe"
                        ? `Checking ${harness.label} auth.`
                        : harnessLoading
                          ? "A global agent check is already running."
                          : `Check ${harness.label} auth again.`;
                    return (
                      <SettingsRow
                        key={harness.id}
                        className="grid w-full grid-cols-[minmax(0,1fr)_minmax(8rem,24rem)] items-center gap-3 px-2.5 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <div className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                              {harness.label}
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}
                            >
                              {status.label}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-xs text-stone-500 dark:text-stone-400">
                            {harness.binary}
                          </span>
                          {versionLine && (
                            <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">
                              {versionLine}
                            </span>
                          )}
                          {harness.auth && (
                            <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
                              {harness.auth.message}
                            </span>
                          )}
                          {authMethodDescription &&
                            !harness.auth?.message.includes(
                              authMethodDescription,
                            ) && (
                              <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">
                                {authMethodDescription}
                              </span>
                            )}
                          {busyMessage && (
                            <span
                              className="mt-1 block text-xs text-sky-700 dark:text-sky-300"
                              aria-live="polite"
                            >
                              {busyMessage}
                            </span>
                          )}
                          {(authWaiting || authAttention) && (
                            <span
                              className={`mt-1 block text-xs ${authAttention ? "text-amber-700 dark:text-amber-300" : "text-sky-700 dark:text-sky-300"}`}
                            >
                              {authAttention
                                ? (authLaunch.message ??
                                  `Still waiting for ${harness.label} auth.`)
                                : (authLaunch.message ??
                                  `Waiting for ${harness.label} auth…`)}
                            </span>
                          )}
                          {needsAuth && harness.auth?.command && (
                            <Collapsible className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                              <CollapsibleTrigger asChild>
                                <Button
                                  size="sm"
                                  shape="rounded"
                                  className="min-h-0 cursor-pointer rounded-none border-transparent bg-transparent px-0 py-0 text-xs font-medium text-stone-600 shadow-none hover:bg-transparent hover:text-stone-700 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:underline focus-visible:underline-offset-4 dark:text-stone-300 dark:hover:text-stone-200"
                                >
                                  Manual fallback
                                </Button>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <span className="mt-1 block leading-5">
                                  {hasTerminalAuthMethod ? (
                                    "Configure the required credentials in the agent terminal, settings, or environment, then click Check again."
                                  ) : hasEnvVarAuthMethod ? (
                                    `Set ${envVarAuthNames.length > 0 ? envVarAuthNames.join(", ") : "the required environment variables"} in your agent environment, then click Check again.`
                                  ) : (
                                    <>
                                      If Sign in does not open, run{" "}
                                      <code className="rounded bg-warm-muted px-1 font-mono">
                                        {harness.auth.command}
                                      </code>{" "}
                                      and follow the agent auth prompt.
                                    </>
                                  )}
                                </span>
                              </CollapsibleContent>
                            </Collapsible>
                          )}
                          {!harness.available &&
                            !canInstall &&
                            harness.homepage && (
                              <span className="mt-1 block break-all text-xs text-stone-500 dark:text-stone-400">
                                Docs: {harness.homepage}
                              </span>
                            )}
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                          {fieldAuthMethods.map((method) => {
                            const formKey = `${harness.id}:${method.id}`;
                            const values = authFieldValues[formKey] ?? {};
                            const requiredComplete = (method.vars ?? []).every(
                              (variable) =>
                                variable.optional ||
                                Boolean(values[variable.name]?.trim()),
                            );
                            return (
                              <form
                                key={method.id}
                                className="flex min-w-[14rem] flex-wrap items-end justify-end gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  if (!requiredComplete) return;
                                  void onAuthenticateHarness(
                                    harness.id,
                                    method.id,
                                    values,
                                  );
                                }}
                              >
                                {(method.vars ?? []).map((variable) => (
                                  <label
                                    key={variable.name}
                                    className="min-w-[10rem] flex-1 text-left text-xs font-medium text-stone-600 dark:text-stone-300"
                                  >
                                    <span className="mb-1 block">
                                      {variable.label ?? variable.name}
                                    </span>
                                    <Input
                                      aria-label={
                                        variable.label ?? variable.name
                                      }
                                      type={
                                        variable.secret ? "password" : "text"
                                      }
                                      autoComplete="off"
                                      required={!variable.optional}
                                      value={values[variable.name] ?? ""}
                                      onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setAuthFieldValues((current) => ({
                                          ...current,
                                          [formKey]: {
                                            ...(current[formKey] ?? {}),
                                            [variable.name]: value,
                                          },
                                        }));
                                      }}
                                      className="h-8 rounded-lg font-mono text-xs"
                                    />
                                  </label>
                                ))}
                                <Button
                                  type="submit"
                                  size="sm"
                                  aria-label={`Continue with ${method.name ?? method.id}`}
                                  disabled={busy || !requiredComplete}
                                  className="rounded-lg border border-brand/30 bg-brand-light px-3 py-1.5 text-xs font-medium text-brand shadow-sm transition-colors hover:bg-brand-light/80 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  Continue
                                </Button>
                              </form>
                            );
                          })}
                          {canInstall && (
                            <Button
                              size="sm"
                              aria-label={`Install ${harness.label}`}
                              disabled={busy}
                              onClick={() => onInstallHarness(harness.id)}
                            >
                              {savingAction === "install"
                                ? "Installing…"
                                : "Install"}
                            </Button>
                          )}
                          {canUpgrade && (
                            <Button
                              size="sm"
                              aria-label={`Upgrade ${harness.label}`}
                              disabled={busy}
                              onClick={() => {
                                void onUpgradeHarness(harness.id);
                              }}
                              className="rounded-lg border border-brand/30 bg-brand-light px-3 py-1.5 text-xs font-medium text-brand shadow-sm transition-colors hover:bg-brand-light/80 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {savingAction === "upgrade"
                                ? "Upgrading…"
                                : "Upgrade"}
                            </Button>
                          )}
                          {canUninstall && (
                            <Button
                              size="sm"
                              variant="destructive"
                              aria-label={`Uninstall ${harness.label}`}
                              disabled={busy}
                              onClick={() => setUninstallHarnessTarget(harness)}
                              className="rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {savingAction === "uninstall"
                                ? "Uninstalling…"
                                : "Uninstall"}
                            </Button>
                          )}
                          {authBlocked && (
                            <Tooltip label={authRetryTooltip}>
                              <Button
                                size="sm"
                                aria-label={`Check ${harness.label} auth again`}
                                disabled={busy || harnessLoading}
                                onClick={() => {
                                  void onRecheckHarnesses(harness.id);
                                }}
                              >
                                {savingAction === "probe"
                                  ? "Checking auth…"
                                  : "Check again"}
                              </Button>
                            </Tooltip>
                          )}
                          {needsAuth &&
                            launchAuthMethods.length > 1 &&
                            launchAuthMethods.map((method) => {
                              const methodLabel = method.name ?? method.id;
                              const buttonLabel = authActionLabel(method, true);
                              const methodActive =
                                authLaunch?.methodId === method.id;
                              const methodOpening = authOpening && methodActive;
                              const methodWaiting =
                                (authWaiting || authAttention) && methodActive;
                              const methodOpeningLabel = authMethodIsTerminal(
                                method,
                              )
                                ? "Opening setup…"
                                : "Opening sign in…";
                              return (
                                <Button
                                  key={method.id}
                                  size="sm"
                                  aria-label={authActionAriaLabel(
                                    harness.label,
                                    method,
                                    true,
                                  )}
                                  disabled={busy && !methodWaiting}
                                  onClick={() =>
                                    onAuthenticateHarness(harness.id, method.id)
                                  }
                                  className="rounded-lg border border-brand/30 bg-brand-light px-3 py-1.5 text-xs font-medium text-brand shadow-sm transition-colors hover:bg-brand-light/80 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {methodOpening
                                    ? methodOpeningLabel
                                    : methodWaiting
                                      ? `Open ${methodLabel} again`
                                      : buttonLabel}
                                </Button>
                              );
                            })}
                          {needsAuth && launchAuthMethods.length === 1 && (
                            <Button
                              size="sm"
                              aria-label={authActionAriaLabel(
                                harness.label,
                                launchAuthMethods[0],
                                false,
                              )}
                              disabled={busy && !(authWaiting || authAttention)}
                              onClick={() =>
                                onAuthenticateHarness(
                                  harness.id,
                                  launchAuthMethods[0]?.id,
                                )
                              }
                              className="rounded-lg border border-brand/30 bg-brand-light px-3 py-1.5 text-xs font-medium text-brand shadow-sm transition-colors hover:bg-brand-light/80 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {authOpening
                                ? authMethodIsTerminal(launchAuthMethods[0])
                                  ? "Opening setup…"
                                  : "Opening sign in…"
                                : authWaiting || authAttention
                                  ? "Open again"
                                  : authActionLabel(
                                      launchAuthMethods[0],
                                      false,
                                    )}
                            </Button>
                          )}
                          {showEnableSwitch && (
                            <>
                              {switchDisabledReason ? (
                                <Tooltip label={switchDisabledReason}>
                                  <Switch
                                    checked={switchChecked}
                                    aria-label={`${switchChecked ? "Disable" : "Enable"} ${harness.label} agent`}
                                    aria-describedby={switchReasonId}
                                    disabled={switchDisabled}
                                    onCheckedChange={(checked) => {
                                      void onToggleHarness(harness.id, checked);
                                    }}
                                  />
                                </Tooltip>
                              ) : (
                                <Switch
                                  checked={switchChecked}
                                  aria-label={`${switchChecked ? "Disable" : "Enable"} ${harness.label} agent`}
                                  aria-describedby={switchReasonId}
                                  disabled={switchDisabled}
                                  onCheckedChange={(checked) => {
                                    void onToggleHarness(harness.id, checked);
                                  }}
                                />
                              )}
                              {switchDisabledReason && (
                                <span id={switchReasonId} className="sr-only">
                                  {switchDisabledReason}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </SettingsRow>
                    );
                  })}
                </SettingsAnimatedBody>
              )}
            </>
          ) : selectedRuntimeGroup.runtime?.agents.length ? (
            <SettingsAnimatedBody className="grid gap-[var(--settings-row-gap)]">
              {selectedRuntimeGroup.runtime.agents.map((agent) => {
                const status =
                  agent.auth?.status === "needs-auth"
                    ? "Auth needed"
                    : agent.auth?.status === "configured"
                      ? "Auth configured"
                      : "Reported";
                return (
                  <SettingsRow
                    key={`${selectedRuntimeGroup.id}-${agent.id}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                          {agent.label ?? agent.id}
                        </span>
                        <span className="rounded-full bg-warm-muted px-2 py-0.5 text-[11px] font-medium text-stone-600 dark:text-stone-300">
                          {status}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-xs text-stone-500 dark:text-stone-400">
                        {[
                          agent.binary,
                          agent.version ? `v${agent.version}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || agent.id}
                      </span>
                      {agent.auth?.message && (
                        <span className="mt-1 block text-xs text-stone-600 dark:text-stone-300">
                          {agent.auth.message}
                        </span>
                      )}
                    </div>
                    <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
                      {agent.config_options?.length
                        ? `${agent.config_options.length} options`
                        : "Read-only"}
                    </span>
                  </SettingsRow>
                );
              })}
            </SettingsAnimatedBody>
          ) : (
            <SettingsEmptyState>
              No agents reported by this runtime.
            </SettingsEmptyState>
          )}
        </SettingsCollection>
      ) : null}

      <div className="mt-4 space-y-3 border-t border-warm-border/80 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              Custom agent servers
            </h3>
            <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
              {Object.keys(agentServers).length > 0
                ? `${Object.keys(agentServers).length} custom server${Object.keys(agentServers).length === 1 ? "" : "s"} configured.`
                : "Add command-backed ACP agent servers."}
            </p>
          </div>
          <Button
            size="sm"
            onClick={openAddCustomAgentDialog}
            leftIcon={<Plus className="h-3.5 w-3.5" weight="bold" />}
          >
            Add custom agent server
          </Button>
        </div>
        {Object.entries(agentServers).length > 0 && (
          <SettingsCollection aria-label="Custom agent servers">
            {Object.entries(agentServers).map(([name, server]) => (
              <SettingsRow
                key={name}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {name}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-stone-500 dark:text-stone-400">
                    {formatAgentCommand(server)}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => openEditCustomAgentDialog(name, server)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      void onRemoveCustomAgentServer(name);
                    }}
                    disabled={agentServersSaving}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Remove
                  </Button>
                </div>
              </SettingsRow>
            ))}
          </SettingsCollection>
        )}
        <SettingsRow className="px-2.5 py-1.5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Prompt queue
              </h3>
              <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
                When enabled, follow-up messages wait for the current agent
                loop. Turn it off to send every message as a prompt immediately.
              </p>
            </div>
            <Switch
              checked={rt.promptQueueEnabled}
              aria-label={`${rt.promptQueueEnabled ? "Disable" : "Enable"} prompt queue`}
              onCheckedChange={(checked) => rt.setPromptQueueEnabled(checked)}
            />
          </div>
        </SettingsRow>
      </div>

      <CustomAgentServerDialog
        open={customAgentDialogOpen}
        editing={customAgentOriginalName != null}
        starterId={customAgentStarterId}
        name={customAgentName}
        command={customAgentCommand}
        argsText={customAgentArgsText}
        envText={customAgentEnvText}
        error={customAgentError}
        saving={agentServersSaving}
        onClose={() => setCustomAgentDialogOpen(false)}
        onStarterChange={applyCustomAgentStarter}
        onNameChange={setCustomAgentName}
        onCommandChange={setCustomAgentCommand}
        onArgsTextChange={setCustomAgentArgsText}
        onEnvTextChange={setCustomAgentEnvText}
        onSave={() => {
          void onSaveCustomAgentServer();
        }}
      />
      <UninstallHarnessDialog
        harness={uninstallHarnessTarget}
        busy={Boolean(
          uninstallHarnessTarget &&
          savingHarnesses[uninstallHarnessTarget.id] === "uninstall",
        )}
        onClose={() => {
          if (
            uninstallHarnessTarget &&
            savingHarnesses[uninstallHarnessTarget.id] === "uninstall"
          )
            return;
          setUninstallHarnessTarget(null);
        }}
        onConfirm={(harnessId) => {
          void onUninstallHarness(harnessId);
        }}
      />
    </SettingsSectionLayout>
  );
}

function UninstallHarnessDialog({
  harness,
  busy,
  onClose,
  onConfirm,
}: {
  harness: LocalHarnessInfo | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (harnessId: string) => void;
}) {
  return (
    <Dialog
      open={!!harness}
      onClose={onClose}
      title={harness ? `Uninstall ${harness.label}?` : "Uninstall agent?"}
      description={
        harness ? (
          <>
            This removes the Clash-managed ACP install at{" "}
            <code className="font-mono">{harness.binary}</code>. Local agents
            installed outside Clash are not removed.
          </>
        ) : undefined
      }
      size="sm"
      disableBackdropClose={busy}
    >
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          aria-label={
            harness
              ? `Confirm uninstall ${harness.label}`
              : "Confirm uninstall agent"
          }
          onClick={() => harness && onConfirm(harness.id)}
          disabled={!harness || busy}
          className="inline-flex items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 shadow-sm transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {busy ? "Uninstalling…" : "Uninstall"}
        </Button>
      </div>
    </Dialog>
  );
}

interface CustomAgentServerDialogProps {
  open: boolean;
  editing: boolean;
  starterId: string;
  name: string;
  command: string;
  argsText: string;
  envText: string;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onStarterChange: (starterId: string) => void;
  onNameChange: (value: string) => void;
  onCommandChange: (value: string) => void;
  onArgsTextChange: (value: string) => void;
  onEnvTextChange: (value: string) => void;
  onSave: () => void;
}

function CustomAgentServerDialog({
  open,
  editing,
  starterId,
  name,
  command,
  argsText,
  envText,
  error,
  saving,
  onClose,
  onStarterChange,
  onNameChange,
  onCommandChange,
  onArgsTextChange,
  onEnvTextChange,
  onSave,
}: CustomAgentServerDialogProps) {
  const title = editing
    ? "Edit custom agent server"
    : "Add custom agent server";
  const previewName = name.trim() || "my-agent";
  const previewCommand = command.trim() || "<command>";
  const previewArgs = parseArgsText(argsText);
  let previewEnv: Record<string, string> = {};
  try {
    const parsedEnv = JSON.parse(envText || "{}") as unknown;
    if (
      parsedEnv &&
      typeof parsedEnv === "object" &&
      !Array.isArray(parsedEnv)
    ) {
      previewEnv = Object.fromEntries(
        Object.entries(parsedEnv as Record<string, unknown>).filter(
          ([, value]) => typeof value === "string",
        ),
      ) as Record<string, string>;
    }
  } catch {
    previewEnv = {};
  }
  const settingsPreview = JSON.stringify(
    {
      agent_servers: {
        [previewName]: {
          type: "custom",
          command: previewCommand,
          args: previewArgs,
          env: previewEnv,
        },
      },
    },
    null,
    2,
  );
  return (
    <Dialog open={open} onClose={onClose} ariaLabel={title} size="xl" unstyled>
      <div className="absolute left-1/2 top-1/2 w-[min(56rem,100%)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-warm-border bg-warm-surface shadow-xl dark:bg-stone-950">
        <div className="flex max-h-[min(34rem,82vh)] min-h-[24rem] flex-col sm:min-h-[28rem] sm:flex-row">
          <aside className="w-full shrink-0 border-b border-warm-border bg-warm-muted/55 p-3 dark:bg-stone-900/70 sm:w-56 sm:border-b-0 sm:border-r">
            <div className="mb-2 px-2 text-[11px] font-semibold uppercase text-stone-500 dark:text-stone-400">
              Starter
            </div>
            <div className="grid grid-cols-3 gap-1 sm:block sm:space-y-1">
              {CUSTOM_AGENT_SERVER_STARTERS.map((starter) => {
                const selected = starterId === starter.id;
                return (
                  <Button
                    key={starter.id}
                    size="sm"
                    onClick={() => onStarterChange(starter.id)}
                    className={`h-auto min-h-0 w-full truncate rounded-lg border-0 px-2.5 py-2 text-left text-sm font-medium shadow-none transition-colors ${
                      selected
                        ? "bg-warm-surface text-brand shadow-sm ring-1 ring-brand/25"
                        : "bg-transparent text-content-secondary hover:bg-warm-muted hover:text-content-primary"
                    }`}
                  >
                    {starter.label}
                  </Button>
                );
              })}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex items-start justify-between gap-4 border-b border-warm-border px-5 py-4">
              <div className="min-w-0">
                <h2 className="font-display text-lg font-bold text-slate-900 dark:text-slate-50">
                  {title}
                </h2>
              </div>
              <IconButton
                label="Close"
                onClick={onClose}
                icon={<X className="h-4 w-4" weight="bold" />}
                className="rounded-md p-1.5 text-stone-500 transition-colors hover:bg-warm-muted hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-stone-300 dark:hover:text-stone-100"
              />
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
                      Name
                    </span>
                    <Input
                      aria-label="Agent server name"
                      value={name}
                      onChange={(event) => onNameChange(event.target.value)}
                      className="h-9"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
                      Command
                    </span>
                    <Input
                      aria-label="Command"
                      value={command}
                      onChange={(event) => onCommandChange(event.target.value)}
                      className="h-9 font-mono"
                    />
                  </label>
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <label className="block min-w-0">
                    <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
                      Arguments
                    </span>
                    <Textarea
                      aria-label="Arguments"
                      value={argsText}
                      onChange={(event) => onArgsTextChange(event.target.value)}
                      spellCheck={false}
                      rows={6}
                      className="min-h-[9rem] resize-y font-mono text-xs leading-5"
                    />
                  </label>

                  <label className="block min-w-0">
                    <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
                      Environment
                    </span>
                    <Textarea
                      aria-label="Environment"
                      value={envText}
                      onChange={(event) => onEnvTextChange(event.target.value)}
                      spellCheck={false}
                      rows={6}
                      className="min-h-[9rem] resize-y font-mono text-xs leading-5"
                    />
                  </label>
                </div>

                <div>
                  <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">
                    Settings preview
                  </span>
                  <pre className="max-h-36 overflow-auto rounded-lg border border-warm-border bg-warm-muted/55 px-3 py-2 font-mono text-xs leading-5 text-stone-600 dark:text-stone-300">
                    {settingsPreview}
                  </pre>
                </div>

                {error && <InlineAlert tone="error" title={error} />}
              </div>
            </div>

            <footer className="flex justify-end gap-2 border-t border-warm-border bg-warm-muted/40 px-5 py-3 dark:bg-stone-900/60">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={onSave} disabled={saving}>
                {saving ? "Saving…" : "Save agent server"}
              </Button>
            </footer>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
