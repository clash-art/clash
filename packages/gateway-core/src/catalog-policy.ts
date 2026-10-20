/**
 * Product policy applied to every published catalog before routing, so each
 * adapter enforces it identically (locked decision, 2026-10-20): the official
 * gateway serves DeepSeek through Flash models only. A DeepSeek card that is
 * not a Flash card is dropped, and a Flash card keeps only implementations
 * whose upstream model is a Flash model, so routing can never fall back to a
 * Pro/Reasoner upstream.
 */
import type { GatewayCatalog, GatewayModelCard } from "./routing.js";

const DEEPSEEK = /deepseek/i;
const FLASH = /flash/i;

type Implementation = NonNullable<GatewayModelCard["providerImplementations"]>[number];

function isDeepSeekCard(card: GatewayModelCard): boolean {
  return (
    DEEPSEEK.test(card.id) ||
    DEEPSEEK.test(card.provider) ||
    (card.providerImplementations ?? []).some(
      (implementation) =>
        DEEPSEEK.test(implementation.upstreamId) || DEEPSEEK.test(implementation.upstreamModel),
    )
  );
}

function servesFlashOnly(implementation: Implementation): boolean {
  return FLASH.test(implementation.upstreamModel);
}

export interface GatewayCatalogExclusion {
  modelCode: string;
  reason: "deepseek-not-flash";
}

export function applyGatewayCatalogPolicy(catalog: GatewayCatalog): {
  catalog: GatewayCatalog;
  excluded: GatewayCatalogExclusion[];
} {
  const excluded: GatewayCatalogExclusion[] = [];
  const models = catalog.models.flatMap((card): GatewayModelCard[] => {
    if (!isDeepSeekCard(card)) return [card];
    const implementations = (card.providerImplementations ?? []).filter(servesFlashOnly);
    if (!FLASH.test(card.id) || implementations.length === 0) {
      excluded.push({ modelCode: card.id, reason: "deepseek-not-flash" });
      return [];
    }
    return [{ ...card, providerImplementations: implementations }];
  });
  return { catalog: { ...catalog, models }, excluded };
}
