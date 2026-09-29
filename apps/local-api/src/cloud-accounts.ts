import { createClashUserConfigStore } from "./user-config.js";

import { OFFICIAL_CLOUD_URL } from "@clash/shared-types";
export { OFFICIAL_CLOUD_URL };
export interface CloudUser {
  id: string;
  email: string;
  name: string;
}
interface CloudCredential {
  token: string;
  user: CloudUser;
}
export function cloudOrigin(value: string): string {
  const url = new URL(value.trim());
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("Enter the service origin without a path or credentials");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("Cloud services require HTTPS (HTTP is allowed for localhost)");
  return url.origin;
}
function records(value: unknown): Record<string, CloudCredential | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) =>
        v === null ||
        (v &&
          typeof v === "object" &&
          typeof v.token === "string" &&
          typeof v.user?.id === "string"),
    ),
  );
}
/** Host-private credentials keyed by exact service origin, never returned to the renderer. */
export function createCloudAccounts(dataDir: string) {
  const store = createClashUserConfigStore(dataDir);
  const accounts = async () =>
    records((await store.getCredentials()).cloudAccounts);
  const selected = async () => {
    const config = await store.getSection<{ serviceUrl?: string }>("cloud");
    return cloudOrigin(config?.serviceUrl ?? OFFICIAL_CLOUD_URL);
  };
  return {
    async select(url: string) {
      await store.setSection("cloud", { serviceUrl: cloudOrigin(url) });
    },
    async save(
      url: string,
      credential: CloudCredential,
      shouldCommit: () => boolean = () => true,
    ) {
      const origin = cloudOrigin(url);
      if (!credential.token || !credential.user.id)
        throw Error("Missing cloud identity");
      await store.updateCredentials((current) =>
        shouldCommit()
          ? {
              ...current,
              cloudAccounts: {
                ...records(current.cloudAccounts),
                [origin]: credential,
              },
            }
          : current,
      );
    },
    async token(url: string) {
      return (await accounts())[cloudOrigin(url)]?.token;
    },
    async resolveToken(
      url: string,
      options: {
        expectedUserId?: string;
        env?: {
          CLASH_REMOTE_LORO_URL?: string;
          CLASH_REMOTE_LORO_TOKEN?: string;
        };
      } = {},
    ) {
      const origin = cloudOrigin(url),
        profiles = await accounts();
      if (Object.prototype.hasOwnProperty.call(profiles, origin)) {
        const account = profiles[origin];
        return account &&
          (!options.expectedUserId ||
            account.user.id === options.expectedUserId)
          ? account.token
          : undefined;
      }
      const matches = (value: unknown) => {
        try {
          return typeof value === "string" && cloudOrigin(value) === origin;
        } catch {
          return false;
        }
      };
      if (
        matches(options.env?.CLASH_REMOTE_LORO_URL) &&
        options.env?.CLASH_REMOTE_LORO_TOKEN
      )
        return options.env.CLASH_REMOTE_LORO_TOKEN;
      const sync = await store.getSection<{ remote_loro?: { url?: string } }>(
        "sync",
      );
      const server = await store.getSection<{ url?: string }>("server");
      const credentials = await store.getCredentials();
      const tokens = credentials.syncRemoteLoroTokens;
      if (
        tokens &&
        typeof tokens === "object" &&
        typeof (tokens as Record<string, unknown>)[origin] === "string"
      )
        return (tokens as Record<string, string>)[origin];
      if (
        matches(sync?.remote_loro?.url) &&
        typeof credentials.syncRemoteLoroToken === "string"
      )
        return credentials.syncRemoteLoroToken;
      if (matches(server?.url) && typeof credentials.cliApiKey === "string")
        return credentials.cliApiKey;
      return undefined;
    },
    async status(url?: string) {
      const serviceUrl = url ? cloudOrigin(url) : await selected();
      return {
        serviceUrl,
        official: serviceUrl === OFFICIAL_CLOUD_URL,
        user: (await accounts())[serviceUrl]?.user ?? null,
      };
    },
    async logout(url: string) {
      const origin = cloudOrigin(url);
      const sync = await store.getSection<{ remote_loro?: { url?: string } }>(
        "sync",
      );
      const server = await store.getSection<{ url?: string }>("server");
      const matches = (value: unknown) => {
        try {
          return typeof value === "string" && cloudOrigin(value) === origin;
        } catch {
          return false;
        }
      };
      await store.updateCredentials((current) => {
        const profiles = records(current.cloudAccounts);
        profiles[origin] = null;
        const next: Record<string, unknown> = {
          ...current,
          cloudAccounts: profiles,
        };
        if (matches(sync?.remote_loro?.url)) delete next.syncRemoteLoroToken;
        if (matches(server?.url)) delete next.cliApiKey;
        if (
          next.syncRemoteLoroTokens &&
          typeof next.syncRemoteLoroTokens === "object"
        ) {
          const tokens = {
            ...(next.syncRemoteLoroTokens as Record<string, unknown>),
          };
          delete tokens[origin];
          next.syncRemoteLoroTokens = tokens;
        }
        return next;
      });
    },
  };
}
