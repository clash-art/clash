// These opt-in suites exercise a built Host. Runtime-load its artifacts while
// source checks use only the narrow ports consumed by the test harness.
export interface ClosableServer {
  close(callback: (error?: Error) => void): unknown;
}
interface HostServerModule {
  startLocalApiServer(options: {
    port: number;
    dataDir: string;
  }): Promise<ClosableServer>;
}
interface FixtureAgent {
  id: string;
  label: string;
  spec: { command: string; args: string[] };
}
interface FixtureSessionManager {
  start(params: { session_id: string }): void;
  prompt(params: { session_id: string; turn_id: string }): void;
  cancel(): void;
  dispose(): void;
}
interface AcpModule {
  DESKTOP_LOCAL_RUNTIME_ID: string;
  createLocalHarnessConfigStore(dataDir: string): unknown;
  createLocalAcpAdapter(options: {
    harnessConfig: unknown;
    harnessDownloadDir: string;
    probeCwd: string;
    fetch: typeof fetch;
    spawnEnv: Record<string, string>;
    hostname(): string;
    osTag(): string;
    nowSeconds(): number;
    detectAgents(): Promise<FixtureAgent[]>;
    probeAgentAuth(
      agent: FixtureAgent,
    ): Promise<
      { status: string; message: string; command: string } | undefined
    >;
    authenticateAgent(agent: FixtureAgent): Promise<void>;
    listResumeSessions(): Promise<unknown[]>;
    createSessionManager(
      send: (message: Record<string, unknown>) => void,
    ): FixtureSessionManager;
  }): unknown;
}
interface HostAppModule {
  createLocalApiApp(options: { dataDir: string; localAcp: unknown }): {
    fetch(request: Request): Response | Promise<Response>;
  };
}
async function loadArtifact<T>(
  relative: string,
  functions: string[],
): Promise<T> {
  const artifact = await import(new URL(relative, import.meta.url).href);
  for (const name of functions) {
    if (typeof artifact[name] !== "function")
      throw new Error(
        `Built Host artifact ${relative} is missing ${name}; rebuild the Host before running this suite.`,
      );
  }
  return artifact as T;
}
export function loadHostServer(): Promise<HostServerModule> {
  return loadArtifact("../../local-api/dist/server.js", [
    "startLocalApiServer",
  ]);
}
export function loadHostApp(): Promise<HostAppModule> {
  return loadArtifact("../../local-api/dist/app.js", ["createLocalApiApp"]);
}
export async function loadHostAcp(): Promise<AcpModule> {
  const artifact = await loadArtifact<AcpModule>(
    "../../local-api/dist/local-acp.js",
    ["createLocalHarnessConfigStore", "createLocalAcpAdapter"],
  );
  if (typeof artifact.DESKTOP_LOCAL_RUNTIME_ID !== "string")
    throw new Error("Built Host ACP artifact has no local runtime identity");
  return artifact;
}
