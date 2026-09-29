// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import MarketplacePluginDetail from "./MarketplacePluginDetail";
const api = vi.hoisted(() => ({ skill: vi.fn(), plugin: vi.fn() }));
vi.mock("../lib/clientActions", () => ({ marketplaceInstallSkill: api.skill, marketplaceInstallPlugin: api.plugin, listProjects: async () => [], marketplacePluginScope: async () => ({scope: "global"}) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("installs a skill from its detail page and reflects success", async () => {
  api.plugin.mockResolvedValue(undefined);
  render(<MemoryRouter><MarketplacePluginDetail installed={false} item={{ id: "continuity", type: "skill", name: "Continuity", description: "Shot continuity", installation: { kind: "skill", skillId: "continuity" } }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByText("Installed")).toBeTruthy();
  expect(api.plugin).toHaveBeenCalledWith(expect.objectContaining({ id: "continuity" }), {scope: "global"});
});
it("shows an installation failure and permits retry", async () => {
  api.plugin.mockRejectedValueOnce(new Error("Host unavailable")).mockResolvedValueOnce(undefined);
  render(<MemoryRouter><MarketplacePluginDetail installed={false} item={{ id: "continuity", type: "skill", name: "Continuity", description: "Shot continuity", installation: { kind: "skill", skillId: "continuity" } }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Host unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Installed")).toBeTruthy();
});
