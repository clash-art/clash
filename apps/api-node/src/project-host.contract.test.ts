import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  CONTRACT_SAMPLE_VIDEO_FILE,
  describeProjectHostContract,
} from "@clash/shared-runtime/project-host-contract";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";
import { loadTimelineDefinition } from "./timeline-definition.ts";

describeProjectHostContract("api-node (Postgres + disk)", async () => {
  const db = new PGlite();
  const directory = await mkdtemp(join(tmpdir(), "api-node-contract-"));
  await migrateDatabase(db);
  const token = "clsh_" + "c".repeat(40);
  await db.query(
    "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES('t','owner','contract',$1,'clsh_')",
    [createHash("sha256").update(token).digest("hex")],
  );
  await db.query(
    "INSERT INTO project(id,owner_id,name,created_at,updated_at) VALUES('contract','owner','Contract',now(),now())",
  );
  const endpoint = "http://api-node.contract.test";
  const app = createNodeCloudApp({
    db,
    syncBaseUrl: endpoint,
    assetDirectory: directory,
    timeline: {
      definition: loadTimelineDefinition(),
      receiptSecret: "contract-receipt-secret",
    },
  });
  return {
    endpoint,
    projectId: "contract",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return app.request(String(input instanceof Request ? input.url : input), {
        ...init,
        headers,
      });
    },
    capabilities: {
      "catalog.generators": "supported",
      "catalog.views": "supported",
      "catalog.actions": "supported",
      "timeline.list": "supported",
      "timeline.create": "supported",
      "timeline.update": "supported",
      "timeline.attach": "supported",
      "timeline.detach": "supported",
      "timeline.delete": "supported",
      // No cloud render executor: the shared command answers 501.
      "timeline.render": "unavailable",
      "assets.list": "supported",
      "assets.batch": "supported",
      "assets.get": "supported",
      "assets.references": "supported",
      "assets.import": "supported",
      "assets.trash": "unavailable",
      "assets.restore": "unavailable",
      "assets.media": "supported",
    },
    sampleVideo: {
      bytes: new Uint8Array(
        await readFile(
          new URL(
            `../../../packages/shared-runtime/src/project-host-contract/fixtures/${CONTRACT_SAMPLE_VIDEO_FILE}`,
            import.meta.url,
          ),
        ),
      ),
      fileName: CONTRACT_SAMPLE_VIDEO_FILE,
      contentType: "video/mp4",
    },
    close: async () => {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
