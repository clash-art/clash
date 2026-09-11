// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SyncRecoveryDialog } from "./SyncRecoveryDialog";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows the project load failure and retries without archiving or reloading local edits", async () => {
  const retry = vi.fn();
  const recover = vi.fn();
  const reload = vi.fn();
  const loadError = { type: "project.load-error" as const, projectId: "project", code: "PROJECT_UPGRADE_FAILED" as const, message: "Restore plugin example.action version 1.0.0, then retry." };
  render(<SyncRecoveryDialog rejected={false} loadError={loadError} onRetryLoad={retry} onRecover={recover} onReload={reload} />);
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Project could not open" })).toBeVisible());
  expect(screen.getByRole("alert")).toHaveTextContent(loadError.message);
  fireEvent.click(screen.getByRole("button", { name: "Retry opening project" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(recover).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Save local copy and reload" })).toBeNull();
});

it("reloads only after the local recovery archive succeeds", async () => {
  let release!: () => void;
  const archive = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const reload = vi.fn();
  render(<SyncRecoveryDialog rejected onRecover={archive} onReload={reload} />);
  fireEvent.click(screen.getByRole("button", { name: "Save local copy and reload" }));
  expect(archive).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  await act(async () => release());
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it("keeps the recovery dialog open and displays an archive failure", async () => {
  const reload = vi.fn();
  render(<SyncRecoveryDialog rejected onRecover={async () => { throw new Error("Storage is full"); }} onReload={reload} />);
  fireEvent.click(screen.getByRole("button", { name: "Save local copy and reload" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage is full");
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("downloads the preserved copy and lets the user continue after reload", () => {
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovery");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const recover = vi.fn();
  render(<SyncRecoveryDialog rejected={false} backup={{ id: "backup", projectId: "project", createdAt: 0, snapshot: new Uint8Array([1, 2, 3]) }} onRecover={recover} />);
  fireEvent.click(screen.getByRole("button", { name: "Download local copy" }));
  expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
  expect(click.mock.instances[0]).toHaveAttribute("download", "clash-recovery-project-backup.loro");
  expect(recover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
