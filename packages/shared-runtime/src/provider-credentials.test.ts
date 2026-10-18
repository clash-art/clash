import { describe, expect, it } from "vitest";
import {
  encryptProviderCredentials,
  selectProviderCredentials,
  type ProviderCredentialCandidateRow,
} from "./provider-credentials.js";

const SECRET = "provider-credentials-test-secret";

async function row(
  credentials: Record<string, string>,
  overrides: Partial<ProviderCredentialCandidateRow> = {},
): Promise<ProviderCredentialCandidateRow> {
  return {
    region: null,
    priority: null,
    supported_model_ids: null,
    model_priorities: null,
    updated_at: 1,
    encrypted_credentials: await encryptProviderCredentials(credentials, SECRET),
    ...overrides,
  };
}

describe("selectProviderCredentials", () => {
  it("prefers the per-model priority, then account priority, then the newest row", async () => {
    const rows = [
      await row({ apiKey: "low-priority" }, { priority: 1, updated_at: 9 }),
      await row({ apiKey: "model-pinned" }, { priority: 50, model_priorities: JSON.stringify({ " gemini-3-flash ": "0" }) }),
    ];
    await expect(
      selectProviderCredentials(rows, SECRET, {
        providerId: "official",
        modelCode: "gemini-3-flash",
        requiredCredentials: ["apiKey"],
      }),
    ).resolves.toEqual({ apiKey: "model-pinned" });
    await expect(
      selectProviderCredentials(rows, SECRET, { providerId: "official" }),
    ).resolves.toEqual({ apiKey: "low-priority" });
  });

  it("skips rows outside the region or model allow-list and rows missing a required key", async () => {
    const rows = [
      await row({ apiKey: "other-region" }, { region: "eu" }),
      await row({ apiKey: "other-model" }, { supported_model_ids: JSON.stringify(["some-other-model"]) }),
      await row({ baseUrl: "https://example.test" }),
      await row({ apiKey: "match" }, { region: "us", supported_model_ids: JSON.stringify([" gemini-3-flash "]) }),
    ];
    await expect(
      selectProviderCredentials(rows, SECRET, {
        providerId: "official",
        region: "us",
        modelCode: "gemini-3-flash",
        requiredCredentials: ["apiKey"],
      }),
    ).resolves.toEqual({ apiKey: "match" });
  });

  it("names the provider and missing keys when nothing matches", async () => {
    await expect(
      selectProviderCredentials([await row({ baseUrl: "x" })], SECRET, {
        providerId: "official",
        upstreamId: "google-ai-studio",
        requiredCredentials: ["apiKey"],
      }),
    ).rejects.toThrow("Provider credentials not configured for official/google-ai-studio. Missing: apiKey.");
  });
});
