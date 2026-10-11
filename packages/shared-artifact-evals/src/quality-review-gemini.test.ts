import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createQualityReviewRequest,
  evaluateQualityReview,
} from "./quality-review";
import { codexQualityJudgeSupportsRequest } from "./quality-review-codex";
import {
  geminiBaseUrl,
  geminiQualityJudgeSupportsRequest,
  runGeminiQualityJudge,
} from "./quality-review-gemini";
import type {
  ArtifactBenchmarkCase,
  ArtifactEvidence,
  GeminiQualityReviewer,
  QualityReviewRequest,
} from "./types";

const API_KEY = "test-gemini-key";

type RecordedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
};

let server: Server;
let baseUrl: string;
let recorded: RecordedRequest[];
let respond: (request: RecordedRequest) => Reply;
let roots: string[];

beforeEach(async () => {
  recorded = [];
  roots = [];
  respond = () => ({ status: 500, body: { error: "unexpected request" } });
  server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      };
      recorded.push(request);
      const reply = respond(request);
      outgoing.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      outgoing.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.CLASH_TEST_GEMINI_KEY = API_KEY;
});

afterEach(async () => {
  delete process.env.CLASH_TEST_GEMINI_KEY;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

function reviewer(): GeminiQualityReviewer {
  return {
    adapter: "gemini",
    provider: "google",
    model: "gemini-judge",
    apiKeyEnv: "CLASH_TEST_GEMINI_KEY",
    baseUrl,
  };
}

type MediaFixture = {
  id: string;
  kind: "image" | "video" | "audio";
  path: string;
  bytes: Buffer;
};

async function fixture(media: MediaFixture[]): Promise<{
  workspace: string;
  caseRoot: string;
  request: QualityReviewRequest;
  evidence: ArtifactEvidence[];
}> {
  const root = await mkdtemp(join(tmpdir(), "clash-gemini-judge-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const caseRoot = join(root, "case");
  await mkdir(join(workspace, "renders"), { recursive: true });
  await mkdir(caseRoot);
  const evidence: ArtifactEvidence[] = [];
  for (const item of media) {
    await writeFile(join(workspace, item.path), item.bytes);
    evidence.push({
      id: item.id,
      kind: item.kind,
      path: item.path,
      bytes: item.bytes.byteLength,
      sha256: createHash("sha256").update(item.bytes).digest("hex"),
    });
  }
  const benchmark: ArtifactBenchmarkCase = {
    id: "media-judge",
    title: "Media judge",
    category: "mixed",
    tags: ["content-effect"],
    outcome: {
      objective: "Cut a short rhythmic edit.",
      acceptanceCriteria: ["Impacts land on the beat."],
      deliverables: media.map(({ id, kind }) => ({
        artifactId: id,
        kind,
        description: id,
      })),
    },
    qualityCriteria: [
      {
        id: "visual-payoff",
        description: "The frames close on a distinct payoff.",
        weight: 1,
        evidenceArtifactIds: media
          .filter(({ kind }) => kind === "image")
          .map(({ id }) => id),
      },
      {
        id: "audio-visual-synchrony",
        description: "Impacts feel synchronized to the rhythm bed.",
        weight: 1,
        evidenceArtifactIds: media
          .filter(({ kind }) => kind !== "image")
          .map(({ id }) => id),
      },
    ],
    passScore: 80,
    timeoutMs: 10_000,
    skills: [],
    execution: {
      profile: "clash-host",
      requiredProductOperations: ["timeline.render"],
      environment: {
        profile: "clash-workspace-v1",
        track: "content-effect",
        inputWorkspace: {
          path: "environments/base-v1",
          bundleDigest: "b".repeat(64),
        },
        outputs: {
          modifiedWorkspace: true,
          rawTrajectory: true,
          normalizedTrajectory: "clash-normalized-v1",
          atifTrajectory: "ATIF-v1.7-when-supported",
          otlpTrace: "otlp-json",
          attempt: "clash-attempt-v1",
        },
      },
    },
    rubric: [
      {
        id: "frame",
        type: "artifact-exists",
        artifactId: media[0]!.id,
        weight: 1,
      },
    ],
  };
  const request = createQualityReviewRequest({
    benchmark,
    evaluation: {
      schemaVersion: 1,
      benchmarkId: benchmark.id,
      taskId: benchmark.id,
      status: "pass",
      score: 100,
      checks: [],
      artifacts: evidence,
      outcomeGate: {
        status: "pass",
        detail: "Present.",
        missingArtifactIds: [],
        invalidArtifactIds: [],
      },
    },
  });
  return { workspace, caseRoot, request, evidence };
}

const MEDIA: MediaFixture[] = [
  {
    id: "frame-peak",
    kind: "image",
    path: "renders/peak.png",
    bytes: Buffer.from("png-bytes"),
  },
  {
    id: "final-video",
    kind: "video",
    path: "renders/final.mp4",
    bytes: Buffer.from("mp4-bytes"),
  },
  {
    id: "rhythm-audio",
    kind: "audio",
    path: "renders/rhythm.wav",
    bytes: Buffer.from("wav-bytes"),
  },
];

function judgeReply(
  text: string,
  extraParts: Array<Record<string, unknown>> = [],
): Reply {
  return {
    body: {
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [...extraParts, { text }] },
        },
      ],
      modelVersion: "gemini-judge-001",
    },
  };
}

function judgeJson(scores: [number, number]): string {
  return JSON.stringify({
    schemaVersion: 1,
    criteria: [
      {
        id: "visual-payoff",
        score: scores[0],
        rationale: "Distinct final frame.",
      },
      {
        id: "audio-visual-synchrony",
        score: scores[1],
        rationale: "Hits land on beats.",
      },
    ],
    overallRationale: "Grounded in the attached media.",
  });
}

type InlinePart = {
  inline_data?: { mime_type: string; data: string };
  file_data?: { mime_type: string; file_uri: string };
  text?: string;
};

function generateBody(request: RecordedRequest) {
  return JSON.parse(request.body.toString("utf8")) as {
    contents: Array<{ parts: InlinePart[] }>;
    tools?: unknown;
    generationConfig: { responseMimeType: string };
  };
}

describe("Gemini content-effect judge", () => {
  it("accepts image, video, and audio criteria that keep the Codex judge pending", async () => {
    const { request } = await fixture(MEDIA);

    expect(codexQualityJudgeSupportsRequest(request)).toBe(false);
    expect(geminiQualityJudgeSupportsRequest(request)).toBe(true);
  });

  it("does not claim criteria whose evidence is a non-media artifact", async () => {
    const { request } = await fixture(MEDIA);
    const reportRequest: QualityReviewRequest = {
      ...request,
      artifacts: request.artifacts.map((artifact) =>
        artifact.id === "rhythm-audio"
          ? { ...artifact, kind: "report" }
          : artifact,
      ),
    };

    expect(geminiQualityJudgeSupportsRequest(reportRequest)).toBe(false);
  });

  it("sends the exact verified media bytes with a header key and returns a bound review", async () => {
    const { workspace, caseRoot, request, evidence } = await fixture(MEDIA);
    respond = () => judgeReply(judgeJson([90, 70]));

    const result = await runGeminiQualityJudge({
      reviewer: reviewer(),
      request,
      evidence,
      workspace,
      caseRoot,
    });

    expect(recorded).toHaveLength(1);
    const [call] = recorded;
    expect(call!.url).toBe("/v1beta/models/gemini-judge:generateContent");
    expect(call!.headers["x-goog-api-key"]).toBe(API_KEY);
    const body = generateBody(call!);
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    const inline = body.contents[0]!.parts.flatMap((part) =>
      part.inline_data ? [part.inline_data] : [],
    );
    expect(
      Object.fromEntries(
        inline.map(({ data, mime_type }) => [
          Buffer.from(data, "base64").toString(),
          mime_type,
        ]),
      ),
    ).toEqual({
      "png-bytes": "image/png",
      "mp4-bytes": "video/mp4",
      "wav-bytes": "audio/wav",
    });
    const serialized = call!.body.toString("utf8");
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain("renders/");

    expect(result?.reviewer).toMatchObject({
      kind: "gemini",
      provider: "google",
      model: "gemini-judge",
    });
    expect(result?.reviewer.adapterVersion).toContain("gemini-judge-001");
    expect(result?.aggregate).toEqual({
      score: 80,
      threshold: 80,
      status: "pass",
    });
    expect(evaluateQualityReview({ request, result }).status).toBe("pass");
    expect(
      await readFile(
        join(caseRoot, "quality-review-private", "request-summary.json"),
        "utf8",
      ),
    ).not.toContain(API_KEY);
  });

  it("refuses evidence whose bytes changed after technical evaluation", async () => {
    const { workspace, caseRoot, request, evidence } = await fixture(MEDIA);
    await writeFile(join(workspace, "renders/final.mp4"), "mp4-BYTES");

    await expect(
      runGeminiQualityJudge({
        reviewer: reviewer(),
        request,
        evidence,
        workspace,
        caseRoot,
      }),
    ).rejects.toThrow(/final-video.*SHA-256/u);
    expect(recorded).toHaveLength(0);
  });

  it("fails before any request when the API key variable is unset", async () => {
    const { workspace, caseRoot, request, evidence } = await fixture(MEDIA);
    delete process.env.CLASH_TEST_GEMINI_KEY;

    await expect(
      runGeminiQualityJudge({
        reviewer: reviewer(),
        request,
        evidence,
        workspace,
        caseRoot,
      }),
    ).rejects.toThrow(/CLASH_TEST_GEMINI_KEY/u);
    expect(recorded).toHaveLength(0);
  });

  it.each([
    [
      "a tool call",
      judgeReply(judgeJson([90, 90]), [
        { functionCall: { name: "x", args: {} } },
      ]),
      /tool operation/u,
    ],
    [
      "a safety stop",
      {
        body: {
          candidates: [{ finishReason: "SAFETY", content: { parts: [] } }],
        },
      },
      /SAFETY/u,
    ],
    [
      "an HTTP error",
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } },
      /HTTP 429/u,
    ],
    [
      "a response with a missing criterion",
      judgeReply(
        JSON.stringify({
          schemaVersion: 1,
          criteria: [{ id: "visual-payoff", score: 90, rationale: "x" }],
          overallRationale: "x",
        }),
      ),
      /criteria/u,
    ],
  ] as Array<[string, Reply, RegExp]>)(
    "fails closed on %s",
    async (_label, reply, message) => {
      const { workspace, caseRoot, request, evidence } = await fixture(MEDIA);
      respond = () => reply;

      await expect(
        runGeminiQualityJudge({
          reviewer: reviewer(),
          request,
          evidence,
          workspace,
          caseRoot,
        }),
      ).rejects.toThrow(message);
      expect(
        await readFile(
          join(caseRoot, "quality-review-private", "error.log"),
          "utf8",
        ),
      ).not.toContain(API_KEY);
    },
  );

  it("ignores thought parts when reading the judged JSON", async () => {
    const { workspace, caseRoot, request, evidence } = await fixture(MEDIA);
    respond = () =>
      judgeReply(judgeJson([60, 60]), [
        { text: "considering the frames", thought: true },
      ]);

    const result = await runGeminiQualityJudge({
      reviewer: reviewer(),
      request,
      evidence,
      workspace,
      caseRoot,
    });

    expect(result?.aggregate.status).toBe("fail");
  });

  it("uploads oversized video through the Files API and deletes it afterwards", async () => {
    const largeVideo = Buffer.alloc(15 * 1024 * 1024, 7);
    const media = MEDIA.map((item) =>
      item.id === "final-video" ? { ...item, bytes: largeVideo } : item,
    );
    const { workspace, caseRoot, request, evidence } = await fixture(media);
    let uploaded = 0;
    let polled = 0;
    respond = (call) => {
      if (call.url === "/upload/v1beta/files") {
        uploaded += 1;
        const label = call.headers["x-goog-upload-header-content-type"];
        return {
          headers: {
            "x-goog-upload-url": `${baseUrl}/resumable/${uploaded}?type=${label}`,
          },
          body: {},
        };
      }
      if (call.url.startsWith("/resumable/")) {
        const id = call.url.split("/")[2]!.split("?")[0];
        return {
          body: {
            file: {
              name: `files/f${id}`,
              uri: `${baseUrl}/v1beta/files/f${id}`,
              state: "PROCESSING",
              sizeBytes: String(call.body.byteLength),
            },
          },
        };
      }
      if (call.method === "GET" && call.url.startsWith("/v1beta/files/")) {
        polled += 1;
        const name = call.url.slice("/v1beta/".length);
        return {
          body: { name, uri: `${baseUrl}/v1beta/${name}`, state: "ACTIVE" },
        };
      }
      if (call.method === "DELETE") return { body: {} };
      return judgeReply(judgeJson([85, 85]));
    };

    const result = await runGeminiQualityJudge({
      reviewer: reviewer(),
      request,
      evidence,
      workspace,
      caseRoot,
    });

    const finalize = recorded.filter(({ url }) =>
      url.startsWith("/resumable/"),
    );
    expect(
      finalize.map(({ headers }) => headers["x-goog-upload-command"]),
    ).toEqual(["upload, finalize", "upload, finalize"]);
    expect(finalize.some(({ body }) => body.equals(largeVideo))).toBe(true);
    expect(polled).toBe(2);
    const generate = recorded.find(({ url }) =>
      url.endsWith(":generateContent"),
    )!;
    const parts = generateBody(generate).contents[0]!.parts;
    expect(
      parts
        .filter((part) => part.file_data)
        .map((part) => part.file_data!.mime_type)
        .sort(),
    ).toEqual(["audio/wav", "video/mp4"]);
    expect(
      parts
        .filter((part) => part.inline_data)
        .map((part) => part.inline_data!.mime_type),
    ).toEqual(["image/png"]);
    expect(
      recorded
        .filter(({ method }) => method === "DELETE")
        .map(({ url }) => url)
        .sort(),
    ).toEqual(["/v1beta/files/f1", "/v1beta/files/f2"]);
    expect(result?.aggregate.status).toBe("pass");
  });

  it("records the endpoint host and key variable name, never the key or a path", async () => {
    const { workspace, caseRoot, request, evidence } = await fixture(MEDIA);
    respond = () => judgeReply(judgeJson([90, 70]));

    const result = await runGeminiQualityJudge({
      reviewer: reviewer(),
      request,
      evidence,
      workspace,
      caseRoot,
    });

    expect(result?.reviewer).toMatchObject({
      endpointHost: new URL(baseUrl).host,
      apiKeyEnv: "CLASH_TEST_GEMINI_KEY",
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    for (const file of ["request-summary.json", "response.json"]) {
      expect(
        await readFile(join(caseRoot, "quality-review-private", file), "utf8"),
      ).not.toContain(API_KEY);
    }
  });

  it("accepts only an https origin without credentials for the key-bearing base URL", () => {
    expect(geminiBaseUrl("https://relay.example/")).toBe(
      "https://relay.example",
    );
    expect(geminiBaseUrl("http://127.0.0.1:9")).toBe("http://127.0.0.1:9");
    for (const bad of [
      "http://relay.example",
      "https://user:pw@relay.example",
      "https://relay.example/?key=1",
      "not a url",
    ]) {
      expect(() => geminiBaseUrl(bad)).toThrow();
    }
  });
});
