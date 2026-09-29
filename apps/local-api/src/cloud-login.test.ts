import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCloudLogin } from "./cloud-login.js";
import { createCloudAccounts } from "./cloud-accounts.js";
it("uses PKCE loopback login and stores credentials only for the selected service", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-login-"));
  const requests: Array<{ url: string; headers: Headers }> = [];
  const login = createCloudLogin({
    dataDir,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/api/v1/cloud"))
        return Response.json({
          protocol: "clash-cloud-v1",
          auth: {
            clientId: "clash-cli",
            authorizationPath: "/auth/cli",
            tokenPath: "/api/v1/cli-auth/token",
          },
        });
      if (url.endsWith("/token")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("code")).toBe("returned-code");
        expect(form.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
        return Response.json({
          access_token: "clsh_" + "a".repeat(40),
          token_type: "Bearer",
        });
      }
      if (url.endsWith("/account"))
        return Response.json({
          user: { id: "owner", email: "user@example.test", name: "Owner" },
        });
      throw Error("Unexpected endpoint");
    },
  });
  try {
    const started = await login.start("https://selfhost.example");
    const auth = new URL(started.authorizationUrl);
    expect(auth.origin).toBe("https://selfhost.example");
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    callback.searchParams.set("code", "returned-code");
    await fetch(callback);
    await expect.poll(() => login.status(started.id).state).toBe("succeeded");
    const accounts = createCloudAccounts(dataDir);
    expect(await accounts.token("https://clash.art")).toBeUndefined();
    expect((await accounts.status()).user?.id).toBe("owner");
    expect(
      requests
        .filter((r) => !r.url.endsWith("/account"))
        .every((r) => !r.headers.has("authorization")),
    ).toBe(true);
    expect(JSON.stringify(login.status(started.id))).not.toContain("clsh_");
  } finally {
    login.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("rejects incompatible service discovery without changing the selected account", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-incompatible-"));
  const login = createCloudLogin({
    dataDir,
    fetch: async () => Response.json({ version: "unrelated" }),
  });
  try {
    const accounts = createCloudAccounts(dataDir);
    await accounts.select("https://original.example");
    await expect(login.start("https://other.example")).rejects.toThrow(
      /does not support/,
    );
    expect((await accounts.status()).serviceUrl).toBe(
      "https://original.example",
    );
  } finally {
    login.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("does not save a credential when login is cancelled during account verification", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-cancel-"));
  let release!: (response: Response) => void;
  const accountResponse = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let verifying = false;
  const login = createCloudLogin({
    dataDir,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/cloud"))
        return Response.json({
          protocol: "clash-cloud-v1",
          auth: {
            clientId: "clash-cli",
            authorizationPath: "/auth/cli",
            tokenPath: "/api/v1/cli-auth/token",
          },
        });
      if (url.endsWith("/token"))
        return Response.json({
          access_token: "clsh_" + "b".repeat(40),
          token_type: "Bearer",
        });
      verifying = true;
      return accountResponse;
    },
  });
  try {
    const started = await login.start("https://selfhost.example");
    const auth = new URL(started.authorizationUrl);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    callback.searchParams.set("code", "returned-code");
    await fetch(callback);
    await expect.poll(() => verifying).toBe(true);
    login.cancel();
    release(
      Response.json({
        user: { id: "u", name: "User", email: "u@example.test" },
      }),
    );
    await accountResponse;
    expect(login.status(started.id).state).toBe("cancelled");
    expect(
      await createCloudAccounts(dataDir).token("https://selfhost.example"),
    ).toBeUndefined();
  } finally {
    login.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
