// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FontFamilyPicker } from "./FontFamilyPicker";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Local font selection", () => {
  it("identifies a missing authored family without silently replacing it", async () => {
    vi.stubGlobal("queryLocalFonts", async () => [{ family: "Arial" }]);
    const change = vi.fn();
    render(
      <FontFamilyPicker
        value="Missing custom font"
        ariaLabel="Font"
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Font" }));
    await screen.findByRole("option", { name: "Arial" });
    expect(
      screen.getByText(/Missing custom font.*not found in the installed font list/i),
    ).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
    expect(
      screen.getByRole("option", { name: "Missing custom font" }),
    ).toBeTruthy();
  });
  it("loads installed fonts on opening, deduplicates faces and searches families", async () => {
    const query = vi
      .fn()
      .mockResolvedValue([
        { family: "Smiley Sans" },
        { family: "Smiley Sans" },
        { family: "苹方-简" },
      ]);
    vi.stubGlobal("queryLocalFonts", query);
    const change = vi.fn();
    render(
      <FontFamilyPicker
        value="Smiley Sans"
        ariaLabel="Font"
        onChange={change}
      />,
    );
    expect(query).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Font" }));
    await screen.findByRole("option", { name: "苹方-简" });
    expect(screen.getAllByRole("option", { name: "Smiley Sans" })).toHaveLength(
      1,
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search installed fonts" }),
      { target: { value: "苹方" } },
    );
    expect(screen.queryByRole("option", { name: "Smiley Sans" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "苹方-简" }));
    expect(change).toHaveBeenCalledWith("苹方-简");
  });
  it("preserves the current font on permission failure and allows retry", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("Denied"))
      .mockResolvedValueOnce([{ family: "Arial" }]);
    vi.stubGlobal("queryLocalFonts", query);
    const change = vi.fn();
    render(
      <FontFamilyPicker
        value="Custom face"
        ariaLabel="Font"
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Font" }));
    await screen.findByText(/Could not read local fonts/);
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("option", { name: "Arial" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Custom face" })).toBeTruthy();
  });
  it("explains unsupported environments rather than advertising a fake installed list", () => {
    vi.stubGlobal("queryLocalFonts", undefined);
    render(
      <FontFamilyPicker
        value="Custom face"
        ariaLabel="Font"
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Font" }));
    expect(
      screen.getByText(/This browser cannot list local fonts/),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Arial" })).toBeNull();
  });
});
