// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProjectRemoteStateNotice } from "./ProjectRemoteStateNotice";

afterEach(cleanup);

it("shows a coded, retrying notice while the local room stays usable", () => {
  const retryAt = new Date(Date.now() + 30_000).toISOString();
  render(
    <ProjectRemoteStateNotice
      state={{
        type: "project.remote-state",
        projectId: "project-1",
        state: "unavailable",
        code: "PROJECT_REMOTE_UNAVAILABLE",
        message: "Cloud state is unavailable",
        retryAt,
      }}
    />,
  );
  const notice = screen.getByRole("status");
  expect(notice).toHaveAttribute("data-clash-remote-state", "unavailable");
  expect(notice).toHaveAttribute(
    "data-clash-remote-code",
    "PROJECT_REMOTE_UNAVAILABLE",
  );
  expect(notice).toHaveTextContent("Cloud state is unavailable");
  expect(notice).toHaveTextContent("PROJECT_REMOTE_UNAVAILABLE");
  expect(notice).toHaveTextContent("Your edits are saved locally");
});

it("renders nothing when the cloud replica is in sync", () => {
  render(
    <ProjectRemoteStateNotice
      state={{
        type: "project.remote-state",
        projectId: "project-1",
        state: "synced",
      }}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
});
