import { describe, expect, it } from "vitest";

import { AUDIT_REDACTED, redactAuditValue } from "./d1-admin-audit";

describe("admin audit redaction", () => {
  it("redacts secret-named keys at any depth and keeps configuration", () => {
    expect(
      redactAuditValue({
        credential: { apiKey: "anything", baseUrl: "https://api.example.test" },
        tokenHash: "abc",
        accessToken: "abc",
        password: "p",
        encrypted_credentials: "v1.envelope",
        nested: [{ clientSecret: "s" }],
        rateLimit: { tokensPerMinute: 100, requestsPerMinute: 5 },
        inputTokens: 3,
        secretRef: "GATEWAY_UPSTREAM_OPENAI",
      }),
    ).toEqual({
      credential: { apiKey: AUDIT_REDACTED, baseUrl: "https://api.example.test" },
      tokenHash: AUDIT_REDACTED,
      accessToken: AUDIT_REDACTED,
      password: AUDIT_REDACTED,
      encrypted_credentials: AUDIT_REDACTED,
      nested: [{ clientSecret: AUDIT_REDACTED }],
      rateLimit: { tokensPerMinute: 100, requestsPerMinute: 5 },
      inputTokens: 3,
      secretRef: "GATEWAY_UPSTREAM_OPENAI",
    });
  });

  it("redacts credential-shaped values under innocent keys", () => {
    expect(
      redactAuditValue({ note: "sk-live-123", label: "clsh_abc", gw: "sk_gw_x.y", header: "Bearer abc", name: "Team" }),
    ).toEqual({ note: AUDIT_REDACTED, label: AUDIT_REDACTED, gw: AUDIT_REDACTED, header: AUDIT_REDACTED, name: "Team" });
    // A secretRef that is not a binding name is treated as a secret.
    expect(redactAuditValue({ secretRef: "hunter2" })).toEqual({ secretRef: AUDIT_REDACTED });
  });
});
