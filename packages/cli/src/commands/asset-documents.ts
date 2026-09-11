import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  createDocumentClient,
  publicDocumentValue,
  type DocumentRequest,
} from "@clash/shared-runtime/document-client";
import { apiFetch } from "../lib/api";
import { printJson } from "../lib/output";
import { resolveProjectContext } from "../lib/project-context";
import {
  decodeDocument,
  documentFile,
  observeAttachment,
  observedAttachment,
  observeDocumentCollection,
  observedDocument,
  observeDocument,
  pullDocumentFile,
  readDocumentDraft,
  requireEditableDocument,
  saveDocumentDraft,
} from "../lib/document-worktree";

export function createAssetDocumentsCommand(
  deps: {
    request?: DocumentRequest;
    output?: (value: unknown) => void;
    cwd?: string;
  } = {},
): Command {
  const request = deps.request ?? apiFetch;
  const client = createDocumentClient((path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-clash-client-type", "agent");
    return request(path, { ...init, headers });
  });
  const output = (value: unknown) =>
    (deps.output ?? printJson)(publicDocumentValue(value));
  const context = (options: { project?: string }) =>
    resolveProjectContext({ project: options.project, cwd: deps.cwd });
  const command = new Command("documents").description(
    "Read, create and edit native Project Documents through the Host",
  );
  const add = (name: string) =>
    command
      .command(name)
      .option(
        "--project <id>",
        "Project ID, defaults to the working-tree project",
      )
      .option("--json", "Output JSON");
  add("kinds").action(async (options) =>
    output(await client.kinds((await context(options)).projectId)),
  );
  add("list").action(async (options) => {
    const ctx = await context(options),
      result = await client.list(ctx.projectId);
    await observeDocumentCollection(ctx, "heads", result);
    output(result);
  });
  add("history <documentAssetId>").action(async (asset, options) => {
    const ctx = await context(options),
      result = await client.history(ctx.projectId, asset);
    await observeDocumentCollection(ctx, `history:${asset}`, result);
    output(result);
  });
  add("get <documentAssetId>")
    .option(
      "--revision <id>",
      "Read an exact immutable revision instead of the current head",
    )
    .action(async (asset, options) => {
      const ctx = await context(options);
      const result = options.revision
        ? await client.getRevision(ctx.projectId, asset, options.revision)
        : await client.get(ctx.projectId, asset);
      await observeDocument(ctx, result);
      output(result);
    });
  add("create")
    .requiredOption("--kind <kind>", "Registered Document kind")
    .option("--schema-version <version>", "Kind schema version", "1")
    .requiredOption(
      "--file <path>",
      "Body in the kind's declared native format",
    )
    .option(
      "--source-refs <path>",
      "JSON file containing exact source references",
    )
    .action(async (options) => {
      const ctx = await context(options);
      const version = Number(options.schemaVersion);
      const kind = (await client.kinds(ctx.projectId)).kinds.find(
        (value) =>
          value.kind === options.kind && value.schemaVersion === version,
      );
      if (!kind)
        throw new Error(
          "Unknown Document kind/schema version; run clash assets documents kinds.",
        );
      const body = decodeDocument(
        await readFile(
          resolve(deps.cwd ?? process.cwd(), options.file),
          "utf8",
        ),
        kind.projection,
      );
      const sourceRefs = options.sourceRefs
        ? JSON.parse(
            await readFile(
              resolve(deps.cwd ?? process.cwd(), options.sourceRefs),
              "utf8",
            ),
          )
        : [];
      const result = await client.create(ctx.projectId, {
        documentAssetId: randomUUID(),
        revisionId: randomUUID(),
        documentKind: kind.kind,
        schemaVersion: version,
        body,
        sourceRefs,
      });
      await observeDocument(ctx, result);
      output(result);
    });
  add("pull <documentAssetId>")
    .requiredOption("--file <path>", "Working-tree file for native edits")
    .option("--revision <id>", "Pull an exact revision")
    .action(async (asset, options) => {
      const ctx = await context(options),
        file = documentFile(
          ctx,
          resolve(deps.cwd ?? process.cwd(), options.file),
        );
      const result = options.revision
        ? await client.getRevision(ctx.projectId, asset, options.revision)
        : await client.get(ctx.projectId, asset);
      await pullDocumentFile(ctx, file, result);
      await observeDocument(ctx, result);
      output({
        documentAssetId: asset,
        revisionId: result.revision.id,
        file,
        projection: result.projection,
      });
    });
  add("apply <documentAssetId>")
    .requiredOption(
      "--file <path>",
      "Previously pulled file containing native edits",
    )
    .action(async (asset, options) => {
      const ctx = await context(options),
        file = documentFile(
          ctx,
          resolve(deps.cwd ?? process.cwd(), options.file),
        );
      const draft = await readDocumentDraft(ctx, file, asset);
      requireEditableDocument(draft);
      const contents = await readFile(file, "utf8");
      const result = await client.advance(
        ctx.projectId,
        asset,
        {
          expectedHeadRevisionId: draft.revision.id,
          revisionId: randomUUID(),
          body: decodeDocument(contents, draft.projection),
          sourceRefs: draft.revision.sourceRefs,
        },
        draft.readToken,
      );
      await saveDocumentDraft(ctx, file, result, contents);
      await observeDocument(ctx, result);
      output(result);
    });
  add("copy <documentAssetId>")
    .option("--revision <id>", "Copy a previously read exact revision")
    .action(async (asset, options) => {
      const ctx = await context(options),
        observed = await observedDocument(ctx, asset, options.revision);
      const result = await client.copy(
        ctx.projectId,
        asset,
        {
          sourceRevisionId: observed.revision.id,
          documentAssetId: randomUUID(),
          revisionId: randomUUID(),
        },
        observed.readToken,
      );
      await observeDocument(ctx, result);
      output(result);
    });
  add("attachments").action(async (options) => {
    const ctx = await context(options),
      result = await client.attachments(ctx.projectId);
    for (const { readToken, ...attachment } of result.attachments)
      await observeAttachment(ctx, { attachment, readToken });
    output(result);
  });
  add("attachment <attachmentId>").action(async (id, options) => {
    const ctx = await context(options),
      result = await client.attachment(ctx.projectId, id);
    await observeAttachment(ctx, result);
    output(result);
  });
  add("attach <documentAssetId>")
    .requiredOption(
      "--revision <id>",
      "Previously read exact Document revision",
    )
    .requiredOption(
      "--target <path>",
      "JSON attachment target: project-asset, generator-revision or action-run",
    )
    .requiredOption("--slot <slot>", "Attachment slot")
    .action(async (asset, options) => {
      const ctx = await context(options),
        observed = await observedDocument(ctx, asset, options.revision);
      const target = JSON.parse(
        await readFile(
          resolve(deps.cwd ?? process.cwd(), options.target),
          "utf8",
        ),
      );
      const result = await client.attach(
        ctx.projectId,
        {
          id: randomUUID(),
          target,
          slot: options.slot,
          document: {
            kind: "document",
            documentAssetId: asset,
            revisionId: observed.revision.id,
          },
        },
        observed.readToken,
      );
      await observeAttachment(ctx, result);
      output(result);
    });
  add("advance-attachment <attachmentId>")
    .requiredOption(
      "--revision <id>",
      "Previously read exact destination revision",
    )
    .action(async (id, options) => {
      const ctx = await context(options),
        old = await observedAttachment(ctx, id),
        next = await observedDocument(
          ctx,
          old.attachment.document.documentAssetId,
          options.revision,
        );
      const result = await client.advanceAttachment(
        ctx.projectId,
        id,
        {
          expectedRevisionId: old.attachment.document.revisionId,
          document: {
            kind: "document",
            documentAssetId: old.attachment.document.documentAssetId,
            revisionId: next.revision.id,
          },
        },
        old.readToken,
        next.readToken,
      );
      await observeAttachment(ctx, result);
      output(result);
    });
  return command;
}
