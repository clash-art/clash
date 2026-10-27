// Mechanical checks for the anti-patterns in CONTRIBUTING.md. Plain Node 24,
// no dependencies. Modes:
//   node scripts/check-anti-patterns.ts pr-body    <event.json>
//   node scripts/check-anti-patterns.ts issue-body <event.json>
//   node scripts/check-anti-patterns.ts repo [--base <git-rev>]
// Anything not listed here (official SDKs, reinvention, ambiguous states,
// production access) is reviewed by hand; see CONTRIBUTING.md.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Single-backend scoping phrases. Matched case-insensitively. */
export const SCOPING_PATTERNS: readonly RegExp[] = [
  /(?<![\w.])api-cf[- ]only\b/i,
  /(?<![\w.-])(?:cf|cloudflare)[- ]only\b/i,
  /\bonly (?:on |for )?api-(?:cf|node)\b(?!\s*\/)/i,
  /(?<![\w.])(?:api-)?node[- ]only\b/i,
  /\b(?:api-)?node (?:support )?(?:later|in a follow[- ]?up)\b/i,
  /\b(?:api-)?node(?:\/self-host(?:ed)?)? (?:is )?out of scope\b/i,
  /\bself-host(?:ed|ing)? (?:is )?out of scope\b/i,
  /只做\s*(?:api-)?(?:cf|cloudflare|node)/i,
  /node\s*(?:以后|后续|之后)/i,
];

/** Stricter subset for diff lines: prose about one graph node must not trip it. */
export const DIFF_SCOPING_PATTERNS: readonly RegExp[] = SCOPING_PATTERNS.filter(
  (re) => !re.source.includes("node[- ]only"),
);

export function findScopingPhrases(text: string, patterns = SCOPING_PATTERNS): string[] {
  const hits: string[] = [];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}

export interface Author {
  login?: string;
  type?: string;
}

export function isBot(user: Author | undefined): boolean {
  if (!user) return false;
  const login = user.login ?? "";
  return user.type === "Bot" || login.endsWith("[bot]") || login.startsWith("dependabot");
}

export function checkPrBody(body: string): string[] {
  const errors: string[] = [];
  if (!/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+\b/i.test(body))
    errors.push("PR body must reference its issue with `Closes #<n>` (or Fixes/Resolves).");
  if (!/^#{1,6}\s*evidence\b/im.test(body))
    errors.push("PR body must have an `## Evidence` section: commands run, results, real CI links.");
  for (const hit of findScopingPhrases(body))
    errors.push(`Single-backend scoping phrase "${hit}": build on the shared abstraction and wire both hosts.`);
  return errors;
}

export function checkIssueBody(body: string): string[] {
  return findScopingPhrases(body).map(
    (hit) => `Single-backend scoping phrase "${hit}": scope the issue to both hosts.`,
  );
}

/** Returns every zod version resolved in a pnpm-lock.yaml. */
export function zodVersions(lock: string): string[] {
  const versions = new Set<string>();
  for (const m of lock.matchAll(/^ {2}'?zod@(\d[^:('\s]*)/gm)) versions.add(m[1]);
  return [...versions].sort();
}

const LB_FILE = /(?:^|\/)(?:nginx[^/]*\.conf|Caddyfile[^/]*|traefik[^/]*\.ya?ml|traefik[^/]*\.toml|haproxy[^/]*\.cfg|lb-lite[^/]*)$/i;

export function isLoadBalancerConfig(file: string): boolean {
  return LB_FILE.test(file);
}

/** Any lowercase DeepSeek model id (as providers spell them) that is not a Flash id. */
const DEEPSEEK_ID = /\bdeepseek[-/](?:deepseek-)?[a-z0-9][a-z0-9.-]+/g;
const NON_MODEL = /^deepseek-(?:not-flash|test|\d+)$/i;

export function nonFlashDeepSeekIds(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(DEEPSEEK_ID)) {
    const id = m[0].replace(/[.-]+$/, "");
    if (/flash/i.test(id) || NON_MODEL.test(id) || /\.(?:png|jpe?g|webp|svg|ts|tsx|json)$/i.test(id)) continue;
    hits.push(id);
  }
  return hits;
}

/**
 * Files allowed to name a blocked DeepSeek id: the policy tests that prove it
 * is rejected, and a captured upstream session (rewriting it would forge it).
 */
export const DEEPSEEK_ALLOWED_FILES = new Set([
  "packages/gateway-core/src/catalog-policy.test.ts",
  "packages/gateway-core/src/billing.test.ts",
  "packages/gateway-core/src/catalog.test.ts",
  "apps/api-node/src/gateway-schema.test.ts",
  "apps/api-node/src/gateway-security.test.ts",
  "apps/api-cf/src/gateway/d1-billing.test.ts",
  "apps/api-cf/src/routes/v1/admin/gateway.test.ts",
  "apps/api-cf/src/routes/v1/admin/gateway-console.test.ts",
  "apps/api-cf/src/routes/v1/admin/gateway-catalog-publish.test.ts",
  "packages/shared-artifact-evals/src/acp-pi-session.fixture.jsonl",
]);

/** Files that document or test these rules and therefore quote them. */
const RULE_FILES = new Set([
  "CONTRIBUTING.md",
  "docs/anti-patterns.md",
  "scripts/check-anti-patterns.ts",
  "scripts/check-anti-patterns.test.ts",
]);

const SCANNED = /\.(?:[cm]?[jt]sx?|json|jsonl|ya?ml|toml|md|mdx|sql|env|example|sh|py)$/i;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Added lines per file in `base...HEAD`. */
export function parseAddedLines(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : "";
      continue;
    }
    if (file && line.startsWith("+") && !line.startsWith("+++")) {
      const list = out.get(file) ?? [];
      list.push(line.slice(1));
      out.set(file, list);
    }
  }
  return out;
}

export function checkRepo(root: string, base?: string): string[] {
  const errors: string[] = [];
  const files = git(["ls-files", "-z"], root).split("\0").filter(Boolean);

  for (const f of files)
    if (isLoadBalancerConfig(f))
      errors.push(`${f}: load balancer config is the deployer's job, not a product deliverable.`);

  const versions = zodVersions(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  if (versions.length > 1) errors.push(`pnpm-lock.yaml resolves several zod versions (${versions.join(", ")}); keep one.`);

  for (const f of files) {
    if (!SCANNED.test(f) || RULE_FILES.has(f) || DEEPSEEK_ALLOWED_FILES.has(f) || f === "pnpm-lock.yaml") continue;
    let text: string;
    try {
      text = readFileSync(path.join(root, f), "utf8");
    } catch {
      continue;
    }
    if (!/deepseek/i.test(text)) continue;
    const ids = [...new Set(nonFlashDeepSeekIds(text))];
    if (ids.length) errors.push(`${f}: non-Flash DeepSeek model id(s) ${ids.join(", ")}; use DeepSeek Flash only.`);
  }

  if (base && !/^0+$/.test(base)) {
    const added = parseAddedLines(git(["diff", "--unified=0", "--no-color", `${base}...HEAD`], root));
    for (const [f, lines] of added) {
      if (RULE_FILES.has(f) || f === "pnpm-lock.yaml") continue;
      for (const line of lines)
        for (const hit of findScopingPhrases(line, DIFF_SCOPING_PATTERNS))
          errors.push(`${f}: added single-backend scoping phrase "${hit}".`);
    }
  }
  return errors;
}

function readEvent(file: string | undefined): Record<string, any> {
  if (!file) throw new Error("missing event payload path");
  return JSON.parse(readFileSync(file, "utf8"));
}

export function main(argv: string[]): number {
  const [mode, arg, value] = argv;
  let errors: string[];
  if (mode === "pr-body") {
    const pr = readEvent(arg).pull_request ?? {};
    if (isBot(pr.user)) {
      console.log(`skip: bot PR by ${pr.user?.login}`);
      return 0;
    }
    errors = checkPrBody(pr.body ?? "");
  } else if (mode === "issue-body") {
    const issue = readEvent(arg).issue ?? {};
    if (isBot(issue.user)) return 0;
    errors = checkIssueBody(`${issue.title ?? ""}\n${issue.body ?? ""}`);
  } else if (mode === "repo") {
    errors = checkRepo(process.cwd(), arg === "--base" ? value : undefined);
  } else {
    console.error("usage: check-anti-patterns.ts pr-body|issue-body <event.json> | repo [--base <rev>]");
    return 2;
  }
  for (const e of errors) console.error(`::error::${e}`);
  if (errors.length) console.error(`\n${errors.length} anti-pattern violation(s). See CONTRIBUTING.md#anti-patterns.`);
  else console.log(`check-anti-patterns ${mode}: ok`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
