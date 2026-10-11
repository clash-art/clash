/**
 * Credential-free vocabulary shared by the Environment lock, execution
 * backends, and Trial Aggregate. Nothing here may carry a secret, a host path,
 * or a mutable pointer: every value is safe to publish in a portable bundle.
 */

export const BENCHMARK_BACKEND_KINDS = [
  "native-local",
  "container",
  "claude-cloud",
] as const;

export type BenchmarkBackendKind = (typeof BENCHMARK_BACKEND_KINDS)[number];

/**
 * Backends whose isolation and transport have not been verified against the
 * real service. They run only on explicit opt-in, and every result they
 * produce is labelled experimental.
 */
export const EXPERIMENTAL_BACKEND_KINDS: readonly BenchmarkBackendKind[] = [
  "claude-cloud",
];

export function isExperimentalBackend(kind: BenchmarkBackendKind): boolean {
  return EXPERIMENTAL_BACKEND_KINDS.includes(kind);
}

/**
 * What the dispatcher asserts about the place an Attempt will run. The worker
 * that actually runs the Attempt re-observes what it can and the lock records
 * both, so a claim the worker cannot corroborate fails the Attempt instead of
 * being recorded as fact.
 */
export type BenchmarkRuntimeClaim =
  | { kind: "native-local" }
  | {
      kind: "container";
      engine: { name: "docker" | "podman"; version: string };
      /** Content-addressed image id reported by the engine, never a mutable tag. */
      image: { id: string };
      network: "engine-default" | "none";
    }
  | {
      kind: "claude-cloud";
      pool:
        | { kind: "anthropic-managed" }
        | { kind: "self-hosted"; environmentId: string };
    };

export type BenchmarkObservedRuntime = {
  platform: { os: NodeJS.Platform; arch: string; nodeVersion: string };
  /** A container marker file such as /.dockerenv or /run/.containerenv exists. */
  containerMarker: boolean;
};

/**
 * Identifies the Clash product build under test. `runtimeSha256` is the digest
 * of the plugin runtime tree the Agent actually executes, and the lock refuses
 * a record whose digest differs from the tree it locks.
 */
export type BenchmarkSubjectRecord = {
  kind: "working-tree" | "commit" | "release";
  /** Plugin manifest version of the locked build. */
  version: string;
  /** 40-hex source revision. Present for working-tree and commit subjects. */
  commit?: string;
  /** working-tree only: tracked or untracked changes exist on top of `commit`. */
  dirty?: boolean;
  /** working-tree only: digest of the uncommitted diff and untracked files. */
  dirtyDigest?: string;
  artifact: {
    kind: "built-runtime-tree" | "release-tarball" | "installed-release-tree";
    sha256: string;
  };
  /** Digest of the locked plugin runtime tree. */
  runtimeSha256: string;
  /** Where a release was obtained when it was not an already-present artifact. */
  source?: "npm-registry" | "local-tarball" | "installed-directory";
  /**
   * Whether the dispatcher built the runtime from the recorded source. When
   * `performed` is false the runtime is a prebuilt tree that this record cannot
   * prove was produced from `commit`.
   */
  build?: { performed: boolean; commandsSha256?: string };
};
