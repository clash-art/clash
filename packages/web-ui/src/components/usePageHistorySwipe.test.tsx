// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import MarketplacePluginDetail from "./MarketplacePluginDetail";
import { usePageHistorySwipe } from "./usePageHistorySwipe";

vi.mock("../lib/runtimeConfig", () => ({ isDesktopRuntime: () => true }));

function Surface({
  back,
  enabled = true,
}: {
  back: () => void;
  enabled?: boolean;
}) {
  const bind = usePageHistorySwipe(back, enabled);
  return (
    <div data-testid="surface" {...bind()}>
      <div data-testid="child" />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function finish() {
  act(() => {
    vi.runAllTimers();
  });
}

describe("page history swipe", () => {
  it("returns from the real detail surface to its preceding route", () => {
    vi.useFakeTimers();
    const { container, getByText } = render(
      <MemoryRouter initialEntries={["/home", "/detail"]} initialIndex={1}>
        <Routes>
          <Route path="/home" element={<p>Previous page</p>} />
          <Route
            path="/detail"
            element={
              <MarketplacePluginDetail
                installed
                item={{ id: "plugin", name: "Test plugin", type: "plugin" }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.wheel(container.querySelector("h1")!, { deltaX: -200 });
    finish();
    expect(getByText("Previous page")).toBeTruthy();
  });

  it("returns once when a deliberate backward wheel gesture ends, including its momentum", () => {
    vi.useFakeTimers();
    const back = vi.fn();
    const { getByTestId } = render(<Surface back={back} />);
    for (const deltaX of [-40, -60, -90, -15])
      fireEvent.wheel(getByTestId("surface"), { deltaX, deltaY: 1 });
    expect(back).not.toHaveBeenCalled();
    finish();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it.each([
    { deltaX: 0, deltaY: 200 },
    { deltaX: -10, deltaY: 0 },
    { deltaX: 200, deltaY: 0 },
    { deltaX: -200, deltaY: 0, ctrlKey: true },
    { deltaX: -200, deltaY: 0, deltaMode: 1 },
  ])(
    "leaves scrolling, small movements, forward swipes and zoom untouched: %j",
    (event) => {
      vi.useFakeTimers();
      const back = vi.fn();
      const { getByTestId } = render(<Surface back={back} />);
      fireEvent.wheel(getByTestId("surface"), event);
      finish();
      expect(back).not.toHaveBeenCalled();
    },
  );

  it("does not steal a gesture that started inside horizontal content, even at its edge", () => {
    vi.useFakeTimers();
    const back = vi.fn();
    const { getByTestId } = render(<Surface back={back} />);
    const child = getByTestId("child");
    child.style.overflowX = "auto";
    Object.defineProperties(child, {
      scrollWidth: { value: 1000 },
      clientWidth: { value: 300 },
    });
    fireEvent.wheel(child, { deltaX: -200 });
    finish();
    expect(back).not.toHaveBeenCalled();
  });

  it("leaves native browser navigation alone", () => {
    vi.useFakeTimers();
    const back = vi.fn();
    const { getByTestId } = render(<Surface back={back} enabled={false} />);
    fireEvent.wheel(getByTestId("surface"), { deltaX: -200 });
    finish();
    expect(back).not.toHaveBeenCalled();
  });
});
