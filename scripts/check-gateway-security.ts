#!/usr/bin/env node
/**
 * Gateway-node security mechanical checks (#385 / N29). Plain Node 24, no
 * dependencies. Complements scripts/check-anti-patterns.ts (Flash-only, zod,
 * LB, scoping).
 *
 *   node scripts/check-gateway-security.ts
 *   node scripts/check-gateway-security.ts --root <path>
 *
 * Checks:
 *   1. High-confidence secret patterns are absent from tracked text files
 *      (allowlisted fixtures/tests/examples may quote fakes).
 *   2. Self-host defaults: no prompt/body retention wiring, Dockerfile does
 *      not EXPOSE the admin port, compose publishes admin on loopback by
 *      default, GATEWAY_STAFF_PROMPT_ACCESS is not enabled in Node deploy.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");

/** High-confidence credential shapes — not the fake sk_test_ / sk_gw_ fixtures. */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // A real PEM blob (header + base64 body), not a parser that only mentions the marker.
  {
    name: "PEM private key",
    // eslint-disable-next-line prefer-regex-literals -- body must include newlines
    re: new RegExp(
      "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
      "g",
    ),
  },
  { name: "GitHub PAT", re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Stripe live secret", re: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  // OpenAI sk-/sk-proj- keys are long alphanumerics; hyphenated smoke values are ignored.
  { name: "OpenAI live-looking key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{40,}\b/g },
  { name: "Anthropic live-looking key", re: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{40,}\b/g },
];

const SCANNED = /\.(?:[cm]?[jt]sx?|json|jsonl|ya?ml|toml|md|mdx|sql|env|example|sh|py|Dockerfile)$/i;

/** Paths allowed to contain the patterns above (tests, fixtures, docs quoting them). */
export function isSecretScanAllowlisted(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  if (f.includes("/node_modules/") || f.startsWith("node_modules/")) return true;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f)) return true;
  if (f.includes("/testing/") || f.includes("/fixtures/") || f.includes("/evidence/") || f.includes("/e2e/")) return true;
  if (f.includes("mock-upstream")) return true;
  if (f.endsWith(".example") || f.endsWith(".example.env") || /(^|\/)\.env\.example$/.test(f)) return true;
  if (
    f === "scripts/check-gateway-security.ts" ||
    f === "scripts/check-gateway-security.test.ts" ||
    f === "scripts/check-anti-patterns.ts" ||
    f === "scripts/check-anti-patterns.test.ts" ||
    f === ".github/scripts/redact-gateway-ci-artifact.mjs" ||
    f === ".github/scripts/redact-gateway-ci-artifact.test.mjs"
  )
    return true;
  if (f.startsWith("apps/docs/guide/gateway-node-threat-model.md")) return true;
  if (f.startsWith("apps/api-node/deploy/ops/SBOM.md")) return true;
  return false;
}

function gitLsFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

export function findSecretHits(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

export function checkSecretScan(root: string): string[] {
  const errors: string[] = [];
  for (const file of gitLsFiles(root)) {
    if (!SCANNED.test(file) && path.basename(file) !== "Dockerfile") continue;
    if (isSecretScanAllowlisted(file)) continue;
    let text: string;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    // Skip binary-ish blobs.
    if (text.includes("\0")) continue;
    const hits = findSecretHits(text);
    if (hits.length) errors.push(`${file}: possible secret material (${hits.join(", ")}); remove or move to a secret store.`);
  }
  return errors;
}

const GATEWAY_NODE = "apps/api-node/src/gateway-node.ts";
const DOCKERFILE = "apps/api-node/deploy/Dockerfile";
const COMPOSE = "apps/api-node/deploy/compose.yaml";
const ENTRYPOINT = "apps/api-node/deploy/entrypoint.sh";

export function checkGatewayDefaults(root: string): string[] {
  const errors: string[] = [];
  const read = (rel: string) => {
    const p = path.join(root, rel);
    if (!existsSync(p)) {
      errors.push(`${rel}: missing (required for gateway-node security checks).`);
      return "";
    }
    return readFileSync(p, "utf8");
  };

  const nodeSrc = read(GATEWAY_NODE);
  if (nodeSrc) {
    if (!/retention:\s*unavailablePort\(\s*["']retention["']\s*\)/.test(nodeSrc))
      errors.push(`${GATEWAY_NODE}: self-host must keep retention: unavailablePort("retention") (no prompt/body logging by default).`);
    if (/retention\s*:\s*\{[^}]*enabled\s*:\s*true/.test(nodeSrc))
      errors.push(`${GATEWAY_NODE}: must not enable gateway-core retention by default.`);
    if (/GATEWAY_STAFF_PROMPT_ACCESS\s*=\s*["']enabled["']/.test(nodeSrc))
      errors.push(`${GATEWAY_NODE}: GATEWAY_STAFF_PROMPT_ACCESS=enabled is hosted-only; refuse on self-host defaults.`);
  }

  const dockerfile = read(DOCKERFILE);
  if (dockerfile) {
    const exposes = [...dockerfile.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].map((m) => m[1]!.trim());
    if (exposes.length === 0) errors.push(`${DOCKERFILE}: expected EXPOSE 8080 for the public listener.`);
    for (const line of exposes) {
      if (!/^8080(?:\/tcp)?$/i.test(line))
        errors.push(`${DOCKERFILE}: EXPOSE must be only 8080 (public PORT); admin stays on GATEWAY_ADMIN_PORT, got "${line}".`);
    }
    if (/GATEWAY_ENCRYPTION_KEYS\s*=|POSTGRES_PASSWORD\s*=|ADMIN_AUTH_SECRET\s*=/.test(dockerfile))
      errors.push(`${DOCKERFILE}: must not assign runtime secrets in the image.`);
    if (!/GATEWAY_ROLE=api/.test(dockerfile))
      errors.push(`${DOCKERFILE}: default GATEWAY_ROLE should be api.`);
  }

  const compose = read(COMPOSE);
  if (compose) {
    if (/GATEWAY_STAFF_PROMPT_ACCESS\s*:\s*["']?enabled["']?/.test(compose))
      errors.push(`${COMPOSE}: must not enable GATEWAY_STAFF_PROMPT_ACCESS (self-host ≠ hosted staff prompt policy).`);
    // Admin publish host defaults to loopback.
    if (!/GATEWAY_PUBLISH_HOST:-\s*127\.0\.0\.1/.test(compose))
      errors.push(`${COMPOSE}: published ports should default GATEWAY_PUBLISH_HOST to 127.0.0.1.`);
    if (!/GATEWAY_ADMIN_PORT/.test(compose))
      errors.push(`${COMPOSE}: admin service must set GATEWAY_ADMIN_PORT (separate listener).`);
  }

  const entry = read(ENTRYPOINT);
  if (entry && !/api\|admin\|all/.test(entry))
    errors.push(`${ENTRYPOINT}: GATEWAY_ROLE matrix must remain api|admin|all|migrate.`);

  return errors;
}

export function checkGatewaySecurity(root: string): string[] {
  return [...checkSecretScan(root), ...checkGatewayDefaults(root)];
}

export function main(argv: string[]): number {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i] ?? "");
  }
  const errors = checkGatewaySecurity(root);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`gateway-security: ${errors.length} issue(s)`);
    return 1;
  }
  console.log("gateway-security: ok");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
