import type { ClientCapabilities } from "@agentclientprotocol/sdk";

type ExtendedClientCapabilities = ClientCapabilities & {
  session?: {
    configOptions?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

const CLASH_ACP_EXTENSION_CAPABILITIES = {
  "terminal-auth": true,
  terminal_output: true,
  // Cursor uses this negotiated flag to expose thought-level and model-config
  // parameters as standard SessionConfigOption entries. Other agents ignore it.
  parameterizedModelPicker: true,
} as const;

export function withClashAcpExtensionCapabilities(
  capabilities: ClientCapabilities,
): ClientCapabilities {
  const extended = capabilities as ExtendedClientCapabilities;
  return {
    ...capabilities,
    session: {
      ...(extended.session ?? {}),
      configOptions: {
        ...(extended.session?.configOptions ?? {}),
        boolean: {},
      },
    },
    _meta: {
      ...(capabilities._meta ?? {}),
      ...CLASH_ACP_EXTENSION_CAPABILITIES,
    },
  } as ClientCapabilities;
}
