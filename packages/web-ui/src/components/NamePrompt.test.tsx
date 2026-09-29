// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNamePrompt } from "./NamePrompt";

afterEach(cleanup);
function Harness({ onResult }: { onResult: (value: string | null) => void }) {
  const { requestName, namePrompt } = useNamePrompt();
  return (
    <>
      {namePrompt}
      <button
        onClick={async () =>
          onResult(await requestName("Timeline name", "旧名称"))
        }
      >
        New Timeline
      </button>
    </>
  );
}
it("collects a trimmed name in an application dialog", async () => {
  const result = vi.fn();
  render(<Harness onResult={result} />);
  fireEvent.click(screen.getByRole("button", { name: "New Timeline" }));
  const input = screen.getByRole("textbox", { name: "Timeline name" });
  expect(input).toHaveValue("旧名称");
  fireEvent.change(input, { target: { value: "  内测时间线  " } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(result).toHaveBeenCalledWith("内测时间线"));
});
it("cancels without creating anything and rejects blank names", async () => {
  const result = vi.fn();
  render(<Harness onResult={result} />);
  fireEvent.click(screen.getByRole("button", { name: "New Timeline" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(result).toHaveBeenCalledWith(null));
});
