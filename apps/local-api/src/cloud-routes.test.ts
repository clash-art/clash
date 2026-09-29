import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalApiApp } from "./app.js";
import { createCloudAccounts } from "./cloud-accounts.js";
it("serves local cloud account state without exposing credentials and rejects foreign browser writes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-routes-"));
  try {
    const accounts = createCloudAccounts(dataDir);
    await accounts.save("https://selfhost.example", {
      token: "private-token",
      user: { id: "u", name: "User", email: "u@example.test" },
    });
    await accounts.select("https://selfhost.example");
    const app = createLocalApiApp({ dataDir });
    const response = await app.request("http://localhost/api/v1/local/cloud");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("u@example.test");
    expect(text).not.toContain("private-token");
    expect(
      (
        await app.request("http://localhost/api/v1/local/cloud/logout", {
          method: "POST",
          headers: {
            origin: "https://foreign.example",
            "content-type": "application/json",
          },
          body: JSON.stringify({ serviceUrl: "https://selfhost.example" }),
        })
      ).status,
    ).toBe(403);
    expect(await accounts.token("https://selfhost.example")).toBe(
      "private-token",
    );
    expect(
      (
        await app.request("http://localhost/api/v1/local/cloud/logout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serviceUrl: "https://selfhost.example" }),
        })
      ).status,
    ).toBe(200);
    expect(await accounts.token("https://selfhost.example")).toBeUndefined();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
