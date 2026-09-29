// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginGeneratorOutput } from "./PluginGeneratorOutput";
const client = vi.hoisted(() => ({
  getActionRun: vi.fn(),
  getOutputCommit: vi.fn(),
}));
vi.mock("@clash/shared-runtime/generator-client", () => ({
  createGeneratorClient: () => client,
}));
vi.mock("./ProjectContext", () => ({
  useProject: () => ({ projectId: "project" }),
}));
const output = {
  generatorId: "generator",
  generatorRevisionId: "revision",
  actionRunId: "run",
  outputSlot: "image",
  mediaKind: "image" as const,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("shows an acknowledged running output as a pending material instead of inventing an asset", async () => {
  client.getActionRun.mockResolvedValue({ run: { status: "running" } });
  const ready = vi.fn();
  render(<PluginGeneratorOutput output={output} onReady={ready} />);
  await screen.findByText("Generating…");
  expect(screen.getByRole("status", { name: "Pending material" })).toBeTruthy();
  expect(ready).not.toHaveBeenCalled();
});
it("resolves a saved run after remount from its committed output", async () => {
  client.getActionRun.mockResolvedValue({ run: { status: "succeeded" } });
  client.getOutputCommit.mockResolvedValue({
    commit: {
      actionRunId: "run",
      outputSlot: "image",
      asset: { kind: "media", projectAssetId: "asset" },
    },
  });
  const ready = vi.fn();
  render(<PluginGeneratorOutput output={output} onReady={ready} />);
  await waitFor(() =>
    expect(ready).toHaveBeenCalledWith(
      expect.objectContaining({
        projectAssetId: "asset",
        generatedBy: expect.objectContaining({
          actionRunId: "run",
          outputCommitId: "run:image",
        }),
      }),
    ),
  );
  expect(client.getOutputCommit).toHaveBeenCalledWith(
    "project",
    "run",
    "image",
  );
});
it("keeps a failed run visible without publishing a successful candidate", async () => {
  client.getActionRun.mockResolvedValue({ run: { status: "failed" } });
  const ready = vi.fn();
  render(<PluginGeneratorOutput output={output} onReady={ready} />);
  await screen.findByRole("alert", { name: "Generation failed" });
  expect(ready).not.toHaveBeenCalled();
});

it("shows the Host's safe failure stage and recovery hint for the failed output", async () => {
  const failure = { outputSlot: "image", code: "output_persistence_failed", phase: "finalizing", retryable: false, message: "Generated result could not be attached. Inspect its saved output." };
  client.getActionRun.mockResolvedValue({ run: { actionRunId: "run", status: "failed" }, diagnostics: { failures: [failure] } });
  render(<PluginGeneratorOutput output={output} onReady={vi.fn()} presentation="preview" />);
  expect(await screen.findByText(failure.message)).toBeTruthy();
  expect(screen.getByText(/finalizing/)).toBeTruthy();
  expect(screen.getByText(new RegExp(failure.code))).toBeTruthy();
});

it("opens the pending output when its SDK thumbnail is clicked", () => {
  client.getActionRun.mockResolvedValue({ run: { status: "running" } });
  const onPreview = vi.fn();
  render(
    <PluginGeneratorOutput
      output={output}
      onReady={vi.fn()}
      onPreview={onPreview}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Preview pending material" }),
  );
  expect(onPreview).toHaveBeenCalledOnce();
});
