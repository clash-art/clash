// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GeneratorComposer, PluginUiProvider } from "@clash/action-sdk/ui";

afterEach(cleanup);
it("delegates authoring to the host and returns its saved revision without rewriting identity", () => {
  const execute = vi.fn(async () => {});
  const close = vi.fn();
  const revision = {
    generatorId: "existing-generator",
    generatorRevisionId: "saved-revision",
  };
  render(
    <PluginUiProvider
      components={{
        GeneratorComposer: (props) => (
          <>
            <button onClick={() => props.onExecuteRevision(revision)}>
              {props.generatorId}
            </button>
            <button onClick={props.onClose}>Close</button>
          </>
        ),
      }}
    >
      <GeneratorComposer
        generatorId={revision.generatorId}
        onExecuteRevision={execute}
        onClose={close}
      />
    </PluginUiProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: revision.generatorId }));
  expect(execute).toHaveBeenCalledWith(revision);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledOnce();
});
