// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HARNESS_UPDATED_EVENT } from "../lib/sessionRuntime";
import { AppFeedbackProvider } from "./AppFeedback";
import { HarnessUpdateNotifier } from "./HarnessUpdateNotifier";

vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => (
      <>{children}</>
    ),
    motion: new Proxy(
      {},
      {
        get:
          (_target, tag: string) =>
          ({ children, ...props }: { children?: ReactNode }) => {
            const safeProps = Object.fromEntries(
              Object.entries(props).filter(
                ([key]) =>
                  ![
                    "initial",
                    "animate",
                    "exit",
                    "transition",
                    "layoutId",
                  ].includes(key),
              ),
            );
            return React.createElement(tag, safeProps, children);
          },
      },
    ),
  };
});

const availableHarnesses = [
  {
    id: "codex",
    label: "Codex",
    updateAvailable: true,
    installedVersion: "1.0.1",
    latestVersion: "1.1.5",
  },
  {
    id: "claude",
    label: "Claude",
    updateAvailable: true,
    installedVersion: "0.18.0",
    latestVersion: "0.19.0",
  },
  {
    id: "gemini",
    label: "Gemini",
    updateAvailable: false,
    installedVersion: "2.4.0",
    latestVersion: "2.4.0",
  },
];

function renderNotifier() {
  return render(
    <AppFeedbackProvider>
      <HarnessUpdateNotifier />
    </AppFeedbackProvider>,
  );
}

describe("HarnessUpdateNotifier", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps one persistent chrome control and expands every available ACP update", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ harnesses: availableHarnesses }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderNotifier();

    const trigger = await screen.findByRole("button", {
      name: "2 ACP updates available",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/local\/harnesses\?updates=1$/),
      { credentials: "include" },
    );
    expect(screen.queryByText("Codex update available")).toBeNull();

    fireEvent.click(trigger);

    expect(screen.queryByRole("heading", { name: "ACP updates" })).toBeNull();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("1.0.1 → 1.1.5")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("0.18.0 → 0.19.0")).toBeTruthy();
    expect(screen.queryByText("Gemini")).toBeNull();
    expect(screen.queryByText(/New sessions use the updated runtime\./)).toBeNull();
  });

  it("upgrades one ACP in place and keeps the remaining update discoverable", async () => {
    const upgradedHarnesses = availableHarnesses.map((harness) =>
      harness.id === "codex"
        ? { ...harness, installedVersion: "1.1.5", updateAvailable: false }
        : harness,
    );
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(input).toContain("/api/v1/local/harnesses/codex/upgrade");
        return new Response(JSON.stringify({ harnesses: upgradedHarnesses }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ harnesses: availableHarnesses }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const updatedEvent = vi.fn();
    window.addEventListener(HARNESS_UPDATED_EVENT, updatedEvent);

    renderNotifier();
    fireEvent.click(
      await screen.findByRole("button", { name: "2 ACP updates available" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Update Codex" }),
    );

    expect(
      (
        await screen.findByRole("button", { name: "Updating Codex" })
      ).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      await screen.findByRole("button", { name: "1 ACP update available" }),
    ).toBeTruthy();
    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(updatedEvent).toHaveBeenCalledTimes(1);

    window.removeEventListener(HARNESS_UPDATED_EVENT, updatedEvent);
  });

  it("updates different ACPs concurrently without stale responses restoring completed updates", async () => {
    let resolveCodex!: (response: Response) => void;
    let resolveClaude!: (response: Response) => void;
    const codexResponse = new Promise<Response>((resolve) => {
      resolveCodex = resolve;
    });
    const claudeResponse = new Promise<Response>((resolve) => {
      resolveClaude = resolve;
    });
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ harnesses: availableHarnesses }), {
            status: 200,
          }),
        );
      }
      if (input.includes("/codex/upgrade")) return codexResponse;
      if (input.includes("/claude/upgrade")) return claudeResponse;
      throw new Error(`Unexpected upgrade request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderNotifier();
    fireEvent.click(
      await screen.findByRole("button", { name: "2 ACP updates available" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Update Codex" }),
    );
    expect(
      await screen.findByRole("button", { name: "Updating Codex" }),
    ).toBeTruthy();

    const claudeButton = screen.getByRole("button", { name: "Update Claude" });
    expect(claudeButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(claudeButton);

    expect(
      await screen.findByRole("button", { name: "Updating Claude" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Updating Codex" })).toBeTruthy();

    resolveClaude(
      new Response(
        JSON.stringify({
          harnesses: availableHarnesses.map((harness) =>
            harness.id === "claude"
              ? {
                  ...harness,
                  installedVersion: "0.19.0",
                  updateAvailable: false,
                }
              : harness,
          ),
        }),
        { status: 200 },
      ),
    );
    resolveCodex(
      new Response(
        JSON.stringify({
          harnesses: availableHarnesses.map((harness) =>
            harness.id === "codex"
              ? {
                  ...harness,
                  installedVersion: "1.1.5",
                  updateAvailable: false,
                }
              : harness,
          ),
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Updating Codex" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Updating Claude" }),
      ).toBeNull();
    });
    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.queryByText("Claude")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(2);
  });

  it("shows upgrade failures in shared feedback and keeps the retry action", async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Registry unavailable" }), {
          status: 503,
        });
      }
      return new Response(
        JSON.stringify({ harnesses: [availableHarnesses[0]] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderNotifier();
    fireEvent.click(
      await screen.findByRole("button", { name: "1 ACP update available" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Update Codex" }),
    );

    expect((await screen.findByText("Registry unavailable")).closest('[data-ui="toast-viewport"]')).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry Codex update" }),
    ).toBeTruthy();
  });

  it("checks again when the desktop window regains focus", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ harnesses: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ harnesses: [availableHarnesses[0]] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderNotifier();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.focus(window);

    expect(
      await screen.findByRole("button", { name: "1 ACP update available" }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("retries a failed initial check while the window remains focused", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Host starting"))
      .mockResolvedValue(new Response(JSON.stringify({ harnesses: [availableHarnesses[0]] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await act(async () => { renderNotifier(); });
      expect(screen.queryByRole("button", { name: "1 ACP update available" })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.getByRole("button", { name: "1 ACP update available" })).toBeTruthy();
      cleanup();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

});
