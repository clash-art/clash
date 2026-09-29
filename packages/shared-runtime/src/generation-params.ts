/**
 * GenerationParams — discriminated by `type`. The workflow dispatcher reads
 * `type` + `modelName` to pick a provider; the provider reads only the fields
 * it actually needs.
 */

import type { ModelUpstreamRoute } from "@clash/shared-types";

export interface GenerationParams {
  taskId: string;
  nodeId: string;
  projectId: string;
  type:
    | "image_gen"
    | "video_gen"
    | "audio_gen"
    | "text_gen"
    | "video_render"
    | "image_desc"
    | "video_desc"
    | "understand";

  // ─── Actor attribution (Phase 0 multi-actor billing) ──────────
  // Threaded from the node-creation site (web UI / ACP tool / CLI)
  // through NodeProcessor to here. The (closed-source) billing plugin
  // reads these to attribute usage; createAsset uses actorUserId as
  // the asset's owner (replacing the legacy getProjectOwner fallback
  // — that fallback was wrong as soon as a project had two humans
  // collaborating or an agent acting on behalf of its owner).
  //
  // actorUserId is REQUIRED — non-optional in the type so any new
  // call site that forgets to populate fails at compile time. There
  // is no fallback path; legacy nodes without an actor are surfaced
  // as failures in NodeProcessor with a clear error message.
  /** Who is responsible for this generation. */
  actorType: "user" | "agent";
  /** The accountable human user id. Always set, even for actorType='agent'
   *  (in which case it's the agent's owner / claimer). createAsset uses
   *  this as the asset row's user_id. */
  actorUserId: string;
  /** agent_member.id when actorType='agent'. Undefined otherwise. The
   *  plugin uses this to look up the agent's budget pocket. */
  actorAgentId?: string;

  prompt?: string;
  systemPrompt?: string;
  aspectRatio?: string;
  modelName?: string;
  modelParams?: Record<string, unknown>;
  /** Provider-account route resolved for this actor before execution. */
  selectedRoute?: ModelUpstreamRoute;

  /** Ordered prompt parts preserving text + asset-ref interleaving. */
  promptParts?: Array<{
    type: string;
    text?: string;
    nodeId?: string;
    r2Key?: string;
    modality?: "image" | "video" | "audio";
  }>;

  // ─── Input resources (4 orthogonal categories) ────────────────────
  // NodeProcessor maps Loro node ref arrays into these slots based purely
  // on inputMode shape (startEnd vs images vs videos vs audios). Providers
  // own the wire mapping — e.g. Veo decides whether referenceImageR2Keys[0]
  // becomes Vertex `inst.image` (i2v anchor) or `inst.referenceImages[]`
  // (multi-subject) based on its model id.

  /** startEnd: first frame anchor */
  startFrameR2Key?: string;
  /** startEnd: last frame anchor */
  endFrameR2Key?: string;
  /** Flat list of reference images. Used when promptParts isn't provided. */
  referenceImageR2Keys?: string[];
  /** Flat list of reference videos. */
  referenceVideoR2Keys?: string[];
  /** Flat list of reference audios. */
  referenceAudioR2Keys?: string[];

  // ─── Other generation params ──────────────────────────────────────
  duration?: number;
  cfgScale?: number;
  /** Deprecated alias kept for wire-compat; readers should fall back to modelName. */
  videoModel?: string;

  /** describe / understand */
  r2Key?: string;
  mimeType?: string;
  language?: string;

  /** video_render */
  timelineDsl?: Record<string, unknown>;

  /**
   * Lineage — pre-built `assets.sources` rows describing which upstream
   * assets contributed to this generation. The workflow forwards this to
   * `createAsset` on success, so old assets without lineage stay null.
   *
   * NodeProcessor builds it from the Loro pending node's `referenceImageAssetIds`
   * etc. fields (parallel to the URL arrays). Frontend-direct callers
   * (legacy /api/generate/*) currently leave it undefined.
   */
  sources?: Array<{
    assetId: string;
    role: "primary" | "reference" | "edit-source";
  }>;
}
