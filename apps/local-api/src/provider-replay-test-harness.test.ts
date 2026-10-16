import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertProviderMediaFormat,
  createProviderReplayOfflineFetch,
  mediaTypeMatchesExpectedAssetKind,
  normalizeProviderReplayText,
  providerTestReferenceAssetId,
  providerTestExecutedNodeId,
  resolveProviderReplayChainRefs,
  runProviderReplayTestHarness,
  validateProviderReplayCaseChain,
} from "./provider-replay-test-harness.js";
import { loadProviderLiveTestConfig } from "./provider-live-test-config.test-helper.js";

describe("provider replay test harness", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("defaults to credential-free offline replay", async () => {
    await expect(
      loadProviderLiveTestConfig({
        CLASH_PROVIDER_E2E_CONFIG: "/does/not/exist/provider-e2e.json",
        CLASH_MINIMAX_API_KEY: "must-not-be-read-during-replay",
      }),
    ).resolves.toEqual({
      mode: "replay",
      env: {},
    });
  });

  it("loads live credentials from a local config and lets environment variables override them", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-provider-e2e-config-"));
    temporaryRoots.push(root);
    const configPath = join(root, "provider-e2e.json");
    await writeFile(
      configPath,
      JSON.stringify({
        env: {
          CLASH_MINIMAX_API_KEY: "config-key",
          CLASH_GOOGLE_KEY: "/config/google.json",
        },
      }),
    );

    await expect(
      loadProviderLiveTestConfig({
        CLASH_PROVIDER_E2E: "live",
        CLASH_PROVIDER_E2E_CONFIG: configPath,
        CLASH_MINIMAX_API_KEY: "environment-key",
      }),
    ).resolves.toEqual({
      mode: "live",
      configPath,
      env: {
        CLASH_MINIMAX_API_KEY: "environment-key",
        CLASH_GOOGLE_KEY: "/config/google.json",
        CLASH_PROVIDER_E2E: "live",
        CLASH_PROVIDER_E2E_CONFIG: configPath,
      },
    });
  });

  it("preserves a host-command execute error instead of reporting a missing child node", () => {
    expect(() =>
      providerTestExecutedNodeId("minimax-tts", {
        error: "MiniMax TTS rejected voice_id female-warm",
      }),
    ).toThrow(
      "minimax-tts execute failed: MiniMax TTS rejected voice_id female-warm",
    );
  });

  it("keeps reference import identity stable for the same case and reference index", () => {
    const firstReplay = providerTestReferenceAssetId("case/with spaces", 0);
    const secondReplay = providerTestReferenceAssetId("case/with spaces", 0);

    expect(secondReplay).toBe(firstReplay);
    expect(providerTestReferenceAssetId("another-case", 0)).not.toBe(
      firstReplay,
    );
    expect(providerTestReferenceAssetId("case/with spaces", 1)).not.toBe(
      firstReplay,
    );
  });

  it("blocks non-loopback fetches during offline replay", async () => {
    const calls: string[] = [];
    const guarded = createProviderReplayOfflineFetch(async (input) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("local");
    });

    await expect(
      guarded("http://127.0.0.1:49321/api/v1/projects"),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      guarded("https://provider.example/v1/generate"),
    ).rejects.toThrow("Offline provider replay blocked network fetch");
    expect(calls).toEqual(["http://127.0.0.1:49321/api/v1/projects"]);
  });

  it("normalizes only presentation-level text differences for replay grading", () => {
    expect(normalizeProviderReplayText("你好 Clash，测试时间对齐！")).toBe(
      "你好clash测试时间对齐",
    );
    expect(normalizeProviderReplayText("ＣＬＡＳＨ\u00a0ready")).toBe(
      "clashready",
    );
    expect(normalizeProviderReplayText("结果不同")).not.toBe(
      normalizeProviderReplayText("结果相同"),
    );
  });

  it("accepts model_gen as a provider replay case type carrying a 3D output", async () => {
    // A `type: "model_gen"` case with `expect: { kind: "model" }` must be
    // representable at the type level (mesh generation / auto-rig). We can't
    // exercise a live model_gen provider run without network or a bundled
    // Tripo plugin, so this is a compile-time + fast-fail structural check
    // rather than a full grading run.
    await expect(
      runProviderReplayTestHarness({
        fixturePath: join(
          import.meta.dirname,
          "fixtures/minimax-local-stand-in-traffic.jsonl",
        ),
        account: {
          id: "model-gen-shape-check",
          providerId: "minimax",
          upstreamId: "minimax",
          credentials: { apiKey: "replay-placeholder" },
        },
        cases: [
          {
            id: "mesh-gen",
            type: "model_gen",
            modelId: "meshy-mesh-gen",
            prompt: "Generate a low-poly fox mesh",
            expect: { kind: "model", mediaType: "model/gltf-binary" },
            // Forward reference: no earlier case named `auto-rig` exists yet,
            // so the harness must fail fast during chain validation instead of
            // starting a server or touching the network.
            refCaseIds: ["auto-rig"],
          },
        ],
        providerAssetFetch: async () => {
          throw new Error("offline replay harness attempted provider network");
        },
      }),
    ).rejects.toThrow(/refCaseIds names auto-rig/);
  });

  it("validates a case chain rejects self-references and forward references", () => {
    expect(() =>
      validateProviderReplayCaseChain([
        { id: "mesh-gen" },
        { id: "auto-rig", refCaseIds: ["mesh-gen"] },
      ]),
    ).not.toThrow();

    expect(() =>
      validateProviderReplayCaseChain([
        { id: "mesh-gen", refCaseIds: ["mesh-gen"] },
      ]),
    ).toThrow(/cannot reference itself/);

    expect(() =>
      validateProviderReplayCaseChain([
        { id: "auto-rig", refCaseIds: ["mesh-gen"] },
        { id: "mesh-gen" },
      ]),
    ).toThrow(/refCaseIds names mesh-gen, which is not an earlier case/);

    expect(() =>
      validateProviderReplayCaseChain([
        { id: "auto-rig", refCaseIds: ["does-not-exist"] },
      ]),
    ).toThrow(/refCaseIds names does-not-exist, which is not an earlier case/);
  });

  it("matches a 3D model MIME against a known set, not a naive `model/` prefix pass-through", () => {
    expect(
      mediaTypeMatchesExpectedAssetKind("model", "model/gltf-binary"),
    ).toBe(true);
    expect(
      mediaTypeMatchesExpectedAssetKind("model", "model/gltf+json"),
    ).toBe(true);
    // Not every `model/*` spelling is a real, replayable 3D container --
    // an unregistered subtype must not pass just because of the prefix.
    expect(
      mediaTypeMatchesExpectedAssetKind("model", "model/not-a-real-format"),
    ).toBe(false);
    // These are real published 3D MIME types, but `assertProviderMediaFormat`
    // has no byte-level validator for them: accepting them here would let a
    // case pass MIME matching and then always fail format assertion.
    expect(mediaTypeMatchesExpectedAssetKind("model", "model/obj")).toBe(
      false,
    );
    expect(mediaTypeMatchesExpectedAssetKind("model", "model/stl")).toBe(
      false,
    );
    expect(
      mediaTypeMatchesExpectedAssetKind("model", "model/vnd.usdz+zip"),
    ).toBe(false);
    expect(mediaTypeMatchesExpectedAssetKind("image", "image/png")).toBe(true);
    expect(mediaTypeMatchesExpectedAssetKind("image", "model/gltf-binary")).toBe(
      false,
    );
  });

  it("resolves refCaseIds to the graded output node id, not the Project Asset id", () => {
    const outputNodeIdByCaseId = new Map([
      ["mesh-gen", "node-abc123"],
    ]);

    const refs = resolveProviderReplayChainRefs(
      { id: "auto-rig", refCaseIds: ["mesh-gen"] },
      outputNodeIdByCaseId,
    );

    expect(refs).toEqual(["node-abc123"]);
    // The asset id format (`asset:provider-test:...`) must never leak into
    // `refs`; `host-command add` resolves `refs` as Canvas node ids.
    expect(refs).not.toEqual([
      providerTestReferenceAssetId("mesh-gen", 0),
    ]);
  });

  it("fails resolving a refCaseIds chain when the named case has not graded a node id yet", () => {
    expect(() =>
      resolveProviderReplayChainRefs(
        { id: "auto-rig", refCaseIds: ["mesh-gen"] },
        new Map(),
      ),
    ).toThrow(
      /auto-rig refCaseIds names mesh-gen, which has not produced a storable asset yet/,
    );
  });

  it("accepts real container signatures used by provider replay assets", () => {
    expect(() =>
      assertProviderMediaFormat(
        "image/png",
        Buffer.from("89504e470d0a1a0a00000000", "hex"),
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderMediaFormat(
        "image/jpeg",
        Buffer.from("ffd8ffe000104a46494600ffd9", "hex"),
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderMediaFormat(
        "audio/wav",
        Buffer.from("524946462400000057415645666d7420", "hex"),
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderMediaFormat(
        "audio/mpeg",
        Buffer.from("49443304000000000000", "hex"),
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderMediaFormat(
        "video/mp4",
        Buffer.from("000000186674797069736f6d00000200", "hex"),
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderMediaFormat(
        "model/gltf-binary",
        Buffer.concat([
          Buffer.from("glTF", "ascii"),
          Buffer.from([0x02, 0x00, 0x00, 0x00]),
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderMediaFormat(
        "model/gltf+json",
        Buffer.from('{"asset":{"version":"2.0"}}', "utf8"),
      ),
    ).not.toThrow();
  });

  it("rejects non-media bytes even when metadata claims a media MIME", () => {
    expect(() =>
      assertProviderMediaFormat("image/png", Buffer.from("not a png")),
    ).toThrow("does not contain PNG bytes");
    expect(() =>
      assertProviderMediaFormat("video/mp4", Buffer.from("not an mp4")),
    ).toThrow("does not contain an MP4 file type box");
    expect(() =>
      assertProviderMediaFormat(
        "model/gltf-binary",
        Buffer.from("not a glb file", "utf8"),
      ),
    ).toThrow("does not contain a glTF binary magic header");
    expect(() =>
      assertProviderMediaFormat(
        "model/gltf+json",
        Buffer.from("not json at all", "utf8"),
      ),
    ).toThrow("does not contain glTF JSON content");
  });

  it("grades a text fixture through Project Canvas with no provider network fallback", async () => {
    const fixturePath = join(
      import.meta.dirname,
      "fixtures/minimax-local-stand-in-traffic.jsonl",
    );
    const result = await runProviderReplayTestHarness({
      fixturePath,
      account: {
        id: "minimax-replay-harness",
        providerId: "minimax",
        upstreamId: "minimax",
        credentials: {
          apiKey: "replay-placeholder",
          service: "international",
          baseUrl: "https://minimax.stand-in.invalid",
        },
      },
      cases: [
        {
          id: "m3-text",
          type: "text_gen",
          modelId: "minimax-m3",
          prompt: "Explain this synthetic recorder fixture.",
          params: { system_prompt: "Answer in one sentence." },
          expect: {
            kind: "text",
            text: "Synthetic MiniMax M3 fixture answer.",
          },
        },
      ],
      providerAssetFetch: async () => {
        throw new Error("offline replay harness attempted provider network");
      },
    });

    expect(result.cases).toEqual([
      expect.objectContaining({
        id: "m3-text",
        kind: "text",
        text: "Synthetic MiniMax M3 fixture answer.",
        revisionId: expect.any(String),
      }),
    ]);
    expect(result.dataDir).toContain("clash-provider-replay-harness-");
    await expect(
      import("node:fs/promises").then(({ access }) => access(result.dataDir)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
