import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeFetch: vi.fn(),
}));

vi.mock("@clash/web-ui/components/ProjectEditor", () => ({
  default: () => null,
}));
vi.mock("@clash/web-ui/lib/runtimeConfig", () => ({
  runtimeFetch: mocks.runtimeFetch,
}));

import { ErrorBoundary, PROJECT_OPEN_TIMEOUT_MS, loader } from "./project.$id";

afterEach(() => {
  mocks.runtimeFetch.mockReset();
  vi.unstubAllGlobals();
});

describe("project loader connection state", () => {
  it("keeps project loader failures inside the project route so Desktop chrome remains visible", () => {
    expect(ErrorBoundary).toEqual(expect.any(Function));
  });

  it("marks the owning Desktop tab disconnected when the Host cannot be reached", async () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    mocks.runtimeFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const connectionEvents: unknown[] = [];
    windowTarget.addEventListener("clash:desktop-tab-connection", (event) => {
      connectionEvents.push((event as CustomEvent).detail);
    });

    await expect(
      loader({ params: { id: "project-1" } } as never),
    ).rejects.toThrow("Failed to fetch");

    expect(connectionEvents).toContainEqual({
      path: "/projects/project-1",
      connection: "disconnected",
    });
  });

  it("fails a project open that the Host never answers with a coded timeout instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", new EventTarget());
      mocks.runtimeFetch.mockReturnValue(new Promise(() => undefined));
      const opening = loader({ params: { id: "project-1" } } as never);
      const failed = expect(opening).rejects.toMatchObject({
        code: "PROJECT_OPEN_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(PROJECT_OPEN_TIMEOUT_MS);
      await failed;
      expect(mocks.runtimeFetch).toHaveBeenCalledWith(
        "/api/v1/projects/project-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const signal = mocks.runtimeFetch.mock.calls[0]![1].signal as AbortSignal;
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("codes an unreachable Host", async () => {
    vi.stubGlobal("window", new EventTarget());
    mocks.runtimeFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      loader({ params: { id: "project-1" } } as never),
    ).rejects.toMatchObject({ code: "PROJECT_OPEN_HOST_UNREACHABLE" });
  });
});
