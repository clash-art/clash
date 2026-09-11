export const ARTIFACT_KINDS = [
  "director-stage",
  "timeline",
  "remotion-component",
  "video",
  "audio",
  "image",
  "report",
  "project-asset",
  "canvas-state",
  "generator",
  "action-run",
  "output-commit",
  "document",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactDescriptor = {
  id: string;
  kind: ArtifactKind;
  path: string;
};

export type ArtifactSubmission = {
  schemaVersion: 1;
  taskId: string;
  artifacts: ArtifactDescriptor[];
};

export type OutcomeDeliverable = {
  artifactId: string;
  kind: ArtifactKind;
  description: string;
};

export type BenchmarkOutcome = {
  objective: string;
  acceptanceCriteria: string[];
  deliverables: OutcomeDeliverable[];
};

export type BenchmarkQualityCriterion = {
  id: string;
  description: string;
  weight: number;
  /** Exact deliverables whose evidence a reviewer may use. */
  evidenceArtifactIds?: string[];
  /** Resolve all submitted deliverables of these kinds into exact evidence. */
  evidenceKinds?: ArtifactKind[];
};

export const BENCHMARK_CATEGORIES = [
  "director",
  "timeline",
  "mg-character",
  "mixed",
  "asset",
  "canvas",
  "generator",
  "document",
  "workflow",
  "plugin",
  "text",
] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

export const BENCHMARK_EXECUTION_LANES = [
  "agent-product",
  "blocked-contract",
] as const;

export type BenchmarkExecutionLane = (typeof BENCHMARK_EXECUTION_LANES)[number];

export const BENCHMARK_EXECUTION_TRANSPORTS = ["auto", "mcp", "cli"] as const;

export type BenchmarkExecutionTransport =
  (typeof BENCHMARK_EXECUTION_TRANSPORTS)[number];

export type BenchmarkInputFixture = {
  /** Directory relative to the benchmark suite root. */
  path: string;
  /** SHA-256 of the canonical sorted file manifest. */
  manifestSha256: string;
};

export type BenchmarkFixtureFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type BenchmarkFixtureManifest = {
  schemaVersion: 1;
  files: BenchmarkFixtureFile[];
  manifestSha256: string;
  totalBytes: number;
};

export type BenchmarkInputFixtureProvenance = BenchmarkFixtureManifest & {
  sourcePath: string;
  workspacePath: ".";
  receiptPath: ".clash/benchmark-input-fixture.json";
};

export type BenchmarkEnvironmentTrack = "functional" | "content-effect";

export type BenchmarkEnvironmentWorkspace = {
  format: "clash-workspace-v1";
  /** Product Workspace bundle directory relative to the suite root. */
  path: string;
  bundleDigest: string;
};

type BenchmarkEnvironmentContractBase = {
  track: BenchmarkEnvironmentTrack;
  /** Public, credential-free execution requirements needed to reproduce the case. */
  requirements?: {
    plugins?: string[];
    models?: string[];
    providers?: string[];
  };
};

type BenchmarkEnvironmentOutputs = {
  modifiedWorkspace: true;
  /** Adapter-native retained events; private reasoning is not implied. */
  rawTrajectory: true;
  normalizedTrajectory: "clash-normalized-v1";
  atifTrajectory: "ATIF-v1.7-when-supported";
  otlpTrace: "otlp-json";
  /** Immutable, score-free record of one Agent rollout and its evidence. */
  attempt: "clash-attempt-v1";
};

type LegacyBenchmarkEnvironmentOutputs = Omit<
  BenchmarkEnvironmentOutputs,
  "attempt"
> & {
  attemptManifest: "clash-attempt-result-bundle-v1";
};

/** Canonical benchmark Environment input. Workspace remains a product format. */
export type BenchmarkAgentEnvironmentContract =
  BenchmarkEnvironmentContractBase & {
    profile: "clash-agent-environment-v1";
    outputs: BenchmarkEnvironmentOutputs;
    initialState?: {
      workspace: BenchmarkEnvironmentWorkspace;
    };
    /**
     * Runtime-only compatibility accessor installed by the schema parser.
     * It is inherited and therefore never serialized into task or suite JSON.
     * @deprecated Read `initialState.workspace`; remove with the runner migration.
     */
    inputWorkspace?: Omit<BenchmarkEnvironmentWorkspace, "format">;
  };

/** @deprecated Accepted as an input migration shape; never emitted by schemas. */
export type LegacyBenchmarkEnvironmentContract =
  BenchmarkEnvironmentContractBase & {
    profile: "clash-workspace-v1";
    outputs: BenchmarkEnvironmentOutputs | LegacyBenchmarkEnvironmentOutputs;
    initialState?: never;
    inputWorkspace?: Omit<BenchmarkEnvironmentWorkspace, "format">;
  };

export type BenchmarkEnvironmentContract =
  BenchmarkAgentEnvironmentContract | LegacyBenchmarkEnvironmentContract;

export type BenchmarkExecution = {
  profile: "clash-host";
  lane?: BenchmarkExecutionLane;
  /** Agent-facing Clash transport. Suite parsing canonicalizes omission to auto. */
  transport?: BenchmarkExecutionTransport;
  /** Transport-neutral product mutations and reads, for example timeline.render. */
  requiredProductOperations?: string[];
  /** Product operations whose trusted invocation is itself an execution failure. */
  forbiddenProductOperations?: string[];
  /** Legacy transport-specific gate. Prefer requiredProductOperations. */
  requiredMcpTools?: string[];
  /** Legacy transport-specific gate. Prefer requiredProductOperations. */
  requiredCliCommands?: string[];
  requiredCapabilities?: string[];
  preflight?: {
    status: "ready" | "blocked";
    checks: Array<{
      capability: string;
      status: "available" | "missing";
      detail: string;
    }>;
  };
  evidence?: {
    traceRequired: true;
    submissionRequired: true;
  };
  productReadback?: {
    required: true;
    mechanism: string;
    artifactIds: string[];
    /** Benchmark-owned Project Asset identity; never sourced from submission. */
    expectedProjectAssetId?: string;
    description: string;
  };
  environment?: BenchmarkEnvironmentContract;
};

type RubricBase<Type extends string> = {
  id: string;
  type: Type;
  weight: number;
  required?: boolean;
};

export type ArtifactExistsRubric = RubricBase<"artifact-exists"> & {
  artifactId: string;
  kind?: ArtifactKind;
  minBytes?: number;
};

export type ArtifactSetRubric = RubricBase<"artifact-set"> & {
  kind?: ArtifactKind;
  minCount: number;
  minBytes?: number;
};

export type DirectorStageRubric = RubricBase<"director-stage"> & {
  artifactId: string;
  minObjects?: number;
  minCameras?: number;
  /** @deprecated Legacy no-op; capture evidence belongs to artifacts and trusted receipts. */
  minCapturedShots?: number;
  minSequenceShots?: number;
  minAnimatedTracks?: number;
  minActionClips?: number;
  minMannequins?: number;
  requireMannequin?: boolean;
  requiredActions?: string[];
};

export type TimelineRubric = RubricBase<"timeline"> & {
  artifactId: string;
  minTracks?: number;
  minItems?: number;
  minDurationInFrames?: number;
  requiredItemTypes?: string[];
};

export type MgCharacterRubric = RubricBase<"mg-character"> & {
  artifactId: string;
  profile?: "remotion-tsx";
  minSourceBytes?: number;
  requiredBodyParts?: string[];
  requiredRemotionApis?: string[];
};

export type MediaRubric = RubricBase<"media"> & {
  artifactId: string;
  width?: number;
  height?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  requireVideo?: boolean;
  requireAudio?: boolean;
};

export type VisualFramesRubric = RubricBase<"visual-frames"> & {
  artifactIds: string[];
  width: number;
  height: number;
  minDistinctPairs: number;
  minMeanAbsoluteDifference: number;
  foregroundCoverage?: {
    backgroundTolerance: number;
    minRatio: number;
  };
  safeArea?: {
    marginPercent: number;
    backgroundTolerance: number;
    maxForegroundEdgeRatio: number;
  };
};

export type MixedLineageRubric = RubricBase<"mixed-lineage"> & {
  directorArtifactId: string;
  timelineArtifactId: string;
  componentArtifactId: string;
};

export type ArtifactRubric =
  | ArtifactExistsRubric
  | ArtifactSetRubric
  | DirectorStageRubric
  | TimelineRubric
  | MgCharacterRubric
  | MediaRubric
  | VisualFramesRubric
  | MixedLineageRubric;

export type ArtifactBenchmarkCase = {
  id: string;
  title: string;
  category: BenchmarkCategory;
  tags?: string[];
  outcome: BenchmarkOutcome;
  /** Semantic/creative criteria, distinct from technical acceptance gates. */
  qualityCriteria?: BenchmarkQualityCriterion[];
  /** Legacy context appended after the outcome contract when present. */
  prompt?: string;
  passScore: number;
  timeoutMs: number;
  /** Named, task-scoped pack; skills contains its resolved members plus additions. */
  skillPack?: { path: string; id: string };
  skills: string[];
  inputFixture?: BenchmarkInputFixture;
  execution?: BenchmarkExecution;
  rubric: ArtifactRubric[];
};

export type ArtifactBenchmarkSuite = {
  schemaVersion: 1;
  id: string;
  title: string;
  cases: ArtifactBenchmarkCase[];
};

export type ArtifactEvidence = ArtifactDescriptor & {
  bytes: number;
  sha256: string;
};

export type QualityReviewStatus = "pending" | "pass" | "fail";

export type QualityReviewArtifactBinding = {
  id: string;
  kind: ArtifactKind;
  bytes: number;
  sha256: string;
};

export type QualityReviewCriterion = {
  id: string;
  description: string;
  weight: number;
  evidenceArtifactIds: string[];
};

export type QualityReviewRequest = {
  schemaVersion: 1;
  kind: "clash.benchmark.quality-review-request";
  benchmarkId: string;
  objective: string;
  criteriaSource: "quality-criteria";
  criteria: QualityReviewCriterion[];
  artifacts: QualityReviewArtifactBinding[];
  passThreshold: number;
  requestSha256: string;
};

export type QualityJudgeResponse = {
  schemaVersion: 1;
  criteria: Array<{
    id: string;
    score: number;
    rationale: string;
  }>;
  overallRationale: string;
};

export type QualityReviewerProvenance = {
  kind: "codex" | "human";
  provider: string;
  model: string;
  adapterVersion: string;
};

export type QualityReviewResult = {
  schemaVersion: 1;
  kind: "clash.benchmark.quality-review-result";
  benchmarkId: string;
  requestSha256: string;
  artifacts: QualityReviewArtifactBinding[];
  reviewer: QualityReviewerProvenance;
  provenance: {
    promptSha256: string;
    rubricSha256: string;
    rawResponseSha256: string;
  };
  criteria: QualityJudgeResponse["criteria"];
  aggregate: {
    score: number;
    threshold: number;
    status: "pass" | "fail";
  };
  overallRationale: string;
};

export type QualityReviewReport = {
  required: boolean;
  status: QualityReviewStatus;
  detail: string;
  request?: QualityReviewRequest;
  result?: QualityReviewResult;
};

export type CodexQualityReviewer = {
  adapter: "codex";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  provider: "openai";
  model: string;
  timeoutMs?: number;
};

export type BenchmarkQualityReviewer = CodexQualityReviewer;

export type EvaluationCheck = {
  id: string;
  type: ArtifactRubric["type"];
  status: "pass" | "fail";
  required: boolean;
  weight: number;
  awardedWeight: number;
  detail: string;
  metrics?: Record<string, number | string | boolean | string[]>;
};

export type ArtifactEvaluationReport = {
  schemaVersion: 1;
  benchmarkId: string;
  taskId: string | null;
  status: "pass" | "fail" | "not-run";
  score: number;
  checks: EvaluationCheck[];
  artifacts: ArtifactEvidence[];
  outcomeGate: {
    status: "pass" | "fail";
    detail: string;
    missingArtifactIds: string[];
    invalidArtifactIds: string[];
  };
  error?: string;
};

export type CommandAgent = {
  adapter?: "command";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Inherit the parent environment. Defaults to true for real CLI agents. */
  inheritEnv?: boolean;
};

export type CodexAgent = {
  adapter: "codex";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  model?: string;
  clashHost?: {
    pluginRoot: string;
    profile: "dev" | "prod";
  };
};

export type ClaudeAgent = {
  adapter: "claude";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  model?: string;
  clashHost?: {
    pluginRoot: string;
    profile: "dev" | "prod";
  };
};

export type PiAgent = {
  adapter: "pi";
  command?: string;
  args?: string[];
  /** Additional Pi skill directories to load alongside case-scoped skills. */
  skills?: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** Explicit provider bound into the reproducible benchmark Environment. */
  provider?: string;
  model?: string;
  clashHost?: {
    pluginRoot: string;
    profile: "dev" | "prod";
  };
};

export type BenchmarkAgent = CommandAgent | CodexAgent | ClaudeAgent | PiAgent;

export type OutcomeResult = {
  schemaVersion: 1;
  caseId: string;
  objective: string;
  status: "achieved" | "failed" | "blocked" | "pending-review";
  score: number;
  passScore: number;
  agentStatus: AgentRunReport["status"];
  evaluationStatus: ArtifactEvaluationReport["status"];
  executionStatus: ProductExecutionReport["status"];
  qualityReviewStatus?: QualityReviewStatus;
  completedAt: string;
};

export type ProductExecutionReport = {
  profile: "portable" | "clash-host";
  status: "pass" | "fail" | "blocked";
  requiredProductOperations: string[];
  observedProductOperations: ProductOperationObservation[];
  missingProductOperations: string[];
  forbiddenProductOperations: string[];
  observedForbiddenProductOperations: ProductOperationObservation[];
  requiredMcpTools: string[];
  observedMcpTools: string[];
  missingMcpTools: string[];
  requiredCliCommands: string[];
  observedCliCommands: string[];
  missingCliCommands: string[];
  detail: string;
  identityIntegrity?: BenchmarkIdentityIntegrityReport;
  productReadback?: {
    status: "pass" | "fail";
    receiptPath: string;
    matchedArtifactIds: string[];
    detail: string;
  };
};

export type BenchmarkIdentityIntegrityViolation = {
  code:
    | "local-user-override"
    | "agent-member-id-cleared"
    | "agent-name-cleared"
    | "agent-member-id-unset"
    | "agent-name-unset";
  source: "codex-command" | "claude-command" | "clash-cli-trace";
  sourceLine: number;
  command: string;
};

export type BenchmarkIdentityIntegrityReport = {
  status: "pass" | "fail";
  violations: BenchmarkIdentityIntegrityViolation[];
  detail: string;
};

export type ProductOperationObservation = {
  operation: string;
  transport: "mcp" | "cli";
  invocation: string;
};

export type AgentRunReport = {
  status: "completed" | "failed" | "timed-out" | "spawn-error" | "not-run";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  observedEventsPath?: string;
  trajectoryPath?: string;
  error?: string;
};

export type BenchmarkCaseReport = {
  id: string;
  workspace: string;
  inputFixture?: BenchmarkInputFixtureProvenance;
  status: "pass" | "fail" | "blocked" | "pending-review";
  attempt?: number;
  /** A failed forced attempt is waiting for another explicit --force. */
  forcePending?: boolean;
  failure?: BenchmarkCaseFailure;
  agent: AgentRunReport;
  execution: ProductExecutionReport;
  evaluation: ArtifactEvaluationReport;
  qualityReview?: QualityReviewReport;
  outcome: OutcomeResult;
};

export type BenchmarkSuiteReport = {
  schemaVersion: 1;
  suiteId: string;
  runId: string;
  status: "pass" | "fail" | "blocked" | "pending-review";
  startedAt: string;
  finishedAt: string;
  resumed?: boolean;
  qualityReview?: {
    status: QualityReviewStatus;
    pending: number;
    passed: number;
    failed: number;
  };
  cases: BenchmarkCaseReport[];
};

export type BenchmarkCaseFailureClassification =
  "infrastructure" | "agent" | "product" | "evaluation" | "preflight";

export type BenchmarkCaseFailure = {
  classification: BenchmarkCaseFailureClassification;
  retryable: boolean;
  phase: string;
  detail: string;
};

export type BenchmarkAttemptLedgerEntry = {
  schemaVersion: 1;
  suiteId: string;
  runId: string;
  caseId: string;
  attempt: number;
  event: "started" | "completed" | "abandoned" | "force-pending";
  at: string;
  caseRoot: string;
  /** This ledger transition belongs to an explicitly forced benchmark retry. */
  forced?: boolean;
  status?: BenchmarkCaseReport["status"];
  failure?: BenchmarkCaseFailure;
  reportPath?: string;
  attemptPath?: string;
  attemptSha256?: string;
  attemptDigest?: string;
};

export type EvaluateSubmissionInput = {
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
};

export type RunBenchmarkSuiteInput = {
  suite: ArtifactBenchmarkSuite;
  suiteRoot: string;
  outputRoot: string;
  runId: string;
  agent: BenchmarkAgent;
  /** Optional independent content-effect reviewer. Provider and model are explicit. */
  qualityReviewer?: BenchmarkQualityReviewer;
  /** Continue a compatible existing run directory instead of replacing it. */
  resume?: boolean;
  /** Run one explicit retry for eligible failed cases in a resumed run. */
  force?: boolean;
  /** Total tries allowed for infrastructure failures only. Defaults to 2. */
  maxInfrastructureAttempts?: number;
};

export type ReevaluateBenchmarkRunInput = {
  suite: ArtifactBenchmarkSuite;
  suiteRoot: string;
  outputRoot: string;
  runId: string;
  caseId: string;
};
