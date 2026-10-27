import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./redact-gateway-ci-artifact.mjs", import.meta.url));

describe("redact-gateway-ci-artifact (#383)", () => {
  it("strips Bearer / sk_gw_ / sk- / clsh_ shapes from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-redact-"));
    try {
      const file = join(dir, "report.json");
      await writeFile(
        file,
        [
          'auth=Bearer eyJhbGciOi.test',
          'virtual=sk_gw_live.secret',
          'openai=sk-openai-abc',
          'product=clsh_tenant_xyz',
          "ok=true",
        ].join("\n") + "\n",
        "utf8",
      );
      const run = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const body = await readFile(file, "utf8");
      assert.match(body, /Bearer \[REDACTED\]/);
      assert.match(body, /sk_gw_\[REDACTED\]/);
      assert.match(body, /sk-\[REDACTED\]/);
      assert.match(body, /clsh_\[REDACTED\]/);
      assert.doesNotMatch(body, /eyJhbGciOi|sk_gw_live|sk-openai|clsh_tenant/);
      assert.match(body, /ok=true/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
