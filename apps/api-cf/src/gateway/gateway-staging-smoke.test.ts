/**
 * #360 optional staging smoke (REPORT §13 case 15). Never production.
 *
 * Enable with GATEWAY_STAGING_SMOKE=1 and GATEWAY_STAGING_BASE_URL /
 * GATEWAY_STAGING_TOKEN (a staging virtual key). Writes a redacted artifact
 * under artifacts/gateway-staging-smoke/; secrets are never printed.
 *
 * DeepSeek Flash-only if any model appears. Not a multi-hour soak.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const enabled = process.env.GATEWAY_STAGING_SMOKE === "1";
const baseUrl = process.env.GATEWAY_STAGING_BASE_URL?.replace(/\/$/, "");
const token = process.env.GATEWAY_STAGING_TOKEN;
const model = process.env.GATEWAY_STAGING_MODEL ?? "deepseek-flash";

function redact(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .replace(/clsh_[A-Za-z0-9._-]+/g, "clsh_[REDACTED]")
    .replace(/sk_gw_[A-Za-z0-9._-]+/g, "sk_gw_[REDACTED]");
}

describe.skipIf(!enabled)("#360 staging smoke (env-gated, never production)", () => {
  it("completes one text chat on staging and records a redacted artifact", async () => {
    expect(baseUrl, "GATEWAY_STAGING_BASE_URL").toBeTruthy();
    expect(token, "GATEWAY_STAGING_TOKEN").toBeTruthy();
    expect(baseUrl!).not.toMatch(/clash\.art|production|prod\./i);

    const started = Date.now();
    const res = await fetch(`${baseUrl}/gateway/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
      }),
    });
    const raw = await res.text();
    const requestId = res.headers.get("x-clash-request-id");
    const errorCode = res.headers.get("x-clash-error-code");
    const artifact = {
      at: new Date().toISOString(),
      baseHost: new URL(baseUrl!).host,
      model,
      status: res.status,
      errorCode,
      requestId,
      elapsedMs: Date.now() - started,
      bodyPreview: redact(raw).slice(0, 500),
    };
    const dir = path.join(REPO_ROOT, "artifacts/gateway-staging-smoke");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `smoke-${Date.now()}.json`);
    await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    expect(res.status, redact(raw)).toBe(200);
    expect(requestId).toMatch(/\S/);
    expect(redact(raw)).not.toMatch(/sk-|clsh_|Bearer\s+[A-Za-z0-9]/);
  });
});
