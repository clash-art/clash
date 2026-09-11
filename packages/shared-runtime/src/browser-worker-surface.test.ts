import { describe, expect, it } from "vitest";

import * as browser from "./browser.js";
import * as bflVideo from "./bfl-video.js";
import * as geminiOmni from "./gemini-omni.js";
import * as miniMaxH3 from "./minimax-h3.js";
import * as pikaChat from "./pika-chat.js";
import * as pikaMedia from "./pika-media.js";
import * as pikaPricing from "./pika-pricing.js";
import * as pikaRequest from "./pika-request.js";
import * as textGeneration from "./text-generation.js";

// The Vite/Worker "browser" condition resolves @clash/shared-runtime to
// browser.ts, so every Worker-safe API the root entry publishes must also be
// reachable here and must be the same implementation, not a re-declaration.
const workerSafeSurface: ReadonlyArray<readonly [string, unknown]> = [
  ["submitBflFlux3Video", bflVideo.submitBflFlux3Video],
  ["pollBflFlux3VideoOnce", bflVideo.pollBflFlux3VideoOnce],
  ["resolveFlux3KeyframeIndices", bflVideo.resolveFlux3KeyframeIndices],
  ["buildBflFlux3VideoRequest", bflVideo.buildBflFlux3VideoRequest],
  ["createGeminiOmniInteraction", geminiOmni.createGeminiOmniInteraction],
  ["downloadGeminiOmniVideo", geminiOmni.downloadGeminiOmniVideo],
  ["extractGeminiOmniVideo", geminiOmni.extractGeminiOmniVideo],
  ["geminiOmniInteractionId", geminiOmni.geminiOmniInteractionId],
  ["geminiOmniInteractionStatus", geminiOmni.geminiOmniInteractionStatus],
  ["getGeminiOmniInteraction", geminiOmni.getGeminiOmniInteraction],
  ["uploadPikaMedia", pikaMedia.uploadPikaMedia],
  ["createPikaMediaJob", pikaMedia.createPikaMediaJob],
  ["getPikaMediaJob", pikaMedia.getPikaMediaJob],
  ["getPikaMediaContent", pikaMedia.getPikaMediaContent],
  ["PIKA_MEDIA_BASE_URL", pikaMedia.PIKA_MEDIA_BASE_URL],
  ["generatePikaChat", pikaChat.generatePikaChat],
  ["buildPikaMediaRequest", pikaRequest.buildPikaMediaRequest],
  ["fetchPikaCatalogQuote", pikaPricing.fetchPikaCatalogQuote],
  ["pikaBillingBasis", pikaPricing.pikaBillingBasis],
  ["quotePikaCatalogRequest", pikaPricing.quotePikaCatalogRequest],
  ["generateTextCompletion", textGeneration.generateTextCompletion],
  ["buildMiniMaxH3Content", miniMaxH3.buildMiniMaxH3Content],
];

describe("browser entry Worker-safe surface", () => {
  it.each(workerSafeSurface)(
    "re-exports %s from its implementation module",
    (name, implementation) => {
      expect((browser as Record<string, unknown>)[name]).toBe(implementation);
    },
  );

  it("keeps the browser entry free of Node-only daemon and filesystem helpers", () => {
    const names = Object.keys(browser as Record<string, unknown>);
    expect(names).not.toContain("resolveDaemonNodeRuntime");
    expect(names).not.toContain("storeMetadataBody");
    expect(names).not.toContain("initializeClashWorkspace");
  });

  it("runs a Worker-safe pure helper through the browser entry", () => {
    const viaBrowser = browser.resolveFlux3KeyframeIndices(undefined, 3, 5);
    const viaModule = bflVideo.resolveFlux3KeyframeIndices(undefined, 3, 5);
    expect(viaBrowser).toEqual(viaModule);
  });

  it("builds MiniMax H3 content through the browser entry", () => {
    const input = {
      prompt: "a cat",
      orderedParts: [{ kind: "text" as const, text: "a cat" }],
    };
    expect(browser.buildMiniMaxH3Content(input)).toEqual(
      miniMaxH3.buildMiniMaxH3Content(input),
    );
  });
});
