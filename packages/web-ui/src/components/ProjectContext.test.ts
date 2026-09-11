import { describe, expect, it } from 'vitest';
import { MODEL_CARDS, type ModelCard, type ModelCatalogEntry, type ProviderAccountAvailability } from '@clash/shared-types';
import { enabledModelCatalogEntries } from './ProjectContext';

describe('enabledModelCatalogEntries', () => {
    it('requires both canvas enablement and an executable catalog route', () => {
        const template = MODEL_CARDS.find((model) => model.kind === 'video')!;
        const model = (id: string): ModelCard => ({
            ...template,
            id,
            name: id,
            providerImplementations: [{
                providerId: 'fal',
                upstreamId: 'fal',
                upstreamModel: `test/${id}`,
                apiShape: 'fal',
            }],
        });
        const entry = (card: ModelCard, tier: ModelCatalogEntry['tier'], selectedRoute: unknown) => ({
            model: card,
            tier,
            selectedRoute,
        }) as ModelCatalogEntry;
        const providers: ProviderAccountAvailability[] = [{
            providerId: 'fal',
            upstreamId: 'fal',
            enabled: true,
            supportedModelIds: ['enabled-canvas-model'],
        }];

        const enabled = enabledModelCatalogEntries([
            entry(model('enabled-canvas-model'), 'configured-provider', null),
            entry(model('disabled-canvas-model'), 'available', { providerId: 'configured' }),
        ], providers);

        expect(enabled).toEqual([]);
        expect(enabledModelCatalogEntries([entry(model('enabled-canvas-model'), 'available', { providerId: 'fal' })], providers).map(e => e.model.id)).toEqual(['enabled-canvas-model']);
        expect(enabledModelCatalogEntries([entry(model('enabled-canvas-model'), 'all', null)], [])).toEqual([]);
        expect(enabledModelCatalogEntries([{
            ...entry(model('enabled-canvas-model'), 'available', { providerId: 'fal' }),
            runtimeReadiness: { capability: 'text-to-speech', model: 'local-test', readiness: 'not-installed', executable: false },
        }], providers)).toEqual([]);
    });
});
