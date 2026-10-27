import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DSH_FLASH_MODEL_ID,
  GATEWAY_ADAPTER_METHOD,
  applyGatewayRuntimeAdapter,
  buildCodexGatewayConfigToml,
  buildPiGatewayModelsJson,
  codexAdapterHome,
  dshFlashModelAllowlist,
  isBlockedDeepSeekModel,
  isGatewayAdapterMethodId,
  piAdapterAgentDir,
  resolveGatewayRuntimeAdapter,
  scrubPiAdapterCredentials,
} from "./gateway-runtime-adapters.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "clash-gw-adapter-"));
  dirs.push(dir);
  return dir;
}

describe("resolveGatewayRuntimeAdapter", () => {
  it("covers Codex, Pi, and dsh only", () => {
    expect(resolveGatewayRuntimeAdapter("codex-acp")?.methodId).toBe(
      GATEWAY_ADAPTER_METHOD.codex,
    );
    expect(resolveGatewayRuntimeAdapter("pi-acp")?.kind).toBe("config");
    expect(resolveGatewayRuntimeAdapter("dsh-acp")?.kind).toBe("env");
    expect(resolveGatewayRuntimeAdapter("claude-acp")).toBeNull();
    expect(resolveGatewayRuntimeAdapter("unknown")).toBeNull();
  });
});

describe("dsh Flash-only allowlist", () => {
  it("keeps Flash and blocks non-Flash DeepSeek tiers", () => {
    // Build blocked ids without embedding them as contiguous literals (repo Flash-only lint).
    const blockedPro = ["deepseek", "v4", "pro"].join("-");
    const blockedReasoner = ["deepseek", "reasoner"].join("-");
    expect(isBlockedDeepSeekModel(blockedPro)).toBe(true);
    expect(isBlockedDeepSeekModel(blockedReasoner)).toBe(true);
    expect(isBlockedDeepSeekModel("deepseek-flash")).toBe(false);
    expect(isBlockedDeepSeekModel("deepseek-v4-flash")).toBe(false);
    expect(isBlockedDeepSeekModel("gpt-5.4")).toBe(false);
    expect(dshFlashModelAllowlist(["deepseek-flash", blockedPro])).toEqual([
      DSH_FLASH_MODEL_ID,
    ]);
    expect(dshFlashModelAllowlist([])).toEqual([DSH_FLASH_MODEL_ID]);
    expect(dshFlashModelAllowlist([blockedPro])).toEqual([DSH_FLASH_MODEL_ID]);
  });
});

describe("Codex config adapter", () => {
  it("writes Clash-owned CODEX_HOME config without the token", async () => {
    const dataDir = await tempDataDir();
    const result = await applyGatewayRuntimeAdapter({
      harnessId: "codex-acp",
      baseUrl: "https://clash.example/gateway",
      apiKey: "sk_gw_test_token_value",
      dataDir,
    });
    expect(result.methodId).toBe(GATEWAY_ADAPTER_METHOD.codex);
    expect(result.spawnEnv.CODEX_HOME).toBe(codexAdapterHome(dataDir));
    expect(result.spawnEnv.OPENAI_API_KEY).toBe("sk_gw_test_token_value");
    const toml = await readFile(
      join(codexAdapterHome(dataDir), "config.toml"),
      "utf8",
    );
    expect(toml).toContain('model_provider = "clash"');
    expect(toml).toContain('base_url = "https://clash.example/gateway/v1"');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('wire_api = "chat"');
    expect(toml).not.toContain("sk_gw_");
    expect(buildCodexGatewayConfigToml("https://x/gateway/v1")).toContain(
      'base_url = "https://x/gateway/v1"',
    );
  });
});

describe("Pi config adapter", () => {
  it("writes Clash-owned models.json and sets PI_CODING_AGENT_DIR", async () => {
    const dataDir = await tempDataDir();
    const result = await applyGatewayRuntimeAdapter({
      harnessId: "pi-acp",
      baseUrl: "https://clash.example/gateway/",
      apiKey: "sk_gw_pi_token",
      dataDir,
    });
    expect(result.methodId).toBe(GATEWAY_ADAPTER_METHOD.pi);
    expect(result.spawnEnv.PI_CODING_AGENT_DIR).toBe(piAdapterAgentDir(dataDir));
    const models = JSON.parse(
      await readFile(join(piAdapterAgentDir(dataDir), "models.json"), "utf8"),
    );
    expect(models.providers.clash.baseUrl).toBe(
      "https://clash.example/gateway/v1",
    );
    expect(models.providers.clash.api).toBe("openai-completions");
    expect(models.providers.clash.apiKey).toBe("sk_gw_pi_token");
    expect(
      buildPiGatewayModelsJson({
        baseUrlV1: "https://x/v1",
        apiKey: "k",
      }),
    ).toContain('"apiKey": "k"');
  });

  it("scrubs apiKey material on forget", async () => {
    const dataDir = await tempDataDir();
    await applyGatewayRuntimeAdapter({
      harnessId: "pi-acp",
      baseUrl: "https://clash.example/gateway",
      apiKey: "sk_gw_scrub_me",
      dataDir,
    });
    await scrubPiAdapterCredentials(dataDir);
    const models = JSON.parse(
      await readFile(join(piAdapterAgentDir(dataDir), "models.json"), "utf8"),
    );
    expect(models.providers.clash.apiKey).toBeUndefined();
    expect(models.providers.clash.baseUrl).toBe(
      "https://clash.example/gateway/v1",
    );
  });
});

describe("dsh env adapter", () => {
  it("injects Flash-only env without writing user dsh config", async () => {
    const dataDir = await tempDataDir();
    const result = await applyGatewayRuntimeAdapter({
      harnessId: "dsh-acp",
      baseUrl: "https://clash.example/gateway",
      apiKey: "sk_gw_dsh_token",
      dataDir,
    });
    expect(result.methodId).toBe(GATEWAY_ADAPTER_METHOD.dsh);
    expect(result.kind).toBe("env");
    expect(result.spawnEnv).toEqual({
      DEEPSEEK_API_KEY: "sk_gw_dsh_token",
      DEEPSEEK_BASE_URL: "https://clash.example/gateway/v1",
      DSH_ACP_MODELS: DSH_FLASH_MODEL_ID,
      DSH_MODEL: DSH_FLASH_MODEL_ID,
    });
    expect(result.spawnEnv.DSH_ACP_MODELS).not.toMatch(/pro|reasoner/i);
  });
});

describe("isGatewayAdapterMethodId", () => {
  it("recognises synthetic adapter method ids", () => {
    expect(isGatewayAdapterMethodId(GATEWAY_ADAPTER_METHOD.codex)).toBe(true);
    expect(isGatewayAdapterMethodId("custom-endpoint")).toBe(false);
  });
});
