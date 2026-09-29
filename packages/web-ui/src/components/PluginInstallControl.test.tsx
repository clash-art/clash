// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginInstallControl } from "./PluginInstallControl";
const api = vi.hoisted(() => ({ install: vi.fn(async () => undefined) }));
vi.mock("../lib/clientActions", () => ({
  marketplaceInstallPlugin: api.install,
  marketplacePluginScope: async () => ({ scope: "projects", projectIds: ["a"] }),
  listProjects: async () => [{id: "a", name: "A"}, {id: "b", name: "B"}],
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("offers installation in this project while preserving existing project selections", async () => {
  const item = { id: "example.plugin", name: "Example", type: "plugin" as const, description: "Example" };
  render(<PluginInstallControl item={item} installed projectId="b" />);
  expect(await screen.findByText("Not installed in this project")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Install in this project"}));
  await waitFor(() => expect(api.install).toHaveBeenCalledWith(item, {scope: "projects", projectIds: ["a", "b"]}));
  expect(await screen.findByText("Installed in this project")).toBeTruthy();
});
