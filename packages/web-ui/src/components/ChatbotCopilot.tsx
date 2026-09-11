import type { AcpForkPoint } from "@clash/shared-types";
import {
  memo,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type CSSProperties,
} from "react";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import {
  ArrowBendDownRight,
  BookOpen,
  CaretDown,
  CaretRight,
  Crosshair,
  DotsSixVertical,
  DotsThree,
  PencilSimple,
  Plus,
  ClockCounterClockwise,
  Trash,
  Plug,
  ShieldWarning,
  SlidersHorizontal,
  Lightbulb,
  Lightning,
  Target,
  X,
  Play,
  Pause,
} from "@phosphor-icons/react";
import {
  HandIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { createComposerDraftStore } from "@openma/common/chat-ui";
import { useTranslation } from "react-i18next";
import { UserMessage } from "./copilot/UserMessage";
import { AgentCard, type AgentLog } from "./copilot/AgentCard";
import { ToolCall } from "./copilot/ToolCall";
import { ApprovalCard } from "./copilot/ApprovalCard";
import { ThinkingProcess } from "./copilot/ThinkingProcess";
import { ChatInput } from "./copilot/ChatInput";
import { RuntimePromptQueueContent } from "./copilot/RuntimePromptQueueContent";
import { parseUserMessageContent } from "./copilot/userMessageContent";
import { TodoList, TodoItem } from "./copilot/TodoList";
import { ThinkingIndicator } from "./copilot/ThinkingIndicator";
import type { ClashProjectEntity } from "./copilot/AcpInlineRenderers";
import { AgentMotion, type AgentMotionState } from "./copilot/AgentMotion";
import { RuntimeSessionTimeline } from "./copilot/RuntimeSessionTimeline";
import { AcpAgentLogo } from "./copilot/AcpAgentLogo";
import { CopilotRailSlot } from "./copilot/CopilotRail";
import { MessageErrorBoundary } from "./copilot/MessageErrorBoundary";
import { RuntimePickerDialog } from "./copilot/RuntimePickerDialog";
import { SessionHarnessUpdateControl } from "./copilot/SessionHarnessUpdateControl";
import {
  SessionHistoryPopoverPanel,
  type SessionHistoryItem,
} from "./copilot/SessionHistorySidebar";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { IconButton } from "./ui/icon-button";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { SelectMenu, type SelectSection } from "./ui/select";
import { Sheet, SheetContent, SheetOverlay } from "./ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Tooltip } from "./ui/tooltip";
import {
  ComboboxItem,
  ComboboxList,
  ComboboxProvider,
  useComboboxStore,
} from "./ui/combobox";
import { SortableList, useSortableItem } from "./ui/sortable";
import { useDragGesture } from "./ui/gesture";
import { FeedbackSurface, InlineAlert } from "./ui/feedback";
import { useAppFeedback } from "./AppFeedback";
import {
  useClashRuntime,
  type AcpSessionConfigOption,
  type AcpSessionModeState,
  type ClashRuntimeStatus,
  type Runtime,
  type RuntimeAgentAuthMethod,
  type RuntimeElicitationProperty,
  type RuntimeElicitationRequest,
  type RuntimeElicitationResponse,
  type RuntimeElicitationValue,
  type RuntimePromptQueueMode,
  type RuntimeQueuedPrompt,
  type RuntimeSessionInfo,
} from "@clash/web-ui/hooks/useClashRuntime";
import {
  agentDisplayName,
  defaultPermissionModeForSession,
  findAcpSelectConfigOption,
  flattenAcpSelectValues,
  permissionModeOption,
  resolvePermissionModeForSession,
  type AcpSelectValue,
} from "@clash/web-ui/lib/acpSessionConfig";
import {
  commandActionFromAvailableCommand,
  type AvailableCommand,
  type ByoMessage as RuntimeMessage,
  type PlanEntry,
  type RuntimeGoalState,
} from "@clash/web-ui/lib/acpEvents";
import {
  applyAgentAttribution,
  parseAgentCanvasPatch,
} from "@clash/web-ui/lib/agentCanvasPatch";
import type {
  Node as RFNode,
  Edge as RFEdge,
  Connection as RFConnection,
} from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { getAsset } from "@clash/web-ui/lib/hooks/useAsset";
import { assetThumbnailImageUrl } from "../features/assets/media-url";
import { useIsBelowLg } from "@clash/web-ui/lib/hooks/useMediaQuery";
import {
  useAgentCopilot,
  type CustomEvent,
} from "@clash/web-ui/hooks/useAgentCopilot";
import {
  getRuntimeConfig,
  runtimeApiUrl,
} from "@clash/web-ui/lib/runtimeConfig";
import { type AgentAnnotationDraft } from "@clash/shared-types";
import { visibleUserPromptText } from "@clash/shared-runtime";
import {
  buildCopilotPrompt,
  type CopilotMentionSource,
  type CopilotWorkspaceContext,
} from "@clash/web-ui/lib/copilotWorkspaceContext";
import {
  REVISION_RESTORE_REQUEST_EVENT,
  type RevisionRestoreRequest,
} from "./nodes/RevisionHistoryBadge";
import {
  buildComposerConfigOptions,
  buildRunMenuConfigOptions,
  configModeOptionPresentation,
  findSelectConfigOption,
  isFastSessionConfigOption,
  sessionConfigOptionEnabled,
  withSessionStateCommands,
} from "@clash/web-ui/lib/sessionConfigOptions";
import { preferredRecentAgentId } from "@clash/web-ui/lib/recentRunPreferences";
import { withoutInitialProjectPrompt } from "@clash/web-ui/lib/projectSessionRoute";
import { clampCopilotPanelWidthForViewport } from "./copilotPanelLayout";

interface Message {
  id: string;
  content: string;
  role: string;
  projectId: string;
  createdAt: Date;
}

type CopilotNodeRef = Pick<RFNode, "id" | "type" | "data">;

interface ChatbotCopilotProps {
  projectId: string;
  threadId: string;
  initialMessages: Message[];
  width: number;
  onWidthPreview?: (width: number) => void;
  onWidthChange: (width: number) => void;
  onResizeStateChange?: (resizing: boolean) => void;
  isCollapsed: boolean;
  onCollapseChange: (collapsed: boolean) => void;
  collapsedLauncherPlacement?: "canvas" | "header";
  layoutMode?: "floating" | "docked";
  followingAgent?: boolean;
  onFollowingAgentChange?: (following: boolean) => void;
  onAgentCanvasTarget?: (nodeId: string) => void;
  onOpenClashEntity?: (entity: ClashProjectEntity) => void;
  onAddNode?: (type: string, extraData?: any) => string | Promise<string>;
  onRemoveNode?: (
    nodeId: string,
    options?: { actorClientType?: string; ifMatch?: string },
  ) => void;
  onAddEdge?: (
    params: RFEdge | RFConnection,
    options?: { actorClientType?: string; ifMatch?: string },
  ) => void;
  onUpdateEdge?: (
    edgeId: string,
    patch: Record<string, unknown>,
    options?: { actorClientType?: string; ifMatch?: string },
  ) => void;
  onRemoveEdge?: (
    edgeId: string,
    options?: { actorClientType?: string; ifMatch?: string },
  ) => void;
  onApplyTimeline?: (
    nodeId: string,
    timelineDsl: unknown,
    options?: { actorClientType?: string; ifMatch?: string },
  ) => void;
  nodes?: CopilotNodeRef[];
  /** Project-wide mention inventory, already ranked by active workspace scope. */
  mentionSources?: CopilotMentionSource[];
  /** Surface identity included with every prompt so the agent knows where the user is. */
  workspaceContext?: CopilotWorkspaceContext;
  initialPrompt?: string;
  /** Session history + actions passed from parent */
  sessionHistory?: Array<CopilotSessionHistoryItem>;
  sessionHistoryHasMore?: boolean;
  sessionHistoryLoadingMore?: boolean;
  onLoadMoreSessionHistory?: () => void | Promise<void>;
  onNewSession?: () => void;
  onSwitchSession?: (threadId: string) => void;
  onArchiveSession?: (threadId: string) => void | Promise<void>;
  onRenameSession?: (threadId: string, title: string) => void | Promise<void>;
  onUpsertSession?: (session: CopilotSessionHistoryItem) => void;
  onRuntimeSessionRouteChange?: (threadId: string | null) => void;
  /** Called when user sends first message with no active session */
  onCreateSession?: (initialMessage: string) => void;
  /** Create canvas nodes from already-uploaded attachments */
  onUploadFiles?: (
    attachments: import("./copilot/ChatInput").UploadedAttachment[],
  ) => void;
  /** Human user represented by the selected local agent. */
  actorUserId?: string;
  annotationBlocks?: AgentAnnotationDraft[];
  onAnnotationRemove?: (annotationId: string) => void;
  onAnnotationsSubmitted?: (annotationIds: string[]) => void;
}

const CREATIVE_STATUS_ROTATION_MS = 15_000;
const ACTIVITY_DURATION_MINUTE_MS = 60_000;

function displayErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLocalHarnessUnavailableMessage(message: string): boolean {
  return /no (?:enabled )?local (?:acp )?agent|local agent .*not enabled or available|agent harness .*unavailable/i.test(
    message,
  );
}

type CompletedActivity = {
  startedAt: number;
  completedAt: number;
};

function formatActivityDuration(
  ms: number,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const safeMs = Math.max(0, ms);
  if (safeMs < ACTIVITY_DURATION_MINUTE_MS) {
    return t("copilot.status.workedForSeconds", {
      count: Math.max(1, Math.round(safeMs / 1000)),
    });
  }
  return t("copilot.status.workedForMinutes", {
    count: Math.max(1, Math.round(safeMs / ACTIVITY_DURATION_MINUTE_MS)),
  });
}

type CopilotSessionHistoryItem = SessionHistoryItem;

function runtimeSessionToHistoryItem(
  session: RuntimeSessionInfo,
  title?: string,
): CopilotSessionHistoryItem {
  return {
    id: session.id,
    threadId: session.threadId,
    title: title ?? session.title,
    type: "runtime",
    projectId: session.projectId,
    runtimeId: session.runtimeId,
    agentId: session.agentId ?? undefined,
    agentMemberId: session.agentMemberId,
    permissionMode: session.permissionMode,
    acpSessionId: session.acpSessionId,
    supportsSessionFork: session.supportsSessionFork,
    status: session.status,
  };
}

/** Markdown components for assistant text rendering */
const markdownComponents = {
  p: ({ children }: any) => <p className="mb-4 last:mb-0">{children}</p>,
  ul: ({ children }: any) => (
    <ul className="list-disc pl-4 mb-4 space-y-1">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal pl-4 mb-4 space-y-1">{children}</ol>
  ),
  li: ({ children }: any) => <li className="mb-1">{children}</li>,
  // Demote heading levels: assistant messages live deep inside the page,
  // so their `#` headings shouldn't compete with the page's real h1/h2.
  // Visual sizes preserved.
  h1: ({ children }: any) => (
    <h2 className="font-display text-2xl font-bold mb-4 mt-6">{children}</h2>
  ),
  h2: ({ children }: any) => (
    <h3 className="font-display text-xl font-bold mb-3 mt-5">{children}</h3>
  ),
  h3: ({ children }: any) => (
    <h4 className="font-display text-lg font-bold mb-2 mt-4">{children}</h4>
  ),
  h4: ({ children }: any) => (
    <h5 className="font-display text-base font-bold mb-2 mt-3">{children}</h5>
  ),
  code: ({ className, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || "");
    const isInline = !match && !String(children).includes("\n");
    return isInline ? (
      <code
        className="bg-warm-muted px-1.5 py-0.5 rounded text-sm font-mono text-brand border border-warm-border dark:text-brand-light"
        {...props}
      >
        {children}
      </code>
    ) : (
      <code
        className="clash-copilot-code block rounded-xl p-4 mb-4 overflow-x-auto text-sm font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: any) => <pre className="not-prose mb-4">{children}</pre>,
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-4 border-warm-border pl-4 italic text-stone-600 mb-4 dark:text-stone-300">
      {children}
    </blockquote>
  ),
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-warm-surface rounded-sm"
    >
      {children}
    </a>
  ),
};

type MentionNodeRef = {
  id: string;
  type: string;
  label: string;
  thumbnail?: string;
};

const DESKTOP_LOCAL_RUNTIME_ID = "desktop-local";

const COPILOT_PANEL_TRANSITION = {
  duration: 0.24,
  ease: [0.16, 1, 0.3, 1] as const,
};
const COPILOT_PANEL_COLLAPSE_TRANSITION = {
  duration: 0.34,
  ease: [0.22, 1, 0.36, 1] as const,
  times: [0, 0.52, 1],
};
const COPILOT_LAUNCHER_ENTER_TRANSITION = {
  duration: 0.24,
  delay: 0.12,
  ease: [0.22, 1, 0.36, 1] as const,
};
const COPILOT_LAUNCHER_EXIT_TRANSITION = {
  duration: 0.12,
  ease: [0.25, 1, 0.5, 1] as const,
};
const COPILOT_LAUNCHER_RELOCATION_TRANSITION = {
  layout: { duration: 0.42, ease: [0.16, 1, 0.3, 1] as const },
  opacity: COPILOT_LAUNCHER_ENTER_TRANSITION,
  scale: COPILOT_LAUNCHER_ENTER_TRANSITION,
  y: COPILOT_LAUNCHER_ENTER_TRANSITION,
};
const COPILOT_PANEL_LAUNCHER_FOCAL_OFFSET_PX = 44;
const COPILOT_COMPOSER_RAIL_WIDTH_CLASS =
  "mx-auto w-[calc(100%-6rem)] max-w-[940px]";
const COPILOT_PANEL_CANVAS_TRANSFORM_ORIGIN = `calc(100% - ${COPILOT_PANEL_LAUNCHER_FOCAL_OFFSET_PX}px) calc(100% - ${COPILOT_PANEL_LAUNCHER_FOCAL_OFFSET_PX}px)`;
const COPILOT_PANEL_HEADER_TRANSFORM_ORIGIN =
  "calc(100% - 16px) calc(0% + 14px)";
const COPILOT_PANEL_COLLAPSED_CANVAS_STATE = {
  opacity: [1, 0.76, 0],
  scale: [1, 0.56, 0.08],
  x: [0, 0, 42],
  y: [0, 34, 34],
};
const COPILOT_PANEL_COLLAPSED_HEADER_STATE = {
  opacity: [1, 0.76, 0],
  scale: [1, 0.56, 0.08],
  x: 0,
  y: 0,
};
const COPILOT_PANEL_EXPANDED_DESKTOP_STATE = {
  opacity: 1,
  scale: 1,
  x: 0,
  y: 0,
};

function isRevisionRestoreRequest(
  value: unknown,
): value is RevisionRestoreRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  const command =
    typeof request.command === "string" ? request.command.trim() : "";
  return (
    request.kind === "text" &&
    typeof request.nodeId === "string" &&
    request.nodeId.trim().length > 0 &&
    typeof request.revisionId === "string" &&
    request.revisionId.trim().length > 0 &&
    request.mode === "replace" &&
    command.startsWith("clash text restore ")
  );
}

function revisionRestorePrompt(request: RevisionRestoreRequest): string {
  return [
    "Run the explicit local revision restore action below from the current project cwd.",
    "",
    "Use the CLI/CAS restore path exactly as written. Do not edit the canvas, snapshot, or SQLite directly.",
    "",
    "```bash",
    request.command,
    "```",
  ].join("\n");
}

function selectedAcpSelectValue(
  option?: AcpSessionConfigOption | null,
): AcpSelectValue | null {
  const values = flattenAcpSelectValues(option);
  return (
    values.find((entry) => entry.value === option?.currentValue) ??
    values[0] ??
    null
  );
}

function sessionTitleForHeader(
  threadId: string,
  sessionHistory: CopilotSessionHistoryItem[],
  fallback: string,
): string {
  if (!threadId) return fallback;
  const storedTitle = sessionHistory
    .find((session) => session.threadId === threadId)
    ?.title?.trim();
  const title = storedTitle
    ? visibleUserPromptText(storedTitle)
        .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1")
        .trim()
    : "";
  if (title === "New session") return fallback;
  return title || fallback;
}

function compactSessionTitleForHeader(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= 28) return title;
  return `${characters.slice(0, 27).join("")}…`;
}

function normalizedRuntimeSessionTitle(
  title?: string | null,
): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed || trimmed === "New session") return undefined;
  return trimmed;
}

function titleFromRuntimeMessages(messages: RuntimeMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const textPart = message.parts.find((part) => part.type === "text");
    const text = textPart?.text ? visibleUserPromptText(textPart.text) : "";
    if (!text) continue;
    return text.length > 52 ? `${text.slice(0, 52)}...` : text;
  }
  return null;
}

function annotationOnlyPrompt(
  annotations: readonly AgentAnnotationDraft[],
): string {
  return annotations
    .map((annotation) => {
      const note = annotation.note.trim();
      if (note) return `${annotation.target.objectLabel}: ${note}`;
      const quote = annotation.target.selection?.exact.trim();
      return quote
        ? `${annotation.target.objectLabel}: Review the selected text “${quote}”.`
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

const PERSONA_MAP: Record<string, string> = {
  ScriptWriter: "scriptwriter",
  ConceptArtist: "conceptartist",
  StoryboardDesigner: "storyboardartist",
  Editor: "videoproducer",
};

/**
 * Memoized single part of an assistant message (text / reasoning / tool-call
 * / step-divider). Lifted out so React.memo's shallow equality can skip
 * re-renders of unchanged parts within the currently-streaming message —
 * useAgentCopilot's streaming pattern gives a new reference only to the
 * actively-updating part, so every other part in the same message skips
 * ReactMarkdown parse and AgentCard logs rebuild on every token tick.
 */
const MessagePart = memo(function MessagePart({ part }: { part: any }) {
  if (part.type === "event_note") {
    const isError = part.tone === "error";
    return (
      <div
        role={isError ? "alert" : undefined}
        className={`flex gap-3 rounded-2xl border px-4 py-3.5 ${
          isError
            ? "border-status-down/25 bg-status-down/5 text-slate-900 dark:bg-status-down/10 dark:text-slate-50"
            : "border-warm-border bg-warm-muted/50 text-slate-800 dark:text-slate-100"
        }`}
      >
        <ShieldWarning
          aria-hidden="true"
          className={`mt-0.5 h-5 w-5 shrink-0 ${isError ? "text-status-down" : "text-stone-500"}`}
          weight="fill"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-5">{part.title}</p>
          {part.detail ? (
            <p className="mt-1 text-sm font-normal leading-5 text-stone-600 dark:text-stone-300">
              {part.detail}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  if (part.type === "text" && part.text) {
    return (
      <div className="text-base text-slate-800 leading-relaxed px-1 font-medium dark:text-slate-100">
        <ReactMarkdown components={markdownComponents}>
          {part.text}
        </ReactMarkdown>
      </div>
    );
  }
  if (part.type === "reasoning") {
    return <ThinkingProcess content={part.text} />;
  }
  if (part.type === "step-start") {
    return <div className="border-t border-warm-border my-2" />;
  }
  if (part.type?.startsWith("tool-") || part.type === "dynamic-tool") {
    const toolName =
      part.type === "dynamic-tool"
        ? part.toolName
        : part.type.replace("tool-", "");

    if (toolName === "task_delegation" && part.preliminary && part.output) {
      const progress = part.output as any;
      const agentName = progress.agent || "Agent";
      const agentLogs: AgentLog[] = [];

      if (progress.toolCalls?.length) {
        progress.toolCalls.forEach((tc: any) => {
          if (typeof tc === "string") {
            agentLogs.push({
              id: `tc-${tc}`,
              type: "text",
              content: `→ ${tc}`,
            });
          } else {
            agentLogs.push({
              id: tc.id || `tc-${tc.toolName}`,
              type: "tool_call",
              toolProps: {
                toolName: tc.toolName,
                args: tc.args,
                result: tc.output,
                status:
                  tc.status === "completed"
                    ? "success"
                    : tc.status === "error"
                      ? "error"
                      : "pending",
                indent: false,
              },
            });
          }
        });
      }
      if (progress.text) {
        agentLogs.push({ id: "text", type: "text", content: progress.text });
      }
      if (progress.message) {
        agentLogs.push({ id: "msg", type: "text", content: progress.message });
      }

      return (
        <AgentCard
          agentName={agentName}
          status={
            progress.status === "completed"
              ? "done"
              : progress.status === "failed"
                ? "failed"
                : "working"
          }
          logs={agentLogs}
          persona={(PERSONA_MAP[agentName] || "default") as any}
        />
      );
    }

    const toolStatus =
      part.state === "output-available"
        ? "success"
        : part.state === "output-error"
          ? "error"
          : part.state === "approval-requested"
            ? "pending"
            : ("pending" as const);
    return (
      <ToolCall
        toolName={toolName}
        args={part.input}
        result={part.output}
        status={toolStatus}
      />
    );
  }
  return null;
});

/**
 * Memoized message row. Lifted out of the main component so React.memo can
 * skip re-renders of unchanged messages during streaming — without this,
 * every token tick re-runs ReactMarkdown for every prior message in the
 * thread (O(n) work per chunk).
 *
 * Only re-renders when its `msg` reference or `mentionableNodes` ref changes.
 * useAgentCopilot mutates only the streaming message, so completed messages
 * stay referentially stable and are skipped entirely.
 */
const MessageRow = memo(function MessageRow({
  msg,
  mentionableNodes,
}: {
  msg: any;
  mentionableNodes: MentionNodeRef[];
}) {
  return (
    // content-visibility: auto lets the browser skip paint + layout for
    // off-screen rows — native render-skipping that scales to long threads
    // without virtualization's architectural cost. contain-intrinsic-size
    // gives a height hint so the scrollbar doesn't jitter as rows enter
    // the viewport and self-measure. 200px is a reasonable average for
    // mixed text + tool-call messages; under-/over-estimates self-correct
    // after first measurement.
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
    >
      <MessageErrorBoundary messageId={msg.id}>
        {msg.role === "user" ? (
          <UserMessage
            content={
              msg.parts
                ?.filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("") || ""
            }
            mentionNodes={mentionableNodes}
          />
        ) : (
          <div className="space-y-3">
            {msg.parts?.map((part: any, i: number) => (
              <MessagePart key={part.toolCallId ?? part.id ?? i} part={part} />
            ))}
          </div>
        )}
      </MessageErrorBoundary>
    </motion.div>
  );
});

function ChatbotCopilot({
  projectId,
  threadId,
  initialMessages,
  width,
  onWidthPreview,
  onWidthChange,
  onResizeStateChange,
  isCollapsed,
  onCollapseChange,
  collapsedLauncherPlacement = "canvas",
  layoutMode = "floating",
  followingAgent = false,
  onFollowingAgentChange,
  onAgentCanvasTarget,
  onOpenClashEntity,
  onAddNode,
  onRemoveNode,
  onAddEdge,
  onUpdateEdge,
  onRemoveEdge,
  onApplyTimeline,
  nodes = [],
  mentionSources = [],
  workspaceContext,
  initialPrompt,
  sessionHistory = [],
  sessionHistoryHasMore = false,
  sessionHistoryLoadingMore = false,
  onLoadMoreSessionHistory,
  onNewSession,
  onSwitchSession,
  onArchiveSession,
  onRenameSession,
  onUpsertSession,
  onRuntimeSessionRouteChange,
  onCreateSession,
  onUploadFiles,
  actorUserId,
  annotationBlocks = [],
  onAnnotationRemove,
  onAnnotationsSubmitted,
}: ChatbotCopilotProps) {
  const { t } = useTranslation();
  const feedback = useAppFeedback();
  const lastHarnessSetupIssueNotifiedRef = useRef<string | null>(null);
  const notifyAgentHarnessRequired = useCallback(() => {
    feedback.notify({
      variant: "info",
      title: t("copilot.status.agentHarnessRequiredTitle"),
      message: t("copilot.status.agentHarnessRequired"),
      actionLabel: t("copilot.actions.openAgents"),
      actionHref: "/settings?section=agents",
    });
  }, [feedback, t]);
  // Below Tailwind's `lg` (1024px), the panel switches to a full-screen
  // sheet over the canvas. Desktop keeps a resizable bottom-right popover.
  const isMobile = useIsBelowLg();
  const isDocked = !isMobile && layoutMode === "docked";
  const panelHeaderControlSize = isMobile ? "lg" : "sm";
  const collapsesIntoHeader = collapsedLauncherPlacement === "header";
  const desktopTransformOrigin = collapsesIntoHeader
    ? COPILOT_PANEL_HEADER_TRANSFORM_ORIGIN
    : COPILOT_PANEL_CANVAS_TRANSFORM_ORIGIN;
  const collapsedDesktopState = collapsesIntoHeader
    ? COPILOT_PANEL_COLLAPSED_HEADER_STATE
    : COPILOT_PANEL_COLLAPSED_CANVAS_STATE;
  // ─── UI State ──────────────────────────────────────────────
  const composerDrafts = useMemo(() => {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      storage = undefined;
    }
    return createComposerDraftStore({
      namespace: "clash.project-composer",
      storage,
    });
  }, []);
  const composerDraftScope = `${projectId}:${threadId || "new"}`;
  const [inputState, setInputState] = useState(() => {
    const value = initialPrompt ?? composerDrafts.read(composerDraftScope);
    if (initialPrompt !== undefined) {
      composerDrafts.write(composerDraftScope, initialPrompt);
    }
    return { scope: composerDraftScope, value };
  });
  const input =
    inputState.scope === composerDraftScope
      ? inputState.value
      : composerDrafts.read(composerDraftScope);
  const setInput = useCallback(
    (value: string) => {
      composerDrafts.write(composerDraftScope, value);
      setInputState({ scope: composerDraftScope, value });
    },
    [composerDraftScope, composerDrafts],
  );
  const [dismissedSlashCommand, setDismissedSlashCommand] = useState<
    string | null
  >(null);
  const [isResizing, setIsResizing] = useState(false);
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false);
  const presentationWidth = width;
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [suggestions, setSuggestions] = useState<
    Array<{ label: string; message: string }>
  >([]);

  // Two transports:
  //   - 'cloud'   : useAgentCopilot (hosted Clash agent, temporarily disabled)
  //   - 'runtime' : useClashRuntime (registered local daemon / clashd)
  const [chatMode, setChatMode] = useState<"cloud" | "runtime">("runtime");
  const [sessionConfigOpen, setSessionConfigOpen] = useState(false);
  const [switchingRuntimeSessionId, setSwitchingRuntimeSessionId] = useState<
    string | null
  >(null);
  const runtimeSessionSwitchSeq = useRef(0);
  const restoredRouteSessionRef = useRef<string | null>(null);
  const [sessionHarnessId, setSessionHarnessId] = useState<string | null>(null);
  const [sessionPermissionModeByAgentId, setSessionPermissionModeByAgentId] =
    useState<Record<string, string>>({});
  const [authenticatingHarnessId, setAuthenticatingHarnessId] = useState<
    string | null
  >(null);
  const [authRecoveryPendingHarnessId, setAuthRecoveryPendingHarnessId] =
    useState<string | null>(null);
  /** When set, the runtime picker dialog is open for this runtime. */
  const [runtimePicker, setRuntimePicker] = useState<Runtime | null>(null);
  const clashRt = useClashRuntime();
  const notifiedModelFallbacks = useRef(new Set<string>());
  useEffect(() => {
    const fallback = clashRt.modelFallback;
    if (chatMode !== "runtime" || !fallback || !clashRt.sessionId) return;
    const key = JSON.stringify([clashRt.sessionId, fallback.from, fallback.to]);
    if (notifiedModelFallbacks.current.has(key)) return;
    notifiedModelFallbacks.current.add(key);
    feedback.notify({
      variant: "warning",
      title: `已切换至 ${fallback.to}`,
      message: `当前运行时无法识别 ${fallback.from}。可在窗口右上角更新 ACP。`,
    });
  }, [chatMode, clashRt.sessionId, clashRt.modelFallback, feedback]);

  const slashCommandQuery = useMemo(() => {
    if (chatMode === "cloud") return null;
    const draft = input.replace(/[\r\n]+$/g, "");
    if (!draft.startsWith("/")) return null;
    const query = draft.slice(1);
    if (/\s/.test(query)) return null;
    if (draft === dismissedSlashCommand) return null;
    return query.toLowerCase();
  }, [chatMode, dismissedSlashCommand, input]);
  const isDesktopLocalMode = useMemo(
    () => getRuntimeConfig().mode === "desktop",
    [],
  );
  const desktopLocalRuntime = useMemo(
    () =>
      clashRt.runtimes.find((rt) => rt.id === DESKTOP_LOCAL_RUNTIME_ID) ?? null,
    [clashRt.runtimes],
  );
  const desktopRuntimeStartupPending =
    chatMode === "runtime" &&
    isDesktopLocalMode &&
    clashRt.startupStatus === "loading";
  const desktopRuntimeStartupFailed =
    chatMode === "runtime" &&
    isDesktopLocalMode &&
    clashRt.startupStatus === "error";
  const desktopRuntimeNeedsSetup =
    chatMode === "runtime" &&
    isDesktopLocalMode &&
    clashRt.startupStatus === "ready" &&
    (!desktopLocalRuntime || desktopLocalRuntime.agents.length === 0);
  const desktopRuntimeUnavailable =
    desktopRuntimeStartupPending ||
    desktopRuntimeStartupFailed ||
    desktopRuntimeNeedsSetup;
  const selectedRuntimeForSession = useMemo(
    () =>
      chatMode === "runtime"
        ? (clashRt.runtimes.find((rt) => rt.id === clashRt.selectedRuntimeId) ??
          desktopLocalRuntime)
        : null,
    [
      chatMode,
      clashRt.runtimes,
      clashRt.selectedRuntimeId,
      desktopLocalRuntime,
    ],
  );
  const sessionHarnessOptions = selectedRuntimeForSession?.agents ?? [];
  const effectiveSessionHarnessId =
    sessionHarnessId ??
    clashRt.selectedAgentId ??
    preferredRecentAgentId(
      sessionHarnessOptions,
      selectedRuntimeForSession?.preferences?.agent_id,
    ) ??
    null;
  const selectedSessionHarness = useMemo(
    () =>
      sessionHarnessOptions.find(
        (agent) => agent.id === effectiveSessionHarnessId,
      ) ?? null,
    [effectiveSessionHarnessId, sessionHarnessOptions],
  );
  const selectedSessionHarnessAuth =
    selectedSessionHarness?.auth?.status === "needs-auth"
      ? selectedSessionHarness.auth
      : null;
  const selectedSessionHarnessAuthTitle =
    selectedSessionHarnessAuth && effectiveSessionHarnessId
      ? `Sign in to ${agentDisplayName(effectiveSessionHarnessId)}`
      : null;
  const selectedSessionHarnessAuthMessage =
    selectedSessionHarnessAuth?.message ?? null;
  useEffect(() => {
    if (!authRecoveryPendingHarnessId || authenticatingHarnessId) return;
    if (authRecoveryPendingHarnessId !== effectiveSessionHarnessId) {
      setAuthRecoveryPendingHarnessId(null);
      return;
    }
    if (selectedSessionHarnessAuth) return;
    setAuthRecoveryPendingHarnessId(null);
    if (clashRt.sessionId) void clashRt.restartSession("now");
  }, [
    authRecoveryPendingHarnessId,
    authenticatingHarnessId,
    clashRt.restartSession,
    clashRt.sessionId,
    effectiveSessionHarnessId,
    selectedSessionHarnessAuth,
  ]);
  const effectiveSessionConfigOptions = useMemo(() => {
    const agentConfigOptions = selectedSessionHarness?.config_options ?? [];
    if (
      clashRt.selectedAgentId === effectiveSessionHarnessId &&
      clashRt.sessionConfigOptions.length > 0
    ) {
      return clashRt.sessionConfigOptions;
    }
    if (agentConfigOptions.length > 0) return agentConfigOptions;
    if (selectedSessionHarness) return [];
    return clashRt.sessionConfigOptions;
  }, [
    clashRt.selectedAgentId,
    clashRt.sessionConfigOptions,
    effectiveSessionHarnessId,
    selectedSessionHarness?.config_options,
  ]);
  const effectiveSessionModes = useMemo(() => {
    if (
      clashRt.selectedAgentId === effectiveSessionHarnessId &&
      clashRt.sessionModes
    ) {
      return clashRt.sessionModes;
    }
    return selectedSessionHarness?.session_modes ?? null;
  }, [
    clashRt.selectedAgentId,
    clashRt.sessionModes,
    effectiveSessionHarnessId,
    selectedSessionHarness?.session_modes,
  ]);
  const modelConfigOption = useMemo(
    () => findAcpSelectConfigOption(effectiveSessionConfigOptions, "model"),
    [effectiveSessionConfigOptions],
  );
  const modeConfigOption = useMemo(
    () => findAcpSelectConfigOption(effectiveSessionConfigOptions, "mode"),
    [effectiveSessionConfigOptions],
  );
  const sessionPermissionModeId = useMemo(() => {
    if (!effectiveSessionHarnessId)
      return defaultPermissionModeForSession(
        effectiveSessionModes,
        modeConfigOption,
      );
    return resolvePermissionModeForSession(
      sessionPermissionModeByAgentId[effectiveSessionHarnessId] ??
        selectedRuntimeForSession?.preferences?.mode_by_agent[
          effectiveSessionHarnessId
        ],
      effectiveSessionModes,
      modeConfigOption,
    );
  }, [
    effectiveSessionHarnessId,
    effectiveSessionModes,
    modeConfigOption,
    selectedRuntimeForSession?.preferences?.mode_by_agent,
    sessionPermissionModeByAgentId,
  ]);
  const setSessionPermissionModeForAgent = useCallback(
    (agentId: string | null | undefined, modeId: string) => {
      if (!agentId) return;
      setSessionPermissionModeByAgentId((prev) =>
        prev[agentId] === modeId ? prev : { ...prev, [agentId]: modeId },
      );
    },
    [],
  );
  const slashCommandCandidates = useMemo(() => {
    const seen = new Set<string>();
    return withSessionStateCommands(
      clashRt.availableCommands ?? [],
      effectiveSessionConfigOptions,
    ).filter((command) => {
      const name = normalizeSlashCommandName(command).toLowerCase();
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }, [
    clashRt.availableCommands,
    effectiveSessionConfigOptions,
    effectiveSessionHarnessId,
  ]);
  const slashCommandOptions = useMemo(() => {
    if (slashCommandQuery === null) return [];
    return slashCommandCandidates
      .filter((command) => {
        const name = normalizeSlashCommandName(command);
        if (!name) return false;
        return matchesSlashCommand(command, slashCommandQuery);
      })
      .slice(0, 12);
  }, [slashCommandCandidates, slashCommandQuery]);
  const handlePickSlashCommand = useCallback((command: AvailableCommand) => {
    const name = normalizeSlashCommandName(command);
    if (!name) return;
    setDismissedSlashCommand(`/${name}`);
    setInput(name.toLowerCase() === "plan" ? `/${name}` : `/${name} `);
  }, []);
  const runtimeTitle = useMemo(
    () =>
      titleFromRuntimeMessages(clashRt.messages) ??
      normalizedRuntimeSessionTitle(clashRt.currentSession?.title),
    [clashRt.currentSession?.title, clashRt.messages],
  );
  const runtimeHistoryItem = useMemo<CopilotSessionHistoryItem | null>(() => {
    if (chatMode !== "runtime" || !clashRt.currentSession) return null;
    return runtimeSessionToHistoryItem(clashRt.currentSession, runtimeTitle);
  }, [chatMode, clashRt.currentSession, runtimeTitle]);
  const visibleSessionHistory = useMemo<CopilotSessionHistoryItem[]>(() => {
    if (!runtimeHistoryItem) return sessionHistory;
    if (
      sessionHistory.some(
        (session) => session.threadId === runtimeHistoryItem.threadId,
      )
    )
      return sessionHistory;
    return [runtimeHistoryItem, ...sessionHistory];
  }, [runtimeHistoryItem, sessionHistory]);
  const hasThreadInHistory = Boolean(
    threadId &&
    visibleSessionHistory.some((session) => session.threadId === threadId),
  );
  const activeSessionId =
    chatMode === "runtime"
      ? (clashRt.currentSession?.threadId ??
        (hasThreadInHistory ? threadId : ""))
      : threadId;
  const sessionHarnessLocked =
    chatMode === "runtime" &&
    Boolean(clashRt.currentSession || clashRt.sessionId || clashRt.ready);
  const panelTitle = sessionTitleForHeader(
    activeSessionId,
    visibleSessionHistory,
    chatMode === "runtime"
      ? t("copilot.header.newChat")
      : t("copilot.panel.label"),
  );
  const compactPanelTitle = compactSessionTitleForHeader(panelTitle);

  useEffect(() => {
    if (chatMode !== "runtime" || !clashRt.currentSession || !onUpsertSession)
      return;
    onUpsertSession(
      runtimeSessionToHistoryItem(clashRt.currentSession, runtimeTitle),
    );
  }, [chatMode, clashRt.currentSession, onUpsertSession, runtimeTitle]);

  useEffect(() => {
    if (chatMode !== "runtime" || !clashRt.currentSession) return;
    onRuntimeSessionRouteChange?.(clashRt.currentSession.threadId);
  }, [chatMode, clashRt.currentSession, onRuntimeSessionRouteChange]);

  useEffect(() => {
    if (sessionHarnessOptions.length === 0) return;
    if (
      effectiveSessionHarnessId &&
      sessionHarnessOptions.some(
        (agent) => agent.id === effectiveSessionHarnessId,
      )
    )
      return;
    setSessionHarnessId(
      preferredRecentAgentId(
        sessionHarnessOptions,
        selectedRuntimeForSession?.preferences?.agent_id,
      ) ?? null,
    );
  }, [
    effectiveSessionHarnessId,
    selectedRuntimeForSession?.preferences?.agent_id,
    sessionHarnessOptions,
  ]);

  const handleSelectSessionHarness = useCallback(
    (agentId: string) => {
      if (sessionHarnessLocked) return;
      setSessionHarnessId(agentId);
      const pickedAgent = sessionHarnessOptions.find(
        (agent) => agent.id === agentId,
      );
      if (pickedAgent?.auth?.status === "needs-auth") {
        setSessionError(null);
        void clashRt
          .refresh({ probe: "config", refresh: true })
          .catch((error) => {
            feedback.notify({
              variant: "error",
              title: "Could not check agent auth",
              message: displayErrorMessage(error),
              actionLabel: "Open Agents",
              actionHref: "/settings?section=agents",
            });
          });
        return;
      }
      const nextModeConfigOption = findAcpSelectConfigOption(
        pickedAgent?.config_options ?? [],
        "mode",
      );
      const nextPermissionModeId = resolvePermissionModeForSession(
        sessionPermissionModeByAgentId[agentId],
        pickedAgent?.session_modes ?? null,
        nextModeConfigOption,
      );
      if (nextPermissionModeId)
        setSessionPermissionModeForAgent(agentId, nextPermissionModeId);
      const runtime = selectedRuntimeForSession ?? desktopLocalRuntime;
      if (chatMode === "runtime" && runtime?.status === "online") {
        const sessionOptions = {
          projectId,
          agentId,
          ...permissionModeOption(nextPermissionModeId),
        };
        if (clashRt.ready) {
          void clashRt.select(runtime.id, undefined, sessionOptions);
        } else {
          clashRt.startDraft(runtime.id, undefined, sessionOptions);
        }
      }
    },
    [
      chatMode,
      clashRt.select,
      clashRt.ready,
      clashRt.refresh,
      clashRt.startDraft,
      desktopLocalRuntime,
      projectId,
      selectedRuntimeForSession,
      sessionHarnessLocked,
      sessionHarnessOptions,
      sessionPermissionModeByAgentId,
      setSessionPermissionModeForAgent,
      feedback,
    ],
  );

  const handleSelectSessionConfigOption = useCallback(
    (configId: string, value: string | boolean) => {
      clashRt.setConfigOption(configId, value);
    },
    [clashRt.setConfigOption],
  );

  const handleSessionConfigOpenChange = useCallback(
    (open: boolean) => {
      setSessionConfigOpen(open);
      if (open && chatMode === "runtime") {
        void Promise.resolve(
          clashRt.refresh({ probe: "config", refresh: true }),
        ).catch((error) => {
          setSessionConfigOpen(false);
          feedback.notify({
            variant: "error",
            title: "Could not refresh local agents",
            message: displayErrorMessage(error),
            actionLabel: "Open Agents",
            actionHref: "/settings?section=agents",
          });
        });
      }
    },
    [chatMode, clashRt.refresh, feedback],
  );

  const handleAuthenticateSessionHarness = useCallback(
    async (options?: {
      methodId?: string;
      values?: Record<string, string>;
    }) => {
      if (!effectiveSessionHarnessId) return;
      const label =
        selectedSessionHarness?.label ??
        agentDisplayName(effectiveSessionHarnessId);
      setAuthenticatingHarnessId(effectiveSessionHarnessId);
      setSessionError(null);
      try {
        const res = await fetch(
          runtimeApiUrl(
            `/api/v1/local/harnesses/${encodeURIComponent(effectiveSessionHarnessId)}/authenticate`,
          ),
          {
            method: "POST",
            credentials: "include",
            ...(options?.methodId || options?.values
              ? {
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    ...(options.methodId
                      ? { method_id: options.methodId }
                      : {}),
                    ...(options.values ? { values: options.values } : {}),
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
        const body = (await res.json().catch(() => null)) as {
          harnesses?: Array<{ id?: string; auth?: { status?: string } }>;
        } | null;
        const authenticated =
          body?.harnesses?.some(
            (harness) =>
              harness.id === effectiveSessionHarnessId &&
              harness.auth?.status === "configured",
          ) ?? false;
        setAuthRecoveryPendingHarnessId(
          authenticated ? null : effectiveSessionHarnessId,
        );
        await clashRt.refresh({ probe: "config", refresh: true });
        if (authenticated && clashRt.sessionId) {
          await clashRt.restartSession("now");
        }
        feedback.notify({
          variant: "info",
          title: authenticated
            ? `${label} signed in`
            : `${label} sign in opened`,
          message: authenticated
            ? "The agent session is ready to continue."
            : "Finish authentication, then check again.",
          actionLabel: "Check again",
          onAction: () => {
            void clashRt.refresh({ probe: "config", refresh: true });
          },
        });
      } catch (e) {
        feedback.notify({
          variant: "error",
          title: `Could not start ${label} sign in`,
          message: displayErrorMessage(e),
          actionLabel: "Check again",
          onAction: () => {
            void clashRt.refresh({ probe: "config", refresh: true });
          },
        });
      } finally {
        setAuthenticatingHarnessId(null);
      }
    },
    [
      clashRt.refresh,
      clashRt.restartSession,
      clashRt.sessionId,
      effectiveSessionHarnessId,
      feedback,
      selectedSessionHarness?.label,
    ],
  );

  const handleRecheckSessionHarness = useCallback(async () => {
    setSessionError(null);
    setAuthRecoveryPendingHarnessId(effectiveSessionHarnessId);
    try {
      await clashRt.refresh({ probe: "config", refresh: true });
    } catch (error) {
      setAuthRecoveryPendingHarnessId(null);
      feedback.notify({
        variant: "error",
        title: "Could not check agent auth",
        message: displayErrorMessage(error),
        actionLabel: "Open Agents",
        actionHref: "/settings?section=agents",
      });
    }
  }, [clashRt.refresh, effectiveSessionHarnessId, feedback]);

  const handleSelectSessionPermissionMode = useCallback(
    (modeId: string) => {
      const runtime = selectedRuntimeForSession ?? desktopLocalRuntime;
      const agentId =
        effectiveSessionHarnessId ??
        preferredRecentAgentId(
          runtime?.agents ?? [],
          runtime?.preferences?.agent_id,
        );
      if (!agentId) return;
      setSessionPermissionModeForAgent(agentId, modeId);

      if (modeConfigOption) {
        if (clashRt.ready || clashRt.status === "draft") {
          clashRt.setConfigOption(modeConfigOption.id, modeId);
        }
        if (
          !clashRt.ready &&
          chatMode === "runtime" &&
          runtime?.status === "online"
        ) {
          clashRt.startDraft(runtime.id, undefined, {
            projectId,
            agentId,
            ...permissionModeOption(modeId),
          });
        }
        return;
      }

      if (effectiveSessionModes) {
        clashRt.setSessionMode(modeId);
        if (
          chatMode === "runtime" &&
          runtime?.status === "online" &&
          !clashRt.ready &&
          clashRt.status !== "draft"
        ) {
          clashRt.startDraft(runtime.id, undefined, {
            projectId,
            agentId,
            ...permissionModeOption(modeId),
          });
        }
      }
    },
    [
      chatMode,
      clashRt.select,
      clashRt.ready,
      clashRt.setConfigOption,
      clashRt.setSessionMode,
      clashRt.startDraft,
      clashRt.status,
      desktopLocalRuntime,
      effectiveSessionHarnessId,
      effectiveSessionModes,
      modeConfigOption,
      projectId,
      selectedRuntimeForSession,
      setSessionPermissionModeForAgent,
    ],
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const [shouldStickToBottom, setShouldStickToBottom] = useState(true);
  const updateStickToBottom = useCallback((next: boolean) => {
    stickToBottomRef.current = next;
    setShouldStickToBottom(next);
  }, []);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const resizeStartWidthRef = useRef(width);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingResizeWidthRef = useRef(width);
  const appliedRuntimeCanvasNodesRef = useRef<Set<string>>(new Set());
  const appliedRuntimeCanvasNodeDeletesRef = useRef<Set<string>>(new Set());
  const appliedRuntimeCanvasEdgesRef = useRef<Set<string>>(new Set());
  const appliedRuntimeCanvasEdgeUpdatesRef = useRef<Set<string>>(new Set());
  const appliedRuntimeCanvasEdgeDeletesRef = useRef<Set<string>>(new Set());
  const appliedRuntimeTimelineAppliesRef = useRef<Set<string>>(new Set());

  const closeMobileSheet = useCallback(
    () => onCollapseChange(true),
    [onCollapseChange],
  );

  useEffect(() => {
    if (isMobile || isCollapsed) return;
    onWidthPreview?.(presentationWidth);
  }, [isCollapsed, isMobile, onWidthPreview, presentationWidth]);

  // ─── Agent Chat Hook ─────────────────────────────────────
  const {
    messages,
    sendMessage,
    stop,
    status,
    clearHistory,
    connected,
    connectionError,
    lastFailedMessage,
    clearConnectionError,
    customEvents,
    clearCustomEvents,
    queueMessageOnOpen,
  } = useAgentCopilot({
    projectId,
    threadId,
    enabled: chatMode === "cloud",
    onCustomEvent: useCallback((data: Record<string, unknown>) => {
      if (data.type === "suggestions" && Array.isArray(data.suggestions)) {
        setSuggestions(
          data.suggestions as Array<{ label: string; message: string }>,
        );
      }
    }, []),
  });

  const sendRevisionRestoreRequest = useCallback(
    (request: RevisionRestoreRequest) => {
      const runtimePrompt = revisionRestorePrompt(request);
      setSuggestions([]);
      setSessionError(null);
      clearConnectionError();
      if (chatMode === "cloud") updateStickToBottom(true);

      if (chatMode !== "runtime") {
        setInput(runtimePrompt);
        return;
      }
      if (selectedSessionHarnessAuth) {
        setInput(runtimePrompt);
        return;
      }
      if (!clashRt.ready) {
        const runtime = selectedRuntimeForSession ?? desktopLocalRuntime;
        if (
          isDesktopLocalMode &&
          runtime &&
          runtime.status === "online" &&
          runtime.agents.length > 0
        ) {
          if (
            !clashRt.selectedRuntimeId ||
            clashRt.status === "idle" ||
            clashRt.status === "disconnected"
          ) {
            clashRt.startDraft(runtime.id, undefined, {
              projectId,
              agentId:
                effectiveSessionHarnessId ??
                preferredRecentAgentId(
                  runtime.agents,
                  runtime.preferences?.agent_id,
                ),
              ...permissionModeOption(sessionPermissionModeId),
            });
          }
        } else if (isDesktopLocalMode) {
          setInput(runtimePrompt);
          void clashRt.refresh();
          return;
        } else {
          setInput(runtimePrompt);
          setSessionError(t("copilot.status.localRuntimeRequired"));
          return;
        }
      }
      setInput("");
      clashRt.sendMessage(runtimePrompt);
    },
    [
      chatMode,
      clashRt.ready,
      clashRt.refresh,
      clashRt.selectedRuntimeId,
      clashRt.sendMessage,
      clashRt.startDraft,
      clashRt.status,
      clearConnectionError,
      desktopLocalRuntime,
      effectiveSessionHarnessId,
      isDesktopLocalMode,
      projectId,
      selectedRuntimeForSession,
      selectedSessionHarnessAuth,
      sessionPermissionModeId,
      t,
      updateStickToBottom,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRevisionRestoreRequest = (event: Event) => {
      const detail = (event as Event & { detail?: unknown }).detail;
      if (!isRevisionRestoreRequest(detail)) return;
      sendRevisionRestoreRequest(detail);
    };
    window.addEventListener(
      REVISION_RESTORE_REQUEST_EVENT,
      onRevisionRestoreRequest,
    );
    return () =>
      window.removeEventListener(
        REVISION_RESTORE_REQUEST_EVENT,
        onRevisionRestoreRequest,
      );
  }, [sendRevisionRestoreRequest]);

  useEffect(() => {
    if (!isDesktopLocalMode || chatMode !== "runtime") return;
    if (
      clashRt.selectedRuntimeId ||
      clashRt.ready ||
      clashRt.status === "connecting"
    )
      return;
    const runtime = desktopLocalRuntime;
    if (!runtime || runtime.status !== "online" || runtime.agents.length === 0)
      return;
    clashRt.startDraft(runtime.id, undefined, {
      projectId,
      agentId: preferredRecentAgentId(
        runtime.agents,
        runtime.preferences?.agent_id,
      ),
      ...permissionModeOption(sessionPermissionModeId),
    });
  }, [
    chatMode,
    clashRt.ready,
    clashRt.selectedRuntimeId,
    clashRt.startDraft,
    clashRt.status,
    desktopLocalRuntime,
    isDesktopLocalMode,
    projectId,
    sessionPermissionModeId,
  ]);

  const cloudIsProcessing = status === "submitted" || status === "streaming";
  const runtimeHistoryPending =
    !!switchingRuntimeSessionId &&
    (clashRt.agentUIState.sessionId !== switchingRuntimeSessionId ||
      clashRt.agentUIState.turnOrder.length === 0);
  const runtimeTranscriptHasTurns = clashRt.agentUIState.turnOrder.some(
    (turnId) => clashRt.agentUIState.turns[turnId]?.status !== "queued",
  );
  const runtimeTurnIsProcessing =
    clashRt.status === "sending" ||
    clashRt.status === "streaming" ||
    (clashRt.status === "connecting" && !!clashRt.agentUIState.activeTurnId);
  const isProcessing =
    chatMode === "runtime" ? runtimeTurnIsProcessing : cloudIsProcessing;
  const showProcessingIndicator =
    chatMode === "runtime"
      ? runtimeTranscriptHasTurns && runtimeTurnIsProcessing
      : isProcessing;
  const processingIndicatorMessage =
    chatMode === "runtime"
      ? t(
          clashRt.status === "sending"
            ? "copilot.status.thinking"
            : "copilot.status.streaming",
        )
      : t(
          status === "submitted"
            ? "copilot.status.thinking"
            : "copilot.status.streaming",
        );
  const creativeStatusKey = showProcessingIndicator
    ? chatMode === "runtime"
      ? clashRt.status === "sending"
        ? "copilot.status.creativeThinking"
        : "copilot.status.creativeStreaming"
      : status === "submitted"
        ? "copilot.status.creativeThinking"
        : "copilot.status.creativeStreaming"
    : null;
  const [creativeStatusIndex, setCreativeStatusIndex] = useState(0);
  const creativeStatusMessages = useMemo(() => {
    if (!creativeStatusKey) {
      return [] as string[];
    }
    const messages = t(creativeStatusKey, { returnObjects: true });
    return Array.isArray(messages) && messages.length > 0
      ? messages.map((message) => String(message)).filter(Boolean)
      : [processingIndicatorMessage];
  }, [creativeStatusKey, processingIndicatorMessage, t]);
  useEffect(() => {
    setCreativeStatusIndex(0);
    if (!creativeStatusKey || creativeStatusMessages.length <= 1) return;
    const interval = window.setInterval(() => {
      setCreativeStatusIndex(
        (index) => (index + 1) % creativeStatusMessages.length,
      );
    }, CREATIVE_STATUS_ROTATION_MS);
    return () => window.clearInterval(interval);
  }, [creativeStatusKey, creativeStatusMessages.length]);
  const creativeStatusLabel = creativeStatusKey
    ? (creativeStatusMessages[
        creativeStatusIndex % Math.max(creativeStatusMessages.length, 1)
      ] ?? processingIndicatorMessage)
    : null;
  const activeTurnStartedAtRef = useRef<number | null>(null);
  const [lastCompletedActivity, setLastCompletedActivity] =
    useState<CompletedActivity | null>(null);
  const activitySessionScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (showProcessingIndicator) {
      if (activeTurnStartedAtRef.current === null) {
        activeTurnStartedAtRef.current = Date.now();
      }
      setLastCompletedActivity(null);
      return;
    }
    if (activeTurnStartedAtRef.current !== null) {
      const completedActivity = {
        startedAt: activeTurnStartedAtRef.current,
        completedAt: Date.now(),
      };
      setLastCompletedActivity(completedActivity);
      activeTurnStartedAtRef.current = null;
    }
  }, [showProcessingIndicator]);
  useEffect(() => {
    const nextScope = chatMode === "runtime" ? clashRt.sessionId : threadId;
    const previousScope = activitySessionScopeRef.current;
    activitySessionScopeRef.current = nextScope;
    if (previousScope === null || previousScope === nextScope) return;
    activeTurnStartedAtRef.current = null;
    setLastCompletedActivity(null);
  }, [chatMode, clashRt.sessionId, threadId]);
  const pendingCompletedActivityLabel =
    !showProcessingIndicator && activeTurnStartedAtRef.current !== null
      ? formatActivityDuration(Date.now() - activeTurnStartedAtRef.current, t)
      : null;
  const completedActivityLabel =
    pendingCompletedActivityLabel ??
    (lastCompletedActivity
      ? formatActivityDuration(
          lastCompletedActivity.completedAt - lastCompletedActivity.startedAt,
          t,
        )
      : null);
  const runtimeTransientStatusLabel = useMemo(() => {
    if (chatMode !== "runtime" || !clashRt.transientStatus) return null;
    const status = clashRt.transientStatus;
    const label =
      status.kind === "reconnecting"
        ? t("copilot.status.reconnecting", {
            attempt: status.attempt ?? 0,
            maxAttempts: status.maxAttempts ?? 0,
          })
        : t("copilot.status.switchingTransport");
    return status.detail ? `${label} · ${status.detail}` : label;
  }, [chatMode, clashRt.transientStatus, t]);
  const activityStatusLabel =
    runtimeTransientStatusLabel ??
    creativeStatusLabel ??
    completedActivityLabel ??
    (showProcessingIndicator ? processingIndicatorMessage : null);
  const showRuntimeActivityRow =
    chatMode === "runtime" &&
    (!!runtimeTransientStatusLabel ||
      showProcessingIndicator ||
      !!completedActivityLabel);
  const showCloudActivityRow =
    chatMode === "cloud" &&
    !!activityStatusLabel &&
    (showProcessingIndicator || !!completedActivityLabel);
  const goalPlanEntries = useMemo<PlanEntry[]>(() => {
    const planId = clashRt.agentUIState.planOrder.at(-1);
    const plan = planId ? clashRt.agentUIState.plans[planId] : undefined;
    return (plan?.entries ?? []).map((entry) => ({
      content: entry.content,
      status: entry.status ?? "pending",
      ...(entry.priority ? { priority: entry.priority } : {}),
    }));
  }, [clashRt.agentUIState]);
  const visibleRuntimeUserTurnIds = useMemo(() => {
    return new Set(
      clashRt.agentUIState.turnOrder.filter(
        (turnId) => clashRt.agentUIState.turns[turnId]?.status !== "queued",
      ),
    );
  }, [clashRt.agentUIState]);
  const visibleRuntimePromptQueue = useMemo(
    () =>
      clashRt.promptQueue.filter(
        (item) => !visibleRuntimeUserTurnIds.has(item.turnId),
      ),
    [clashRt.promptQueue, visibleRuntimeUserTurnIds],
  );
  const runtimeAlertMessage =
    chatMode === "runtime" && !isDesktopLocalMode ? clashRt.errorMessage : null;
  const desktopLocalSetupIssue =
    chatMode === "runtime" && isDesktopLocalMode ? clashRt.errorMessage : null;
  useEffect(() => {
    if (
      !desktopLocalSetupIssue ||
      !isLocalHarnessUnavailableMessage(desktopLocalSetupIssue)
    ) {
      lastHarnessSetupIssueNotifiedRef.current = null;
      return;
    }
    if (lastHarnessSetupIssueNotifiedRef.current === desktopLocalSetupIssue)
      return;
    lastHarnessSetupIssueNotifiedRef.current = desktopLocalSetupIssue;
    notifyAgentHarnessRequired();
  }, [desktopLocalSetupIssue, notifyAgentHarnessRequired]);
  const showRuntimeComposerCompanion =
    chatMode === "runtime" &&
    !desktopRuntimeUnavailable &&
    !runtimeTranscriptHasTurns &&
    !desktopLocalSetupIssue &&
    (showRuntimeActivityRow ||
      (isDesktopLocalMode && (clashRt.status === "draft" || clashRt.ready)));
  useEffect(() => {
    if (
      chatMode !== "runtime" ||
      (!onAddNode &&
        !onRemoveNode &&
        !onAddEdge &&
        !onUpdateEdge &&
        !onRemoveEdge &&
        !onApplyTimeline)
    )
      return;

    const pendingCreates: Promise<unknown>[] = [];
    const pendingNodeDeletes: Array<{
      nodeId: string;
      ifMatch?: string;
      requiresReadProof: boolean;
    }> = [];
    const pendingEdges: Array<{
      id: string;
      source: string;
      target: string;
      type?: string;
      ifMatch?: string;
      requiresReadProof: boolean;
    }> = [];
    const pendingEdgeUpdates: Array<{
      id: string;
      patch: Record<string, unknown>;
      ifMatch?: string;
      requiresReadProof: boolean;
    }> = [];
    const pendingEdgeDeletes: Array<{
      id: string;
      ifMatch?: string;
      requiresReadProof: boolean;
    }> = [];
    const pendingTimelineApplies: Array<{
      nodeId: string;
      dsl: unknown;
      ifMatch?: string;
      requiresReadProof: boolean;
    }> = [];

    for (const message of clashRt.messages) {
      for (const part of message.parts) {
        if (part.type !== "raw_event") continue;
        const operations = parseAgentCanvasPatch(part.event);
        const createdNodeIdsInPatch = new Set<string>();
        const createdEdgeIdsInPatch = new Set<string>();
        for (const operation of operations) {
          if (operation.op === "add_edge") {
            if (!onAddEdge) continue;
            const patchEdge = operation.edge;
            if (appliedRuntimeCanvasEdgesRef.current.has(patchEdge.id))
              continue;
            appliedRuntimeCanvasEdgesRef.current.add(patchEdge.id);
            createdEdgeIdsInPatch.add(patchEdge.id);
            pendingEdges.push({
              ...patchEdge,
              ifMatch: operation.ifMatch,
              requiresReadProof:
                !createdNodeIdsInPatch.has(patchEdge.source) &&
                !createdNodeIdsInPatch.has(patchEdge.target),
            });
            onAgentCanvasTarget?.(patchEdge.target);
            continue;
          }

          if (operation.op === "update_edge") {
            if (!onUpdateEdge) continue;
            const key = `${operation.edge.id}:${JSON.stringify(operation.edge.patch)}`;
            if (appliedRuntimeCanvasEdgeUpdatesRef.current.has(key)) continue;
            appliedRuntimeCanvasEdgeUpdatesRef.current.add(key);
            pendingEdgeUpdates.push({
              ...operation.edge,
              ifMatch: operation.ifMatch,
              requiresReadProof: !createdEdgeIdsInPatch.has(operation.edge.id),
            });
            continue;
          }

          if (operation.op === "delete_edge") {
            if (!onRemoveEdge) continue;
            const edgeId = operation.edge.id;
            if (appliedRuntimeCanvasEdgeDeletesRef.current.has(edgeId))
              continue;
            appliedRuntimeCanvasEdgeDeletesRef.current.add(edgeId);
            pendingEdgeDeletes.push({
              id: edgeId,
              ifMatch: operation.ifMatch,
              requiresReadProof: !createdEdgeIdsInPatch.has(edgeId),
            });
            continue;
          }

          if (operation.op === "timeline_apply") {
            if (!onApplyTimeline) continue;
            const key = `${operation.timeline.nodeId}:${JSON.stringify(operation.timeline.dsl)}`;
            if (appliedRuntimeTimelineAppliesRef.current.has(key)) continue;
            appliedRuntimeTimelineAppliesRef.current.add(key);
            pendingTimelineApplies.push({
              ...operation.timeline,
              requiresReadProof: !createdNodeIdsInPatch.has(
                operation.timeline.nodeId,
              ),
            });
            onAgentCanvasTarget?.(operation.timeline.nodeId);
            continue;
          }

          if (operation.op === "delete_node") {
            if (!onRemoveNode) continue;
            const nodeId = operation.node.id;
            if (appliedRuntimeCanvasNodeDeletesRef.current.has(nodeId))
              continue;
            appliedRuntimeCanvasNodeDeletesRef.current.add(nodeId);
            pendingNodeDeletes.push({
              nodeId,
              ifMatch: operation.ifMatch,
              requiresReadProof: !createdNodeIdsInPatch.has(nodeId),
            });
            continue;
          }

          if (operation.op !== "add_node" || !onAddNode) continue;
          const patchNode = operation.node;
          if (appliedRuntimeCanvasNodesRef.current.has(patchNode.id)) continue;
          appliedRuntimeCanvasNodesRef.current.add(patchNode.id);
          createdNodeIdsInPatch.add(patchNode.id);

          const data = applyAgentAttribution(patchNode.data, {
            actorUserId,
            actorAgentId: clashRt.selectedAgentId ?? undefined,
          });

          const createdNodeId = onAddNode(patchNode.type, {
            id: patchNode.id,
            ...data,
            ...(patchNode.position ? { position: patchNode.position } : {}),
            ...(patchNode.parentId ? { parentId: patchNode.parentId } : {}),
            ...(patchNode.width !== undefined
              ? { width: patchNode.width }
              : {}),
            ...(patchNode.height !== undefined
              ? { height: patchNode.height }
              : {}),
            ...(patchNode.style ? { style: patchNode.style } : {}),
          });
          if (createdNodeId && typeof createdNodeId !== "string") pendingCreates.push(createdNodeId.then((id) => onAgentCanvasTarget?.(id || patchNode.id)));
          else onAgentCanvasTarget?.(createdNodeId || patchNode.id);
        }
      }
    }

    if (
      (pendingNodeDeletes.length > 0 && onRemoveNode) ||
      (pendingEdges.length > 0 && onAddEdge) ||
      (pendingEdgeUpdates.length > 0 && onUpdateEdge) ||
      (pendingEdgeDeletes.length > 0 && onRemoveEdge) ||
      (pendingTimelineApplies.length > 0 && onApplyTimeline)
    ) {
      const applyPending = () => window.setTimeout(async () => {
        if (onRemoveNode) {
          for (const deletion of pendingNodeDeletes) {
            onRemoveNode(
              deletion.nodeId,
              deletion.requiresReadProof
                ? {
                    actorClientType: "agent",
                    ifMatch: deletion.ifMatch,
                  }
                : undefined,
            );
          }
        }
        if (onAddEdge) {
          for (const patchEdge of pendingEdges) {
            onAddEdge(
              {
                id: patchEdge.id,
                source: patchEdge.source,
                target: patchEdge.target,
                type: patchEdge.type ?? "default",
              },
              patchEdge.requiresReadProof
                ? {
                    actorClientType: "agent",
                    ifMatch: patchEdge.ifMatch,
                  }
                : undefined,
            );
          }
        }
        if (onUpdateEdge) {
          for (const edgeUpdate of pendingEdgeUpdates) {
            onUpdateEdge(
              edgeUpdate.id,
              edgeUpdate.patch,
              edgeUpdate.requiresReadProof
                ? {
                    actorClientType: "agent",
                    ifMatch: edgeUpdate.ifMatch,
                  }
                : undefined,
            );
          }
        }
        if (onRemoveEdge) {
          for (const edgeDelete of pendingEdgeDeletes) {
            onRemoveEdge(
              edgeDelete.id,
              edgeDelete.requiresReadProof
                ? {
                    actorClientType: "agent",
                    ifMatch: edgeDelete.ifMatch,
                  }
                : undefined,
            );
          }
        }
        if (onApplyTimeline) {
          for (const apply of pendingTimelineApplies) {
            await onApplyTimeline(
              apply.nodeId,
              apply.dsl,
              apply.requiresReadProof
                ? {
                    actorClientType: "agent",
                    ifMatch: apply.ifMatch,
                  }
                : undefined,
            );
          }
        }
      }, 0);
      if (pendingCreates.length) void Promise.all(pendingCreates).then(applyPending).catch((error) => console.error("Canvas patch could not be applied", error));
      else applyPending();
    } else if (pendingCreates.length) {
      void Promise.all(pendingCreates).catch((error) => console.error("Canvas creation failed", error));
    }
  }, [
    actorUserId,
    chatMode,
    clashRt.messages,
    clashRt.selectedAgentId,
    onAddEdge,
    onAddNode,
    onAgentCanvasTarget,
    onApplyTimeline,
    onRemoveEdge,
    onRemoveNode,
    onUpdateEdge,
  ]);

  // Mount-time send of the pending first message. Parent gives us a fresh
  // `key={threadId}` whenever the session changes, so this component remounts
  // cleanly on every session change — no useChat id-transition race, no
  // module-level pending state. queueMessageOnOpen waits for the WS handshake
  // to land before firing; subsequent sends just hit `sendMessage` directly.
  const initialMessageRef = useRef(initialPrompt);
  const initialRuntimePromptHandledRef = useRef(false);
  useEffect(() => {
    const msg = initialMessageRef.current;
    if (chatMode === "cloud" && msg && threadId) {
      queueMessageOnOpen(
        buildCopilotPrompt(msg, workspaceContext, mentionableNodes),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cover the gap between mount and the first send actually firing. During
  // that ~300-800ms window (POST settled but WS still handshaking,
  // queueMessageOnOpen waiting for `connected`), `status` is still 'ready'
  // and `isCreatingSession` has flipped back to false — so without this
  // flag ChatInput briefly shows the idle "arrow" submit button, which
  // looks like nothing is happening. Cleared as soon as the first message
  // shows up in the array (sendMessage's optimistic insert), at which point
  // status takes over → 'submitted' → 'streaming'.
  const [waitingFirstSend, setWaitingFirstSend] = useState(
    chatMode === "cloud" && !!initialPrompt,
  );
  useEffect(() => {
    if (waitingFirstSend && messages.length > 0) setWaitingFirstSend(false);
  }, [messages.length, waitingFirstSend]);

  // Auto-restore failed message to input
  useEffect(() => {
    if (lastFailedMessage && !input) {
      setInput(lastFailedMessage);
    }
  }, [lastFailedMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Session Actions (delegated to parent) ───────────────
  const handleNewSession = useCallback(() => {
    if (runtimeHistoryItem && onUpsertSession) {
      onUpsertSession(runtimeHistoryItem);
    }
    setTodoItems([]);
    clearCustomEvents();
    const runtime = selectedRuntimeForSession ?? desktopLocalRuntime;
    if (chatMode === "runtime" && runtime?.status === "online") {
      onRuntimeSessionRouteChange?.(null);
      clashRt.startDraft(runtime.id, undefined, {
        projectId,
        agentId:
          effectiveSessionHarnessId ??
          preferredRecentAgentId(runtime.agents, runtime.preferences?.agent_id),
        ...permissionModeOption(sessionPermissionModeId),
        freshSession: true,
      });
      return;
    }
    onNewSession?.();
  }, [
    chatMode,
    clashRt.startDraft,
    clearCustomEvents,
    desktopLocalRuntime,
    effectiveSessionHarnessId,
    onNewSession,
    onRuntimeSessionRouteChange,
    onUpsertSession,
    projectId,
    runtimeHistoryItem,
    selectedRuntimeForSession,
    sessionPermissionModeId,
  ]);

  const forkRuntimeSession = useCallback(
    (item: CopilotSessionHistoryItem, forkPoint?: AcpForkPoint) => {
      if (!item.runtimeId || !item.acpSessionId) return;
      const nextAgentId =
        item.agentId ?? effectiveSessionHarnessId ?? undefined;
      if (nextAgentId) setSessionHarnessId(nextAgentId);
      if (item.permissionMode)
        setSessionPermissionModeForAgent(nextAgentId, item.permissionMode);
      setChatMode("runtime");
      onRuntimeSessionRouteChange?.(null);
      clashRt.startDraft(item.runtimeId, item.agentMemberId, {
        projectId: item.projectId ?? projectId,
        ...(nextAgentId ? { agentId: nextAgentId } : {}),
        ...(item.permissionMode
          ? { permissionModeId: item.permissionMode }
          : {}),
        forkFromAcpSessionId: item.acpSessionId,
        ...(forkPoint ? { forkPoint } : {}),
      });
    },
    [
      clashRt.startDraft,
      effectiveSessionHarnessId,
      onRuntimeSessionRouteChange,
      projectId,
      setSessionPermissionModeForAgent,
    ],
  );

  const forkCurrentRuntimeSession = useCallback((point?: AcpForkPoint) => {
    if (!runtimeHistoryItem?.supportsSessionFork) return;
    forkRuntimeSession(runtimeHistoryItem, point);
  }, [forkRuntimeSession, runtimeHistoryItem]);

  const handleStop = async () => {
    if (chatMode === "runtime") {
      clashRt.cancel();
      return;
    }
    await stop();
  };

  const selectHistoryItem = useCallback(
    (item: CopilotSessionHistoryItem) => {
      if (item.type === "runtime" && item.runtimeId) {
        const operation = ++runtimeSessionSwitchSeq.current;
        const nextAgentId = item.agentId ?? effectiveSessionHarnessId ?? null;
        if (nextAgentId) setSessionHarnessId(nextAgentId);
        if (item.permissionMode)
          setSessionPermissionModeForAgent(nextAgentId, item.permissionMode);
        setChatMode("runtime");
        onRuntimeSessionRouteChange?.(item.threadId);
        setSwitchingRuntimeSessionId(item.id ?? item.threadId);
        void clashRt
          .attachSession({
            id: item.id ?? item.threadId,
            threadId: item.threadId,
            title: item.title,
            type: "runtime",
            projectId: item.projectId ?? projectId,
            runtimeId: item.runtimeId,
            agentId: nextAgentId,
            ...(item.agentMemberId
              ? { agentMemberId: item.agentMemberId }
              : {}),
            permissionMode: item.permissionMode,
            acpSessionId: item.acpSessionId,
            status: item.status,
          })
          .catch(() => undefined)
          .finally(() => {
            if (runtimeSessionSwitchSeq.current === operation) {
              setSwitchingRuntimeSessionId(null);
            }
          });
      } else {
        onSwitchSession?.(item.threadId);
      }
      historyButtonRef.current?.focus();
    },
    [
      clashRt.attachSession,
      effectiveSessionHarnessId,
      onSwitchSession,
      onRuntimeSessionRouteChange,
      projectId,
      setSessionPermissionModeForAgent,
    ],
  );

  useEffect(() => {
    if (!threadId) {
      restoredRouteSessionRef.current = null;
      return;
    }
    if (clashRt.currentSession?.threadId === threadId) {
      restoredRouteSessionRef.current = threadId;
      return;
    }
    const routeSession = sessionHistory.find(
      (session) =>
        session.threadId === threadId &&
        session.type === "runtime" &&
        Boolean(session.runtimeId),
    );
    if (!routeSession || restoredRouteSessionRef.current === threadId) return;
    restoredRouteSessionRef.current = threadId;
    selectHistoryItem(routeSession);
  }, [
    clashRt.currentSession?.threadId,
    selectHistoryItem,
    sessionHistory,
    threadId,
  ]);

  // On mobile, the panel covers the canvas. Sheet owns dialog semantics
  // and focus behavior; this keeps the page behind it from scrolling.
  useEffect(() => {
    if (!isMobile || isCollapsed) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isMobile, isCollapsed]);

  // ─── Scroll ──────────────────────────────────────────────
  const scrollToBottom = useCallback(() => {
    if (!stickToBottomRef.current) return;
    if (scrollFrameRef.current !== null) return;
    const scheduleFrame =
      typeof globalThis.requestAnimationFrame === "function"
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback: FrameRequestCallback) =>
            window.setTimeout(() => callback(Date.now()), 0);
    scrollFrameRef.current = scheduleFrame(() => {
      scrollFrameRef.current = null;
      if (!stickToBottomRef.current) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current === null) return;
      const cancelFrame =
        typeof globalThis.cancelAnimationFrame === "function"
          ? globalThis.cancelAnimationFrame.bind(globalThis)
          : window.clearTimeout.bind(window);
      cancelFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, []);

  // Stick-to-bottom is driven by IntersectionObserver instead of an
  // onScroll handler so we don't force a layout read (scrollHeight) on
  // every wheel tick. The observer fires only when the intersection
  // state of the bottom sentinel actually changes.
  //
  // rootMargin bottom: 120px → the sentinel is treated as "visible" as
  // long as the user is within 120px of the bottom. Matches the prior
  // `distanceToBottom < 120` heuristic.
  useEffect(() => {
    if (chatMode !== "cloud") return;
    const sentinel = messagesEndRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => updateStickToBottom(entry.isIntersecting),
      { root: container, rootMargin: "0px 0px 120px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chatMode, isCollapsed, updateStickToBottom]);

  useEffect(() => {
    if (chatMode !== "cloud" || isCollapsed) return;
    scrollToBottom();
  }, [
    chatMode,
    clashRt.agentUIState,
    isCollapsed,
    messages,
    shouldStickToBottom,
    scrollToBottom,
  ]);

  // ─── @-mention nodes for ChatInput ────────────────────────
  // `thumbnail` decides whether the mention renders as an inline image chip:
  //   - image nodes  → ResolvedAsset.url
  //   - video nodes  → ResolvedAsset.thumbnailUrl
  //   - text / no asset → plain text mention
  // Resolving assets is async (getAsset hits the Project-scoped Asset route); we stash
  // the results in a Map keyed by nodeId and populate it lazily. Nodes
  // without a resolved asset yet render as text-only mentions, which is
  // the same outcome as "no thumbnail" used to be.
  const [assetThumbsByNodeId, setAssetThumbsByNodeId] = useState<
    Map<string, string>
  >(() => new Map());
  useEffect(() => {
    if (!nodes) return;
    let cancelled = false;
    (async () => {
      const next = new Map<string, string>();
      for (const n of nodes) {
        if (!["image", "video"].includes(n.type as string)) continue;
        const assetId =
          typeof n.data?.assetId === "string" ? n.data.assetId : undefined;
        if (!assetId) continue;
        try {
          const asset = await getAsset(projectId, assetId);
          const previewUrl = assetThumbnailImageUrl(asset);
          if (previewUrl) next.set(n.id, previewUrl);
        } catch {
          // asset not yet available; skip
        }
      }
      if (cancelled) return;
      // Skip the setState when contents are equal — the previous version
      // always handed in a *new* Map identity, which made `mentionableNodes`
      // (useMemo deps include this Map) recompute on every nodes change
      // even when nothing meaningful moved. New array identity then forced
      // child renders down through ReactMarkdown / hook-heavy thumbnails,
      // which made render-time setState chains in those subtrees easy to
      // tip into "Maximum update depth exceeded" (React #185).
      setAssetThumbsByNodeId((prev) => {
        if (prev.size === next.size) {
          let same = true;
          for (const [k, v] of next) {
            if (prev.get(k) !== v) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [nodes, projectId]);

  const mentionableNodes = useMemo(() => {
    if (mentionSources.length > 0) {
      return mentionSources.map((source) => ({
        ...source,
        thumbnail: source.thumbnail ?? assetThumbsByNodeId.get(source.id),
      }));
    }
    return nodes.map((n) => ({
      id: n.id,
      type: n.type as string,
      label: (n.data.label as string) || n.id,
      thumbnail: assetThumbsByNodeId.get(n.id),
      kind: "node" as const,
      scope: "current-canvas" as const,
    }));
  }, [nodes, mentionSources, assetThumbsByNodeId]);
  const clashProjectEntities = useMemo<ClashProjectEntity[]>(() => {
    const entities = new Map<string, ClashProjectEntity>();
    const addEntity = (entity: ClashProjectEntity) => {
      entities.set(`${entity.kind}:${entity.id}`, entity);
    };
    if (
      workspaceContext?.activeSurface &&
      workspaceContext.activeSurface.kind !== "browser"
    ) {
      addEntity({
        kind: workspaceContext.activeSurface.kind,
        id: workspaceContext.activeSurface.id,
        label: workspaceContext.activeSurface.name,
      });
    }
    for (const source of mentionSources) {
      if (source.kind === "node") {
        addEntity({
          kind: "canvas-node",
          id: source.id,
          label: source.label,
          ...(source.canvasId ? { canvasId: source.canvasId } : {}),
        });
        if (source.canvasId) {
          addEntity({
            kind: "canvas",
            id: source.canvasId,
            label: source.canvasName?.trim() || source.canvasId,
          });
        }
      } else if (
        source.kind === "asset" ||
        source.kind === "timeline" ||
        source.kind === "director-stage"
      ) {
        addEntity({
          kind: source.kind,
          id: source.id,
          label: source.label,
        });
      }
    }
    return [...entities.values()];
  }, [mentionSources, workspaceContext]);

  // ─── Submit ──────────────────────────────────────────────
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [editingQueuedTurnId, setEditingQueuedTurnId] = useState<string | null>(
    null,
  );
  const [editingQueuedAnnotations, setEditingQueuedAnnotations] = useState<
    AgentAnnotationDraft[]
  >([]);
  const agentMotionState: AgentMotionState =
    runtimeAlertMessage || desktopLocalSetupIssue || sessionError
      ? "failed"
      : showProcessingIndicator
        ? "working"
        : chatMode === "runtime" &&
            !clashRt.ready &&
            (clashRt.status === "idle" || clashRt.status === "connecting")
          ? "connecting"
          : suggestions.length > 0
            ? "waiting"
            : clashRt.ready && runtimeTranscriptHasTurns
              ? "review"
              : "idle";
  const handleSubmit = async (
    text: string,
    attachments: import("./copilot/ChatInput").UploadedAttachment[] = [],
    annotations: AgentAnnotationDraft[] = [],
  ) => {
    const rawValue = text.trim();
    const effectiveAnnotations =
      editingQueuedTurnId && annotations.length === 0
        ? editingQueuedAnnotations
        : annotations;
    const value = rawValue || annotationOnlyPrompt(effectiveAnnotations);
    if (!value && attachments.length === 0) return;
    if ((chatMode !== "runtime" && isProcessing) || isCreatingSession) return;
    if (chatMode === "runtime" && editingQueuedTurnId) {
      clashRt.updateQueuedPrompt(
        editingQueuedTurnId,
        buildCopilotPrompt(
          value,
          workspaceContext,
          mentionableNodes,
          effectiveAnnotations,
        ),
      );
      setEditingQueuedTurnId(null);
      setEditingQueuedAnnotations([]);
      setInput("");
      return;
    }
    setSuggestions([]);
    setSessionError(null);
    clearConnectionError();
    if (chatMode === "cloud") updateStickToBottom(true);

    // Persistent-runtime mode: raw prompt, daemon handles the local ACP session.
    if (chatMode === "runtime") {
      // ACP slash commands are control-plane input. Prefixing them with
      // Clash's workspace-context comment stops harnesses from parsing
      // the leading slash, so send commands exactly as the user typed.
      const runtimePrompt = rawValue.startsWith("/")
        ? rawValue
        : buildCopilotPrompt(
            value,
            workspaceContext,
            mentionableNodes,
            annotations,
          );
      if (selectedSessionHarnessAuth) {
        setInput(rawValue);
        return;
      }
      const exactSlashCommand =
        rawValue.startsWith("/") && !/\s/.test(rawValue)
          ? slashCommandCandidates.find(
              (command) =>
                normalizeSlashCommandName(command).toLowerCase() ===
                rawValue.slice(1).toLowerCase(),
            )
          : null;
      const advertisedAction = exactSlashCommand
        ? commandActionFromAvailableCommand(exactSlashCommand)
        : null;
      if (advertisedAction?.kind === "setConfigOption") {
        setInput("");
        clashRt.setConfigOption(
          advertisedAction.configId,
          advertisedAction.value,
        );
        return;
      }
      if (!clashRt.ready) {
        const runtime = selectedRuntimeForSession ?? desktopLocalRuntime;
        if (
          isDesktopLocalMode &&
          runtime &&
          runtime.status === "online" &&
          runtime.agents.length > 0
        ) {
          if (
            !clashRt.selectedRuntimeId ||
            clashRt.status === "idle" ||
            clashRt.status === "disconnected"
          ) {
            clashRt.startDraft(runtime.id, undefined, {
              projectId,
              agentId:
                effectiveSessionHarnessId ??
                preferredRecentAgentId(
                  runtime.agents,
                  runtime.preferences?.agent_id,
                ),
              ...permissionModeOption(sessionPermissionModeId),
            });
          }
        } else if (
          isDesktopLocalMode &&
          runtime &&
          runtime.agents.length === 0
        ) {
          setInput(rawValue);
          notifyAgentHarnessRequired();
          void clashRt.refresh({ probe: "config", refresh: true });
          return;
        } else if (isDesktopLocalMode) {
          setInput(rawValue);
          void clashRt.refresh();
          return;
        } else {
          setInput(rawValue);
          setSessionError(t("copilot.status.localRuntimeRequired"));
          return;
        }
      }
      setInput("");
      clashRt.sendMessage(runtimePrompt);
      onAnnotationsSubmitted?.(annotations.map((annotation) => annotation.id));
      return;
    }

    setInput("");

    // Create canvas nodes for uploaded attachments
    if (attachments.length > 0 && onUploadFiles) {
      onUploadFiles(attachments);
    }

    // Message text carries Project Asset media URLs plus explicit stable-id
    // markers. Runtime consumers can use the URL for this turn while all
    // product identity stays on assetId.
    const msgText = buildCopilotPrompt(
      value,
      workspaceContext,
      mentionableNodes,
      annotations,
    );

    if (!threadId) {
      setIsCreatingSession(true);
      try {
        await onCreateSession?.(msgText);
        onAnnotationsSubmitted?.(
          annotations.map((annotation) => annotation.id),
        );
      } catch {
        setSessionError("Failed to create session. Please try again.");
        setInput(rawValue);
      } finally {
        setIsCreatingSession(false);
      }
    } else {
      try {
        await sendMessage({ text: msgText });
        onAnnotationsSubmitted?.(
          annotations.map((annotation) => annotation.id),
        );
      } catch {
        setInput(rawValue);
      }
    }
  };

  // A prompt created on Home is still a normal Project composer submit.
  // The server-owned startup snapshot is the only authority here: never
  // interpret a not-yet-loaded inventory as an agent selection.
  useEffect(() => {
    const message = initialMessageRef.current?.trim();
    if (
      !message ||
      chatMode !== "runtime" ||
      initialRuntimePromptHandledRef.current
    )
      return;
    if (isDesktopLocalMode && clashRt.startupStatus !== "ready") return;
    if (desktopRuntimeNeedsSetup) {
      initialRuntimePromptHandledRef.current = true;
      return;
    }
    if (isDesktopLocalMode && !desktopLocalRuntime) return;
    initialRuntimePromptHandledRef.current = true;
    void handleSubmit(message);
    // handleSubmit intentionally uses the render that supplied the now-known runtime inventory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatMode,
    clashRt.startupStatus,
    desktopLocalRuntime,
    desktopRuntimeNeedsSetup,
    isDesktopLocalMode,
  ]);

  // Strip the ?prompt= query param after first use so a manual reload
  // doesn't re-send the original landing prompt.
  useEffect(() => {
    if (initialPrompt && window.location.search.includes("prompt=")) {
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${withoutInitialProjectPrompt(window.location.search)}${window.location.hash}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Resize ──────────────────────────────────────────────
  const applyResizePreview = useCallback(
    (nextWidth: number) => {
      if (panelRef.current) panelRef.current.style.width = `${nextWidth}px`;
      onWidthPreview?.(nextWidth);
    },
    [onWidthPreview],
  );

  const cancelResizeFrame = useCallback(() => {
    if (resizeFrameRef.current === null) return;
    cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = null;
  }, []);

  const scheduleResizePreview = useCallback(
    (nextWidth: number) => {
      pendingResizeWidthRef.current = nextWidth;
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        applyResizePreview(pendingResizeWidthRef.current);
      });
    },
    [applyResizePreview],
  );

  const resizeGestureBind = useDragGesture<PointerEvent>(
    ({ first, last, movement: [movementX], event }) => {
      event.preventDefault();
      event.stopPropagation();
      if (first) {
        resizeStartWidthRef.current = width;
        setIsResizing(true);
        onResizeStateChange?.(true);
      }
      const nextWidth = clampCopilotPanelWidthForViewport(
        resizeStartWidthRef.current - movementX,
        window.innerWidth,
      );
      if (last) {
        cancelResizeFrame();
        applyResizePreview(nextWidth);
        onWidthChange(nextWidth);
        setIsResizing(false);
        onResizeStateChange?.(false);
        return;
      }
      scheduleResizePreview(nextWidth);
    },
    {
      preventDefault: true,
      axis: "x",
      pointer: { capture: true },
      eventOptions: { passive: false },
    },
  );

  useEffect(() => {
    if (!isResizing) return undefined;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);

  useEffect(
    () => () => {
      cancelResizeFrame();
      onResizeStateChange?.(false);
    },
    [cancelResizeFrame, onResizeStateChange],
  );

  // ─── Render ──────────────────────────────────────────────
  return (
    <MotionConfig reducedMotion="user">
      <Collapsible
        open={!isCollapsed}
        onOpenChange={(nextOpen) => onCollapseChange(!nextOpen)}
      >
        <AnimatePresence>
          {isCollapsed && (
            <motion.div
              key="copilot-launcher"
              layout="position"
              layoutDependency={collapsedLauncherPlacement}
              data-copilot-launcher-placement={collapsedLauncherPlacement}
              className={
                collapsedLauncherPlacement === "header"
                  ? "fixed right-2 top-[calc(var(--clash-desktop-chrome-height,0px)+0.375rem)] z-50"
                  : "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-50"
              }
              initial={{ opacity: 0, scale: 0.86, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{
                opacity: 0,
                scale: 0.92,
                y: 6,
                transition: COPILOT_LAUNCHER_EXIT_TRANSITION,
              }}
              transition={COPILOT_LAUNCHER_RELOCATION_TRANSITION}
              whileHover={{ scale: 1.035, y: -1 }}
              whileTap={{ scale: 0.965 }}
            >
              <CollapsibleTrigger asChild>
                <IconButton
                  label={t("copilot.panel.expand")}
                  size={collapsedLauncherPlacement === "header" ? "sm" : "lg"}
                  shape="rounded"
                  icon={
                    <AgentMotion
                      state="idle"
                      className={
                        collapsedLauncherPlacement === "header"
                          ? "h-6 w-6"
                          : "h-16 w-16"
                      }
                    />
                  }
                  // Clears the iPhone home-indicator gesture zone with safe-area-inset-bottom
                  // while keeping the same bottom-right launcher position on desktop.
                  className={
                    collapsedLauncherPlacement === "header"
                      ? "clash-copilot-launcher clash-copilot-launcher--header h-8 min-h-8 w-8 min-w-8 rounded-lg bg-transparent hover:bg-transparent focus-visible:ring-offset-warm-page"
                      : "clash-copilot-launcher h-20 min-h-20 w-20 min-w-20 rounded-[26px] bg-transparent hover:bg-transparent focus-visible:ring-offset-warm-page"
                  }
                />
              </CollapsibleTrigger>
            </motion.div>
          )}
        </AnimatePresence>

        <Sheet
          open={isMobile && !isCollapsed}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && isMobile && !isCollapsed) closeMobileSheet();
          }}
        >
          <AnimatePresence>
            {isMobile && !isCollapsed && (
              <SheetOverlay active asChild>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="lg:hidden"
                  onClick={closeMobileSheet}
                />
              </SheetOverlay>
            )}
          </AnimatePresence>

          <SheetContent
            active={isMobile && !isCollapsed}
            asChild
            aria-label={t("copilot.panel.label")}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              panelRef.current?.focus();
            }}
          >
            <motion.aside
              ref={panelRef as React.RefObject<HTMLElement>}
              id="clash-copilot-panel"
              aria-label={t("copilot.panel.label")}
              aria-hidden={isCollapsed}
              tabIndex={isMobile && !isCollapsed ? -1 : undefined}
              className={
                isMobile
                  ? // Mobile: bg-warm-page extends to the unsafe areas so the system bars blend with the panel; padding shrinks the positioning context so absolute children land inside the safe zone. All four insets cover portrait (notch top, home indicator bottom) and landscape (notch on left or right).
                    `fixed inset-0 z-50 flex flex-col bg-warm-page h-[100dvh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] ${isCollapsed ? "pointer-events-none" : ""}`
                  : `clash-copilot-panel-shell fixed z-50 flex flex-col overflow-hidden bg-warm-page ${
                      isDocked
                        ? "clash-copilot-panel-shell--docked bottom-0 right-0 rounded-none"
                        : "bottom-2 right-2 rounded-matrix"
                    } ${isCollapsed ? "pointer-events-none" : "pointer-events-auto"}`
              }
              style={
                isMobile
                  ? ({
                      "--clash-workspace-control-size": "44px",
                    } as CSSProperties)
                  : {
                      width: `${presentationWidth}px`,
                      height: isDocked
                        ? "calc(100dvh - var(--clash-desktop-chrome-height, 0px))"
                        : "calc(100dvh - var(--clash-desktop-chrome-height, 0px) - 1rem)",
                      transformOrigin: desktopTransformOrigin,
                    }
              }
              animate={
                isMobile
                  ? { x: isCollapsed ? "100%" : 0 }
                  : isCollapsed
                    ? collapsedDesktopState
                    : COPILOT_PANEL_EXPANDED_DESKTOP_STATE
              }
              initial={false}
              transition={
                isResizing
                  ? { duration: 0 }
                  : isCollapsed && !isMobile
                    ? COPILOT_PANEL_COLLAPSE_TRANSITION
                    : COPILOT_PANEL_TRANSITION
              }
            >
              {/* Screen-reader-only heading: gives heading-nav rotor users
                    a landmark to jump to. Hidden visually because the panel
                    already shows its purpose via design + the floating
                    toggle button. */}
              <h2 className="sr-only">{t("copilot.panel.label")}</h2>
              {!isCollapsed && !isMobile && (
                <div
                  {...resizeGestureBind()}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize panel"
                  style={{ touchAction: "none" }}
                  className={`clash-copilot-resize-handle absolute -left-1 top-8 bottom-8 z-10 w-2 cursor-ew-resize rounded-full ${isResizing ? "is-resizing" : ""}`}
                />
              )}

              <AnimatePresence>
                {!isCollapsed && (
                  <motion.div
                    initial={{ opacity: 0, y: 8, scale: 0.99 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.99 }}
                    transition={COPILOT_PANEL_TRANSITION}
                    className="relative flex h-full min-w-0"
                  >
                    <div
                      className="relative flex min-w-0 flex-1 flex-col"
                      data-chat-surface="main"
                    >
                      <div className="clash-copilot-panel-header relative z-20 flex h-[38px] shrink-0 items-center gap-2 px-4">
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate font-display text-[14px] font-semibold text-slate-900 dark:text-slate-100"
                            data-copilot-session-title
                            title={panelTitle}
                          >
                            {compactPanelTitle}
                          </div>
                        </div>

                        <div
                          className="flex items-center gap-[var(--clash-workspace-control-gap)]"
                          role="toolbar"
                          aria-label={t("copilot.panel.label")}
                        >
                          {chatMode === "runtime" && (
                            <SessionHarnessUpdateControl
                              status={clashRt.sessionRuntimeStatus}
                              phase={clashRt.sessionRestartPhase}
                              busy={
                                clashRt.sessionRuntimeStatus?.busy === true ||
                                clashRt.status === "sending" ||
                                clashRt.status === "streaming"
                              }
                              onRestart={(mode) => {
                                void clashRt.restartSession(mode);
                              }}
                            />
                          )}
                          <IconButton
                            onClick={handleNewSession}
                            label={t("copilot.header.newSession")}
                            size={panelHeaderControlSize}
                            disabled={desktopRuntimeUnavailable}
                            className="clash-workspace-icon-control"
                            icon={<Plus className="w-4 h-4" weight="bold" />}
                          />
                          <Popover
                            open={sessionHistoryOpen}
                            onOpenChange={setSessionHistoryOpen}
                          >
                            <PopoverTrigger asChild>
                              <IconButton
                                ref={historyButtonRef}
                                label={t("copilot.header.history")}
                                size={panelHeaderControlSize}
                                disabled={desktopRuntimeUnavailable}
                                className="clash-workspace-icon-control relative"
                                icon={
                                  <ClockCounterClockwise
                                    className="h-4 w-4"
                                    weight="bold"
                                  />
                                }
                              />
                            </PopoverTrigger>
                            <PopoverContent
                              aria-label={t("copilot.history.title")}
                              align="end"
                              side="bottom"
                              sideOffset={6}
                              className="w-80 max-w-[calc(100vw-1rem)] gap-0 overflow-hidden bg-warm-surface p-0"
                            >
                              <SessionHistoryPopoverPanel
                                activeSessions={visibleSessionHistory}
                                activeSessionId={activeSessionId}
                                onSelect={selectHistoryItem}
                                onFork={forkRuntimeSession}
                                onArchive={onArchiveSession}
                                onRename={onRenameSession}
                                hasMore={sessionHistoryHasMore}
                                isLoadingMore={sessionHistoryLoadingMore}
                                onLoadMore={onLoadMoreSessionHistory}
                                onClose={() => setSessionHistoryOpen(false)}
                              />
                            </PopoverContent>
                          </Popover>
                          {!isDesktopLocalMode && (
                            <div className="relative">
                              <DropdownMenu
                                onOpenChange={(open) => {
                                  if (open) void clashRt.refresh();
                                }}
                              >
                                <DropdownMenuTrigger asChild>
                                  <IconButton
                                    label={t("copilot.header.runOn")}
                                    size={panelHeaderControlSize}
                                    variant={
                                      chatMode !== "cloud"
                                        ? "active"
                                        : "default"
                                    }
                                    icon={
                                      <Plug className="w-5 h-5" weight="bold" />
                                    }
                                  />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  aria-label={t("copilot.runtime.menuTitle")}
                                  align="end"
                                  side="bottom"
                                  className="w-72"
                                >
                                  <div className="px-3 pb-1 pt-1 text-sm font-medium text-stone-500 dark:text-stone-400">
                                    {t("copilot.runtime.menuTitle")}
                                  </div>
                                  <div className="space-y-0.5">
                                    <RuntimeMenuRow
                                      label={t("copilot.runtime.cloud.label")}
                                      sub={t("copilot.runtime.cloud.sub")}
                                      active={chatMode === "cloud"}
                                      disabled
                                    />
                                    {clashRt.runtimes.length > 0 && (
                                      <div
                                        role="presentation"
                                        className="px-3 pt-1.5 text-xs font-medium text-stone-500 dark:text-stone-400"
                                      >
                                        {t("copilot.runtime.machinesHeader")}
                                      </div>
                                    )}
                                    {clashRt.runtimes.map((rt) => {
                                      const online = rt.status === "online";
                                      const sub = online
                                        ? t(
                                            "copilot.runtime.machineSub_online",
                                            {
                                              count: rt.agents.length,
                                            },
                                          )
                                        : t(
                                            "copilot.runtime.machineSub_offline",
                                          );
                                      return (
                                        <RuntimeMenuRow
                                          key={rt.id}
                                          label={
                                            rt.hostname ||
                                            rt.machine_id.slice(0, 10)
                                          }
                                          sub={sub}
                                          active={
                                            chatMode === "runtime" &&
                                            clashRt.selectedRuntimeId === rt.id
                                          }
                                          disabled={
                                            !online || rt.agents.length === 0
                                          }
                                          onSelect={() => {
                                            // Open the daemon picker so runtime sessions keep
                                            // the same agent + resume-session UX.
                                            setRuntimePicker(rt);
                                          }}
                                        />
                                      );
                                    })}
                                  </div>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          )}
                          <CollapsibleTrigger asChild>
                            <IconButton
                              label={t("copilot.panel.collapse")}
                              size={panelHeaderControlSize}
                              icon={
                                <CaretRight className="h-4 w-4" weight="bold" />
                              }
                              className="clash-workspace-icon-control text-stone-700 dark:text-stone-300"
                            />
                          </CollapsibleTrigger>
                        </div>
                      </div>


                      {chatMode === "runtime" && (
                        <RuntimeSessionTimeline
                          className="flex-1 min-h-0"
                          store={clashRt.agentUIStore}
                          agentId={clashRt.selectedAgentId}
                          phase={runtimeTranscriptHasTurns ? "active" : "draft"}
                          mentionableNodes={mentionableNodes}
                          clashEntities={clashProjectEntities}
                          onOpenClashEntity={onOpenClashEntity}
                          onForkAtMessage={clashRt.supportsMessageFork ? forkCurrentRuntimeSession : undefined}
                          onFork={
                            runtimeHistoryItem?.supportsSessionFork
                              ? () => forkCurrentRuntimeSession()
                              : undefined
                          }
                          slots={{
                            empty: (
                              <>
                                {runtimeAlertMessage && (
                                  <InlineAlert
                                    tone="error"
                                    title={t("copilot.errors.warningPrefix")}
                                    message={runtimeAlertMessage}
                                  />
                                )}
                                {selectedSessionHarnessAuthTitle &&
                                  selectedSessionHarnessAuth && (
                                    <RuntimeAuthNotice
                                      title={selectedSessionHarnessAuthTitle}
                                      message={
                                        selectedSessionHarnessAuthMessage ?? ""
                                      }
                                      command={
                                        selectedSessionHarnessAuth.command
                                      }
                                      methods={
                                        selectedSessionHarnessAuth.methods
                                      }
                                      busy={
                                        authenticatingHarnessId ===
                                        effectiveSessionHarnessId
                                      }
                                      onAuthenticate={
                                        handleAuthenticateSessionHarness
                                      }
                                      onRecheck={handleRecheckSessionHarness}
                                    />
                                  )}
                                <RuntimeEmptyState
                                  ready={clashRt.ready}
                                  startupPending={desktopRuntimeStartupPending}
                                  desktopLocalMode={isDesktopLocalMode}
                                  localRuntime={desktopLocalRuntime}
                                  setupIssue={desktopLocalSetupIssue}
                                  status={clashRt.status}
                                  activityLabel={
                                    showRuntimeActivityRow
                                      ? activityStatusLabel
                                      : null
                                  }
                                  agentMotionState={agentMotionState}
                                  renderEmptyActivity={
                                    !showRuntimeComposerCompanion
                                  }
                                />
                              </>
                            ),
                            beforeComposer: (
                              <>
                                {showRuntimeComposerCompanion && (
                                  <motion.div
                                    className="clash-copilot-agent-activity-empty-anchor clash-copilot-agent-activity-composer-companion relative -left-3 top-2 z-20 mx-auto w-full max-w-[68rem] px-4 pb-1 sm:px-6"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 6 }}
                                    transition={{
                                      duration: 0.22,
                                      ease: [0.16, 1, 0.3, 1],
                                    }}
                                  >
                                    <AgentActivitySlot
                                      label={
                                        showRuntimeActivityRow
                                          ? activityStatusLabel
                                          : null
                                      }
                                      state={
                                        showRuntimeActivityRow
                                          ? agentMotionState
                                          : "idle"
                                      }
                                      gazeTarget={null}
                                      emptyLabel={t(
                                        "copilot.status.readyWhenYouAre",
                                      )}
                                    />
                                  </motion.div>
                                )}
                                {clashRt.permissionRequests.length === 0 &&
                                  slashCommandQuery !== null && (
                                    <SlashCommandPalette
                                      commands={slashCommandOptions}
                                      onPick={handlePickSlashCommand}
                                      emptyLabel={t(
                                        slashCommandCandidates.length > 0
                                          ? "copilot.slash.noMatches"
                                          : "copilot.slash.noCommands",
                                      )}
                                    />
                                  )}
                                {clashRt.promptQueueEnabled &&
                                  visibleRuntimePromptQueue.length > 0 && (
                                    <RuntimePromptQueueBar
                                      items={visibleRuntimePromptQueue}
                                      onSteer={clashRt.steerQueuedPrompt}
                                      onEdit={(item) => {
                                        const content = parseUserMessageContent(
                                          item.text,
                                        );
                                        setEditingQueuedTurnId(item.turnId);
                                        setEditingQueuedAnnotations(
                                          content.annotations,
                                        );
                                        setInput(content.text);
                                      }}
                                      onRemove={clashRt.removeQueuedPrompt}
                                      onReorder={clashRt.reorderPromptQueue}
                                    />
                                  )}
                                {clashRt.goal ? (
                                  <GoalSessionBar
                                    goal={clashRt.goal}
                                    planEntries={goalPlanEntries}
                                    onEdit={() =>
                                      setInput(
                                        `/goal ${clashRt.goal?.objective ?? ""}`,
                                      )
                                    }
                                    onToggle={() =>
                                      clashRt.sendMessage(
                                        clashRt.goal?.status === "active"
                                          ? "/goal pause"
                                          : "/goal resume",
                                      )
                                    }
                                    onClear={() =>
                                      clashRt.sendMessage("/goal clear")
                                    }
                                  />
                                ) : null}
                              </>
                            ),
                            composer: !desktopRuntimeUnavailable ? (
                              <div className="relative z-20">
                                <div className="relative z-10">
                                  {clashRt.elicitationRequests[0] ? (
                                    <AcpElicitationComposer
                                      key={
                                        clashRt.elicitationRequests[0].requestId
                                      }
                                      request={clashRt.elicitationRequests[0]}
                                      onRespond={clashRt.respondElicitation}
                                    />
                                  ) : clashRt.permissionRequests[0] ? (
                                    <AcpPermissionComposer
                                      request={clashRt.permissionRequests[0]}
                                      onRespond={clashRt.respondPermission}
                                    />
                                  ) : (
                                    <ChatInput
                                      input={input}
                                      onInputChange={setInput}
                                      onSubmit={handleSubmit}
                                      onStop={handleStop}
                                      isProcessing={isProcessing}
                                      isCreatingSession={isCreatingSession}
                                      connected={clashRt.ready}
                                      error={sessionError}
                                      onDismissError={() => {
                                        setSessionError(null);
                                        clearConnectionError();
                                      }}
                                      allowSubmitWhileProcessing
                                      disabled={
                                        !isDesktopLocalMode && !clashRt.ready
                                      }
                                      mentionableNodes={mentionableNodes}
                                      projectId={projectId}
                                      annotationBlocks={annotationBlocks}
                                      onAnnotationRemove={onAnnotationRemove}
                                      toolbarAccessory={
                                        <div className="clash-composer-session-controls flex min-w-0 items-center gap-1">
                                          {onFollowingAgentChange ? (
                                            <Tooltip
                                              label={t(
                                                followingAgent
                                                  ? "copilot.follow.stop"
                                                  : "copilot.follow.start",
                                              )}
                                            >
                                              <IconButton
                                                label={t(
                                                  followingAgent
                                                    ? "copilot.follow.stop"
                                                    : "copilot.follow.start",
                                                )}
                                                aria-pressed={followingAgent}
                                                variant={
                                                  followingAgent
                                                    ? "active"
                                                    : "default"
                                                }
                                                size="sm"
                                                shape="rounded"
                                                onClick={() =>
                                                  onFollowingAgentChange(
                                                    !followingAgent,
                                                  )
                                                }
                                                icon={
                                                  <Crosshair
                                                    className="h-4 w-4"
                                                    weight={
                                                      followingAgent
                                                        ? "bold"
                                                        : "regular"
                                                    }
                                                  />
                                                }
                                              />
                                            </Tooltip>
                                          ) : null}
                                          <HarnessPermissionSelector
                                            agentId={effectiveSessionHarnessId}
                                            selectedPermissionModeId={
                                              sessionPermissionModeId
                                            }
                                            sessionModes={effectiveSessionModes}
                                            modeConfigOption={modeConfigOption}
                                            onSelectPermissionMode={
                                              handleSelectSessionPermissionMode
                                            }
                                          />
                                          <SessionPlanTag
                                            configOptions={
                                              effectiveSessionConfigOptions
                                            }
                                            onSelectConfigOption={
                                              handleSelectSessionConfigOption
                                            }
                                          />
                                          {clashRt.goal ? (
                                            <SessionGoalTag
                                              onClear={() =>
                                                clashRt.sendMessage(
                                                  "/goal clear",
                                                )
                                              }
                                            />
                                          ) : null}
                                          <InlineSessionConfigControls
                                            configOptions={
                                              effectiveSessionConfigOptions
                                            }
                                            onSelectConfigOption={
                                              handleSelectSessionConfigOption
                                            }
                                          />
                                        </div>
                                      }
                                      rightToolbarAccessory={
                                        <SessionConfigSelector
                                          open={sessionConfigOpen}
                                          onOpenChange={
                                            handleSessionConfigOpenChange
                                          }
                                          embedded
                                          selectedHarnessId={
                                            effectiveSessionHarnessId
                                          }
                                          statusLabel={null}
                                          harnessOptions={sessionHarnessOptions}
                                          harnessLocked={sessionHarnessLocked}
                                          configOptions={
                                            effectiveSessionConfigOptions
                                          }
                                          modelConfigOption={modelConfigOption}
                                          onSelectHarness={
                                            handleSelectSessionHarness
                                          }
                                          onSelectConfigOption={
                                            handleSelectSessionConfigOption
                                          }
                                        />
                                      }
                                    />
                                  )}
                                </div>
                              </div>
                            ) : null,
                            wrapConversationContent: (children) => (
                              <>
                                {runtimeAlertMessage && (
                                  <div className="chat-turn-frame mx-auto w-full max-w-3xl">
                                    <InlineAlert
                                      tone="error"
                                      title={t("copilot.errors.warningPrefix")}
                                      message={runtimeAlertMessage}
                                    />
                                  </div>
                                )}
                                {selectedSessionHarnessAuthTitle &&
                                  selectedSessionHarnessAuth && (
                                    <div className="chat-turn-frame mx-auto w-full max-w-3xl">
                                      <RuntimeAuthNotice
                                        title={selectedSessionHarnessAuthTitle}
                                        message={
                                          selectedSessionHarnessAuthMessage ??
                                          ""
                                        }
                                        command={
                                          selectedSessionHarnessAuth.command
                                        }
                                        methods={
                                          selectedSessionHarnessAuth.methods
                                        }
                                        busy={
                                          authenticatingHarnessId ===
                                          effectiveSessionHarnessId
                                        }
                                        onAuthenticate={
                                          handleAuthenticateSessionHarness
                                        }
                                        onRecheck={handleRecheckSessionHarness}
                                      />
                                    </div>
                                  )}
                                {runtimeHistoryPending ? (
                                  <motion.div
                                    role="status"
                                    aria-label="Loading session"
                                    aria-live="polite"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: 0.15, duration: 0.15 }}
                                    className="chat-turn-frame mx-auto w-full max-w-3xl py-6"
                                  >
                                    <div
                                      aria-hidden="true"
                                      className="space-y-6 motion-safe:animate-pulse"
                                    >
                                      <div className="ml-auto h-9 w-2/5 rounded-xl bg-current/[0.05]" />
                                      <div className="space-y-3">
                                        <div className="h-3 w-4/5 rounded-full bg-current/[0.05]" />
                                        <div className="h-3 w-3/5 rounded-full bg-current/[0.05]" />
                                        <div className="h-3 w-2/5 rounded-full bg-current/[0.05]" />
                                      </div>
                                    </div>
                                  </motion.div>
                                ) : (
                                  children
                                )}
                                {suggestions.length > 0 && !isProcessing && (
                                  <motion.div
                                    role="group"
                                    aria-label="Suggestions"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="chat-turn-frame mx-auto flex w-full max-w-3xl flex-wrap gap-2 px-1"
                                  >
                                    {suggestions.map((suggestion, index) => (
                                      <Button
                                        key={index}
                                        onClick={() =>
                                          handleSubmit(suggestion.message)
                                        }
                                        size="sm"
                                        className="min-h-[36px] rounded-xl px-4 py-2 text-sm font-medium text-slate-800 hover:border-brand/30 hover:bg-warm-muted dark:text-slate-100 focus-visible:ring-offset-warm-page"
                                      >
                                        {suggestion.label}
                                      </Button>
                                    ))}
                                  </motion.div>
                                )}
                              </>
                            ),
                          }}
                        />
                      )}

                      {chatMode === "cloud" && (
                        <div
                          ref={scrollContainerRef}
                          className="relative flex-1 min-h-0 overflow-y-auto"
                        >
                          <div
                            className="chat-turn-frame mx-auto flex min-h-full w-full max-w-3xl min-w-0 flex-col gap-3 py-6"
                            data-chat-column="turns"
                          >
                            {messages.map((msg: any) => (
                              <MessageRow
                                key={msg.id}
                                msg={msg}
                                mentionableNodes={mentionableNodes}
                              />
                            ))}
                            {showCloudActivityRow && (
                              <AgentActivityRow
                                label={activityStatusLabel}
                                state={agentMotionState}
                                gazeTarget={null}
                              />
                            )}

                            {/* Suggestion chips (e.g. "Continue" after step limit) */}
                            {suggestions.length > 0 && !isProcessing && (
                              <motion.div
                                role="group"
                                aria-label="Suggestions"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="flex flex-wrap gap-2 px-1"
                              >
                                {suggestions.map((s, i) => (
                                  <Button
                                    key={i}
                                    onClick={() => handleSubmit(s.message)}
                                    size="sm"
                                    className="min-h-[36px] rounded-xl px-4 py-2 text-sm font-medium text-slate-800 hover:border-brand/30 hover:bg-warm-muted dark:text-slate-100 focus-visible:ring-offset-warm-page"
                                  >
                                    {s.label}
                                  </Button>
                                ))}
                              </motion.div>
                            )}

                            <div ref={messagesEndRef} />
                          </div>
                        </div>
                      )}

                      {/* Todo List Overlay */}
                      <AnimatePresence>
                        {todoItems.length > 0 && <TodoList items={todoItems} />}
                      </AnimatePresence>

                      {chatMode === "cloud" && !desktopRuntimeUnavailable && (
                        <div
                          className="clash-copilot-composer-stack chat-composer-frame mx-auto w-full max-w-3xl min-w-0 space-y-2"
                          data-chat-column="composer"
                        >
                          {showRuntimeComposerCompanion && (
                            <motion.div
                              className="clash-copilot-agent-activity-empty-anchor clash-copilot-agent-activity-composer-companion relative -left-3 top-2 z-20 mx-auto w-full max-w-[68rem] px-4 pb-1 sm:px-6"
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: 6 }}
                              transition={{
                                duration: 0.22,
                                ease: [0.16, 1, 0.3, 1],
                              }}
                            >
                              <AgentActivitySlot
                                label={
                                  showRuntimeActivityRow
                                    ? activityStatusLabel
                                    : null
                                }
                                state={
                                  showRuntimeActivityRow
                                    ? agentMotionState
                                    : "idle"
                                }
                                gazeTarget={null}
                                emptyLabel={t("copilot.status.readyWhenYouAre")}
                              />
                            </motion.div>
                          )}
                          {clashRt.permissionRequests.length === 0 &&
                            slashCommandQuery !== null && (
                              <SlashCommandPalette
                                commands={slashCommandOptions}
                                onPick={handlePickSlashCommand}
                                emptyLabel={t(
                                  slashCommandCandidates.length > 0
                                    ? "copilot.slash.noMatches"
                                    : "copilot.slash.noCommands",
                                )}
                              />
                            )}
                          <div className="relative z-20">
                            <div className="relative z-10">
                              {clashRt.elicitationRequests[0] ? (
                                <AcpElicitationComposer
                                  key={clashRt.elicitationRequests[0].requestId}
                                  request={clashRt.elicitationRequests[0]}
                                  onRespond={clashRt.respondElicitation}
                                />
                              ) : clashRt.permissionRequests[0] ? (
                                <AcpPermissionComposer
                                  request={clashRt.permissionRequests[0]}
                                  onRespond={clashRt.respondPermission}
                                />
                              ) : (
                                <ChatInput
                                  input={input}
                                  onInputChange={setInput}
                                  onSubmit={handleSubmit}
                                  onStop={handleStop}
                                  isProcessing={isProcessing}
                                  isCreatingSession={
                                    isCreatingSession || waitingFirstSend
                                  }
                                  connected={connected}
                                  error={sessionError || connectionError}
                                  onDismissError={() => {
                                    setSessionError(null);
                                    clearConnectionError();
                                  }}
                                  mentionableNodes={mentionableNodes}
                                  projectId={projectId}
                                  annotationBlocks={annotationBlocks}
                                  onAnnotationRemove={onAnnotationRemove}
                                  toolbarAccessory={
                                    <div className="clash-composer-session-controls flex min-w-0 items-center gap-1">
                                      {onFollowingAgentChange ? (
                                        <Tooltip
                                          label={t(
                                            followingAgent
                                              ? "copilot.follow.stop"
                                              : "copilot.follow.start",
                                          )}
                                        >
                                          <IconButton
                                            label={t(
                                              followingAgent
                                                ? "copilot.follow.stop"
                                                : "copilot.follow.start",
                                            )}
                                            aria-pressed={followingAgent}
                                            variant={
                                              followingAgent
                                                ? "active"
                                                : "default"
                                            }
                                            size="sm"
                                            shape="rounded"
                                            onClick={() =>
                                              onFollowingAgentChange(
                                                !followingAgent,
                                              )
                                            }
                                            icon={
                                              <Crosshair
                                                className="h-4 w-4"
                                                weight={
                                                  followingAgent
                                                    ? "bold"
                                                    : "regular"
                                                }
                                              />
                                            }
                                          />
                                        </Tooltip>
                                      ) : null}
                                      <HarnessPermissionSelector
                                        agentId={effectiveSessionHarnessId}
                                        selectedPermissionModeId={
                                          sessionPermissionModeId
                                        }
                                        sessionModes={effectiveSessionModes}
                                        modeConfigOption={modeConfigOption}
                                        onSelectPermissionMode={
                                          handleSelectSessionPermissionMode
                                        }
                                      />
                                      <SessionPlanTag
                                        configOptions={
                                          effectiveSessionConfigOptions
                                        }
                                        onSelectConfigOption={
                                          handleSelectSessionConfigOption
                                        }
                                      />
                                      {clashRt.goal ? (
                                        <SessionGoalTag
                                          onClear={() =>
                                            clashRt.sendMessage("/goal clear")
                                          }
                                        />
                                      ) : null}
                                      <InlineSessionConfigControls
                                        configOptions={
                                          effectiveSessionConfigOptions
                                        }
                                        onSelectConfigOption={
                                          handleSelectSessionConfigOption
                                        }
                                      />
                                    </div>
                                  }
                                  rightToolbarAccessory={
                                    <SessionConfigSelector
                                      open={sessionConfigOpen}
                                      onOpenChange={
                                        handleSessionConfigOpenChange
                                      }
                                      embedded
                                      selectedHarnessId={
                                        effectiveSessionHarnessId
                                      }
                                      statusLabel={null}
                                      harnessOptions={sessionHarnessOptions}
                                      harnessLocked={sessionHarnessLocked}
                                      configOptions={
                                        effectiveSessionConfigOptions
                                      }
                                      modelConfigOption={modelConfigOption}
                                      onSelectHarness={
                                        handleSelectSessionHarness
                                      }
                                      onSelectConfigOption={
                                        handleSelectSessionConfigOption
                                      }
                                    />
                                  }
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      {(desktopRuntimeNeedsSetup ||
                        desktopRuntimeStartupFailed) && (
                        <div className="absolute bottom-0 left-0 right-0 z-20 px-4 pb-4 sm:px-6">
                          <div className="mx-auto flex w-full max-w-[68rem] items-center gap-3 rounded-2xl border border-warm-border bg-warm-surface/95 p-4 shadow-lg backdrop-blur">
                            <ShieldWarning
                              className="h-5 w-5 shrink-0 text-stone-600 dark:text-stone-300"
                              weight="duotone"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                {t("copilot.status.agentHarnessRequiredTitle")}
                              </div>
                              <div className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
                                {desktopRuntimeStartupFailed
                                  ? (clashRt.errorMessage ??
                                    t(
                                      "copilot.status.desktopLocalSetupRequired",
                                    ))
                                  : t("copilot.status.agentHarnessRequired")}
                              </div>
                            </div>
                            <a
                              href="/settings?section=agents"
                              className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg bg-brand px-3 text-sm font-semibold text-white transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-warm-surface"
                            >
                              {t("copilot.actions.openAgents")}
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.aside>
          </SheetContent>
        </Sheet>

        <RuntimePickerDialog
          open={!!runtimePicker}
          runtime={runtimePicker}
          loadResumeOptions={clashRt.loadResumeOptions}
          onPick={async (agentMemberId, resumeId, agentId) => {
            const rt = runtimePicker;
            setRuntimePicker(null);
            if (!rt) return;
            setChatMode("runtime");
            const pickedAgentId =
              agentId ??
              preferredRecentAgentId(rt.agents, rt.preferences?.agent_id);
            const pickedAgent = pickedAgentId
              ? rt.agents.find((agent) => agent.id === pickedAgentId)
              : null;
            if (pickedAgent?.auth?.status === "needs-auth") {
              setSessionHarnessId(pickedAgent.id);
              setSessionError(null);
              await clashRt.refresh({ probe: "config", refresh: true });
              return;
            }
            const pickedModeConfigOption = findAcpSelectConfigOption(
              pickedAgent?.config_options ?? [],
              "mode",
            );
            const pickedPermissionModeId = pickedAgentId
              ? resolvePermissionModeForSession(
                  sessionPermissionModeByAgentId[pickedAgentId],
                  pickedAgent?.session_modes ?? null,
                  pickedModeConfigOption,
                )
              : null;
            await clashRt.select(rt.id, agentMemberId ?? undefined, {
              projectId,
              resumeAcpSessionId: resumeId,
              agentId,
              ...permissionModeOption(pickedPermissionModeId),
            });
          }}
          onRecheckAgents={() => {
            void clashRt.refresh({ probe: "config", refresh: true });
          }}
          onClose={() => setRuntimePicker(null)}
          busy={clashRt.status === "connecting"}
        />
      </Collapsible>
    </MotionConfig>
  );
}

function elicitationOptions(
  property: RuntimeElicitationProperty,
): Array<{ value: string; label: string }> {
  if (property.oneOf?.length)
    return property.oneOf.map((option) => ({
      value: option.const,
      label: option.title,
    }));
  if (property.enum?.length)
    return property.enum.map((value) => ({ value, label: value }));
  if (property.items?.anyOf?.length)
    return property.items.anyOf.map((option) => ({
      value: option.const,
      label: option.title,
    }));
  if (property.items?.enum?.length)
    return property.items.enum.map((value) => ({ value, label: value }));
  if (property.type === "boolean")
    return [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
  return [];
}

function initialElicitationValue(
  property: RuntimeElicitationProperty,
): RuntimeElicitationValue | undefined {
  if (property.default !== undefined) return property.default;
  if (property.type === "array") return [];
  return undefined;
}

function validElicitationStep(
  property: RuntimeElicitationProperty,
  value: RuntimeElicitationValue | undefined,
  required: boolean,
): boolean {
  if (value === undefined || value === "") return !required;
  if (property.type === "array") {
    if (!Array.isArray(value)) return false;
    return (
      value.length >= (property.minItems ?? (required ? 1 : 0)) &&
      value.length <= (property.maxItems ?? Number.POSITIVE_INFINITY)
    );
  }
  if (property.type === "string") {
    if (typeof value !== "string") return false;
    return (
      value.length >= (property.minLength ?? (required ? 1 : 0)) &&
      value.length <= (property.maxLength ?? Number.POSITIVE_INFINITY)
    );
  }
  if (property.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (property.type === "integer" && !Number.isInteger(value)) return false;
  return (
    value >= (property.minimum ?? Number.NEGATIVE_INFINITY) &&
    value <= (property.maximum ?? Number.POSITIVE_INFINITY)
  );
}

function AcpElicitationComposer({
  request,
  onRespond,
}: {
  request: RuntimeElicitationRequest;
  onRespond: (requestId: string, response: RuntimeElicitationResponse) => void;
}) {
  return request.mode === "url" ? (
    <AcpUrlElicitationComposer request={request} onRespond={onRespond} />
  ) : (
    <AcpFormElicitationComposer request={request} onRespond={onRespond} />
  );
}

function AcpUrlElicitationComposer({
  request,
  onRespond,
}: {
  request: Extract<RuntimeElicitationRequest, { mode: "url" }>;
  onRespond: (requestId: string, response: RuntimeElicitationResponse) => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = useMemo(() => {
    try {
      return new URL(request.url).host;
    } catch {
      return "sign-in page";
    }
  }, [request.url]);
  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      const desktopOpen = globalThis.__CLASH_DESKTOP__?.openExternal;
      if (desktopOpen) await desktopOpen(request.url);
      else window.open(request.url, "_blank", "noopener,noreferrer");
      onRespond(request.requestId, { action: "accept" });
    } catch (cause) {
      setError(displayErrorMessage(cause));
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="px-4 pb-4">
      <div
        role="group"
        aria-label="Confirmation required"
        className="clash-chat-input-surface flex min-h-[150px] flex-col gap-4 px-5 py-4"
      >
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-content-tertiary">
            Sign in required
          </div>
          <div className="mt-1 text-sm font-semibold text-content-primary">
            {request.message}
          </div>
          <div className="mt-1 break-all text-xs text-content-secondary">
            {request.url}
          </div>
          {error ? (
            <InlineAlert tone="error" title={error} className="mt-2" />
          ) : null}
        </div>
        <div className="mt-auto flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            disabled={opening}
            onClick={() => onRespond(request.requestId, { action: "decline" })}
          >
            Decline
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={opening}
            onClick={() => void open()}
          >
            {opening ? "Opening…" : `Open ${host}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AcpFormElicitationComposer({
  request,
  onRespond,
}: {
  request: Extract<RuntimeElicitationRequest, { mode: "form" }>;
  onRespond: (requestId: string, response: RuntimeElicitationResponse) => void;
}) {
  const fields = useMemo(
    () => Object.entries(request.schema.properties),
    [request.schema.properties],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, RuntimeElicitationValue>>(
    () =>
      Object.fromEntries(
        fields.flatMap(([name, property]) => {
          const value = initialElicitationValue(property);
          return value === undefined ? [] : [[name, value]];
        }),
      ),
  );
  const [error, setError] = useState<string | null>(null);
  const [name, property] = fields[Math.min(stepIndex, fields.length - 1)]!;
  const required = request.schema.required.includes(name);
  const value = values[name];
  const options = elicitationOptions(property);
  const isLast = stepIndex === fields.length - 1;
  const update = (next: RuntimeElicitationValue) => {
    setValues((current) => ({ ...current, [name]: next }));
    setError(null);
  };
  const advance = () => {
    if (!validElicitationStep(property, values[name], required)) {
      setError(
        required ? "Complete this field to continue." : "Enter a valid value.",
      );
      return;
    }
    if (!isLast) {
      setStepIndex((current) => current + 1);
      setError(null);
      return;
    }
    onRespond(request.requestId, { action: "accept", content: values });
  };

  return (
    <div className="px-4 pb-4">
      <div
        role="group"
        aria-label="Input required"
        data-testid="acp-elicitation-card"
        className="clash-chat-input-surface flex min-h-[190px] flex-col gap-4 px-5 py-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-content-tertiary">
              Question {stepIndex + 1} of {fields.length}
            </div>
            <div className="mt-1 text-base font-semibold leading-6 text-content-primary">
              {property.title ?? name}
            </div>
            {(property.description ??
            (stepIndex === 0 ? request.message : null)) ? (
              <div className="mt-1 text-sm text-content-secondary">
                {property.description ?? request.message}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => onRespond(request.requestId, { action: "decline" })}
          >
            Dismiss
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {(property.type === "string" && options.length > 0) ||
          property.type === "boolean" ? (
            <RadioGroup
              aria-label={property.title ?? name}
              value={
                typeof value === "boolean"
                  ? String(value)
                  : typeof value === "string"
                    ? value
                    : undefined
              }
              onValueChange={(next) =>
                update(property.type === "boolean" ? next === "true" : next)
              }
            >
              {options.map((option) => (
                <RadioGroupItem key={option.value} value={option.value}>
                  <span className="text-sm font-medium text-content-primary">
                    {option.label}
                  </span>
                </RadioGroupItem>
              ))}
            </RadioGroup>
          ) : property.type === "array" ? (
            <ToggleGroup
              type="multiple"
              aria-label={property.title ?? name}
              value={Array.isArray(value) ? value : []}
              onValueChange={(next) => update(next)}
              className="grid grid-cols-1 gap-1.5"
            >
              {options.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="rounded-lg border border-warm-border px-3 py-2 text-left text-sm data-[state=on]:border-brand data-[state=on]:bg-brand/10"
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <Input
              aria-label={property.title ?? name}
              type={
                property.type === "number" || property.type === "integer"
                  ? "number"
                  : "text"
              }
              step={
                property.type === "integer"
                  ? 1
                  : property.type === "number"
                    ? "any"
                    : undefined
              }
              min={property.minimum}
              max={property.maximum}
              minLength={property.minLength}
              maxLength={property.maxLength}
              value={
                typeof value === "string" || typeof value === "number"
                  ? value
                  : ""
              }
              onChange={(event) =>
                update(
                  property.type === "number" || property.type === "integer"
                    ? event.target.value === ""
                      ? ""
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
              className="h-10 w-full rounded-lg border border-warm-border bg-transparent px-3 text-sm text-content-primary"
            />
          )}
          {error ? (
            <InlineAlert tone="error" title={error} className="mt-2" />
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            disabled={stepIndex === 0}
            onClick={() => {
              setStepIndex((current) => Math.max(0, current - 1));
              setError(null);
            }}
          >
            Back
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={advance}>
            {isLast ? "Submit" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AcpPermissionComposer({
  request,
  onRespond,
}: {
  request: ReturnType<typeof useClashRuntime>["permissionRequests"][number];
  onRespond: (requestId: string, optionId: string | null) => void;
}) {
  const toolTitle =
    typeof request.toolCall.title === "string"
      ? request.toolCall.title
      : "The agent wants to run a tool";
  const allowOptions = request.options.filter(
    (option) => !option.kind.startsWith("reject"),
  );
  const rejectOptions = request.options.filter((option) =>
    option.kind.startsWith("reject"),
  );
  const primaryAllow = allowOptions[0] ?? null;
  const secondaryAllows = allowOptions.slice(1);
  const primaryReject = rejectOptions[0] ?? null;

  const respond = (optionId: string) => onRespond(request.requestId, optionId);
  return (
    <div className="px-4 pb-4">
      <div
        role="group"
        aria-label="Approval required"
        data-testid="acp-permission-card"
        className="clash-chat-input-surface flex min-h-[152px] flex-col justify-between gap-5 px-5 py-4"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-content-secondary">
            <ShieldWarning
              className="h-4 w-4 shrink-0"
              weight="regular"
              aria-hidden="true"
            />
            <span>Permissions</span>
          </div>
          <div
            className="mt-3 text-base font-semibold leading-6 text-content-primary"
            title={toolTitle}
          >
            {toolTitle}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {primaryReject ? (
            <Button
              type="button"
              onClick={() => respond(primaryReject.optionId)}
              size="sm"
              className="min-w-[5.5rem]"
            >
              {primaryReject.name}
            </Button>
          ) : null}
          {primaryAllow ? (
            <div className="flex items-stretch">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => respond(primaryAllow.optionId)}
                className={
                  secondaryAllows.length > 0
                    ? "min-w-[7rem] rounded-r-none pr-3"
                    : "min-w-[7rem]"
                }
              >
                {primaryAllow.name}
              </Button>
              {secondaryAllows.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      aria-label="More approval options"
                      className="min-w-9 rounded-l-none border-l border-white/20 px-2"
                    >
                      <CaretDown
                        className="h-3.5 w-3.5"
                        weight="bold"
                        aria-hidden="true"
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="end" className="w-64">
                    {secondaryAllows.map((option) => (
                      <DropdownMenuItem
                        key={option.optionId}
                        onSelect={() => respond(option.optionId)}
                      >
                        {option.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
          {!primaryAllow &&
            request.options.map((option) => (
              <Button
                key={option.optionId}
                type="button"
                onClick={() => respond(option.optionId)}
                size="sm"
              >
                {option.name}
              </Button>
            ))}
        </div>
      </div>
    </div>
  );
}

function normalizeSlashCommandName(command: AvailableCommand): string {
  return command.name.replace(/^\/+/, "").trim();
}

function matchesSlashCommand(
  command: AvailableCommand,
  query: string,
): boolean {
  if (!query) return true;
  const name = normalizeSlashCommandName(command).toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (name.startsWith(normalizedQuery) || name.includes(normalizedQuery))
    return true;
  let cursor = 0;
  for (const character of normalizedQuery) {
    cursor = name.indexOf(character, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

function isSkillSlashCommand(command: AvailableCommand): boolean {
  if (/^(?:\$|skill[:/])/i.test(normalizeSlashCommandName(command)))
    return true;
  const metadata = command.metadata ?? {};
  const markers = [
    command.kind,
    command.type,
    command.category,
    command.source,
    metadata.kind,
    metadata.type,
    metadata.category,
    metadata.source,
  ];
  if (
    markers.some(
      (value) =>
        typeof value === "string" &&
        (value.toLowerCase() === "skill" || value.toLowerCase() === "skills"),
    )
  ) {
    return true;
  }
  return /^\[?skill[:\]\s-]/i.test(command.description?.trim() ?? "");
}

function SlashCommandPalette({
  commands,
  onPick,
  emptyLabel,
}: {
  commands: AvailableCommand[];
  onPick: (command: AvailableCommand) => void;
  emptyLabel: string;
}) {
  const sections = [
    {
      id: "commands",
      label: "Commands",
      commands: commands.filter((command) => !isSkillSlashCommand(command)),
    },
    {
      id: "skills",
      label: "Skills",
      commands: commands.filter(isSkillSlashCommand),
    },
  ].filter((section) => section.commands.length > 0);
  const commandStore = useComboboxStore({
    value: "",
    setValue: () => undefined,
    setSelectedValue: (selectedValue) => {
      const command = commands.find(
        (candidate) => candidate.name === selectedValue,
      );
      if (command) onPick(command);
    },
    focusLoop: true,
    focusWrap: true,
    orientation: "vertical",
  });

  return (
    <ComboboxProvider store={commandStore}>
      <ComboboxList
        aria-label="Slash commands"
        alwaysVisible
        className="relative z-30 mx-5 mb-2 max-h-[min(24rem,48vh)] overflow-y-auto rounded-[22px] border border-warm-border bg-warm-surface p-2 shadow-[0_24px_70px_rgba(35,29,20,0.16)]"
      >
        {commands.length === 0 ? (
          <div
            role="status"
            className="px-3 py-2 text-sm text-stone-500 dark:text-stone-400"
          >
            {emptyLabel}
          </div>
        ) : null}
        {sections.map((section) => (
          <section key={section.id} aria-label={section.label}>
            <div className="sticky top-0 z-10 bg-warm-surface/95 px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-stone-500 backdrop-blur dark:text-stone-400">
              {section.label}
            </div>
            {section.commands.map((command) => {
              const name = normalizeSlashCommandName(command);
              const description = command.description ?? command.input?.hint;
              return (
                <Tooltip key={command.name} label={description ?? `/${name}`}>
                  <ComboboxItem
                    value={command.name}
                    focusOnHover
                    setValueOnClick={false}
                    onMouseDown={(event) => event.preventDefault()}
                    aria-label={
                      description ? `/${name} ${description}` : `/${name}`
                    }
                    className="group flex min-h-14 w-full cursor-default items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-warm-muted/80 data-[active-item]:bg-warm-muted focus-visible:bg-warm-muted"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-warm-border bg-warm-page text-stone-600 group-data-[active-item]:border-brand/20 group-data-[active-item]:text-brand dark:text-stone-300">
                      {section.id === "commands" ? (
                        <SlidersHorizontal
                          className="h-4 w-4"
                          weight="bold"
                          aria-hidden="true"
                        />
                      ) : (
                        <BookOpen
                          className="h-4 w-4"
                          weight="bold"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                        /{name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">
                        {description ?? "Agent command"}
                      </span>
                    </span>
                  </ComboboxItem>
                </Tooltip>
              );
            })}
          </section>
        ))}
      </ComboboxList>
    </ComboboxProvider>
  );
}

function RuntimeAuthNotice({
  title,
  message,
  command,
  methods,
  busy,
  onAuthenticate,
  onRecheck,
}: {
  title: string;
  message: string;
  command?: string;
  methods?: RuntimeAgentAuthMethod[];
  busy: boolean;
  onAuthenticate: (options?: {
    methodId?: string;
    values?: Record<string, string>;
  }) => void;
  onRecheck: () => void;
}) {
  const [selectedMethodId, setSelectedMethodId] = useState(
    methods?.[0]?.id ?? "",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const selectedMethod =
    methods?.find((method) => method.id === selectedMethodId) ?? methods?.[0];
  const fields =
    selectedMethod?.form === "fields" ? (selectedMethod.vars ?? []) : [];
  const formReady = fields
    .filter((field) => field.optional !== true)
    .every((field) => (values[field.name] ?? "").trim().length > 0);
  const submitAuthentication = (event: React.FormEvent) => {
    event.preventDefault();
    if (fields.length > 0 && !formReady) return;
    onAuthenticate({
      ...(selectedMethod?.id ? { methodId: selectedMethod.id } : {}),
      ...(fields.length > 0
        ? {
            values: Object.fromEntries(
              fields.map((field) => [field.name, values[field.name] ?? ""]),
            ),
          }
        : {}),
    });
  };
  return (
    <FeedbackSurface
      tone="warning"
      density="panel"
      role="alert"
      aria-live="assertive"
      className="mx-auto flex w-full max-w-[68rem] items-start gap-3 p-3.5 text-sm"
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700 dark:bg-amber-300/10 dark:text-amber-200">
        <ShieldWarning className="h-4 w-4" weight="bold" />
      </span>
      <form className="min-w-0 flex-1" onSubmit={submitAuthentication}>
        <span className="block font-semibold leading-5">{title}</span>
        {message ? (
          <span className="mt-0.5 block leading-5 text-amber-900/80 dark:text-amber-100/80">
            {message}
          </span>
        ) : null}
        {methods && methods.length > 1 ? (
          <RadioGroup
            className="mt-2 flex flex-wrap gap-2"
            value={selectedMethod?.id}
            onValueChange={(methodId) => {
              setSelectedMethodId(methodId);
              setValues({});
            }}
            aria-label="Authentication method"
          >
            {methods.map((method) => (
              <RadioGroupItem
                key={method.id}
                value={method.id}
                className="text-xs font-medium"
              >
                {method.name ?? method.id}
              </RadioGroupItem>
            ))}
          </RadioGroup>
        ) : null}
        {fields.length > 0 ? (
          <span className="mt-2 grid gap-2">
            {fields.map((field) => (
              <label
                key={field.name}
                className="grid gap-1 text-xs font-medium"
              >
                <span>
                  {field.label ?? field.name}
                  {field.optional ? " (optional)" : ""}
                </span>
                <Input
                  type={field.secret === true ? "password" : "text"}
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  autoComplete="off"
                  disabled={busy}
                  className="h-8 border-amber-300/70 bg-white/75 text-sm text-slate-950 dark:border-amber-300/25 dark:bg-black/15 dark:text-white"
                />
              </label>
            ))}
          </span>
        ) : null}
        {command ? (
          <Collapsible className="mt-1.5 text-xs text-amber-800/75 dark:text-amber-100/70">
            <CollapsibleTrigger asChild>
              <Button
                size="sm"
                shape="rounded"
                className="min-h-0 cursor-pointer rounded-none border-transparent bg-transparent px-0 py-0 text-xs font-medium text-amber-800/75 shadow-none hover:bg-transparent hover:text-amber-950 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:underline focus-visible:underline-offset-4 dark:text-amber-100/70 dark:hover:text-amber-100"
              >
                Manual fallback
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <span className="mt-1 block leading-5">
                If Sign in does not open, run{" "}
                <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-300/10">
                  {command}
                </code>{" "}
                and use{" "}
                <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-300/10">
                  /auth
                </code>
                .
              </span>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <span className="mt-2 flex items-center justify-end gap-1.5">
          <Button
            type="button"
            onClick={onRecheck}
            disabled={busy}
            size="sm"
            className="rounded-lg border-amber-300/70 bg-transparent px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-none hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60 dark:border-amber-300/30 dark:text-amber-100"
          >
            Check again
          </Button>
          <Button
            type="submit"
            disabled={busy || (fields.length > 0 && !formReady)}
            size="sm"
            className="rounded-lg border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-none hover:bg-amber-500/15 disabled:cursor-wait disabled:opacity-60 dark:text-amber-100"
          >
            {busy ? "Opening..." : fields.length > 0 ? "Continue" : "Sign in"}
          </Button>
        </span>
      </form>
    </FeedbackSurface>
  );
}

export function SessionConfigSelector({
  open,
  onOpenChange,
  embedded = false,
  selectedHarnessId,
  statusLabel,
  harnessOptions,
  harnessLocked,
  configOptions,
  modelConfigOption,
  onSelectHarness,
  onSelectConfigOption,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  embedded?: boolean;
  selectedHarnessId: string | null;
  statusLabel?: string | null;
  harnessOptions: Runtime["agents"];
  harnessLocked?: boolean;
  configOptions: AcpSessionConfigOption[];
  modelConfigOption: AcpSessionConfigOption | null;
  onSelectHarness: (agentId: string) => void;
  onSelectConfigOption: (configId: string, value: string | boolean) => void;
}) {
  const { t } = useTranslation();
  const selectedHarnessName = agentDisplayName(selectedHarnessId);
  const selectedModel = useMemo(
    () => selectedAcpSelectValue(modelConfigOption),
    [modelConfigOption],
  );
  const modelLabel = selectedModel?.name ?? agentDisplayName(selectedHarnessId);
  const configurableOptions = useMemo(
    () => buildRunMenuConfigOptions(configOptions),
    [configOptions],
  );
  const effortConfigOption = useMemo(
    () =>
      configurableOptions.find(
        (option) =>
          option.type === "select" && option.category === "thought_level",
      ) ?? null,
    [configurableOptions],
  );
  const selectedEffort = useMemo(
    () => selectedAcpSelectValue(effortConfigOption),
    [effortConfigOption],
  );
  const fastModeEnabled = configurableOptions.some(
    (option) =>
      isFastSessionConfigOption(option) && sessionConfigOptionEnabled(option),
  );
  const triggerLabel = [
    selectedModel
      ? `${selectedHarnessName} · ${modelLabel}`
      : selectedHarnessName,
    selectedEffort?.name,
    fastModeEnabled ? "Fast mode" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasConfigSwitch = configurableOptions.some(
    (option) =>
      option.type === "boolean" ||
      (option.type === "select" && flattenAcpSelectValues(option).length > 0),
  );
  const selectorDisabled = !!harnessLocked && !hasConfigSwitch;
  const hasStatusLabel = !!statusLabel;
  const menuLabel = t("copilot.sessionConfig.label");
  const comboHarnesses =
    harnessOptions.length > 0
      ? harnessOptions
      : selectedHarnessId
        ? [{ id: selectedHarnessId }]
        : [];
  const modelSections = useMemo<SelectSection<string>[]>(() => {
    const sections: SelectSection<string>[] = [];
    if (!harnessLocked && comboHarnesses.length > 0) {
      sections.push({
        id: "harness",
        label: (
          <span className="text-[11px] font-semibold uppercase tracking-[0.11em]">
            Harness
          </span>
        ),
        options: comboHarnesses.map((agent) => ({
          value: JSON.stringify({ type: "harness", agentId: agent.id }),
          label: agent.label ?? agentDisplayName(agent.id),
          description:
            agent.auth?.status === "needs-auth" ? "Auth needed" : undefined,
          icon: (
            <AcpAgentLogo
              agentId={agent.id}
              title={agent.label ?? agentDisplayName(agent.id)}
              className="h-4 w-4"
            />
          ),
          selected: agent.id === selectedHarnessId,
        })),
      });
    }
    const configRows = configurableOptions.flatMap((option) => {
      const label =
        option.category === "model"
          ? "Model"
          : option.category === "thought_level"
            ? "Effort"
            : isFastSessionConfigOption(option)
              ? "Fast mode"
              : option.name;
      if (
        option.type === "boolean" &&
        typeof option.currentValue === "boolean"
      ) {
        return [
          {
            value: JSON.stringify({ type: "noop", configId: option.id }),
            label,
            description: option.currentValue ? "On" : "Off",
            hasSubmenu: true,
            submenuLabel: label,
            submenuSections: [
              {
                id: `acp-config-${option.id}-values`,
                options: [
                  {
                    value: JSON.stringify({
                      type: "config",
                      configId: option.id,
                      value: !option.currentValue,
                    }),
                    label: option.name,
                    description:
                      option.description ??
                      (option.currentValue ? "On" : "Off"),
                    selected: option.currentValue,
                  },
                ],
              },
            ],
          },
        ];
      }
      const values = flattenAcpSelectValues(option);
      const selected = values.find(
        (value) => value.value === option.currentValue,
      );
      if (values.length === 0) return [];
      return [
        {
          value: JSON.stringify({ type: "noop", configId: option.id }),
          label,
          description: selected?.name ?? String(option.currentValue),
          hasSubmenu: true,
          submenuLabel: label,
          submenuSections: [
            {
              id: `acp-config-${option.id}-values`,
              options: values.map((value) => ({
                value: JSON.stringify({
                  type: "config",
                  configId: option.id,
                  value: value.value,
                }),
                label: value.name,
                description:
                  value.groupName ??
                  value.description ??
                  option.description ??
                  undefined,
                selected: value.value === option.currentValue,
              })),
            },
          ],
        },
      ];
    });
    if (configRows.length > 0) {
      sections.push({
        id: "acp-run-config",
        options: configRows,
      });
    }
    return sections;
  }, [comboHarnesses, configurableOptions, harnessLocked, selectedHarnessId]);

  return (
    <SelectMenu
      className={
        embedded
          ? "relative flex justify-start"
          : "relative flex justify-start px-4 pb-2"
      }
      triggerClassName="clash-session-config-trigger max-w-full text-left"
      triggerTestId="session-harness-config-trigger"
      open={open}
      onOpenChange={onOpenChange}
      value={
        modelConfigOption && selectedModel
          ? JSON.stringify({
              type: "config",
              configId: modelConfigOption.id,
              value: selectedModel.value,
            })
          : JSON.stringify({
              type: "harness",
              agentId: selectedHarnessId ?? "",
            })
      }
      sections={modelSections}
      disabled={selectorDisabled}
      onValueChange={(value) => {
        try {
          const parsed = JSON.parse(value) as {
            type?: string;
            configId?: string;
            value?: string | boolean;
            agentId?: string;
          };
          if (
            parsed.type === "config" &&
            parsed.configId &&
            (typeof parsed.value === "string" ||
              typeof parsed.value === "boolean")
          ) {
            onSelectConfigOption(parsed.configId, parsed.value);
          } else if (parsed.type === "harness" && parsed.agentId) {
            onSelectHarness(parsed.agentId);
          }
        } catch {
          /* ignore malformed menu value */
        }
      }}
      ariaLabel={menuLabel}
      title={triggerLabel}
      variant="inline"
      placement="top"
      menuWidth={280}
      maxMenuHeight={420}
      submenuWidth={220}
      stopPropagation
      triggerPrefix={
        <>
          <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-slate-700 dark:text-slate-200">
            <AcpAgentLogo
              agentId={selectedHarnessId}
              title={agentDisplayName(selectedHarnessId)}
              className="h-[18px] w-[18px]"
            />
          </span>
          <span
            data-session-config-status-slot=""
            aria-live="polite"
            className={`clash-session-config-status-slot truncate text-[11px] font-medium text-stone-500 transition-[max-width,opacity] duration-150 dark:text-stone-400 ${
              hasStatusLabel
                ? "max-w-[4.25rem] opacity-100"
                : "max-w-0 opacity-0"
            }`}
          >
            {statusLabel ?? ""}
          </span>
        </>
      }
      triggerLabel={
        <span className="clash-session-config-summary inline-flex min-w-0 items-center gap-1.5">
          {fastModeEnabled ? (
            <Lightning
              data-session-fast-mode-indicator=""
              aria-label="Fast mode on"
              className="h-3.5 w-3.5 shrink-0 text-content-primary"
              weight="fill"
            />
          ) : null}
          <span className="shrink-0">{modelLabel}</span>
          {selectedEffort ? (
            <span className="clash-session-config-effort truncate font-normal text-stone-500 dark:text-stone-400">
              {selectedEffort.name}
            </span>
          ) : null}
        </span>
      }
    />
  );
}

export function HarnessPermissionSelector({
  agentId,
  selectedPermissionModeId,
  sessionModes,
  modeConfigOption,
  onSelectPermissionMode,
}: {
  agentId: string | null;
  selectedPermissionModeId: string | null;
  sessionModes: AcpSessionModeState | null;
  modeConfigOption: AcpSessionConfigOption | null;
  onSelectPermissionMode: (modeId: string) => void;
}) {
  const modeValues = useMemo(
    () => flattenAcpSelectValues(modeConfigOption),
    [modeConfigOption],
  );
  const sessionModeValues = useMemo(
    () =>
      sessionModes?.availableModes.filter(
        (mode) => typeof mode.id === "string" && typeof mode.name === "string",
      ) ?? [],
    [sessionModes],
  );
  const selectedSessionMode = useMemo(
    () =>
      sessionModeValues.find((mode) => mode.id === selectedPermissionModeId) ??
      sessionModeValues.find(
        (mode) => mode.id === sessionModes?.currentModeId,
      ) ??
      sessionModeValues[0] ??
      null,
    [selectedPermissionModeId, sessionModeValues, sessionModes?.currentModeId],
  );
  const selectedAcpMode = useMemo(
    () =>
      modeValues.find((mode) => mode.value === selectedPermissionModeId) ??
      selectedAcpSelectValue(modeConfigOption),
    [modeConfigOption, modeValues, selectedPermissionModeId],
  );
  const selectedMode = useMemo(() => {
    if (selectedAcpMode) {
      const presentation = configModeOptionPresentation(selectedAcpMode);
      return {
        value: selectedAcpMode.value,
        label: presentation.label,
        description: presentation.description,
      };
    }
    if (selectedSessionMode) {
      return {
        value: selectedSessionMode.id,
        label: selectedSessionMode.name,
        description: selectedSessionMode.description ?? undefined,
      };
    }
    return null;
  }, [agentId, selectedAcpMode, selectedSessionMode]);
  const SelectedModeIcon = selectedMode
    ? permissionModeIcon(selectedMode.value)
    : ShieldCheckIcon;
  const sections = useMemo<SelectSection<string>[]>(
    () => [
      {
        id: "modes",
        label:
          modeValues.length > 0 ? (modeConfigOption?.name ?? "Mode") : "Mode",
        options:
          modeValues.length > 0
            ? modeValues.map((mode) => {
                const presentation = configModeOptionPresentation(mode);
                const ModeIcon = permissionModeIcon(mode.value);
                return {
                  value: mode.value,
                  label: presentation.label,
                  description: presentation.description,
                  selected: mode.value === selectedPermissionModeId,
                  icon: <ModeIcon className="h-4 w-4" aria-hidden="true" />,
                };
              })
            : sessionModeValues.map((mode) => {
                const ModeIcon = permissionModeIcon(mode.id);
                return {
                  value: mode.id,
                  label: mode.name,
                  description: mode.description ?? undefined,
                  selected: mode.id === selectedMode?.value,
                  icon: <ModeIcon className="h-4 w-4" aria-hidden="true" />,
                };
              }),
      },
    ],
    [
      agentId,
      modeConfigOption?.name,
      modeValues,
      selectedMode,
      selectedPermissionModeId,
      sessionModeValues,
    ],
  );

  if (!selectedMode) return null;
  return (
    <SelectMenu
      className="relative flex shrink-0 justify-start"
      triggerClassName="clash-session-permission-trigger shrink-0 text-left text-status-down focus-visible:bg-warm-muted focus-visible:ring-0 focus-visible:ring-offset-0"
      triggerTestId="session-permission-mode-trigger"
      value={selectedMode.value}
      sections={sections}
      onValueChange={onSelectPermissionMode}
      ariaLabel="Harness permission mode"
      title={selectedMode.description ?? undefined}
      variant="inline"
      placement="top"
      menuWidth={220}
      maxMenuHeight={280}
      stopPropagation
      triggerPrefix={
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-status-down">
          <SelectedModeIcon className="h-4 w-4" aria-hidden="true" />
        </span>
      }
      triggerLabel={
        <span className="clash-session-permission-label truncate">
          {selectedMode.label}
        </span>
      }
    />
  );
}

function permissionModeIcon(value: string): LucideIcon {
  if (value === "read-only") return HandIcon;
  if (value === "agent") return ShieldCheckIcon;
  if (value === "agent-full-access") return ShieldAlertIcon;
  return ShieldCheckIcon;
}

export function SessionPlanTag({
  configOptions,
  onSelectConfigOption,
}: {
  configOptions: AcpSessionConfigOption[];
  onSelectConfigOption: (configId: string, value: string | boolean) => void;
}) {
  const option = findSelectConfigOption(configOptions, "collaboration_mode");
  const values = flattenAcpSelectValues(option);
  const fallback =
    values.find((value) => value.value === "default") ??
    values.find((value) => value.value !== "plan");
  if (!option || option.currentValue !== "plan" || !fallback) return null;
  return (
    <span
      data-testid="session-plan-tag"
      className="clash-session-state-tag inline-flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-md bg-warm-muted/75 pl-2 pr-1 text-xs font-semibold text-content-primary"
    >
      <Lightbulb
        className="h-4 w-4 shrink-0 text-stone-600 dark:text-stone-300"
        aria-hidden="true"
      />
      <span className="clash-session-state-tag-label">Plan</span>
      <IconButton
        label="Exit Plan mode"
        size="sm"
        shape="rounded"
        className="h-6 min-h-6 w-6 min-w-6 text-stone-500 hover:bg-warm-hover hover:text-content-primary"
        onClick={() => onSelectConfigOption(option.id, fallback.value)}
        icon={<X className="h-3.5 w-3.5" weight="bold" />}
      />
    </span>
  );
}

function SessionGoalTag({ onClear }: { onClear: () => void }) {
  return (
    <span
      data-testid="session-goal-tag"
      className="clash-session-state-tag inline-flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-md bg-warm-muted/75 pl-2 pr-1 text-xs font-semibold text-content-primary"
    >
      <Target
        className="h-4 w-4 shrink-0 text-stone-600 dark:text-stone-300"
        aria-hidden="true"
      />
      <span className="clash-session-state-tag-label">Goal</span>
      <IconButton
        label="Close Goal"
        size="sm"
        shape="rounded"
        className="h-6 min-h-6 w-6 min-w-6 text-stone-500 hover:bg-warm-hover hover:text-content-primary"
        onClick={onClear}
        icon={<X className="h-3.5 w-3.5" weight="bold" />}
      />
    </span>
  );
}

function formatGoalDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return null;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  return `${Math.max(1, Math.round(seconds / 3_600))}h`;
}

function GoalSessionBar({
  goal,
  planEntries,
  onEdit,
  onToggle,
  onClear,
}: {
  goal: RuntimeGoalState;
  planEntries: PlanEntry[];
  onEdit: () => void;
  onToggle: () => void;
  onClear: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const duration = formatGoalDuration(goal.timeUsedSeconds);
  const isActive = goal.status === "active";
  const statusLabel = goal.status.trim().toLowerCase();
  const completedPlanEntries = planEntries.filter(
    (entry) => entry.status === "completed",
  ).length;
  return (
    <div
      role="region"
      aria-label="Goal status"
      className="relative z-20 mx-4 mb-2 overflow-hidden rounded-xl border border-warm-border bg-warm-surface/95 shadow-sm backdrop-blur sm:mx-6"
    >
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <Target
          className="h-4 w-4 shrink-0 text-stone-500 dark:text-stone-300"
          weight="duotone"
          aria-hidden="true"
        />
        <span className="shrink-0 text-sm font-semibold text-content-primary">
          Goal {statusLabel}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-sm text-stone-600 dark:text-stone-300"
          title={goal.objective}
        >
          {goal.objective}
        </span>
        {duration ? (
          <span className="shrink-0 text-xs tabular-nums text-stone-500 dark:text-stone-400">
            {duration}
          </span>
        ) : null}
        {planEntries.length > 0 ? (
          <span
            aria-label="Goal plan progress"
            className="shrink-0 text-xs tabular-nums text-stone-500 dark:text-stone-400"
          >
            {completedPlanEntries}/{planEntries.length}
          </span>
        ) : null}
        <span className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label="Edit goal"
            size="sm"
            shape="rounded"
            onClick={onEdit}
            icon={<PencilSimple className="h-4 w-4" />}
          />
          <IconButton
            label={isActive ? "Pause goal" : "Resume goal"}
            size="sm"
            shape="rounded"
            onClick={onToggle}
            icon={
              isActive ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )
            }
          />
          <IconButton
            label="Clear goal"
            size="sm"
            shape="rounded"
            onClick={onClear}
            icon={<Trash className="h-4 w-4" />}
          />
          <IconButton
            label={detailsOpen ? "Hide goal details" : "Show goal details"}
            aria-expanded={detailsOpen}
            size="sm"
            shape="rounded"
            onClick={() => setDetailsOpen((open) => !open)}
            icon={
              <CaretRight
                className={`h-4 w-4 transition-transform ${detailsOpen ? "rotate-90" : ""}`}
              />
            }
          />
        </span>
      </div>
      {detailsOpen ? (
        <div className="border-t border-warm-border/80 px-3 py-2 text-xs text-stone-500 dark:text-stone-400">
          <div>
            <span>Status: {goal.status}</span>
            {goal.tokenBudget !== undefined ? (
              <span className="ml-3">
                Budget: {goal.tokenBudget.toLocaleString()} tokens
              </span>
            ) : null}
          </div>
          {planEntries.length > 0 ? (
            <ul aria-label="Goal plan" className="mt-2 space-y-1.5">
              {planEntries.map((entry, index) => (
                <li
                  key={`${entry.content}-${index}`}
                  className="flex min-w-0 items-start gap-2 text-content-secondary"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      entry.status === "completed"
                        ? "bg-status-ready"
                        : entry.status === "in_progress"
                          ? "bg-status-busy"
                          : "bg-stone-400"
                    }`}
                  />
                  <span
                    className={
                      entry.status === "completed"
                        ? "line-through opacity-70"
                        : ""
                    }
                  >
                    {entry.content}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function InlineSessionConfigControls({
  configOptions,
  onSelectConfigOption,
}: {
  configOptions: AcpSessionConfigOption[];
  onSelectConfigOption: (configId: string, value: string | boolean) => void;
}) {
  const options = buildComposerConfigOptions(configOptions);
  if (options.length === 0) return null;
  return (
    <>
      {options.map((option) => {
        if (
          option.type === "boolean" &&
          typeof option.currentValue === "boolean"
        ) {
          return (
            <Button
              key={option.id}
              aria-label={option.name}
              aria-pressed={option.currentValue}
              title={option.description ?? option.name}
              onClick={() =>
                onSelectConfigOption(option.id, !option.currentValue)
              }
              size="sm"
              className={`clash-inline-session-config-trigger h-9 min-h-9 shrink-0 gap-1 rounded-md border-transparent px-1.5 text-sm font-semibold shadow-none ${
                option.currentValue
                  ? "bg-brand/[0.08] text-slate-900 dark:bg-brand/[0.12] dark:text-neutral-50"
                  : "bg-transparent text-stone-600 hover:bg-warm-muted/60 dark:text-stone-300"
              }`}
              leftIcon={<SlidersHorizontal className="h-4 w-4" />}
            >
              <span className="clash-inline-session-config-label">
                {option.name}
              </span>
            </Button>
          );
        }
        const values = flattenAcpSelectValues(option);
        const selected =
          values.find((value) => value.value === option.currentValue) ??
          values[0];
        if (!selected) return null;
        return (
          <SelectMenu
            key={option.id}
            className="relative flex justify-start"
            triggerClassName="clash-inline-session-config-trigger max-w-[180px] text-left"
            value={selected.value}
            sections={[
              {
                id: `composer-config-${option.id}`,
                options: values.map((value) => ({
                  value: value.value,
                  label: value.name,
                  description:
                    value.description ?? option.description ?? undefined,
                  selected: value.value === option.currentValue,
                })),
              },
            ]}
            onValueChange={(value) => onSelectConfigOption(option.id, value)}
            ariaLabel={option.name}
            title={option.description ?? option.name}
            variant="inline"
            placement="top"
            menuWidth={260}
            maxMenuHeight={320}
            stopPropagation
            triggerPrefix={
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            }
            triggerLabel={`${option.name} · ${selected.name}`}
          />
        );
      })}
    </>
  );
}

/**
 * One row in the "Run on" dropdown. Active row gets a checkmark + bg.
 * Disabled rows (offline runtime, no agents detected) are unclickable
 * but still visible so the user knows the runtime exists.
 */
function RuntimeMenuRow({
  label,
  sub,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  sub?: string;
  active?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return (
    <DropdownMenuItem
      aria-current={active ? "true" : undefined}
      disabled={disabled}
      onSelect={onSelect}
      className={`min-h-[44px] ${active ? "bg-brand/[0.08] dark:bg-brand/[0.12]" : ""}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          active ? "bg-brand" : "bg-stone-400 dark:bg-stone-500"
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-800 truncate dark:text-slate-100">
          {label}
        </div>
        {sub && (
          <div className="text-[11px] text-stone-600 truncate dark:text-stone-400">
            {sub}
          </div>
        )}
      </div>
    </DropdownMenuItem>
  );
}

function RuntimeEmptyState({
  ready,
  startupPending = false,
  desktopLocalMode,
  localRuntime,
  setupIssue,
  status,
  activityLabel,
  agentMotionState,
  renderEmptyActivity = true,
}: {
  ready: boolean;
  startupPending?: boolean;
  desktopLocalMode?: boolean;
  localRuntime?: Runtime | null;
  setupIssue?: string | null;
  status: ClashRuntimeStatus;
  activityLabel?: string | null;
  agentMotionState: AgentMotionState;
  renderEmptyActivity?: boolean;
}) {
  const { t } = useTranslation();
  if (startupPending) {
    return null;
  }
  const hasLocalAgent =
    !!localRuntime &&
    localRuntime.status === "online" &&
    localRuntime.agents.length > 0;
  const activitySlot = (
    <motion.div
      className="clash-copilot-agent-activity-empty-anchor clash-copilot-agent-activity-composer-companion relative -left-3 top-2 mx-auto flex min-h-[calc(100dvh-6.5rem)] w-full max-w-[68rem] flex-col justify-end gap-3 pb-0"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    >
      <AgentActivitySlot
        label={activityLabel ?? null}
        state={activityLabel ? agentMotionState : "idle"}
        gazeTarget={null}
        emptyLabel={t("copilot.status.readyWhenYouAre")}
      />
    </motion.div>
  );
  if (activityLabel && renderEmptyActivity) return activitySlot;
  if (setupIssue) return null;
  if (
    desktopLocalMode &&
    !setupIssue &&
    !ready &&
    (status === "idle" || status === "connecting") &&
    (!localRuntime || hasLocalAgent)
  ) {
    return null;
  }
  if (!renderEmptyActivity) return null;
  if (desktopLocalMode && (status === "draft" || ready)) return activitySlot;
  const emptyText = ready
    ? t("copilot.status.localAgentReady")
    : desktopLocalMode
      ? t(
          hasLocalAgent
            ? "copilot.status.desktopLocalStarting"
            : "copilot.status.desktopLocalRequired",
        )
      : t("copilot.status.localRuntimeRequired");
  return (
    <div className="py-12 text-center text-sm text-stone-600 dark:text-stone-300">
      {emptyText}
    </div>
  );
}

function RuntimePromptQueueBar({
  items,
  onSteer,
  onEdit,
  onRemove,
  onReorder,
}: {
  items: RuntimeQueuedPrompt[];
  onSteer: (turnId: string) => void;
  onEdit: (item: RuntimeQueuedPrompt) => void;
  onRemove: (turnId: string) => void;
  onReorder: (turnIds: string[]) => void;
}) {
  const itemIds = useMemo(() => items.map((item) => item.turnId), [items]);

  return (
    <div
      className={`${COPILOT_COMPOSER_RAIL_WIDTH_CLASS} clash-runtime-prompt-queue relative z-0 -mb-10 overflow-visible rounded-t-[20px] px-3 pb-[3.25rem] pt-2.5 text-xs`}
    >
      <SortableList items={itemIds} onReorder={onReorder}>
        <div className="flex flex-col gap-1">
          {items.map((item, index) => (
            <RuntimePromptQueueItem
              key={item.turnId}
              item={item}
              index={index}
              onSteer={onSteer}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableList>
    </div>
  );
}

function RuntimePromptQueueItem({
  item,
  index,
  onSteer,
  onEdit,
  onRemove,
}: {
  item: RuntimeQueuedPrompt;
  index: number;
  onSteer: (turnId: string) => void;
  onEdit: (item: RuntimeQueuedPrompt) => void;
  onRemove: (turnId: string) => void;
}) {
  const { setNodeRef, style, isDragging, dragHandleProps } = useSortableItem(
    item.turnId,
    { draggingZIndex: 30 },
  );
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors ${isDragging ? "bg-warm-muted/70 opacity-60 shadow-md ring-1 ring-brand/20 dark:bg-stone-900" : ""}`}
    >
      <IconButton
        label={`Drag queued message ${index + 1}`}
        size="sm"
        icon={<DotsSixVertical className="h-4 w-4" weight="bold" />}
        className="h-5 min-h-5 w-5 min-w-5 shrink-0 cursor-grab rounded-md text-stone-500 opacity-100 hover:bg-transparent hover:text-stone-600 active:cursor-grabbing dark:text-stone-400 dark:hover:text-stone-300"
        {...dragHandleProps}
      />
      <ArrowBendDownRight
        className="h-3.5 w-3.5 shrink-0 text-stone-500/70 dark:text-stone-400/70"
        aria-hidden="true"
      />
      <RuntimePromptQueueContent content={item.text} />
      <Button
        aria-label={`Steer queued message ${index + 1}`}
        onClick={() => onSteer(item.turnId)}
        size="sm"
        leftIcon={<ArrowBendDownRight className="h-3.5 w-3.5" />}
        className="min-h-5 shrink-0 gap-1 rounded-md border-transparent bg-transparent px-1.5 py-px text-[13px] font-medium text-stone-500 opacity-70 shadow-none hover:bg-warm-muted/70 hover:text-slate-900 hover:opacity-100 dark:text-stone-400 dark:hover:bg-stone-900/70 dark:hover:text-slate-50"
      >
        Steer
      </Button>
      <IconButton
        label={`Remove queued message ${index + 1}`}
        onClick={() => onRemove(item.turnId)}
        variant="destructive"
        size="sm"
        icon={<Trash className="h-4 w-4" />}
        className="h-5 min-h-5 w-5 min-w-5 shrink-0 rounded-md text-stone-500 opacity-70 hover:bg-red-50 hover:text-red-600 hover:opacity-100 dark:text-stone-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label={`Queued message options ${index + 1}`}
            size="sm"
            shape="circle"
            icon={<DotsThree className="h-4 w-4" weight="bold" />}
            className="h-5 min-h-5 w-5 min-w-5 shrink-0 text-stone-500 opacity-70 hover:bg-warm-muted hover:text-slate-800 hover:opacity-100 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-slate-100"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-52">
          <DropdownMenuItem onSelect={() => onEdit(item)}>
            <PencilSimple
              className="h-4 w-4 text-stone-500"
              aria-hidden="true"
            />
            Edit message
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => onRemove(item.turnId)}
            className="text-red-600 hover:text-red-600 dark:text-red-300 dark:hover:text-red-300"
          >
            <Trash className="h-4 w-4" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AgentActivityRow({
  label,
  state,
  gazeTarget,
}: {
  label: string;
  state: AgentMotionState;
  gazeTarget?: { x: number; y: number } | null;
}) {
  return (
    <div
      data-activity-layout="stable"
      className="clash-copilot-agent-activity-row flex items-center gap-0.5 px-0 py-0.5"
    >
      <span className="inline-flex">
        <CopilotRailSlot className="h-8">
          <AgentMotion
            state={state}
            className="clash-agent-motion--compact h-6 w-6"
            gazeTarget={gazeTarget ?? null}
          />
        </CopilotRailSlot>
      </span>
      <span data-agent-activity-label className="inline-flex min-w-0 -ml-0.5">
        <AgentStatusLine label={label} />
      </span>
    </div>
  );
}

function AgentActivitySlot({
  label,
  state,
  gazeTarget,
  emptyLabel,
}: {
  label: string | null;
  state: AgentMotionState;
  gazeTarget?: { x: number; y: number } | null;
  emptyLabel?: string | null;
}) {
  const visibleLabel = label ?? emptyLabel ?? null;
  return (
    <div className="clash-copilot-agent-activity-slot min-h-9">
      {visibleLabel ? (
        <AgentActivityRow
          label={visibleLabel}
          state={state}
          gazeTarget={gazeTarget ?? null}
        />
      ) : null}
    </div>
  );
}

function AgentStatusLine({ label }: { label: string }) {
  return (
    <motion.div
      role="status"
      aria-label={label}
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -4 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="inline-flex min-h-[24px] items-center overflow-hidden rounded-full px-0.5 text-xs font-semibold text-stone-600 dark:text-stone-300"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={label}
          initial={{ opacity: 0, y: 8, filter: "blur(2px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(2px)" }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

export default memo(ChatbotCopilot);
