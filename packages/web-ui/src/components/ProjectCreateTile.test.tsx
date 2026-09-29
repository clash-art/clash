// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectCreateTile from "./ProjectCreateTile";

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

describe("ProjectCreateTile", () => {
  afterEach(cleanup);

  it("keeps project creation visually direct without decorative artwork", () => {
    const { container, rerender } = render(
      <ProjectCreateTile ariaLabel="Start a new project" onCreate={vi.fn()} />,
    );

    expect(container.querySelector('[data-ui="brand-asset"]')).toBeNull();
    expect(screen.getByTestId("plus-icon")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a new project" })).toHaveTextContent(
      "New Project",
    );

    rerender(
      <ProjectCreateTile
        ariaLabel="Start a new project"
        presentation="header-action"
        onCreate={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-ui="brand-asset"]')).toBeNull();
    expect(screen.getByTestId("plus-icon")).toBeTruthy();
  });

  it("collects a project name before creating", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectCreateTile ariaLabel="Start a new project" onCreate={onCreate} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /start a new project/i }),
    );

    expect(
      screen.getByRole("dialog", { name: /create project/i }),
    ).toBeTruthy();
    const nameInput = screen.getByRole("textbox", { name: /project name/i });
    expect(document.activeElement).toBe(nameInput);

    fireEvent.change(nameInput, { target: { value: "  Summer launch  " } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Summer launch");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not submit an empty project name", () => {
    const onCreate = vi.fn();

    render(
      <ProjectCreateTile ariaLabel="Start a new project" onCreate={onCreate} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /start a new project/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: /project name/i }),
    );
  });

  it("keeps failure feedback mounted while a retry is pending", async () => {
    let rejectRetry!: (error: Error) => void;
    const onCreate = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectRetry = reject; }));
    render(<ProjectCreateTile ariaLabel="New project" onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "随便什么吧" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const alert = await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toBe(alert);
    rejectRetry(new Error("offline"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    expect(screen.getByRole("textbox")).toHaveValue("随便什么吧");
  });

  it("renders creation failures through the shared feedback contract", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("offline"));

    render(
      <ProjectCreateTile ariaLabel="Start a new project" onCreate={onCreate} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /start a new project/i }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /project name/i }), {
      target: { value: "Summer launch" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-ui", "feedback");
    expect(alert).toHaveAttribute("data-tone", "error");
    expect(alert).toHaveTextContent("Could not create this project. Try again.");
  });
});
