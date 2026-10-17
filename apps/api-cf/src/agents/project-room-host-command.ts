/**
 * ProjectRoom adapter for the shared Timeline Host commands (issue #180).
 *
 * This is the Cloudflare composition root for `host-command`: the Durable
 * Object supplies the live Loro document, its serial write queue, persistence
 * and broadcast; the platform-agnostic `executeTimelineHostCommand` decides
 * everything else. Loaded with a dynamic import from ProjectRoom so neither
 * the Timeline product code, the plugin catalog nor the generated validators
 * enter Worker startup.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { LoroDoc } from "loro-crdt";
import {
  executeTimelineHostCommand,
  parseTimelineHostCommand,
  timelineReceiptMessage,
  type TimelineHostCommandResult,
} from "@clash/shared-runtime/cloud-project-host/timeline-commands";
import { cloudPluginCatalog } from "../services/cloud-plugin-catalog";
import { requireSecret } from "../services/require-secret";

/** What ProjectRoom lends this adapter; nothing else of the room is visible. */
export interface ProjectRoomHostCommandPort {
  projectId: string;
  doc(): LoroDoc;
  /** Current owner record from the shared project authority (D1). */
  readProject(): Promise<{ ownerId: string; deletedAt: number | null } | null>;
  /** Run `work` as one item of the room's serial Loro write queue. */
  serialize<T>(work: () => Promise<T>): Promise<T>;
  /** Durably append `update` (validates and applies it to the live doc). */
  persist(update: Uint8Array): Promise<void>;
  broadcast(update: Uint8Array): void;
  env: { ENVIRONMENT: string; JWT_SECRET?: string };
}

const READ_ONLY_ACTIONS = new Set<string>(["list_timelines"]);

const notFound = (): TimelineHostCommandResult => ({
  status: 404,
  body: { code: "PROJECT_NOT_FOUND", error: "Project not found" },
  mutated: false,
});

export function timelineReceiptSigner(
  env: ProjectRoomHostCommandPort["env"],
  userId: string,
  projectId: string,
) {
  const secret = requireSecret(
    env,
    "JWT_SECRET",
    env.JWT_SECRET,
    "dev-project-host-receipt-secret",
  );
  // Same algorithm and encoding as api-node, so receipts look alike everywhere.
  return (version: string) =>
    createHmac("sha256", secret)
      .update(timelineReceiptMessage(userId, projectId, version))
      .digest("base64url");
}

async function owned(port: ProjectRoomHostCommandPort, userId: string) {
  const project = await port.readProject();
  return !!project && project.ownerId === userId && project.deletedAt === null;
}

export async function runProjectRoomHostCommand(
  port: ProjectRoomHostCommandPort,
  input: unknown,
): Promise<{ status: number; body: unknown }> {
  const raw = input as { userId?: unknown; command?: unknown } | null;
  const userId = typeof raw?.userId === "string" ? raw.userId : "";
  if (!userId) return { status: 401, body: { error: "unauthorized" } };
  const parsed = parseTimelineHostCommand(raw?.command);
  if (!parsed.ok) return { status: 400, body: parsed.result.body };
  const ports = {
    definitions: cloudPluginCatalog().generatorDefinitions(),
    sign: timelineReceiptSigner(port.env, userId, port.projectId),
    newId: () => randomUUID(),
  };
  const command = parsed.command;
  if (READ_ONLY_ACTIONS.has(command.action)) {
    if (!(await owned(port, userId))) return notFound();
    const { status, body } = executeTimelineHostCommand(port.doc(), command, ports);
    return { status, body };
  }
  const result = await port.serialize(async () => {
    // Ownership may have changed while the command waited for the queue.
    if (!(await owned(port, userId))) return notFound();
    const live = port.doc();
    const fork = live.fork();
    const executed = executeTimelineHostCommand(fork, command, ports);
    if (!executed.mutated) return executed;
    fork.commit({ origin: "host-command" });
    const update = fork.export({ mode: "update", from: live.oplogVersion() });
    if (update.byteLength > 0) {
      await port.persist(update);
      port.broadcast(update);
    }
    return executed;
  });
  return { status: result.status, body: result.body };
}
