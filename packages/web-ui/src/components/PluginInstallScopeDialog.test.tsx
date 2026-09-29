// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginInstallScopeDialog } from "./PluginInstallScopeDialog";
vi.mock("../lib/clientActions", () => ({ listProjects: async () => [{id: "a", name: "Project A"}, {id: "b", name: "Project B"}] }));
afterEach(cleanup);
it("saves the chosen projects and allows changing back to all projects", async () => {
  const save = vi.fn(async () => undefined);
  const { rerender } = render(<PluginInstallScopeDialog initial={{scope: "projects", projectIds: ["a"]}} onClose={() => undefined} onSave={save} />);
  fireEvent.click(await screen.findByLabelText("Project B"));
  fireEvent.click(screen.getByRole("button", {name: "Save"}));
  await waitFor(() => expect(save).toHaveBeenCalledWith({scope: "projects", projectIds: ["a", "b"]}));
  rerender(<PluginInstallScopeDialog initial={{scope: "projects", projectIds: ["a"]}} onClose={() => undefined} onSave={save} />);
  fireEvent.click(screen.getByRole("radio", {name: /All projects/}));
  fireEvent.click(screen.getByRole("button", {name: "Save"}));
  await waitFor(() => expect(save).toHaveBeenCalledWith({scope: "global"}));
});
