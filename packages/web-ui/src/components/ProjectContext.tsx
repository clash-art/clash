
import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import {
    listUserEnabledCanvasModelIds,
    type ModelCatalogEntry,
    type ProviderAccountAvailability,
} from '@clash/shared-types';
import { listModelCatalog, listModelProviders } from '../lib/clientActions';

interface ProjectContextType {
    projectId: string;
    enabledModelCatalog: ModelCatalogEntry[];
    modelCatalogReady: boolean;
    configureModels?: () => void;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export function enabledModelCatalogEntries(
    entries: ReadonlyArray<ModelCatalogEntry>,
    providers: ProviderAccountAvailability[],
): ModelCatalogEntry[] {
    const enabledIds = new Set(listUserEnabledCanvasModelIds({
        models: entries.map((entry) => entry.model),
        configuredProviders: providers,
    }));
    return entries.filter((entry) => enabledIds.has(entry.model.id)
        && entry.tier === 'available' && entry.selectedRoute !== null
        && entry.runtimeReadiness?.executable !== false);
}

export function ProjectProvider({
    projectId,
    children,
    initialModelCatalog,
    catalogVersion = 0,
    onConfigureModels,
}: {
    projectId: string;
    children: ReactNode;
    initialModelCatalog?: ModelCatalogEntry[];
    catalogVersion?: number;
    onConfigureModels?: () => void;
}) {
    const [enabledModelCatalog, setEnabledModelCatalog] = useState<ModelCatalogEntry[]>(initialModelCatalog ?? []);
    const [modelCatalogReady, setModelCatalogReady] = useState(initialModelCatalog !== undefined);

    useEffect(() => {
        if (initialModelCatalog !== undefined) return;
        let cancelled = false;
        setModelCatalogReady(false);
        void Promise.all([listModelCatalog(), listModelProviders()])
            .then(([entries, providers]) => {
                if (!cancelled) setEnabledModelCatalog(enabledModelCatalogEntries(entries, providers));
            })
            .catch(() => {
                if (!cancelled) setEnabledModelCatalog([]);
            })
            .finally(() => {
                if (!cancelled) setModelCatalogReady(true);
            });
        return () => { cancelled = true; };
    }, [initialModelCatalog, projectId, catalogVersion]);

    const value = useMemo(
        () => ({ projectId, enabledModelCatalog, modelCatalogReady, configureModels: onConfigureModels }),
        [enabledModelCatalog, modelCatalogReady, projectId, onConfigureModels],
    );
    return (
        <ProjectContext.Provider value={value}>
            {children}
        </ProjectContext.Provider>
    );
}

export function useProject() {
    const context = useContext(ProjectContext);
    if (!context) {
        throw new Error('useProject must be used within ProjectProvider');
    }
    return context;
}
