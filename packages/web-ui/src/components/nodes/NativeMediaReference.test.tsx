// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NativeMediaReference } from "./NativeMediaReference";
const assets = vi.hoisted(() => ({ value: undefined as any }));
vi.mock("../../lib/hooks/useAsset", () => ({ useAsset: (_projectId: string, _assetId: string) => assets.value }));

it("shows an Asset reference without needing a Canvas node and removes the exact input", () => {
  assets.value = { id: "asset", name: "Closing shot", kind: "video", status: "unavailable", metadata: {}, lifecycle: { state: "active" } };
  const input = { slot: "video", itemKey: "closing", target: { kind: "media" as const, projectAssetId: "asset" } };
  const remove = vi.fn();
  render(<NativeMediaReference projectId="project" input={input} onRemove={remove} />);
  expect(screen.getByText("Closing shot")).toBeTruthy();
  expect(screen.getByText("Unavailable on this device")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove Closing shot reference" }));
  expect(remove).toHaveBeenCalledWith(input);
});

it("keeps an unresolved reference visible and removable", () => {
  assets.value = undefined;
  const input = { slot: "endFrame", target: { kind: "media" as const, projectAssetId: "missing-asset" } };
  const remove = vi.fn();
  render(<NativeMediaReference projectId="project" input={input} onRemove={remove} />);
  expect(screen.getByText("End frame")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove End frame reference" }));
  expect(remove).toHaveBeenCalledWith(input);
});
