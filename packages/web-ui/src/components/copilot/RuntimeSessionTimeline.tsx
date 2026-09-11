"use client";

import type { AcpForkPoint } from "@clash/shared-types";
import { messageForkPoints } from "../../lib/acpForkPoint";

import type {
  AgentUIMessageItem,
  AgentUIStore,
  AgentUIToolItem,
  AgentUITurnState,
} from "@openma/common/agent-ui";
import {
  AgentUIStreamingMarkdown,
  AgentUIStreamingThoughtProjection,
  useAgentUIState,
} from "@openma/common/agent-ui/react";
import {
  CHAT_ASSISTANT_MARKDOWN_CLASS,
  CHAT_THOUGHT_MARKDOWN_CLASS,
  AgentChatView,
  AgentUITurnView,
  ChatMarkdown,
  ChatThoughtEventRow,
  projectChatThoughtEvent,
  type AgentChatDensity,
  type AgentChatViewSlots,
  type ChatCollapsiblePrimitives,
  type ChatThoughtEventProjection,
} from "@openma/common/chat-ui";
import { SessionTurnFooter } from "@openma/common/session-ui";
import { ListChecksIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { MentionableNode } from "../MilkdownEditor";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import {
  AcpAssistantTextInline,
  AcpToolInline,
  pickToolVerb,
  type ClashProjectEntity,
} from "./AcpInlineRenderers";
import {
  AgentMotion,
  type AgentGazeSource,
  useAgentGazeSurface,
} from "./AgentMotion";
import { UserMessage } from "./UserMessage";

const CLASH_COLLAPSIBLE_PRIMITIVES: ChatCollapsiblePrimitives = {
  Root: Collapsible,
  Trigger: CollapsibleTrigger,
  Content: CollapsibleContent,
};

export function RuntimeSessionTimeline({
  store,
  mentionableNodes,
  clashEntities,
  onOpenClashEntity,
  phase = "active",
  slots,
  onFork,
  onForkAtMessage,
  className,
}: {
  store: AgentUIStore;
  agentId?: string | null;
  mentionableNodes: MentionableNode[];
  clashEntities: readonly ClashProjectEntity[];
  onOpenClashEntity?: (entity: ClashProjectEntity) => void;
  phase?: "missing" | "draft" | "active";
  slots?: AgentChatViewSlots;
  /** Forks the current ACP session; only the latest settled turn exposes it. */
  onFork?: () => void;
  onForkAtMessage?: (point: AcpForkPoint) => void;
  className?: string;
}) {
  const state = useAgentUIState(store);
  const { bindAgentGazeSurface, gazeSource } = useAgentGazeSurface();
  const turns = state.turnOrder.flatMap((turnId) => {
    const turn = state.turns[turnId];
    return turn ? [turn] : [];
  });
  const forkPoints = onForkAtMessage ? messageForkPoints(turns) : undefined;
  const latestForkableTurnId =
    onFork && !state.activeTurnId
      ? [...turns].reverse().find((turn) => turn.status === "completed")?.id
      : undefined;
  return (
    <div
      className={className}
      data-testid="runtime-session-timeline"
      data-renderer="backchat"
      data-backchat-session-timeline="true"
      {...bindAgentGazeSurface()}
    >
      <AgentChatView
        density="compact"
        sessionId={state.sessionId}
        surface="main"
        phase={phase}
        turns={turns}
        slots={slots ?? { composer: null }}
        renderTurn={({ turn, density }) => (
          <RuntimeTurn
            key={turn.id}
            density={density}
            store={store}
            turn={turn}
            mentionableNodes={mentionableNodes}
            clashEntities={clashEntities}
            onOpenClashEntity={onOpenClashEntity}
            gazeSource={gazeSource}
            onFork={
              forkPoints?.has(turn.id) && onForkAtMessage
                ? () => onForkAtMessage(forkPoints.get(turn.id)!)
                : turn.id === latestForkableTurnId ? onFork : undefined
            }
          />
        )}
      />
    </div>
  );
}

function RuntimeTurn({
  store,
  turn,
  mentionableNodes,
  clashEntities,
  onOpenClashEntity,
  density,
  gazeSource,
  onFork,
}: {
  store: AgentUIStore;
  turn: AgentUITurnState;
  mentionableNodes: MentionableNode[];
  clashEntities: readonly ClashProjectEntity[];
  onOpenClashEntity?: (entity: ClashProjectEntity) => void;
  density: AgentChatDensity;
  gazeSource: AgentGazeSource;
  onFork?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AgentUITurnView
      sessionId={store.getState().sessionId}
      turn={turn}
      density={density}
      thoughts="history"
      activityTools="all"
      collapsiblePrimitives={CLASH_COLLAPSIBLE_PRIMITIVES}
      className="!max-w-3xl [&_.activity-disclosure-row]:!pl-0"
      labels={{
        workingFor: (seconds) => `正在工作 ${seconds} 秒`,
        workedFor: (seconds) => `已工作 ${seconds} 秒`,
        cancelled: t("copilot.status.interrupted"),
        thinking: "正在思考",
        thoughtFor: (seconds) => `已思考 ${seconds} 秒`,
        toolActivity: describeTool,
        toolRunSummary: (tools) => `已执行 ${tools.length} 项操作`,
      }}
      slots={{
        renderProcessLeading: ({ live }) => (
          <span
            data-session-process-avatar="true"
            className="grid h-5 w-5 shrink-0 place-items-center"
            aria-hidden="true"
          >
            <AgentMotion
              state={live ? "working" : "idle"}
              className="clash-agent-motion--compact h-5 w-5"
              gazeSource={gazeSource}
            />
          </span>
        ),
        renderPrompt: ({ item }) =>
          item.text ? (
            <UserMessage content={item.text} mentionNodes={mentionableNodes} />
          ) : null,
        // Restored text paints immediately; only newly received deltas are paced.
        renderAssistant: ({ item, section, live, prefixSkip }) =>
          live ? (
            <AgentUIStreamingMarkdown
              store={store}
              turnId={turn.id}
              kind="assistant"
              prefixSkip={prefixSkip}
              className={CHAT_ASSISTANT_MARKDOWN_CLASS}
            />
          ) : (
            <AcpAssistantTextInline text={item.text} section={section} />
          ),
        projectThoughtActivity: ({ item, live, prefixSkip }) =>
          projectClashThought({ store, turn, item, live, prefixSkip }),
        renderThought: ({ item, live, prefixSkip }) => {
          const projection = projectClashThought({
            store,
            turn,
            item,
            live,
            prefixSkip,
          });
          return (
            <ChatThoughtEventRow
              live={live}
              text={item.text}
              liveFallback="正在思考"
              completedLabel={thoughtCompletedLabel(item)}
              projection={projection}
              renderBody={() =>
                live ? (
                  <AgentUIStreamingMarkdown
                    store={store}
                    turnId={turn.id}
                    kind="thought"
                    prefixSkip={prefixSkip}
                    className={CHAT_THOUGHT_MARKDOWN_CLASS}
                  />
                ) : (
                  <ChatMarkdown
                    text={item.text}
                    className={CHAT_THOUGHT_MARKDOWN_CLASS}
                  />
                )
              }
            />
          );
        },
        projectToolActivity: ({ tool, live }) => ({
          leading:
            live || isToolRunning(tool) ? (
              <Loader2Icon className="chat-activity-icon animate-spin" />
            ) : (
              <ListChecksIcon className="chat-activity-icon" />
            ),
          summary: describeTool(tool, live),
        }),
        projectToolRun: ({ tools }) => ({
          leading: (
            <ListChecksIcon className="chat-activity-icon text-fg-muted" />
          ),
          summary: `已执行 ${tools.length} 项操作`,
        }),
        renderTool: ({ tool }) => (
          <AcpToolInline
            tool={tool}
            defaultOpen={false}
            clashEntities={clashEntities}
            onOpenClashEntity={onOpenClashEntity}
          />
        ),
        renderError: ({ message }) => (
          <p className="text-sm text-status-down">{message ?? "运行失败"}</p>
        ),
        renderFooter: ({ answerText }) => (
          <SessionTurnFooter
            status={turn.status === "failed" ? "error" : turn.status}
            timestamp={turn.endedAt}
            copyText={answerText}
            onFork={onFork}
            labels={{
              copyAnswer: t("copilot.turn.copyAnswer"),
              answerCopied: t("copilot.turn.answerCopied"),
              continueInNewChat: t("copilot.turn.continueInNewChat"),
            }}
          />
        ),
      }}
    />
  );
}

function projectClashThought({
  store,
  turn,
  item,
  live,
  prefixSkip,
}: {
  store: AgentUIStore;
  turn: AgentUITurnState;
  item: AgentUIMessageItem;
  live: boolean;
  prefixSkip: number;
}): ChatThoughtEventProjection {
  return projectChatThoughtEvent({
    text: item.text,
    live,
    liveFallback: "正在思考",
    completedLabel: thoughtCompletedLabel(item),
    renderLiveSummary: (fallback) => (
      <AgentUIStreamingThoughtProjection
        store={store}
        turnId={turn.id}
        prefixSkip={prefixSkip}
        fallback={String(fallback)}
        mode="body"
      />
    ),
  });
}

function thoughtCompletedLabel(item: AgentUIMessageItem): string {
  const duration =
    item.content && typeof item.content === "object"
      ? (item.content as Record<string, unknown>).durationSeconds
      : undefined;
  return typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration > 0
    ? `已思考 ${duration} 秒`
    : "已思考";
}

function describeTool(tool: AgentUIToolItem, live = false): ReactNode {
  const target = tool.title || tool.name || tool.toolKind || "工具调用";
  const status = live ? "in_progress" : tool.status;
  return `${pickToolVerb(tool.toolKind, status)} ${target}`.trim();
}

function isToolRunning(tool: AgentUIToolItem): boolean {
  return tool.status === "pending" || tool.status === "in_progress";
}
