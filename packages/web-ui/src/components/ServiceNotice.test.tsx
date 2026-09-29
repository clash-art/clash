// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceNotice } from "./ServiceNotice";
afterEach(cleanup);
it("keeps technical details collapsed without inferring capabilities from HTTP errors", () => {
  const retry = vi.fn();
  render(
    <ServiceNotice
      service="Timelines"
      error="Project host request failed with HTTP 404"
      onRetry={retry}
    />,
  );
  expect(screen.getByText("Timelines unavailable")).toBeTruthy();
  expect(screen.queryByText(/does not support/)).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(
    screen.queryByText("Project host request failed with HTTP 404"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
  expect(
    screen.getByText("Project host request failed with HTTP 404"),
  ).toBeTruthy();
});
it("offers a working retry for temporary errors", () => {
  const retry = vi.fn();
  render(
    <ServiceNotice service="Timelines" error="HTTP 503" onRetry={retry} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
});
