import { createHash } from "node:crypto";
import {
  AsrTimedTranscriptSchema,
  transcriptContentHashInput,
} from "@clash/shared-types";

/**
 * The word grid's own identity, stable under any restatement of the same words.
 * Downstream cuts and caption cues address words by id, so this is what tells
 * them whether they are still talking about the transcript they were built on.
 */
export function transcriptGridHash(
  transcript: Pick<ReturnType<typeof AsrTimedTranscriptSchema.parse>, "words">,
): string {
  return `sha256:${createHash("sha256")
    .update(transcriptContentHashInput(transcript), "utf8")
    .digest("hex")}`;
}
