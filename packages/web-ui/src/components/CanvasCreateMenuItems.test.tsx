// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanvasCreateMenuItems } from "./CanvasCreateMenuItems";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu";

afterEach(cleanup);

function openMenu(onSelect: (type: string) => void, customActions: { id: string; name: string }[] = []) {
  render(<DropdownMenu defaultOpen><DropdownMenuTrigger>Create node</DropdownMenuTrigger><DropdownMenuContent><CanvasCreateMenuItems onSelect={onSelect} customActions={customActions} /></DropdownMenuContent></DropdownMenu>);
}

it("dispatches an installed Action Card through its real creation entrypoint", async () => {
  const select = vi.fn();
  const card = { id: "fixture-card", name: "Fixture Action" };
  openMenu(select, [card]);
  const actions = screen.getByRole("menuitem", { name: "Actions" });
  actions.focus();
  fireEvent.keyDown(actions, { key: "ArrowRight" });
  fireEvent.click(await screen.findByRole("menuitem", { name: card.name }));
  expect(select).toHaveBeenCalledExactlyOnceWith(`action-badge-custom-${card.id}`);
  expect(screen.queryByRole("menu")).toBeNull();
});

it.each([
  ["Assets", "assets"],
  ["Editor", "video-editor"],
  ["Director Stage", "director-stage"],
  ["Remotion Component", "remotion-component"],
  ["Group", "group"],
  ["Text", "text"],
])("dispatches the existing %s workflow and closes the menu", (label, type) => {
  const select = vi.fn();
  openMenu(select);
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  expect(select).toHaveBeenCalledExactlyOnceWith(type);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("opens Actions with the keyboard and dispatches a generation action", async () => {
  const select = vi.fn();
  openMenu(select);
  const actions = screen.getByRole("menuitem", { name: "Actions" });
  actions.focus();
  fireEvent.keyDown(actions, { key: "ArrowRight" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Image Gen" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("action-badge-image");
  expect(screen.queryByRole("menu")).toBeNull();
});

it("dismisses without creating anything on Escape", () => {
  const select = vi.fn();
  openMenu(select);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});
