// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectsClient from "@clash/web-ui/components/ProjectsClient";
import { createProject } from "@clash/web-ui/lib/clientActions";

vi.mock("@phosphor-icons/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@phosphor-icons/react")>();
  return {
    ...actual,
    Plus: ({ className, ...props }: any) => (
      <span data-testid="plus-icon" className={className} {...props} />
    ),
    X: ({ className, ...props }: any) => (
      <span data-testid="close-icon" className={className} {...props} />
    ),
  };
});

vi.mock("@clash/web-ui/lib/clientActions", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}));

describe("ProjectsClient desktop behavior", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("collects a name and creates the project without starting from a prompt", async () => {
    const promptSpy = vi.fn(() => "prompt from browser dialog");
    Object.defineProperty(window, "prompt", {
      configurable: true,
      value: promptSpy,
      writable: true,
    });

    render(<ProjectsClient projects={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /create a new project/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /project name/i }), {
      target: { value: "Campaign cut" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith("Campaign cut", {
        startFromPrompt: false,
      });
    });
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
