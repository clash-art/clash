export const CLASH_MCP_COMMAND_IDS = [
  "workspace",
  "plugin",
  "assets",
  "canvas",
  "generators",
  "director",
  "timeline",
] as const;

export type ClashMcpCommandId = (typeof CLASH_MCP_COMMAND_IDS)[number];
export type ClashMcpToolFamily = ClashMcpCommandId | "other";

export type ClashMcpCommand = {
  id: ClashMcpCommandId;
  title: string;
  useWhen: string;
};

/** Root MCP command menu. Leaf syntax remains owned by each live typed tool. */
export const CLASH_MCP_COMMANDS: readonly ClashMcpCommand[] = [
  {
    id: "workspace",
    title: "Workspace",
    useWhen: "binding or inspecting the local Clash project workspace",
  },
  {
    id: "plugin",
    title: "Plugins",
    useWhen:
      "managing Clash plugins, controlling connected Blender/Maya scenes, and exchanging native materials with Clash Assets",
  },
  {
    id: "assets",
    title: "Assets",
    useWhen:
      "importing, finding, reading, admitting, or publishing immutable Project and personal Global media, and reading exact Project Document revisions",
  },
  {
    id: "canvas",
    title: "Canvas",
    useWhen:
      "creating, finding, connecting, or executing media and generation nodes",
  },
  {
    id: "generators",
    title: "Generators",
    useWhen:
      "discovering a plugin-registered Project Generator, its head Revision, or running an Action Run against it",
  },
  {
    id: "director",
    title: "Director Stage",
    useWhen:
      "blocking characters, cameras, shots, performance, and spatial continuity",
  },
  {
    id: "timeline",
    title: "Timeline editor",
    useWhen:
      "assembling picture, sound, captions, transitions, graphics, and editorial timing",
  },
] as const;

export type ClashMcpCommandMenu<T> = {
  schemaVersion: 1;
  commands: Array<{
    id: ClashMcpCommandId;
    title: string;
    useWhen: string;
    availableOperations: number;
  }>;
  selectedCommand?: ClashMcpCommandId;
  operations?: T[];
};

export function classifyClashMcpTool(name: string): ClashMcpToolFamily {
  if (name.startsWith("clash_workspace_") || name.startsWith("clash_studio_"))
    return "workspace";
  if (name.startsWith("clash_plugin_")) return "plugin";
  if (name.startsWith("clash_assets_")) return "assets";
  if (name.startsWith("clash_canvas_")) return "canvas";
  if (name.startsWith("clash_generators_")) return "generators";
  if (name.startsWith("clash_director_")) return "director";
  if (name.startsWith("clash_timeline_")) return "timeline";
  return "other";
}

export function getClashMcpCommand(id: ClashMcpCommandId): ClashMcpCommand {
  const command = CLASH_MCP_COMMANDS.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Unknown Clash MCP command: ${id}`);
  return command;
}

export function buildClashMcpCommandMenu<T>(input: {
  operations: readonly T[];
  selectedCommand?: ClashMcpCommandId;
  belongsToCommand(operation: T, command: ClashMcpCommand): boolean;
}): ClashMcpCommandMenu<T> {
  const operationsFor = (command: ClashMcpCommand): T[] =>
    input.operations.filter((operation) =>
      input.belongsToCommand(operation, command),
    );
  const root = {
    schemaVersion: 1 as const,
    commands: CLASH_MCP_COMMANDS.map((command) => ({
      id: command.id,
      title: command.title,
      useWhen: command.useWhen,
      availableOperations: operationsFor(command).length,
    })),
  };
  if (!input.selectedCommand) return root;
  const command = getClashMcpCommand(input.selectedCommand);
  return {
    ...root,
    selectedCommand: command.id,
    operations: operationsFor(command),
  };
}
