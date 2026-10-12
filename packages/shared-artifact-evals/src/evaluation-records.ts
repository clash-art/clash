import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

export type BenchmarkDigestReference = Readonly<{
  id: string;
  version: string;
  digest: string;
}>;

export type BenchmarkEvaluationDimension = Readonly<{
  id: string;
  score: number;
  verdict: "pass" | "fail" | "pending" | "not-applicable";
  rationale?: string;
}>;

export type BenchmarkEvaluationEvidenceReference = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type BenchmarkEvaluationRecord = Readonly<{
  schemaVersion: 1;
  kind: "clash.benchmark.evaluation";
  attemptDigest: string;
  evaluator: BenchmarkDigestReference;
  spec: BenchmarkDigestReference;
  dimensions: readonly BenchmarkEvaluationDimension[];
  evidence: readonly BenchmarkEvaluationEvidenceReference[];
  digest: string;
}>;

export type BenchmarkEvaluationAggregateRecord = Readonly<{
  schemaVersion: 1;
  kind: "clash.benchmark.evaluation-aggregate";
  attemptDigest: string;
  evaluationDigests: readonly string[];
  policy: BenchmarkDigestReference;
  verdict: "pass" | "fail" | "pending";
  score: number;
  digest: string;
}>;

export type BenchmarkRewardComponent = Readonly<{
  id: string;
  value: number;
  sourceEvaluationDigest?: string;
}>;

export type BenchmarkRewardRecord = Readonly<{
  schemaVersion: 1;
  kind: "clash.benchmark.reward";
  attemptDigest: string;
  aggregateDigest: string;
  policy: BenchmarkDigestReference;
  components: readonly BenchmarkRewardComponent[];
  value: number;
  digest: string;
}>;

export type CreateEvaluationRecordInput = Readonly<{
  attemptDigest: string;
  evaluator: BenchmarkDigestReference;
  spec: BenchmarkDigestReference;
  dimensions: readonly BenchmarkEvaluationDimension[];
  evidence: readonly BenchmarkEvaluationEvidenceReference[];
}>;

export type CreateAggregateRecordInput = Readonly<{
  attemptDigest: string;
  evaluations: readonly BenchmarkEvaluationRecord[];
  policy: BenchmarkDigestReference;
  verdict: BenchmarkEvaluationAggregateRecord["verdict"];
  score: number;
}>;

export type CreateRewardRecordInput = Readonly<{
  attemptDigest: string;
  aggregate: BenchmarkEvaluationAggregateRecord;
  policy: BenchmarkDigestReference;
  components: readonly BenchmarkRewardComponent[];
  value: number;
}>;

export type EvaluationRecordPublication = "created" | "existing";

export type EvaluationRecordReceipt<TRecord> = Readonly<{
  record: TRecord;
  path: string;
  bytes: number;
  sha256: string;
  publication: EvaluationRecordPublication;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,499}$/u;

const DigestSchema = z.string().regex(SHA256);
const PublicIdSchema = z.string().min(1).max(500).regex(SAFE_PUBLIC_ID);
const DigestReferenceSchema = z
  .object({
    id: PublicIdSchema,
    version: PublicIdSchema,
    digest: DigestSchema,
  })
  .strict();
const EvaluationDimensionSchema = z
  .object({
    id: PublicIdSchema,
    score: z.number().finite(),
    verdict: z.enum(["pass", "fail", "pending", "not-applicable"]),
    rationale: z.string().min(1).max(100_000).optional(),
  })
  .strict();
const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (path) => {
      const segments = path.split("/");
      return (
        !isAbsolute(path) &&
        !/^[A-Za-z]:/u.test(path) &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        segments.every(
          (segment) =>
            segment.length > 0 && segment !== "." && segment !== "..",
        )
      );
    },
    { message: "must be a safe relative path" },
  );
const EvaluationEvidenceReferenceSchema = z
  .object({
    path: SafeRelativePathSchema,
    bytes: z.number().int().nonnegative(),
    sha256: DigestSchema,
  })
  .strict();
const EvaluationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.benchmark.evaluation"),
    attemptDigest: DigestSchema,
    evaluator: DigestReferenceSchema,
    spec: DigestReferenceSchema,
    dimensions: z.array(EvaluationDimensionSchema).min(1).max(10_000),
    evidence: z.array(EvaluationEvidenceReferenceSchema).min(1).max(100_000),
    digest: DigestSchema,
  })
  .strict();
const AggregateRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.benchmark.evaluation-aggregate"),
    attemptDigest: DigestSchema,
    evaluationDigests: z.array(DigestSchema).min(1).max(100_000),
    policy: DigestReferenceSchema,
    verdict: z.enum(["pass", "fail", "pending"]),
    score: z.number().finite(),
    digest: DigestSchema,
  })
  .strict();
const RewardComponentSchema = z
  .object({
    id: PublicIdSchema,
    value: z.number().finite(),
    sourceEvaluationDigest: DigestSchema.optional(),
  })
  .strict();
const RewardRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.benchmark.reward"),
    attemptDigest: DigestSchema,
    aggregateDigest: DigestSchema,
    policy: DigestReferenceSchema,
    components: z.array(RewardComponentSchema).min(1).max(10_000),
    value: z.number().finite(),
    digest: DigestSchema,
  })
  .strict();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function recordDigest(unsigned: unknown): string {
  return sha256(canonicalJson(unsigned));
}

function decodeJsonInput(value: unknown, label: string): unknown {
  if (typeof value !== "string" && !ArrayBuffer.isView(value)) return value;
  try {
    const text =
      typeof value === "string"
        ? value
        : Buffer.from(
            value.buffer,
            value.byteOffset,
            value.byteLength,
          ).toString("utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} must contain JSON`, { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique`);
  }
}

function assertSorted(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareText(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`${label} must be in canonical order`);
    }
  }
}

function evaluationUnsigned(record: BenchmarkEvaluationRecord) {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    attemptDigest: record.attemptDigest,
    evaluator: record.evaluator,
    spec: record.spec,
    dimensions: record.dimensions,
    evidence: record.evidence,
  };
}

function aggregateUnsigned(record: BenchmarkEvaluationAggregateRecord) {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    attemptDigest: record.attemptDigest,
    evaluationDigests: record.evaluationDigests,
    policy: record.policy,
    verdict: record.verdict,
    score: record.score,
  };
}

function rewardUnsigned(record: BenchmarkRewardRecord) {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    attemptDigest: record.attemptDigest,
    aggregateDigest: record.aggregateDigest,
    policy: record.policy,
    components: record.components,
    value: record.value,
  };
}

function parseAggregateShape(
  value: unknown,
): BenchmarkEvaluationAggregateRecord {
  const parsed = AggregateRecordSchema.parse(
    decodeJsonInput(value, "Evaluation Aggregate record"),
  ) as BenchmarkEvaluationAggregateRecord;
  assertUnique(parsed.evaluationDigests, "Aggregate Evaluation digests");
  assertSorted(parsed.evaluationDigests, "Aggregate Evaluation digests");
  if (parsed.digest !== recordDigest(aggregateUnsigned(parsed))) {
    throw new Error("Evaluation Aggregate digest does not match its content");
  }
  return deepFreeze(parsed);
}

function parseRewardShape(value: unknown): BenchmarkRewardRecord {
  const parsed = RewardRecordSchema.parse(
    decodeJsonInput(value, "Reward record"),
  ) as BenchmarkRewardRecord;
  const componentIds = parsed.components.map(({ id }) => id);
  assertUnique(componentIds, "Reward component ids");
  assertSorted(componentIds, "Reward component ids");
  if (parsed.digest !== recordDigest(rewardUnsigned(parsed))) {
    throw new Error("Reward digest does not match its content");
  }
  return deepFreeze(parsed);
}

export function parseEvaluationRecord(
  value: unknown,
): BenchmarkEvaluationRecord {
  const parsed = EvaluationRecordSchema.parse(
    decodeJsonInput(value, "Evaluation record"),
  ) as BenchmarkEvaluationRecord;
  const dimensionIds = parsed.dimensions.map(({ id }) => id);
  const evidencePaths = parsed.evidence.map(({ path }) => path);
  assertUnique(dimensionIds, "Evaluation dimension ids");
  assertSorted(dimensionIds, "Evaluation dimension ids");
  assertUnique(evidencePaths, "Evaluation evidence paths");
  assertSorted(evidencePaths, "Evaluation evidence paths");
  if (parsed.digest !== recordDigest(evaluationUnsigned(parsed))) {
    throw new Error("Evaluation digest does not match its content");
  }
  return deepFreeze(parsed);
}

export function createEvaluationRecord(
  input: CreateEvaluationRecordInput,
): BenchmarkEvaluationRecord {
  const candidate = {
    schemaVersion: 1 as const,
    kind: "clash.benchmark.evaluation" as const,
    attemptDigest: input.attemptDigest,
    evaluator: input.evaluator,
    spec: input.spec,
    dimensions: [...input.dimensions]
      .map((dimension) => ({ ...dimension }))
      .sort((left, right) => compareText(left.id, right.id)),
    evidence: [...input.evidence]
      .map((reference) => ({ ...reference }))
      .sort((left, right) => compareText(left.path, right.path)),
  };
  return parseEvaluationRecord({
    ...candidate,
    digest: recordDigest(candidate),
  });
}

export function parseAggregateRecord(
  value: unknown,
  evaluations: readonly BenchmarkEvaluationRecord[],
): BenchmarkEvaluationAggregateRecord {
  const aggregate = parseAggregateShape(value);
  const byDigest = new Map(
    evaluations.map((evaluation) => {
      const parsed = parseEvaluationRecord(evaluation);
      return [parsed.digest, parsed] as const;
    }),
  );
  for (const digest of aggregate.evaluationDigests) {
    const evaluation = byDigest.get(digest);
    if (!evaluation) {
      throw new Error(
        `Aggregate referenced Evaluation ${digest} was not provided`,
      );
    }
    if (evaluation.attemptDigest !== aggregate.attemptDigest) {
      throw new Error("Aggregate Evaluations must belong to the same Attempt");
    }
  }
  return aggregate;
}

export function createAggregateRecord(
  input: CreateAggregateRecordInput,
): BenchmarkEvaluationAggregateRecord {
  const evaluations = input.evaluations.map(parseEvaluationRecord);
  if (
    evaluations.some(
      (evaluation) => evaluation.attemptDigest !== input.attemptDigest,
    )
  ) {
    throw new Error("Aggregate Evaluations must belong to the same Attempt");
  }
  const evaluationDigests = evaluations
    .map(({ digest }) => digest)
    .sort(compareText);
  assertUnique(evaluationDigests, "Aggregate Evaluation digests");
  const candidate = {
    schemaVersion: 1 as const,
    kind: "clash.benchmark.evaluation-aggregate" as const,
    attemptDigest: input.attemptDigest,
    evaluationDigests,
    policy: { ...input.policy },
    verdict: input.verdict,
    score: input.score,
  };
  return parseAggregateRecord(
    { ...candidate, digest: recordDigest(candidate) },
    evaluations,
  );
}

export function parseRewardRecord(
  value: unknown,
  aggregateValue: BenchmarkEvaluationAggregateRecord,
): BenchmarkRewardRecord {
  const aggregate = parseAggregateShape(aggregateValue);
  const reward = parseRewardShape(value);
  if (
    reward.attemptDigest !== aggregate.attemptDigest ||
    reward.aggregateDigest !== aggregate.digest
  ) {
    throw new Error("Reward is bound to a different Attempt or Aggregate");
  }
  for (const component of reward.components) {
    if (
      component.sourceEvaluationDigest !== undefined &&
      !aggregate.evaluationDigests.includes(component.sourceEvaluationDigest)
    ) {
      throw new Error(
        "Reward component references an Evaluation outside its Aggregate",
      );
    }
  }
  return reward;
}

export function createRewardRecord(
  input: CreateRewardRecordInput,
): BenchmarkRewardRecord {
  const aggregate = parseAggregateShape(input.aggregate);
  if (aggregate.attemptDigest !== input.attemptDigest) {
    throw new Error("Reward and Aggregate must belong to the same Attempt");
  }
  const candidate = {
    schemaVersion: 1 as const,
    kind: "clash.benchmark.reward" as const,
    attemptDigest: input.attemptDigest,
    aggregateDigest: aggregate.digest,
    policy: { ...input.policy },
    components: [...input.components]
      .map((component) => ({ ...component }))
      .sort((left, right) => compareText(left.id, right.id)),
    value: input.value,
  };
  return parseRewardRecord(
    { ...candidate, digest: recordDigest(candidate) },
    aggregate,
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function checkedDirectory(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpath(path);
}

export async function publishRecord<TRecord>(input: {
  storeRoot: string;
  category: "evaluations" | "aggregates" | "rewards" | "trial-aggregates";
  record: TRecord;
  digest: string;
}): Promise<EvaluationRecordReceipt<TRecord>> {
  await mkdir(input.storeRoot, { recursive: true });
  const storeRoot = await checkedDirectory(
    input.storeRoot,
    "Record store root",
  );
  const categoryPath = join(storeRoot, input.category);
  await mkdir(categoryPath, { recursive: true });
  await checkedDirectory(categoryPath, "Record category");
  const digestPath = join(categoryPath, "sha256");
  await mkdir(digestPath, { recursive: true });
  await checkedDirectory(digestPath, "Record digest directory");

  const bytes = canonicalJson(input.record);
  const relativePath = `${input.category}/sha256/${input.digest}.json`;
  const finalPath = join(storeRoot, relativePath);
  const temporaryPath = join(
    digestPath,
    `.${randomUUID()}.evaluation-record.tmp`,
  );
  let temporaryExists = false;
  let publication: EvaluationRecordPublication = "existing";
  try {
    const temporary = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    try {
      await temporary.writeFile(bytes);
      await temporary.chmod(0o444);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, finalPath);
      publication = "created";
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  let existing;
  try {
    existing = await open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) {
      throw new Error(
        "Content-addressed record conflicts with a symbolic link",
      );
    }
    throw error;
  }
  try {
    const opened = await existing.stat();
    const existingBytes = await existing.readFile();
    const pathInfo = await lstat(finalPath);
    if (
      !opened.isFile() ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      opened.dev !== pathInfo.dev ||
      opened.ino !== pathInfo.ino ||
      !existingBytes.equals(bytes)
    ) {
      throw new Error("Content-addressed record conflicts with existing bytes");
    }
  } finally {
    await existing.close();
  }
  await chmod(finalPath, 0o444);
  if (publication === "created") await syncDirectory(digestPath);
  return deepFreeze({
    record: input.record,
    path: relativePath,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    publication,
  });
}

export async function writeEvaluationRecord(input: {
  storeRoot: string;
  record: BenchmarkEvaluationRecord;
}): Promise<EvaluationRecordReceipt<BenchmarkEvaluationRecord>> {
  const record = parseEvaluationRecord(input.record);
  return publishRecord({
    storeRoot: input.storeRoot,
    category: "evaluations",
    record,
    digest: record.digest,
  });
}

export async function writeAggregateRecord(input: {
  storeRoot: string;
  record: BenchmarkEvaluationAggregateRecord;
  evaluations: readonly BenchmarkEvaluationRecord[];
}): Promise<EvaluationRecordReceipt<BenchmarkEvaluationAggregateRecord>> {
  const record = parseAggregateRecord(input.record, input.evaluations);
  return publishRecord({
    storeRoot: input.storeRoot,
    category: "aggregates",
    record,
    digest: record.digest,
  });
}

export async function writeRewardRecord(input: {
  storeRoot: string;
  record: BenchmarkRewardRecord;
  aggregate: BenchmarkEvaluationAggregateRecord;
}): Promise<EvaluationRecordReceipt<BenchmarkRewardRecord>> {
  const record = parseRewardRecord(input.record, input.aggregate);
  return publishRecord({
    storeRoot: input.storeRoot,
    category: "rewards",
    record,
    digest: record.digest,
  });
}
