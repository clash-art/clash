import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { AssetKind } from "@clash/shared-types";
import {
  createPersonalGlobalAssetHostClient,
  createProjectAssetHostClient,
  resolveAssetImportFileType,
  type PersonalGlobalAssetHostClient,
  type ProjectAssetHostClient,
  type ProjectAssetHostScope,
} from "@clash/shared-runtime/project-asset-client";
import { ProjectHostHttpError } from "@clash/shared-runtime/project-host-client";

import type { AssetMcpToolName, AssetToolInput } from "./asset-contract.js";

export type AssetProjectHostGateway = {
  invoke(name: AssetMcpToolName, input: AssetToolInput): Promise<unknown>;
};

function requiredString(
  input: AssetToolInput,
  key: "assetId" | "projectAssetId" | "globalAssetId" | "filePath",
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

async function readAssetImportFile(
  input: AssetToolInput,
  workspaceRoot: string,
): Promise<{
  sourcePath: string;
  file: Blob;
  fileName: string;
  kind: AssetKind;
}> {
  const requestedPath = requiredString(input, "filePath");
  const filePath = resolve(workspaceRoot, requestedPath);
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`Asset import source is not a file: ${filePath}`);
  }
  const fileType = resolveAssetImportFileType(filePath, input.kind);
  return {
    sourcePath: filePath,
    // File-backed: the Host receives the bytes as they are read from disk.
    file: await openAsBlob(filePath, { type: fileType.contentType }),
    fileName: basename(filePath),
    kind: fileType.kind,
  };
}

function optionalImportId(
  input: AssetToolInput,
  key: "projectAssetId" | "globalAssetId",
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string when provided`);
  }
  return value.trim();
}

type PendingImport = { id: string };

/** Direct Project Asset transport with MCP-session read receipts and no CLI process. */
export function createAssetProjectHostGateway(
  client: ProjectAssetHostClient = createProjectAssetHostClient(),
  globalClient: PersonalGlobalAssetHostClient = createPersonalGlobalAssetHostClient(),
): AssetProjectHostGateway {
  const observations = new Map<string, string>();
  const deleteOperations = new Map<string, string>();
  // These are pending logical commands, not a content index. Unknown results
  // retain the first id; success or a structured Host rejection clears it. The
  // file is reopened per attempt, so a retry never holds its bytes in memory.
  const pendingProjectImports = new Map<string, PendingImport>();
  const pendingGlobalImports = new Map<string, PendingImport>();
  const pendingGlobalTrash = new Map<string, string>();
  const globalRestoreObservations = new Map<string, string>();
  const deleteObservationKey = (
    projectId: string,
    assetId: string,
    receipt: string,
  ) => JSON.stringify([projectId, assetId, receipt]);
  const deleteOperationFor = (
    projectId: string,
    assetId: string,
    receipt: string,
  ) => {
    const key = deleteObservationKey(projectId, assetId, receipt);
    const existing = deleteOperations.get(key);
    if (existing) return existing;
    const operationId = `delete:sha256:${createHash("sha256")
      .update(key)
      .digest("hex")}`;
    deleteOperations.set(key, operationId);
    return operationId;
  };
  const scope = async (input: AssetToolInput) => {
    const context = await client.resolveContext({
      cwd: input.cwd,
      projectId: input.projectId,
    });
    const requestScope: ProjectAssetHostScope = {
      projectId: context.projectId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    return {
      context,
      requestScope,
      observationKey: (assetId: string) => `${context.projectId}\0${assetId}`,
    };
  };
  const requireReceipt = async (input: AssetToolInput, assetId: string) => {
    const resolved = await scope(input);
    const receipt = observations.get(resolved.observationKey(assetId));
    if (!receipt) {
      throw new Error(
        `READ_REQUIRED: Read Project Asset ${assetId} with clash_assets_get or clash_assets_references before mutating it.`,
      );
    }
    return { ...resolved, receipt };
  };

  return {
    async invoke(name, input) {
      switch (name) {
        case "clash_assets_list": {
          const resolved = await scope(input);
          return (await client.list(resolved.requestScope)).value;
        }
        case "clash_assets_get": {
          const resolved = await scope(input);
          const assetId = requiredString(input, "assetId");
          const observed = await client.get({
            ...resolved.requestScope,
            assetId,
          });
          observations.set(resolved.observationKey(assetId), observed.receipt);
          if (observed.value.lifecycle.state === "trashed") {
            deleteOperations.set(
              deleteObservationKey(
                resolved.context.projectId,
                assetId,
                observed.receipt,
              ),
              observed.value.lifecycle.deleteOperationId,
            );
          }
          return observed.value;
        }
        case "clash_assets_references": {
          const resolved = await scope(input);
          const assetId = requiredString(input, "assetId");
          const observed = await client.references({
            ...resolved.requestScope,
            assetId,
          });
          observations.set(resolved.observationKey(assetId), observed.receipt);
          return { projectAssetId: assetId, references: observed.value };
        }
        case "clash_assets_import_file": {
          const resolved = await scope(input);
          const workspaceRoot =
            input.cwd?.trim() ||
            resolved.context.workspaceRoot ||
            process.cwd();
          const { sourcePath, ...readFile } = await readAssetImportFile(
            input,
            workspaceRoot,
          );
          const explicitId = optionalImportId(input, "projectAssetId");
          const pendingKey = explicitId
            ? JSON.stringify([
                "project-command",
                resolved.context.projectId,
                explicitId,
              ])
            : JSON.stringify([
                "project",
                resolved.context.projectId,
                sourcePath,
                readFile.kind,
              ]);
          const pending = pendingProjectImports.get(pendingKey) ?? {
            id: explicitId ?? `asset:${randomUUID()}`,
          };
          if (!pendingProjectImports.has(pendingKey)) {
            pendingProjectImports.set(pendingKey, pending);
          }
          let imported;
          try {
            imported = await client.importFile({
              ...resolved.requestScope,
              ...readFile,
              projectAssetId: pending.id,
              duplicateContent: input.allowDuplicate ? "allow" : "reject",
            });
          } catch (error) {
            if (error instanceof ProjectHostHttpError) {
              pendingProjectImports.delete(pendingKey);
            }
            throw error;
          }
          pendingProjectImports.delete(pendingKey);
          return imported.value;
        }
        case "clash_assets_admit": {
          const resolved = await scope(input);
          return (
            await client.admit({
              ...resolved.requestScope,
              globalAssetId: requiredString(input, "globalAssetId"),
            })
          ).value;
        }
        case "clash_assets_publish": {
          const resolved = await scope(input);
          return globalClient.publish({
            projectId: resolved.context.projectId,
            projectAssetId: requiredString(input, "projectAssetId"),
          });
        }
        case "clash_assets_trash": {
          const assetId = requiredString(input, "assetId");
          const guarded = await requireReceipt(input, assetId);
          const deleteOperationId = deleteOperationFor(
            guarded.context.projectId,
            assetId,
            guarded.receipt,
          );
          const observed = await client.trash({
            ...guarded.requestScope,
            assetId,
            deleteOperationId,
            actorClientType: "mcp",
            receipt: guarded.receipt,
          });
          observations.set(guarded.observationKey(assetId), observed.receipt);
          deleteOperations.set(
            deleteObservationKey(
              guarded.context.projectId,
              assetId,
              observed.receipt,
            ),
            deleteOperationId,
          );
          return observed.value;
        }
        case "clash_assets_restore": {
          const assetId = requiredString(input, "assetId");
          const guarded = await requireReceipt(input, assetId);
          const observed = await client.restore({
            ...guarded.requestScope,
            assetId,
            actorClientType: "mcp",
            receipt: guarded.receipt,
          });
          observations.set(guarded.observationKey(assetId), observed.receipt);
          return observed.value;
        }
        case "clash_assets_global_list":
          return globalClient.list();
        case "clash_assets_global_get": {
          const globalAssetId = requiredString(input, "globalAssetId");
          const value = await globalClient.get({ globalAssetId });
          if (value.lifecycle.state === "trashed") {
            globalRestoreObservations.set(
              globalAssetId,
              value.lifecycle.deleteOperationId,
            );
          } else {
            globalRestoreObservations.delete(globalAssetId);
          }
          return value;
        }
        case "clash_assets_global_import_file": {
          const workspaceRoot = input.cwd?.trim() || process.cwd();
          const { sourcePath, ...readFile } = await readAssetImportFile(
            input,
            workspaceRoot,
          );
          const explicitId = optionalImportId(input, "globalAssetId");
          const pendingKey = explicitId
            ? JSON.stringify(["global-command", explicitId])
            : JSON.stringify(["global", sourcePath, readFile.kind]);
          const pending = pendingGlobalImports.get(pendingKey) ?? {
            id: explicitId ?? `global:${randomUUID()}`,
          };
          if (!pendingGlobalImports.has(pendingKey)) {
            pendingGlobalImports.set(pendingKey, pending);
          }
          let imported;
          try {
            imported = await globalClient.importFile({
              ...readFile,
              globalAssetId: pending.id,
            });
          } catch (error) {
            if (error instanceof ProjectHostHttpError) {
              pendingGlobalImports.delete(pendingKey);
            }
            throw error;
          }
          pendingGlobalImports.delete(pendingKey);
          return imported;
        }
        case "clash_assets_global_trash": {
          const globalAssetId = requiredString(input, "globalAssetId");
          const deleteOperationId =
            pendingGlobalTrash.get(globalAssetId) ?? `delete:${randomUUID()}`;
          pendingGlobalTrash.set(globalAssetId, deleteOperationId);
          try {
            const trashed = await globalClient.trash({
              globalAssetId,
              deleteOperationId,
            });
            pendingGlobalTrash.delete(globalAssetId);
            return trashed;
          } catch (error) {
            if (error instanceof ProjectHostHttpError) {
              pendingGlobalTrash.delete(globalAssetId);
            }
            throw error;
          }
        }
        case "clash_assets_global_restore": {
          const globalAssetId = requiredString(input, "globalAssetId");
          const deleteOperationId =
            globalRestoreObservations.get(globalAssetId);
          if (!deleteOperationId) {
            throw new Error(
              `READ_REQUIRED: Read Global Asset ${globalAssetId} with clash_assets_global_get before restoring it.`,
            );
          }
          try {
            const restored = await globalClient.restore({
              globalAssetId,
              deleteOperationId,
            });
            globalRestoreObservations.delete(globalAssetId);
            return restored;
          } catch (error) {
            if (error instanceof ProjectHostHttpError) {
              globalRestoreObservations.delete(globalAssetId);
            }
            throw error;
          }
        }
      }
    },
  };
}
