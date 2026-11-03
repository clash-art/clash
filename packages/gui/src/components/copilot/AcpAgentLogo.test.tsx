// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AcpAgentLogo } from "./AcpAgentLogo";

describe("AcpAgentLogo", () => {
  it("renders Cursor with the registry brand icon", () => {
    render(<AcpAgentLogo agentId="cursor" />);

    const logo = screen.getByRole("img", { name: "Cursor" });
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("viewBox", "0 0 466.73 532.09");
    expect(logo).toHaveAttribute("shape-rendering", "geometricPrecision");
    expect(logo).toHaveAttribute("focusable", "false");
    expect(logo).toHaveAttribute("data-slot", "agent-provider-logo");
  });

  it("renders Devin with a brand icon instead of the generic robot", () => {
    render(<AcpAgentLogo agentId="devin" />);

    const logo = screen.getByRole("img", { name: "Devin" });
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("data-openma-agent-brand-icon", "");
  });

  it("renders DeepSeek brand mark for dsh-acp (not generic robot)", () => {
    render(<AcpAgentLogo agentId="dsh-acp" />);

    const logo = screen.getByRole("img", { name: "DeepSeek" });
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("data-agent-brand-id", "dsh-acp");
    expect(logo).toHaveAttribute("data-agent-icon-source", "brand");
  });

  it("uses the official ACP registry icon for Qwen Code", () => {
    render(<AcpAgentLogo agentId="qwen-code" />);

    expect(screen.getByRole("img", { name: "Qwen Code" })).toHaveAttribute(
      "viewBox",
      "0 0 141.38 140",
    );
  });

  it("does not reserve retired built-in harness identities for custom agents", () => {
    render(<AcpAgentLogo agentId="custom-openclaw-acp" />);
    render(<AcpAgentLogo agentId="custom-hermes-acp" />);

    expect(screen.getByLabelText("custom-openclaw-acp")).toHaveAttribute(
      "data-slot",
      "agent-provider-logo",
    );
    expect(screen.getByLabelText("custom-hermes-acp")).toHaveAttribute(
      "data-slot",
      "agent-provider-logo",
    );
  });

  it("keeps unknown harness identities separate from the Clash persona avatar", () => {
    render(<AcpAgentLogo agentId="custom-harness" />);

    expect(screen.getByLabelText("custom-harness")).toHaveAttribute(
      "data-slot",
      "agent-provider-logo",
    );
  });
});
