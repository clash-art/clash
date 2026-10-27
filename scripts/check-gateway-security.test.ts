import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkGatewayDefaults,
  checkGatewaySecurity,
  findSecretHits,
  isSecretScanAllowlisted,
} from "./check-gateway-security.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("secret patterns catch live-looking material and ignore empty text", () => {
  assert.deepEqual(findSecretHits(""), []);
  assert.ok(findSecretHits("key=AKIA" + "A".repeat(16)).includes("AWS access key id"));
  assert.ok(findSecretHits("-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(64) + "\n-----END RSA PRIVATE KEY-----").includes("PEM private key"));
  assert.ok(findSecretHits("ghp_" + "a".repeat(36)).includes("GitHub PAT"));
  assert.ok(findSecretHits("sk_live_" + "x".repeat(24)).includes("Stripe live secret"));
  assert.ok(
    findSecretHits("sk-" + "a".repeat(48)).includes("OpenAI live-looking key"),
  );
  assert.ok(
    findSecretHits("-----BEGIN PRIVATE KEY-----\n" + "A".repeat(64) + "\n-----END PRIVATE KEY-----").includes(
      "PEM private key",
    ),
  );
  // Fixtures / product shapes that are not live provider keys.
  assert.deepEqual(findSecretHits("sk_test_123 sk_gw_abc Bearer clsh_deadbeef sk-desktop-smoke-openai-1"), []);
  assert.deepEqual(findSecretHits('const m = "-----BEGIN PRIVATE KEY-----";'), []);
});

test("allowlist covers tests, fixtures, mock-upstream, and this checker", () => {
  assert.ok(isSecretScanAllowlisted("apps/api-node/src/gateway-admin.test.ts"));
  assert.ok(isSecretScanAllowlisted("apps/api-node/src/mock-upstream/cli.ts"));
  assert.ok(isSecretScanAllowlisted("scripts/check-gateway-security.ts"));
  assert.ok(isSecretScanAllowlisted("packages/gateway-core/src/testing/fixtures.ts"));
  assert.ok(!isSecretScanAllowlisted("apps/api-node/src/gateway-node.ts"));
  assert.ok(!isSecretScanAllowlisted("apps/api-node/deploy/compose.yaml"));
});

test("repo defaults on this worktree pass", () => {
  assert.deepEqual(checkGatewayDefaults(ROOT), []);
});

test("defaults fail when retention is enabled or admin is EXPOSEd", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gw-sec-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  try {
    git("init", "-q");
    mkdirSync(path.join(dir, "apps/api-node/src"), { recursive: true });
    mkdirSync(path.join(dir, "apps/api-node/deploy"), { recursive: true });
    writeFileSync(
      path.join(dir, "apps/api-node/src/gateway-node.ts"),
      `export const ports = { retention: { enabled: true } };\n`,
    );
    writeFileSync(
      path.join(dir, "apps/api-node/deploy/Dockerfile"),
      `FROM node:24-slim\nEXPOSE 8080\nEXPOSE 8090\nENV GATEWAY_ROLE=api\n`,
    );
    writeFileSync(
      path.join(dir, "apps/api-node/deploy/compose.yaml"),
      `services:\n  admin:\n    environment:\n      GATEWAY_STAFF_PROMPT_ACCESS: enabled\n      GATEWAY_ADMIN_PORT: "8090"\n    ports:\n      - 0.0.0.0:8090:8090\n`,
    );
    writeFileSync(
      path.join(dir, "apps/api-node/deploy/entrypoint.sh"),
      `case "$role" in worker) ;; esac\n`,
    );
    writeFileSync(path.join(dir, "leak.env"), "AWS_KEY=AKIAIOSFODNN7EXAMPLE\n");
    git("add", ".");
    git("commit", "-qm", "bad");
    const errors = checkGatewaySecurity(dir);
    assert.ok(errors.some((e) => e.includes("retention")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("EXPOSE")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("GATEWAY_STAFF_PROMPT_ACCESS")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("GATEWAY_PUBLISH_HOST")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("entrypoint")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("leak.env")), errors.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
