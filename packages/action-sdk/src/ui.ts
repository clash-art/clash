import type {
  PendingGeneratorOutput,
  PluginViewResource,
} from "@clash/shared-types/executable-plugin";
import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";

/** Native authoring edits a draft and submits only its acknowledged revision. */
export interface GeneratorComposerProps {
  generatorId: string;
  /** Selects the installed Action Card when a Definition exposes several Actions. */
  actionId?: string;
  onClose?: () => void;
  onExecuteRevision: (revision: {
    generatorId: string;
    generatorRevisionId: string;
  }) => Promise<void>;
}

export interface GeneratorOutputAsset extends PluginViewResource {
  generatedBy: Required<NonNullable<PluginViewResource["generatedBy"]>>;
}
export interface GeneratorOutputProps {
  output: PendingGeneratorOutput;
  presentation?: "thumbnail" | "preview";
  onPreview?: () => void;
  onReady: (asset: GeneratorOutputAsset) => void;
}

export interface PluginUiComponents {
  GeneratorOutput?: ComponentType<GeneratorOutputProps>;
  GeneratorComposer: ComponentType<GeneratorComposerProps>;
}
const PluginUiContext = createContext<PluginUiComponents | null>(null);

/** Installed by the application host, never by an executable plugin worker. */
export function PluginUiProvider({
  components,
  children,
}: {
  components: PluginUiComponents;
  children?: ReactNode;
}) {
  return createElement(
    PluginUiContext.Provider,
    { value: components },
    children,
  );
}

/** Reuses the host's references, parameter controls, validation, and draft persistence. */
export function GeneratorComposer(props: GeneratorComposerProps) {
  const components = useContext(PluginUiContext);
  if (!components)
    throw new Error("GeneratorComposer requires the host PluginUiProvider.");
  if (!props.generatorId.trim())
    throw new Error("GeneratorComposer requires a Generator identity.");
  return createElement(components.GeneratorComposer, props);
}

/** Host-resolved durable output tile; pending outputs are not fake Assets. */
export function GeneratorOutput(props: GeneratorOutputProps) {
  const components = useContext(PluginUiContext);
  if (!components?.GeneratorOutput)
    throw new Error("GeneratorOutput requires the host output renderer.");
  return createElement(components.GeneratorOutput, props);
}
