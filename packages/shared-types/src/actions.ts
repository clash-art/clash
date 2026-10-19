import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

/**
 * The AIGC actions, named by what each produces.
 *
 * Producing one class of output is one action; everything else is parameters. Speech and music are
 * both `audio`, and a video made from a still, from a start and end frame, or driven by an audio
 * track is `video` three times over -- those differ in what they accept, not in what they are.
 *
 * The alternative was tried and did not hold. Cards carried a `task` field, written on 8 of 50,
 * holding `text-to-speech` or `music-generation`. It was not a classification anyone had designed:
 * image and video variants are told apart by the shape of `inputMode`, and those two audio cards
 * happened to share an empty shape, so a field was added to break the tie. A vocabulary that exists
 * only where inference fails is not a vocabulary.
 *
 * This list was already here, spelled out three times as an inline union on `outputKind` in
 * model-capabilities. Naming it is what lets a card, a route and a default all be checked against
 * the same five words.
 *
 * **These are the AIGC actions, not every action.** An action is any operation the product
 * performs; these five are the ones a model performs, which is why each is backed by model cards
 * and those by providers. Rendering a timeline is an action and is not one of these: no model
 * produces it, it has no cards, and nothing about it is chosen by picking a provider. The enum was
 * briefly called `ACTION_KINDS`, which claimed a scope it did not have -- a timeline render is an
 * action that would have had to be absent from the list of actions.
 *
 * Almost `AssetKind`. That enum is `image | video | audio | model`: it names what can be stored.
 * `model` used to be the one member an AIGC action could never produce -- a 3-D asset a user could
 * hold without any action having made it -- but a model-generation action (mesh generation, or
 * binding an existing mesh into a rig) closes that gap the same way any other action produces its
 * output: a static model and a rigged model are both `model`, and there is no separate `rig` kind.
 * `text` is the one member left on this side only, because an AIGC action can produce prose
 * without that prose ever becoming a storable Asset.
 */
export const AIGC_ACTION_KINDS = ["image", "video", "audio", "text", "model"] as const;

export let AigcActionKindSchema = lazySchema(() => (
z.enum(AIGC_ACTION_KINDS)
), (real) => { AigcActionKindSchema = real; });

export type AigcActionKind = z.infer<typeof AigcActionKindSchema>;
