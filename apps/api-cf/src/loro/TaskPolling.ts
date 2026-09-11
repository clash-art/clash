import { hostedGenerationStatus } from "../generation/status";
/**
 * Task Polling Service
 *
 * Polls D1 for completed/failed tasks and updates Loro nodes.
 * Uses `pendingTask` field as the indicator — no separate taskState lock.
 */

import { LoroDoc } from 'loro-crdt';
import type { Env } from '../config';
import { log } from '../logger';
import { updateNodeData, appendNodeLog, clearNodeLog } from './NodeUpdater';
import { getAssetByTaskId } from '../services/assets';
import { Status } from '../domain/canvas';

/**
 * Poll tasks for nodes that have pendingTask field.
 *
 * @returns true if there are still pending tasks
 */
export async function pollNodeTasks(
  doc: LoroDoc,
  env: Env,
  projectId: string,
  broadcast: (data: Uint8Array) => void
): Promise<boolean> {
  let hasPendingTasks = false;

  try {
    const nodesMap = doc.getMap('nodes');

    for (const [nodeId, nodeData] of nodesMap.entries()) {
      const data = nodeData as Record<string, any>;
      const innerData = data?.data || {};
      const pendingTask = innerData.pendingTask;

      if (!pendingTask) continue;

      const taskStatus = await getTaskStatusDirect(env, pendingTask);

      const latest = nodesMap.get(nodeId) as { data?: { pendingTask?: string } } | undefined;
      if (latest?.data?.pendingTask !== pendingTask) continue;
      if (taskStatus.managedByJournal) {
        hasPendingTasks = true;
        continue;
      }
      if (taskStatus.status === Status.Completed) {
        const updates: Record<string, any> = {
          pendingTask: undefined,
          status: Status.Completed,
        };
        if (taskStatus.assetId) updates.assetId = taskStatus.assetId;
        if (taskStatus.coverR2Key) updates.coverUrl = taskStatus.coverR2Key;

        updateNodeData(doc, nodeId, updates, broadcast);
        clearNodeLog(doc, nodeId, broadcast);
      } else if (taskStatus.status === Status.Failed) {
        appendNodeLog(doc, nodeId, `FAILED: ${taskStatus.error}`, broadcast);
        updateNodeData(doc, nodeId, {
          pendingTask: undefined,
          status: Status.Failed,
          error: taskStatus.error,
        }, broadcast);
      } else {
        hasPendingTasks = true;
      }
    }
  } catch (error) {
    log.error('Error:', error);
  }

  return hasPendingTasks;
}

/**
 * Get task status — check D1 assets table first, fall back to Workflow status.
 *
 * If D1 has no asset row yet, the workflow may still be running or may have
 * failed before completing the save-asset step. Check workflow.status() for failure.
 */
async function getTaskStatusDirect(
  env: Env,
  taskId: string
): Promise<{
  status: string;
  managedByJournal?: boolean;
  assetId?: string;
  srcR2Key?: string;
  coverR2Key?: string;
  error?: string;
}> {
  try {
    const durable = await hostedGenerationStatus(env, taskId);
    if (durable) return durable;
    const asset = await getAssetByTaskId(env.DB, taskId);
    if (asset) {
      return {
        status: Status.Completed,
        assetId: asset.id,
        srcR2Key: asset.srcR2Key,
        coverR2Key: asset.coverR2Key ?? undefined,
      };
    }

    // No D1 record — check Workflow status to detect failures.
    try {
      const instance = await env.GENERATION_WORKFLOW.get(taskId);
      const wfStatus = await instance.status();
      if (wfStatus.status === 'errored' || wfStatus.status === 'terminated') {
        return { status: Status.Failed, error: wfStatus.error?.message ?? 'Workflow failed' };
      }
    } catch {
      // Workflow instance not found — task may not have been created yet.
    }

    return { status: Status.Pending };
  } catch (e) {
    // Don't translate DB exceptions into Status.Failed — that would let a
    // transient SQLite hiccup (e.g. a missing column right after a code
    // deploy that added one but before the migration ran) overwrite real
    // task state in Loro. Treat it as an unknown intermediate state and
    // let the next poll retry. Workflow status check above already handles
    // genuinely-failed workflows.
    log.error(`Exception fetching task ${taskId} — treating as Pending (will retry):`, e);
    return { status: Status.Pending };
  }
}

/**
 * Check if any node has a pending task
 */
export function hasPendingTasks(doc: LoroDoc): boolean {
  try {
    const nodesMap = doc.getMap('nodes');
    for (const [, nodeData] of nodesMap.entries()) {
      const data = nodeData as Record<string, any>;
      if (data?.data?.pendingTask) {
        return true;
      }
    }
  } catch {
    // Ignore errors
  }
  return false;
}
