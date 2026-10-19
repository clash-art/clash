import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

import { AssetKindSchema } from "./assets.js";
import type { DraftActionAssetInput } from "./action-asset-bindings.js";

/**
 * Storage-neutral media context attached to a Copilot message.
 *
 * `projectAssetId` is the only media identity. Host URLs, local paths,
 * Resource ids, and storage keys are intentionally impossible to encode.
 */
export let CopilotProjectAssetReferenceSchema = lazySchema(() => (
z
  .object({
    projectAssetId: z.string().trim().min(1),
    kind: AssetKindSchema,
    label: z.string().trim().min(1),
  })
  .strict()
), (real) => { CopilotProjectAssetReferenceSchema = real; });
export type CopilotProjectAssetReference = z.infer<
  typeof CopilotProjectAssetReferenceSchema
>;

/** One Copilot turn's persistent draft Action input identity. */
export let CopilotProjectAssetSubmissionSchema = lazySchema(() => (
z
  .object({
    actionId: z.string().trim().min(1),
    assets: CopilotProjectAssetReferenceSchema.array().min(1),
  })
  .strict()
), (real) => { CopilotProjectAssetSubmissionSchema = real; });
export type CopilotProjectAssetSubmission = z.infer<
  typeof CopilotProjectAssetSubmissionSchema
>;

/** Compile one message's ordered references into semantic draft Action inputs. */
export function copilotProjectAssetDraftInputs(
  input: CopilotProjectAssetSubmission,
): DraftActionAssetInput[] {
  const submission = CopilotProjectAssetSubmissionSchema.parse(input);
  return submission.assets.map((asset, index) => ({
    slot: `attachment:${index}`,
    projectAssetId: asset.projectAssetId,
    role: "reference",
  }));
}
