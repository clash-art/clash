import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkIssueBody,
  checkPrBody,
  checkRepo,
  DIFF_SCOPING_PATTERNS,
  findScopingPhrases,
  isBot,
  isLoadBalancerConfig,
  nonFlashDeepSeekIds,
  parseAddedLines,
  zodVersions,
} from "./check-anti-patterns.ts";

const GOOD_PR = "Closes #12\n\n## Evidence\n- `pnpm test` passed";

test("PR body needs a closing reference and an Evidence heading", () => {
  assert.deepEqual(checkPrBody(GOOD_PR), []);
  assert.deepEqual(checkPrBody("Fixes clash-art/clash#3\n### Evidence\nok"), []);
  assert.equal(checkPrBody("## Evidence\nran it").length, 1);
  assert.equal(checkPrBody("Closes #4\nno evidence").length, 1);
  assert.equal(checkPrBody("Related to #4\nEvidence: trust me").length, 2);
});

test("scoping phrases fail PR and issue bodies", () => {
  for (const body of [
    "api-cf only for now",
    "Node later",
    "Node/self-host out of scope",
    "self-hosted is out of scope",
    "ship only api-cf",
    "CF-only first",
    "node only",
    "先只做 CF",
    "Node 以后再做",
  ]) {
    assert.ok(checkIssueBody(body).length > 0, body);
    assert.ok(checkPrBody(`${GOOD_PR}\n${body}`).length > 0, body);
  }
});

test("scoping scan ignores ordinary prose seen on master", () => {
  for (const text of [
    "# apps/render-server/Dockerfile.cf only when someone runs `wrangler deploy`.",
    "a malformed reference fails that node only.",
    "客户端只做同步",
    "Shared Project Host modules are platform-agnostic; only api-cf / api-node adapters bind ports",
  ])
    assert.deepEqual(findScopingPhrases(text, DIFF_SCOPING_PATTERNS), [], text);
});

test("bots are skipped", () => {
  assert.ok(isBot({ login: "dependabot[bot]", type: "Bot" }));
  assert.ok(isBot({ login: "renovate[bot]" }));
  assert.ok(!isBot({ login: "octocat", type: "User" }));
});

test("zod versions come from lockfile package keys", () => {
  assert.deepEqual(zodVersions("packages:\n\n  zod@4.6.7:\n    x\n  zod-to-json-schema@3.25.2(zod@4.6.7):\n"), ["4.6.7"]);
  assert.deepEqual(zodVersions("  zod@3.25.76:\n  zod@4.6.7:\n  'zod@4.6.7': {}\n"), ["3.25.76", "4.6.7"]);
});

test("load balancer configs are recognised", () => {
  for (const f of ["deploy/nginx.conf", "Caddyfile", "ops/traefik.yml", "traefik-dynamic.yaml", "haproxy.cfg", "infra/lb-lite.ts"])
    assert.ok(isLoadBalancerConfig(f), f);
  for (const f of ["apps/api-node/src/gateway-node.ts", "docs/nginx-notes.md"]) assert.ok(!isLoadBalancerConfig(f), f);
});

test("only DeepSeek Flash ids pass", () => {
  assert.deepEqual(nonFlashDeepSeekIds('"deepseek-flash" deepseek-v4-flash deepseek/deepseek-flash DEEPSEEK_API_KEY DeepSeek-shaped /deepseek/i'), []);
  assert.deepEqual(nonFlashDeepSeekIds("deepseek-chat deepseek-reasoner deepseek-v3 deepseek/deepseek-v4-pro"), [
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v3",
    "deepseek/deepseek-v4-pro",
  ]);
});

test("added lines are parsed per file", () => {
  const diff = "+++ b/a.md\n@@ -0,0 +1 @@\n+api-cf only\n+++ /dev/null\n+gone\n";
  assert.deepEqual([...parseAddedLines(diff)], [["a.md", ["api-cf only"]]]);
});

test("repo mode flags synthetic violations in a scratch git repo", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clash-anti-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "  zod@4.6.7:\n");
    writeFileSync(path.join(dir, "model.ts"), 'export const m = "deepseek-flash";\n');
    git("add", ".");
    git("commit", "-qm", "base");
    assert.deepEqual(checkRepo(dir, "HEAD"), []);
    mkdirSync(path.join(dir, "deploy"));
    writeFileSync(path.join(dir, "deploy/nginx.conf"), "upstream x {}\n");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "  zod@3.25.76:\n  zod@4.6.7:\n");
    writeFileSync(path.join(dir, "model.ts"), '// api-cf only, Node later\nexport const m = "deepseek-reasoner";\n');
    git("add", ".");
    git("commit", "-qm", "bad");
    const errors = checkRepo(dir, "HEAD~1");
    assert.equal(errors.filter((e) => e.includes("nginx.conf")).length, 1);
    assert.equal(errors.filter((e) => e.includes("zod")).length, 1);
    assert.equal(errors.filter((e) => e.includes("deepseek-reasoner")).length, 1);
    assert.equal(errors.filter((e) => e.includes("scoping")).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
