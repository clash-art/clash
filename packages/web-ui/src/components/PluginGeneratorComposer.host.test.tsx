// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginGeneratorComposer } from "./PluginGeneratorComposer";

vi.mock("./ProjectContext", () => ({
  useProject: () => ({ projectId: "project" }),
}));
vi.mock("./LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => ({ doc: null }),
}));
vi.mock("./CustomActionsContext", () => ({
  useProjectCustomActions: () => [
    {
      id: "generate-card",
      pluginBinding: { pluginId: "test.generator" },
      generator: { definitionId: "image", actionId: "generate" },
    },
    {
      id: "edit-card",
      pluginBinding: { pluginId: "test.generator" },
      generator: { definitionId: "image", actionId: "edit" },
    },
  ],
}));
vi.mock("../hooks/useNativeGeneratorDraft", () => ({
  useNativeGeneratorDraft: () => ({
    projection: {
      revision: {
        definitionRef: { pluginId: "test.generator", definitionId: "image" },
      },
    },
  }),
}));
vi.mock("./nodes/ActionBadge", () => ({
  GeneratorComposer: ({ data }: { data: Record<string, unknown> }) => (
    <div aria-label="Native composer">
      {String(data.generatorId)} / {String(data.actionCardId)}
    </div>
  ),
}));
afterEach(cleanup);

it("opens the native composer for a Generator without a Canvas placement and chooses the requested Action", () => {
  render(
    <PluginGeneratorComposer
      generatorId="unplaced-draft"
      actionId="edit"
      onExecuteRevision={async () => {}}
    />,
  );
  expect(screen.getByLabelText("Native composer").textContent).toBe(
    "unplaced-draft / edit-card",
  );
  expect(screen.queryByRole("status")).toBeNull();
});
