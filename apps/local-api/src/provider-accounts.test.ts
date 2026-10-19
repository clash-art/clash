import { createRequire } from "node:module";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeProviderAccountInput, providerAccountsForRuntime, publicProviderAccounts } from "./provider-accounts";
import { createLocalProviderStore } from "./local-provider-store";

const require = createRequire(import.meta.url);

async function tempProviderDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clash-local-provider-store-"));
}

function readSqlitePragma(dataDir: string, pragma: string): string | number | undefined {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      prepare(sql: string): { get(): Record<string, string | number> | undefined };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"), { timeout: 5_000 });
  try {
    const row = db.prepare(`PRAGMA ${pragma}`).get();
    return row ? Object.values(row)[0] : undefined;
  } finally {
    db.close();
  }
}

function readMigrationMarker(dataDir: string, id: string): boolean {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      prepare(sql: string): { get(value: string): Record<string, unknown> | undefined };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"), { timeout: 5_000 });
  try {
    return Boolean(db.prepare("SELECT id FROM local_migration WHERE id = ?").get(id));
  } finally {
    db.close();
  }
}

function createPartialProviderSqlite(dataDir: string): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"), { timeout: 5_000 });
  try {
    db.exec(`
      CREATE TABLE local_migration (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE provider_accounts (
        user_id TEXT NOT NULL,
        account_key TEXT NOT NULL,
        PRIMARY KEY (user_id, account_key)
      );
      CREATE TABLE provider_account_credentials (user_id TEXT NOT NULL);
      CREATE TABLE provider_account_supported_models (user_id TEXT NOT NULL);
      CREATE TABLE provider_account_model_priorities (user_id TEXT NOT NULL);
      CREATE TABLE provider_oauth (
        user_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        PRIMARY KEY (user_id, provider_id)
      );
    `);
  } finally {
    db.close();
  }
}

describe("provider accounts", () => {
  it("appends immutable provider usage events without overwriting a replayed event id", async () => {
    const dataDir = await tempProviderDir();
    const store = createLocalProviderStore(dataDir);
    const original = {
      id: "usage-task-1-submitted",
      userId: "local-user",
      providerId: "pika",
      providerAccountId: "pika-primary",
      modelId: "pika-2.5",
      operation: "pika/pika-2.5/text-to-video",
      taskId: "task-1",
      projectId: "project-1",
      nodeId: "node-1",
      providerRequestId: "media-1",
      idempotencyKey: "task-1",
      status: "submitted" as const,
      estimatedCostMicroUsd: 200_000,
      estimateComplete: true,
      currency: "USD" as const,
      pricingSource: "pika-catalog" as const,
      billingBasis: { resolution: "720p", duration_s: 5 },
      occurredAt: "2026-08-05T12:00:00.000Z",
    };

    await store.appendProviderUsageEvent(original);
    await store.appendProviderUsageEvent({ ...original, status: "failed", estimatedCostMicroUsd: 999_999 });

    await expect(store.listProviderUsageEvents("local-user", 20)).resolves.toEqual([original]);
  });

  it("does not initialize secret storage when provider tables are empty", async () => {
    const dataDir = await tempProviderDir();
    createPartialProviderSqlite(dataDir);
    const store = createLocalProviderStore(dataDir);

    await expect(store.loadProviderAccounts()).resolves.toEqual([]);
    await expect(store.loadProviderOAuth()).resolves.toEqual([]);
    await expect(store.saveProviderAccounts([])).resolves.toBeUndefined();
    await expect(store.saveProviderOAuth([])).resolves.toBeUndefined();
    await expect(stat(join(dataDir, "provider-secret.key"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("initializes sqlite provider storage with WAL journal mode for local multi-client safety", async () => {
    const dataDir = await tempProviderDir();
    const store = createLocalProviderStore(dataDir);

    await store.saveProviderAccounts([
      {
        userId: "user-1",
        providerId: "mock",
        enabled: true,
      },
    ]);

    expect(readSqlitePragma(dataDir, "journal_mode")).toBe("wal");
  });

  it("upgrades partial sqlite provider tables before provider access", async () => {
    const dataDir = await tempProviderDir();
    createPartialProviderSqlite(dataDir);
    const store = createLocalProviderStore(dataDir);

    await expect(store.loadProviderAccounts()).resolves.toEqual([]);
    await expect(store.loadProviderOAuth()).resolves.toEqual([]);
    await expect(store.saveProviderAccounts([
      {
        userId: "user-1",
        id: "mock-primary",
        providerId: "mock",
        enabled: true,
        credentials: { apiKey: "sk-local" },
        supportedModelIds: ["nano-banana-2"],
        modelPriorities: { "nano-banana-2": 1 },
      },
    ])).resolves.toBeUndefined();
    await expect(store.saveProviderOAuth([
      {
        userId: "user-1",
        providerId: "example-oauth",
        accountId: "mock-primary",
        status: "authorized",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      {
        userId: "user-1",
        providerId: "example-oauth",
        accountId: "mock-secondary",
        status: "pending",
        userCode: "user-code",
        deviceCode: "device-code",
      },
    ])).resolves.toBeUndefined();

    await expect(store.loadProviderAccounts()).resolves.toMatchObject([
      {
        userId: "user-1",
        id: "mock-primary",
        providerId: "mock",
        enabled: true,
        credentials: { apiKey: "sk-local" },
        supportedModelIds: ["nano-banana-2"],
        modelPriorities: { "nano-banana-2": 1 },
      },
    ]);
    await expect(store.loadProviderOAuth()).resolves.toMatchObject([
      {
        userId: "user-1",
        providerId: "example-oauth",
        accountId: "mock-primary",
        status: "authorized",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      {
        userId: "user-1",
        providerId: "example-oauth",
        accountId: "mock-secondary",
        status: "pending",
        userCode: "user-code",
        deviceCode: "device-code",
      },
    ]);
  });

  it("exposes provider account credentials without env-shaped variable keys", () => {
    const providers = publicProviderAccounts(
      [
        { userId: "user-1", providerId: "kling", upstreamId: "kling", enabled: true, credentials: { accessKey: "ak", secretKey: "sk" } },
        { userId: "user-1", providerId: "minimax", upstreamId: "minimax", enabled: true, credentials: { apiKey: "mini" } },
        { userId: "user-1", providerId: "volcengine", upstreamId: "volcengine", enabled: true, credentials: { apiKey: "volc", baseUrl: "https://ark.example/v3" } },
        { userId: "user-1", providerId: "elevenlabs", upstreamId: "elevenlabs", enabled: true, credentials: { apiKey: "eleven" } },
      ],
      "user-1",
    );

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "kling",
          upstreamId: "kling",
          configuredCredentials: ["accessKey", "secretKey"],
        }),
        expect.objectContaining({
          providerId: "minimax",
          upstreamId: "minimax",
          configuredCredentials: ["apiKey"],
        }),
        expect.objectContaining({
          providerId: "volcengine",
          upstreamId: "volcengine",
          configuredCredentials: ["apiKey", "baseUrl"],
        }),
        expect.objectContaining({
          providerId: "elevenlabs",
          upstreamId: "elevenlabs",
          configuredCredentials: ["apiKey"],
        }),
      ]),
    );
  });

  it("normalizes hosted provider account input to its matching upstream", () => {
    expect(normalizeProviderAccountInput({ providerId: "elevenlabs", enabled: true })).toMatchObject({
      providerId: "elevenlabs",
      upstreamId: "elevenlabs",
      enabled: true,
    });
  });

  it("normalizes plugin-defined provider accounts without a built-in enum entry", () => {
    const account = normalizeProviderAccountInput({
      id: "hilo-hub-primary",
      providerId: "hilo-hub",
      upstreamId: "hilo-hub",
      apiShape: "hilo-hub",
      enabled: true,
    });

    expect(account).toMatchObject({
      id: "hilo-hub-primary",
      providerId: "hilo-hub",
      upstreamId: "hilo-hub",
      apiShape: "hilo-hub",
      enabled: true,
    });
    expect(publicProviderAccounts([account!], "local-user", [{
      providerId: "hilo-hub",
      accountId: "hilo-hub-primary",
      status: "authorized",
      accessToken: "hub-token",
    }])).toMatchObject([{
      id: "hilo-hub-primary",
      providerId: "hilo-hub",
      upstreamId: "hilo-hub",
      availableOAuth: ["hilo-hub"],
    }]);
  });

  it("turns an authorized plugin OAuth record into a runtime account with an opaque API key", () => {
    const oauth = [{
      userId: "user-1",
      providerId: "hilo-hub",
      accountId: "hilo-hub-primary",
      accountLabel: "MiniMax Hub",
      status: "authorized" as const,
      accessToken: "hub-oauth-token",
    }];

    expect(providerAccountsForRuntime([], "user-1", oauth)).toEqual([
      expect.objectContaining({
        id: "hilo-hub-primary",
        label: "MiniMax Hub",
        providerId: "hilo-hub",
        upstreamId: "hilo-hub",
        credentials: { apiKey: "hub-oauth-token" },
        configuredCredentials: ["apiKey"],
        availableOAuth: ["hilo-hub"],
      }),
    ]);
    expect(publicProviderAccounts([], "user-1", oauth)).toEqual([
      expect.not.objectContaining({ credentials: expect.anything() }),
    ]);
  });

  it("preserves multiple API-key accounts for the same provider", () => {
    expect(normalizeProviderAccountInput({
      id: "replicate-secondary",
      label: "API key 2",
      providerId: "replicate",
      enabled: true,
      credentials: { apiKey: " r8-second-key " },
    })).toMatchObject({
      id: "replicate-secondary",
      label: "API key 2",
      providerId: "replicate",
      upstreamId: "replicate",
      enabled: true,
      credentials: { apiKey: "r8-second-key" },
    });

    const providers = publicProviderAccounts(
      [
        {
          id: "replicate-primary",
          label: "Primary",
          userId: "user-1",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          credentials: { apiKey: "r8-primary" },
        },
        {
          id: "replicate-secondary",
          label: "API key 2",
          userId: "user-1",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          credentials: { apiKey: "r8-second-key" },
        },
      ],
      "user-1",
    );

    expect(providers).toEqual([
      expect.objectContaining({ id: "replicate-primary", label: "Primary", configuredCredentials: ["apiKey"] }),
      expect.objectContaining({ id: "replicate-secondary", label: "API key 2", configuredCredentials: ["apiKey"] }),
    ]);
  });

  it("normalizes and exposes per-account supported model filters", () => {
    expect(normalizeProviderAccountInput({
      id: "mock-primary",
      providerId: "mock",
      enabled: true,
      supportedModelIds: [" nano-banana-2 ", "gpt-image-2", "nano-banana-2", "", 42],
    })).toMatchObject({
      id: "mock-primary",
      providerId: "mock",
      upstreamId: "mock",
      enabled: true,
      supportedModelIds: ["nano-banana-2", "gpt-image-2"],
    });
    expect(normalizeProviderAccountInput({
      id: "mock-primary",
      providerId: "mock",
      enabled: true,
      supportedModelIds: [],
    })).toMatchObject({
      supportedModelIds: [],
    });

    const providers = publicProviderAccounts(
      [
        {
          id: "mock-primary",
          label: "Mock primary",
          userId: "user-1",
          providerId: "mock",
          upstreamId: "mock",
          enabled: true,
          supportedModelIds: ["nano-banana-2"],
        },
      ],
      "user-1",
    );

    expect(providers).toEqual([
      expect.objectContaining({
        id: "mock-primary",
        providerId: "mock",
        upstreamId: "mock",
        supportedModelIds: ["nano-banana-2"],
      }),
    ]);
  });

  it("normalizes and exposes per-model provider priorities", () => {
    expect(normalizeProviderAccountInput({
      id: "replicate-primary",
      providerId: "replicate",
      enabled: true,
      modelPriorities: {
        " nano-banana-2 ": "10",
        "flux-schnell": 30,
        "bad-value": "later",
        "": 1,
      },
    })).toMatchObject({
      id: "replicate-primary",
      providerId: "replicate",
      upstreamId: "replicate",
      enabled: true,
      modelPriorities: {
        "nano-banana-2": 10,
        "flux-schnell": 30,
      },
    });
    expect(normalizeProviderAccountInput({
      id: "replicate-primary",
      providerId: "replicate",
      enabled: true,
      modelPriorities: {},
    })).toMatchObject({
      modelPriorities: {},
    });

    const providers = publicProviderAccounts(
      [
        {
          id: "replicate-primary",
          userId: "user-1",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          modelPriorities: { "nano-banana-2": 10 },
        },
      ],
      "user-1",
    );

    expect(providers).toEqual([
      expect.objectContaining({
        id: "replicate-primary",
        providerId: "replicate",
        upstreamId: "replicate",
        modelPriorities: { "nano-banana-2": 10 },
      }),
    ]);
  });

  it("orders keys for the same provider by configured priority before runtime selection", () => {
    const providers = providerAccountsForRuntime(
      [
        {
          id: "replicate-slow",
          label: "Slow key",
          userId: "user-1",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 30,
          credentials: { apiKey: "r8-slow" },
        },
        {
          id: "replicate-fast",
          label: "Fast key",
          userId: "user-1",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 1,
          credentials: { apiKey: "r8-fast" },
        },
      ],
      "user-1",
    );

    expect(providers.map((provider) => provider.id)).toEqual(["replicate-fast", "replicate-slow"]);
    expect(providers[0]).toMatchObject({
      providerId: "replicate",
      upstreamId: "replicate",
      priority: 1,
      credentials: { apiKey: "r8-fast" },
      configuredCredentials: ["apiKey"],
    });
  });

  it("discovers plugin provider availability from connected OAuth state", () => {
    const providers = publicProviderAccounts(
      [],
      "user-1",
      [
        {
          userId: "user-1",
          providerId: "example-oauth",
          status: "authorized",
          accessToken: "access-token",
          refreshToken: "refresh-token",
        },
      ] as any,
    );

    expect(providers).toEqual([
      expect.objectContaining({
        providerId: "example-oauth",
        upstreamId: "example-oauth",
        enabled: true,
        configuredCredentials: ["apiKey"],
        availableOAuth: ["example-oauth"],
      }),
    ]);
  });

  it("scopes plugin OAuth availability to the matching provider account", () => {
    const providers = publicProviderAccounts(
      [
        {
          id: "example-primary",
          label: "Primary Example OAuth",
          userId: "user-1",
          providerId: "example-oauth",
          upstreamId: "example-oauth",
          enabled: true,
        },
        {
          id: "example-secondary",
          label: "Secondary Example OAuth",
          userId: "user-1",
          providerId: "example-oauth",
          upstreamId: "example-oauth",
          enabled: true,
        },
      ],
      "user-1",
      [
        {
          userId: "user-1",
          accountId: "example-primary",
          providerId: "example-oauth",
          status: "authorized",
          accessToken: "access-token",
        },
      ] as any,
    );

    expect(providers).toEqual([
      expect.objectContaining({
        id: "example-primary",
        availableOAuth: ["example-oauth"],
      }),
      expect.objectContaining({
        id: "example-secondary",
        availableOAuth: [],
      }),
    ]);
  });

  it("keeps account-scoped plugin OAuth records as separate provider accounts", () => {
    const providers = publicProviderAccounts(
      [],
      "user-1",
      [
        {
          userId: "user-1",
          accountId: "example-production",
          accountLabel: "Production Example OAuth",
          providerId: "example-oauth",
          status: "authorized",
          accessToken: "access-token-1",
        },
        {
          userId: "user-1",
          accountId: "example-team",
          accountLabel: "Team Example OAuth",
          providerId: "example-oauth",
          status: "authorized",
          accessToken: "access-token-2",
        },
      ] as any,
    );

    expect(providers).toHaveLength(2);
    expect(providers).toEqual([
      expect.objectContaining({
        label: "Production Example OAuth",
        providerId: "example-oauth",
        upstreamId: "example-oauth",
        enabled: true,
        availableOAuth: ["example-oauth"],
      }),
      expect.objectContaining({
        label: "Team Example OAuth",
        providerId: "example-oauth",
        upstreamId: "example-oauth",
        enabled: true,
        availableOAuth: ["example-oauth"],
      }),
    ]);
  });

  it("migrates legacy bare volcengine ModelArk accounts to the canonical id on first load", async () => {
    const dataDir = await tempProviderDir();
    const seed = createLocalProviderStore(dataDir);
    await seed.saveProviderAccounts([
      {
        userId: "user-1",
        id: "volc-primary",
        providerId: "volcengine",
        upstreamId: "volcengine",
        label: "Ark Prod",
        enabled: false,
        priority: 3,
        weight: 7,
        credentials: { apiKey: "volc-key", baseUrl: "https://ark.example/v3" },
        supportedModelIds: ["seedance-2-ref"],
        modelPriorities: { "seedance-2-ref": 2 },
      },
      {
        userId: "user-1",
        providerId: "volcengine",
        upstreamId: "volcengine",
        region: "cn-beijing",
        enabled: true,
        credentials: { apiKey: "volc-keyless-id" },
      },
      {
        userId: "user-1",
        id: "speech-1",
        providerId: "volcengine-speech",
        upstreamId: "volcengine-speech",
        enabled: true,
        credentials: { apiKey: "speech-key" },
      },
      {
        userId: "user-1",
        id: "mediakit-1",
        providerId: "volcengine-mediakit",
        upstreamId: "volcengine-mediakit",
        enabled: true,
      },
      {
        userId: "user-1",
        id: "provider-only-1",
        providerId: "volcengine",
        upstreamId: "volcengine-mediakit",
        enabled: true,
      },
      {
        userId: "user-1",
        id: "upstream-only-1",
        providerId: "volcengine-speech",
        upstreamId: "volcengine",
        enabled: true,
      },
    ]);

    const migrated = await createLocalProviderStore(dataDir).loadProviderAccounts();
    const byId = (id: string) => migrated.find((account) => account.id === id);

    expect(byId("volc-primary")).toEqual({
      userId: "user-1",
      id: "volc-primary",
      providerId: "volcengine-modelark",
      upstreamId: "volcengine-modelark",
      label: "Ark Prod",
      enabled: false,
      priority: 3,
      weight: 7,
      credentials: { apiKey: "volc-key", baseUrl: "https://ark.example/v3" },
      supportedModelIds: ["seedance-2-ref"],
      modelPriorities: { "seedance-2-ref": 2 },
    });

    const keyless = migrated.find((account) => account.region === "cn-beijing");
    expect(keyless).toEqual({
      userId: "user-1",
      providerId: "volcengine-modelark",
      upstreamId: "volcengine-modelark",
      region: "cn-beijing",
      enabled: true,
      credentials: { apiKey: "volc-keyless-id" },
    });

    expect(byId("speech-1")).toMatchObject({
      providerId: "volcengine-speech",
      upstreamId: "volcengine-speech",
      credentials: { apiKey: "speech-key" },
    });
    expect(byId("mediakit-1")).toMatchObject({
      providerId: "volcengine-mediakit",
      upstreamId: "volcengine-mediakit",
    });
    expect(byId("provider-only-1")).toMatchObject({
      providerId: "volcengine",
      upstreamId: "volcengine-mediakit",
    });
    expect(byId("upstream-only-1")).toMatchObject({
      providerId: "volcengine-speech",
      upstreamId: "volcengine",
    });
  });

  it("runs the volcengine ModelArk account migration once via a local_migration marker", async () => {
    const dataDir = await tempProviderDir();
    const store = createLocalProviderStore(dataDir);
    await store.saveProviderAccounts([
      {
        userId: "user-1",
        id: "volc-primary",
        providerId: "volcengine",
        upstreamId: "volcengine",
        enabled: true,
        credentials: { apiKey: "volc-key" },
      },
    ]);

    const first = await createLocalProviderStore(dataDir).loadProviderAccounts();
    const second = await createLocalProviderStore(dataDir).loadProviderAccounts();
    expect(second).toEqual(first);
    expect(readMigrationMarker(dataDir, "provider-accounts-volcengine-modelark-v1")).toBe(true);

    await store.saveProviderAccounts([
      {
        userId: "user-1",
        id: "volc-late",
        providerId: "volcengine",
        upstreamId: "volcengine",
        enabled: true,
      },
    ]);
    await expect(createLocalProviderStore(dataDir).loadProviderAccounts()).resolves.toEqual([
      {
        userId: "user-1",
        id: "volc-late",
        providerId: "volcengine",
        upstreamId: "volcengine",
        enabled: true,
      },
    ]);
  });

  it("normalizes provider account credential payloads", () => {
    expect(normalizeProviderAccountInput({
      providerId: "volcengine",
      enabled: true,
      credentials: { apiKey: " volc-key ", baseUrl: " https://ark.example/v3 " },
    })).toMatchObject({
      providerId: "volcengine",
      upstreamId: "volcengine",
      enabled: true,
      credentials: {
        apiKey: "volc-key",
        baseUrl: "https://ark.example/v3",
      },
    });
  });
});
