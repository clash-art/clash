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

it("renders a cloud-link transport failure as a usable local-room notice", () => {
  const retryAt = new Date(Date.now() + 20_000).toISOString();
  render(
    <ProjectRemoteStateNotice
      state={{
        type: "project.remote-state",
        projectId: "project-1",
        state: "unavailable",
        code: "CLOUD_LINK_HANDSHAKE_TIMEOUT",
        message: "Cloud sync is unavailable",
        retryAt,
      }}
    />,
  );
  const notice = screen.getByRole("status");
  expect(notice).toHaveAttribute("data-clash-remote-state", "unavailable");
  expect(notice).toHaveAttribute(
    "data-clash-remote-code",
    "CLOUD_LINK_HANDSHAKE_TIMEOUT",
  );
  expect(notice).toHaveTextContent("Cloud sync is unavailable");
  expect(notice).toHaveTextContent("CLOUD_LINK_HANDSHAKE_TIMEOUT");
  expect(notice).toHaveTextContent("Retrying at");
  expect(notice).toHaveTextContent("Your edits are saved locally");
});

it("tells the user when cloud sync needs an action", () => {
  render(
    <ProjectRemoteStateNotice
      state={{
        type: "project.remote-state",
        projectId: "project-1",
        state: "unavailable",
        code: "CLOUD_LINK_ACTION_REQUIRED",
      }}
    />,
  );
  const notice = screen.getByRole("status");
  expect(notice).toHaveTextContent("Cloud sync needs your attention");
  expect(notice).not.toHaveTextContent("Retrying at");
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
