/**
 * Base model cards for the Cloudflare adapter: built-in cards composed with the
 * model-provider bindings of the in-process first-party plugins (same shared
 * `composeExecutablePluginModelCards` the local Host uses). Plugin documents
 * load lazily on first use, so Worker startup does not evaluate them.
 */
import {
  MODEL_CARDS,
  composeExecutablePluginModelCards,
  modelCardVisibleToConsumer,
  type ModelCard,
} from "@clash/shared-types";

let cards: Promise<ModelCard[]> | undefined;

export function hostedBaseModelCards(): Promise<ModelCard[]> {
  // Dynamic import keeps the plugin registry out of the Worker's eager graph.
  cards ??= import("./plugin-execution/registry")
    .then((registry) => registry.listCloudInProcessModelBindings())
    .then((bindings) =>
      composeExecutablePluginModelCards(MODEL_CARDS, [], bindings).filter(
        (model) => modelCardVisibleToConsumer(model, undefined),
      ),
    )
    .catch((error) => {
      cards = undefined;
      throw error;
    });
  return cards;
}
