// @vitest-environment jsdom
import { createRef, forwardRef, Suspense, useImperativeHandle } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import type { AgentAnnotationDraft } from "@clash/shared-types";

import { sourceMatches } from "../../test-support/source-match";
import { setRuntimeConfigOverride } from "../../lib/runtimeConfig";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

const milkdownFocus = vi.hoisted(() => vi.fn());
const milkdownInsert = vi.hoisted(() => vi.fn());

const root = resolve(__dirname, "../../../../..");
const globalCss = readFileSync(
  resolve(root, "apps/web/app/globals.css"),
  "utf8",
);
const chatInputSource = readFileSync(
  resolve(__dirname, "ChatInput.tsx"),
  "utf8",
);
const heroSource = readFileSync(
  resolve(__dirname, "../HeroSection.tsx"),
  "utf8",
);
const projectEditorSource = readFileSync(
  resolve(__dirname, "../ProjectEditor.tsx"),
  "utf8",
);

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>
  );
}

vi.mock("../MilkdownEditor", () => ({
  default: forwardRef(
    (
      props: {
        onSubmit?: () => void;
        placeholder?: string;
        promptModalities?: string[];
        mentionableNodes?: Array<{ type: string }>;
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => ({
        clear: vi.fn(),
        focus: milkdownFocus,
        insertAtCursor: milkdownInsert,
      }));
      return (
        <div
          data-testid="milkdown-editor"
          data-placeholder={props.placeholder}
          data-prompt-modalities={props.promptModalities?.join(",")}
          data-mention-types={props.mentionableNodes
            ?.map((node) => node.type)
            .join(",")}
        >
          <button
            type="button"
            data-testid="milkdown-submit"
            onClick={() => props.onSubmit?.()}
          />
        </div>
      );
    },
  ),
}));

describe("ChatInput", () => {
  // Voice readiness is a capability read, so local and Cloudflare adapters use
  // the same neutral route; adapters that do not serve it hide the button.
  beforeEach(() => setRuntimeConfigOverride({ mode: "local" }));
  afterEach(() => {
    setRuntimeConfigOverride(undefined);
    cleanup();
    milkdownFocus.mockClear();
    milkdownInsert.mockClear();
    vi.restoreAllMocks();
  });

  it("uses the shared localized hint when a Composer caller has no narrower context", async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    expect(await screen.findByTestId("milkdown-editor")).toHaveAttribute(
      "data-placeholder",
      "Ask anything…",
    );
  });

  it("hides the voice button when the adapter does not serve voice input", async () => {
    setRuntimeConfigOverride({
      mode: "local",
      capabilities: { host: { voiceInput: "unavailable" } },
    });

    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    expect(
      screen.queryByRole("button", { name: "copilot.chatInput.voice" }),
    ).toBeNull();
  });

  it("renders structured references inside the shared composer surface", async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          referenceAccessory={<div data-testid="skill-references">skills</div>}
        />
      </Suspense>,
    );

    const references = await screen.findByTestId("skill-references");
    const surface = references.closest(".clash-chat-input-surface");
    expect(surface).toBeTruthy();
    expect(surface?.contains(screen.getByTestId("milkdown-editor"))).toBe(true);
  });

  it("uses the shipped Backchat composer card and action-row structure", async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          onOpenAssetPicker={() => undefined}
          toolbarAccessory={<div data-testid="run-config">config</div>}
        />
      </Suspense>,
    );

    const editor = await screen.findByTestId("milkdown-editor");
    const stack = editor.closest(".composer-stack-card");
    const surface = editor.closest(".app-composer-surface");
    const inlineContent = editor.closest(
      '[data-slot="composer-inline-content"]',
    );
    const runActions = surface?.querySelector(
      '[data-composer-run-actions="true"]',
    );

    expect(stack).toBeTruthy();
    expect(surface).toHaveClass(
      "composer-control-row-inset",
      "composer-radius",
      "composer-card",
    );
    expect(inlineContent).toBeTruthy();
    expect(runActions).toBeTruthy();
    expect(
      runActions?.contains(
        screen.getByRole("button", { name: "copilot.chatInput.send" }),
      ),
    ).toBe(true);
    expect(
      surface?.querySelector('[data-composer-attach="true"]'),
    ).toBeTruthy();
  });

  it("routes the attach control to the shared asset library when provided", async () => {
    const onOpenAssetPicker = vi.fn();
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          onOpenAssetPicker={onOpenAssetPicker}
        />
      </Suspense>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "copilot.chatInput.attach",
      }),
    );
    expect(onOpenAssetPicker).toHaveBeenCalledOnce();
  });

  it("inserts a selected Project Asset through the shared editor handle", async () => {
    const ref = createRef<ChatInputHandle>();
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          ref={ref}
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    ref.current?.insertAssetReference?.({
      id: "asset-logo",
      type: "image",
      label: "Logo master",
      kind: "asset",
      scope: "project-assets",
    });

    expect(milkdownInsert).toHaveBeenCalledWith(
      "@[Logo master](project-asset:asset-logo) ",
    );
  });

  it("imports project media through the Project Asset endpoint", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const assetId = "asset-00000000-0000-4000-8000-000000000001";
    const mediaUrl = `https://media.clash.test/api/v1/projects/project-1/assets/${assetId}/media`;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input).includes("/assets/import-file")) {
          return Response.json({
            id: assetId,
            kind: "image",
            name: "opening.png",
            metadata: {
              originalName: "opening.png",
              contentType: "image/png",
              bytes: 3,
            },
            lifecycle: { state: "active" },
            status: "ready",
            url: mediaUrl,
            thumbnailUrl: mediaUrl,
          });
        }
        return Response.json({
          asr: {
            enabled: false,
            ready: false,
            provider: "builtin-funasr",
            base_url: null,
            model: "iic/SenseVoiceSmall",
          },
        });
      });
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          projectId="project-1"
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );
    await screen.findByTestId("milkdown-editor");
    const file = new File(["png"], "opening.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(milkdownInsert).toHaveBeenCalledWith(
        `![opening.png](${mediaUrl} "clash-project-asset:${assetId}") `,
      ),
    );
    const [url, init] = fetchSpy.mock.calls.find(([input]) =>
      String(input).includes("/assets/import-file"),
    )!;
    const importUrl = new URL(String(url), "http://host.test");
    expect(importUrl.pathname).toBe(
      "/api/v1/projects/project-1/assets/import-file",
    );
    expect(init?.body).toBe(file);
    expect(importUrl.searchParams.get("kind")).toBe("image");
    expect(importUrl.searchParams.get("projectAssetId")).toBe(assetId);
  });

  it("submits imported media as a typed Project Asset reference without its Host URL", async () => {
    const onSubmit = vi.fn();
    const markedAssetId = "asset/stable";
    const input = [
      `![marked](https://media.clash.test/api/v1/projects/project-1/assets/url-id/media "clash-project-asset:${encodeURIComponent(markedAssetId)}")`,
      "![unmarked](https://media.clash.test/api/v1/projects/project-1/assets/inferred-id/media)",
    ].join(" ");
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input={input}
          projectId="project-1"
          onInputChange={() => undefined}
          onSubmit={onSubmit}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    fireEvent.click(screen.getByTestId("milkdown-submit"));

    expect(onSubmit).toHaveBeenCalledWith(
      [
        `@[marked](project-asset:${encodeURIComponent(markedAssetId)})`,
        "![unmarked](https://media.clash.test/api/v1/projects/project-1/assets/inferred-id/media)",
      ].join(" "),
      [
        {
          projectAssetId: markedAssetId,
          kind: "image",
          label: "marked",
        },
      ],
      [],
    );
    expect(JSON.stringify(onSubmit.mock.calls[0])).not.toContain(
      "url-id/media",
    );
  });

  it("types a Project Asset mention separately from a real Canvas node mention", async () => {
    const onSubmit = vi.fn();
    const input =
      "Use @[Logo](project-asset:asset-logo) with @[Render](node:action-1)";
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input={input}
          projectId="project-1"
          onInputChange={() => undefined}
          onSubmit={onSubmit}
          mentionableNodes={[
            {
              id: "asset-logo",
              type: "image",
              label: "Logo",
              kind: "asset",
              scope: "project-assets",
            },
            {
              id: "action-1",
              type: "action",
              label: "Render",
              kind: "node",
              scope: "current-canvas",
            },
          ]}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    fireEvent.click(screen.getByTestId("milkdown-submit"));

    expect(onSubmit).toHaveBeenCalledWith(
      input,
      [
        {
          projectAssetId: "asset-logo",
          kind: "image",
          label: "Logo",
        },
      ],
      [],
    );
  });

  it("does not expose the generic attachment entry outside a Project scope", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    expect(
      screen.queryByRole("button", { name: "copilot.chatInput.attach" }),
    ).toBeNull();
    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput?.accept).toContain("image/*");
    expect(fileInput?.accept).not.toContain("application/pdf");
    expect(fileInput?.accept).not.toContain("text/plain");
  });

  it("resolves a real Project scope before importing from the dashboard Composer", async () => {
    const ensureProjectId = vi.fn().mockResolvedValue("draft-project");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000002",
    );
    const assetId = "asset-00000000-0000-4000-8000-000000000002";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/assets/import-file")
          ? Response.json({
              id: assetId,
              kind: "image",
              name: "opening.png",
              metadata: {
                originalName: "opening.png",
                contentType: "image/png",
                bytes: 3,
              },
              lifecycle: { state: "active" },
              status: "ready",
              url: "https://media.clash.test/opening.png",
              thumbnailUrl: "https://media.clash.test/opening.png",
            })
          : Response.json({
              asr: {
                enabled: false,
                ready: false,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
              },
            }),
      );
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          ensureProjectId={ensureProjectId}
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    expect(
      screen.getByRole("button", { name: "copilot.chatInput.attach" }),
    ).toBeTruthy();
    const file = new File(["png"], "opening.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    await waitFor(() => expect(ensureProjectId).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\/api\/v1\/projects\/draft-project\/assets\/import-file\?/,
        ),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(milkdownInsert).toHaveBeenCalledOnce());
  });

  it("uses the lighter chat-specific input surface classes", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    expect(container.querySelector(".clash-chat-input-surface")).toBeTruthy();
    expect(
      container.querySelector(
        ".clash-chat-input-surface > .openma-composer-shell",
      ),
    ).toBeTruthy();
    expect(container.querySelector("[data-openma-composer-shell]")).toBeTruthy();
    expect(container.querySelector("[data-openma-composer-body]")).toBeTruthy();
    expect(container.querySelector(".clash-chat-input-actions")).toBeTruthy();
    expect(container.querySelector(".clash-chat-input-toolbar")).toBeNull();
    expect(container.querySelector(".clash-input-surface")).toBeNull();
  });

  it("keeps the composer controls in separate shrinkable lanes at narrow panel widths", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          toolbarAccessory={<div data-testid="left-accessory">left</div>}
          rightToolbarAccessory={<div data-testid="right-accessory">right</div>}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    expect(
      container.querySelector(".openma-composer-shell"),
    ).toBeTruthy();
    expect(
      container.querySelector(".clash-chat-input-toolbar-row"),
    ).toBeTruthy();
    expect(
      container.querySelector(".openma-composer-toolbar.clash-chat-input-toolbar-row"),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-openma-composer-toolbar]"),
    ).toBeTruthy();
    expect(
      container.querySelector(".clash-chat-input-toolbar-start"),
    ).toBeTruthy();
    expect(
      container.querySelector(".clash-chat-input-toolbar-end"),
    ).toBeTruthy();
    expect(
      container.querySelector(".clash-chat-input-toolbar-accessory"),
    ).toBeTruthy();
    expect(
      container.querySelector(".clash-chat-input-toolbar-config"),
    ).toBeTruthy();
    expect(globalCss).toMatch(
      /\.clash-chat-input-surface\s*\{[\s\S]*?container-type:\s*inline-size;[\s\S]*?container-name:\s*clash-chat-composer;/,
    );
    expect(globalCss).toMatch(
      /:where\(\.clash-chat-input-surface,\s*\[data-context="composer"\]\)[\s\S]*?--control-height-sm:\s*var\(--clash-workspace-control-size\)/,
    );
    expect(globalCss).toMatch(
      /\.clash-chat-input-toolbar-row:not\(\.openma-composer-toolbar\)\s*\{[\s\S]*?grid-template-columns:\s*minmax\(2\.25rem,\s*1fr\)\s+minmax\(0,\s*max-content\);/,
    );
    expect(globalCss).toMatch(
      /\.clash-chat-input-toolbar-row\.openma-composer-toolbar\s*\{/,
    );
    expect(globalCss).toMatch(
      /@container clash-chat-composer \(max-width:\s*32rem\)\s*\{[\s\S]*?\.clash-session-state-tag-label[\s\S]*?display:\s*none;/,
    );
    expect(globalCss).toMatch(
      /@container clash-chat-composer \(max-width:\s*32rem\)\s*\{[\s\S]*?\.clash-session-permission-label[\s\S]*?display:\s*none;/,
    );
    expect(globalCss).toMatch(
      /@container clash-chat-composer \(max-width:\s*32rem\)\s*\{[\s\S]*?\.clash-chat-input-toolbar-start \.clash-composer-footer-chip > span\.min-w-0\.flex-1\.truncate/,
    );
    expect(globalCss).not.toMatch(
      /@container clash-chat-composer \(max-width:\s*22rem\)/,
    );
    expect(globalCss).toMatch(
      /\.clash-session-config-trigger\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?min-width:\s*max-content;[\s\S]*?max-width:\s*100%;/,
    );
    expect(globalCss).toMatch(
      /@container clash-chat-composer \(max-width:\s*32rem\)\s*\{[\s\S]*?\.clash-session-config-effort\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(globalCss).toMatch(
      /@container clash-chat-composer \(max-width:\s*24\.5rem\)\s*\{[\s\S]*?\.clash-session-config-trigger\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*7\.25rem;/,
    );
  });

  it("keeps the same runtime controls when only the composer size is hero", async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
          toolbarAccessory={
            <div data-testid="hero-left-accessory">permission</div>
          }
          rightToolbarAccessory={
            <div data-testid="hero-right-accessory">model</div>
          }
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    expect(screen.getByTestId("hero-left-accessory")).toBeTruthy();
    expect(screen.getByTestId("hero-right-accessory")).toBeTruthy();
  });

  it("uses the shared workspace radius instead of a composer-only pill radius", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    const surface = container.querySelector(".clash-chat-input-surface");
    expect(surface?.className).not.toContain("rounded-[18px]");
    expect(globalCss).toMatch(
      /\.clash-chat-input-surface\s*\{[\s\S]*?border-radius:\s*var\(--clash-workspace-surface-radius\)/,
    );
  });

  it("only gives the composer accent focus when the editor itself is focused", () => {
    expect(globalCss).not.toMatch(
      /\.clash-chat-input-surface:focus-within\s*\{/,
    );
    expect(globalCss).toMatch(
      /\.clash-chat-input-surface:has\(\.clash-chat-input-editor:focus-within\)\s*\{/,
    );
  });

  it("reports an explicit editor input state instead of measuring the caret", async () => {
    const { container, rerender } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    const host = () =>
      container.querySelector<HTMLElement>(".clash-chat-input-editor")!;

    expect(host().dataset.inputState).toBe("empty");

    rerender(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input="one line"
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );
    expect(host().dataset.inputState).toBe("single-line");

    rerender(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input={"first line\nsecond line"}
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );
    expect(host().dataset.inputState).toBe("multiline");

    rerender(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input="   "
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );
    expect(host().dataset.inputState).toBe("empty");
  });

  it("marks the hero layout wrapper with the same input state as the editor", async () => {
    const { container, rerender } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    const layout = () =>
      container.querySelector<HTMLElement>(".clash-chat-input-hero-layout")!;
    const editor = () =>
      container.querySelector<HTMLElement>(".clash-chat-input-editor")!;

    // The wrapper is the grid container, so it must carry the state rows key off.
    expect(layout().dataset.inputState).toBe("empty");
    expect(layout().dataset.inputState).toBe(editor().dataset.inputState);

    for (const [value, state] of [
      ["one line", "single-line"],
      ["first line\nsecond line", "multiline"],
      ["   ", "empty"],
    ] as const) {
      rerender(
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input={value}
            onInputChange={() => undefined}
            onSubmit={() => undefined}
            variant="hero"
          />
        </Suspense>,
      );
      expect(layout().dataset.inputState).toBe(state);
      expect(layout().dataset.inputState).toBe(editor().dataset.inputState);
    }
  });

  it("keeps the hero placeholder, editor, and action rail in one shared shell across empty, focus, and text states", async () => {
    const { container, rerender } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          placeholder="Describe your video idea..."
          variant="hero"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    const shell = container.querySelector<HTMLElement>(
      ".clash-chat-input-hero-layout",
    )!;
    const surface = container.querySelector<HTMLElement>(
      ".clash-chat-input-surface",
    )!;
    const editor = container.querySelector<HTMLElement>(
      ".clash-chat-input-editor--hero",
    )!;
    const actions = container.querySelector<HTMLElement>(
      ".clash-chat-input-actions",
    )!;

    expect(screen.getByTestId("milkdown-editor")).toHaveAttribute(
      "data-placeholder",
      "Describe your video idea...",
    );
    expect(container.querySelector(".clash-chat-input-placeholder")).toBeNull();
    expect(shell.classList.contains("openma-composer-shell")).toBe(true);
    expect(editor.closest(".clash-chat-input-hero-layout")).toBe(shell);
    expect(actions.parentElement).toBe(shell);
    expect(shell.dataset.inputState).toBe("empty");
    expect(surface.dataset.inputState).toBe("empty");
    expect(surface.dataset.composerVisualState).toBe("expanded");

    fireEvent.focus(editor);
    expect(editor.closest(".clash-chat-input-hero-layout")).toBe(shell);
    expect(actions.parentElement).toBe(shell);

    rerender(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input="Build a quiet forest scene"
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          placeholder="Describe your video idea..."
          variant="hero"
          visualState="compact"
        />
      </Suspense>,
    );

    expect(shell.dataset.inputState).toBe("single-line");
    expect(surface.dataset.inputState).toBe("single-line");
    expect(surface.dataset.composerVisualState).toBe("compact");
    expect(screen.queryByText("Describe your video idea...")).toBeNull();
    expect(editor.closest(".clash-chat-input-hero-layout")).toBe(shell);
    expect(actions.parentElement).toBe(shell);
  });

  it("keeps the expanded hero body above an intact bottom action rail", () => {
    const expandedShellRule = globalCss.match(
      /\.clash-home-hero \.clash-chat-input-hero-layout[\s\S]{0,80}?\{[\s\S]{0,280}?\}/,
    )?.[0];
    expect(expandedShellRule).toBeTruthy();
    expect(expandedShellRule).toMatch(/--composer-section-gap|gap:\s*var\(--composer-section-gap/);
    expect(expandedShellRule).not.toMatch(/display:\s*grid;/);
    expect(globalCss).toMatch(
      /\.clash-chat-input-surface\s*>\s*\.openma-composer-shell\s*\{/,
    );

    const expandedActionsRule = globalCss.match(
      /\.clash-home-hero \.clash-chat-input-actions\s*\{[\s\S]{0,120}?\}/,
    )?.[0];
    expect(expandedActionsRule).toBeTruthy();
    expect(expandedActionsRule).not.toMatch(/display:\s*contents;/);

    const restingSurface = globalCss.match(
      /\.clash-home-hero \.clash-chat-input-surface\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(restingSurface).toBeTruthy();
    // 48px body + 28px controls + 10px block insets + 6px gap + borders,
    // matching Backchat's 104px shared resting composer rhythm.
    expect(restingSurface).toMatch(/min-height:\s*6\.5rem/);
    expect(restingSurface).toMatch(/padding:\s*0\.625rem/);
    expect(
      sourceMatches(
        globalCss,
        /\.clash-home-hero \.clash-chat-input-surface > div\s*\{[^}]*min-height:/,
      ),
    ).toBe(false);
  });

  it("derives the Home title row from the existing Project chrome rhythm", () => {
    expect(globalCss).toMatch(
      /--clash-app-sidebar-header-height:\s*var\(--clash-desktop-chrome-height\)/,
    );
    const homeHero = globalCss.match(/\.clash-home-hero\s*\{[\s\S]*?\}/)?.[0];
    expect(homeHero).toMatch(/padding-top:\s*0/);
    expect(homeHero).not.toMatch(/margin-top:\s*-/);
    expect(homeHero).not.toMatch(/top:\s*-/);

    const titleHeader = globalCss.match(
      /\.clash-home-page-header\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(titleHeader).toMatch(
      /min-height:\s*var\(--clash-project-sidebar-header-height/,
    );
    expect(titleHeader).toMatch(
      /max-height:\s*var\(--clash-project-sidebar-header-height/,
    );

    const stageRule = globalCss.match(
      /\.clash-home-hero \.clash-hero-stage\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(stageRule).toMatch(/gap:\s*var\(--clash-control-gap/);

    const titleRule = globalCss.match(
      /\.clash-home-page-title\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(titleRule).toMatch(/font-size:\s*var\(--clash-project-title-size/);
    expect(titleRule).toMatch(
      /font-weight:\s*var\(--clash-project-title-weight/,
    );
    for (const rule of globalCss.matchAll(
      /\.clash-home-page-title\s*\{[\s\S]*?\}/g,
    )) {
      expect(rule[0].match(/font-size:\s*([^;]+)/)?.[1]?.trim()).toMatch(
        /^var\(--clash-project-title-size/,
      );
    }
    expect(projectEditorSource).toContain(
      "text-[var(--clash-project-title-size,0.8125rem)]",
    );

    const markButtonRule = globalCss.match(
      /\.clash-home-page-title-enter\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(markButtonRule).toMatch(
      /(?:width|height):\s*var\(--clash-project-control-height/,
    );
  });

  it("changes composer presentation without layout or transition choreography", () => {
    expect(chatInputSource).not.toContain('layout="size"');
    expect(heroSource).not.toContain('layout="position"');
    expect(heroSource).not.toContain('layoutId="clash-home-composer"');
    expect(heroSource).not.toContain("onVisualTransitionComplete");
    expect(chatInputSource).not.toContain("onVisualTransitionComplete");

    for (const selector of [
      ".clash-home-hero",
      ".clash-home-page-header",
      ".clash-home-page-title-mark",
      ".clash-home-composer",
      ".clash-home-hero .clash-chat-input-surface",
      ".clash-home-hero .clash-chat-input-editor--hero",
    ]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rule = globalCss.match(
        new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\}`),
      )?.[0];
      expect(rule, selector).toBeTruthy();
      expect(rule, selector).not.toMatch(/transition\s*:/);
      expect(rule, selector).not.toMatch(/animation\s*:/);
    }
  });

  it("floats compact without reserving a document row and keeps expanded in flow", () => {
    const expandedOrigin = globalCss.match(
      /\.clash-home-composer\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(expandedOrigin).toMatch(/position:\s*relative/);

    const compactHero = globalCss.match(
      /\.clash-home-hero\[data-composer-mode="compact"\]\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(compactHero).toMatch(/height:\s*0/);
    expect(compactHero).toMatch(/padding:\s*0/);
    expect(compactHero).toMatch(/pointer-events:\s*none/);

    const floatingOrigin = globalCss.match(
      /\.clash-home-hero\[data-composer-mode="compact"\] \.clash-home-composer\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(floatingOrigin).toMatch(/position:\s*fixed/);
    expect(floatingOrigin).toMatch(/var\(--clash-app-sidebar-width\)/);
    expect(floatingOrigin).toMatch(/var\(--clash-home-floating-inline-gap\)/);
    expect(floatingOrigin).toMatch(/pointer-events:\s*auto/);
    expect(floatingOrigin).not.toMatch(/left:\s*\d+px/);
  });

  it("aligns every shared composer rail action to the 28px context token", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          projectId="project-1"
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          toolbarAccessory={<div data-testid="rail-left">permission</div>}
          rightToolbarAccessory={<div data-testid="rail-right">model</div>}
          variant="hero"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    const attach = screen.getByRole("button", {
      name: "copilot.chatInput.attach",
    });
    const voice = screen.getByRole("button", {
      name: "copilot.chatInput.voice",
    });
    const send = screen.getByRole("button", {
      name: "copilot.chatInput.send",
    });
    expect(attach.classList).toContain("clash-chat-input-icon-control");
    expect(voice.classList).toContain("clash-chat-input-icon-control");
    expect(send.classList).toContain("clash-chat-input-icon-control");
    expect(
      container.querySelector(".clash-chat-input-toolbar-start")?.className,
    ).not.toContain("gap-2");
    expect(
      container.querySelector(".clash-chat-input-toolbar-end")?.className,
    ).not.toContain("gap-1.5");

    const densityRule = globalCss.match(
      /\.clash-chat-input-icon-control\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(densityRule).toBeTruthy();
    expect(densityRule).toMatch(
      /height:\s*var\(--composer-control-height,\s*var\(--control-height-sm\)\)/,
    );
    expect(densityRule).toMatch(
      /width:\s*var\(--composer-control-height,\s*var\(--control-height-sm\)\)/,
    );
  });

  it("lets the shared compact Composer own dashboard internal geometry", () => {
    const restingHeight = Number.parseFloat(
      globalCss.match(
        /--clash-dashboard-composer-resting-height:\s*([\d.]+)rem/,
      )?.[1] ?? "0",
    );
    expect(restingHeight).toBeGreaterThan(4);

    expect(
      sourceMatches(
        globalCss,
        /\.clash-dashboard-composer-dock \.clash-chat-input-surface\s*\{/,
      ),
    ).toBe(false);
    expect(
      sourceMatches(
        globalCss,
        /\.clash-dashboard-composer-dock \.clash-chat-input-hero-layout/,
      ),
    ).toBe(false);
    expect(
      sourceMatches(
        globalCss,
        /\.clash-dashboard-composer-dock \.clash-chat-input-toolbar-row/,
      ),
    ).toBe(false);

    const dockRule = globalCss.match(
      /\.clash-dashboard-composer-dock\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(dockRule).toMatch(/bottom:\s*max\(\s*0\.5rem/);
  });

  it("does not fork shared Composer hover or focus appearance on dashboard", () => {
    expect(
      sourceMatches(
        globalCss,
        /\.clash-dashboard-composer-dock\s+\.clash-chat-input-surface:(?:hover|has)/,
      ),
    ).toBe(false);
  });

  it("does not state-tag the default composer layout wrapper", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    expect(container.querySelector(".clash-chat-input-hero-layout")).toBeNull();
  });

  it("keeps the expanded editor body before the bottom control row", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
          projectId="project-1"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    // ComposerShell owns topology: body slot + toolbar (actions) as siblings.
    const layout = container.querySelector<HTMLElement>(
      ".clash-chat-input-hero-layout.openma-composer-shell",
    )!;
    const body = container.querySelector<HTMLElement>(
      "[data-openma-composer-body]",
    )!;
    const actions = container.querySelector<HTMLElement>(
      ".clash-chat-input-actions",
    )!;
    const editor = container.querySelector<HTMLElement>(
      ".clash-chat-input-editor",
    )!;
    expect(actions.parentElement).toBe(layout);
    expect(body.parentElement).toBe(layout);
    expect(editor.closest("[data-openma-composer-body]")).toBe(body);
    expect(
      container.querySelector(".clash-chat-input-toolbar-start")!.parentElement,
    ).toBe(actions);
    expect(
      container.querySelector(".clash-chat-input-toolbar-end")!.parentElement,
    ).toBe(actions);
    expect(
      editor.compareDocumentPosition(actions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const expandedStack = globalCss.match(
      /\.clash-home-hero \.clash-chat-input-hero-layout[\s\S]{0,80}?\{[\s\S]{0,280}?\}/,
    )?.[0];
    expect(expandedStack).toBeTruthy();
    expect(
      sourceMatches(
        expandedStack!,
        /gap:\s*var\(--composer-section-gap/,
      ),
    ).toBe(true);
    expect(sourceMatches(expandedStack!, /display:\s*grid;/)).toBe(false);
  });

  it("never dissolves the expanded action rail with display contents", () => {
    const actions = globalCss.match(
      /\.clash-home-hero \.clash-chat-input-actions\s*\{[\s\S]{0,120}?\}/,
    )?.[0];
    expect(actions).toBeTruthy();
    expect(sourceMatches(actions!, /display:\s*contents/)).toBe(false);
    expect(sourceMatches(actions!, /pointer-events:\s*none/)).toBe(false);
  });

  it("keeps a real 48px editor body above the expanded controls", () => {
    const editorBody = globalCss.match(
      /\.clash-home-hero \.clash-chat-input-editor--hero\s*\{[\s\S]{0,260}?\}/,
    )?.[0];
    expect(editorBody).toBeTruthy();
    expect(sourceMatches(editorBody!, /min-height:\s*3rem/)).toBe(true);
    expect(sourceMatches(editorBody!, /padding:\s*0\.375rem\s+0\.25rem/)).toBe(
      true,
    );
    expect(sourceMatches(editorBody!, /transform:/)).toBe(false);
  });

  it("leaves expanded multiline on the natural stacked flow", () => {
    // Every expanded state stays in the same flex-column shell.
    expect(
      sourceMatches(
        globalCss,
        /\.clash-chat-input-hero-layout\[data-input-state="multiline"\][\s\S]{0,200}?display:\s*(?:grid|contents)/,
      ),
    ).toBe(false);
  });

  it("keeps the compact pill rules independent of the expanded shared row", () => {
    // The already-correct compact contract must survive untouched.
    expect(globalCss).toMatch(
      /\.clash-home-hero\[data-composer-mode="compact"\] \.clash-chat-input-toolbar-row\s*\{[\s\S]*?display:\s*flex;/,
    );
    expect(globalCss).toMatch(
      /\.clash-home-hero\[data-composer-mode="compact"\] \.clash-chat-input-toolbar-start\s*\{[\s\S]*?display:\s*none;/,
    );

    const compactPill = globalCss.match(
      /\.clash-home-hero\[data-composer-mode="compact"\][\s\S]*?\.clash-chat-input-surface\[data-composer-visual-state="compact"\][\s\S]*?\{[\s\S]*?\}/,
    )?.[0];
    expect(compactPill).toBeTruthy();
    expect(compactPill).toMatch(/border-radius:\s*9999px/);
    expect(compactPill).toMatch(/background:\s*var\(--clash-warm-surface\)/);
    expect(compactPill).toMatch(/box-shadow:\s*var\(--clash-shadow-floating\)/);

    expect(globalCss).toMatch(
      /\.clash-home-hero\[data-composer-mode="compact"\][\s\S]*?\.clash-chat-input-surface\[data-composer-visual-state="growing"\][\s\S]*?\{[\s\S]*?border-radius:\s*1rem/,
    );
  });

  it("promotes compact content to the shared growing visual state", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input={"Line one\nLine two"}
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
          visualState="compact"
        />
      </Suspense>,
    );
    await screen.findByTestId("milkdown-editor");
    expect(
      container.querySelector<HTMLElement>(".clash-chat-input-surface")?.dataset
        .composerVisualState,
    ).toBe("growing");
  });

  it("gives the hero Milkdown wrapper no padding of its own", () => {
    expect(globalCss).toMatch(
      /\.clash-chat-input-editor--hero \.milkdown-editor-wrapper\s*\{\s*padding:\s*0 !important;\s*\}/,
    );
  });

  it("centers compact single-line content with layout instead of faking the caret", () => {
    expect(globalCss).not.toMatch(/padding-top:\s*0\.55rem/);
    const compactEditor = globalCss.match(
      /\.clash-home-hero\[data-composer-mode="compact"\]\s*\.clash-chat-input-editor--hero\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(compactEditor).toBeTruthy();
    expect(compactEditor).toMatch(/display:\s*flex;/);
    expect(compactEditor).toMatch(/align-items:\s*center;/);

    // Empty and single-line content is centered by normal flex layout.
    expect(globalCss).toMatch(
      /\.clash-home-hero\[data-composer-mode="compact"\]\s*\.clash-chat-input-editor--hero\[data-input-state="empty"\],[\s\S]*?\[data-input-state="single-line"\][\s\S]*?\{[\s\S]*?align-items:\s*center;/,
    );

    // Multiline scrolls in normal block flow with a deliberate block inset.
    const compactMultiline = globalCss.match(
      /\.clash-home-hero\[data-composer-mode="compact"\]\s*\.clash-chat-input-editor--hero\[data-input-state="multiline"\]\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(compactMultiline).toBeTruthy();
    expect(compactMultiline).toMatch(/display:\s*block;/);
    expect(compactMultiline).toMatch(/padding-block:/);
  });

  it("lets the compact pill grow from content without a state-specific height branch", () => {
    const compactParent = globalCss.match(
      /\.clash-home-hero\[data-composer-mode="compact"\] \.clash-chat-input-surface > div,[\s\S]*?\.openma-composer-shell\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(compactParent).toBeTruthy();
    expect(compactParent).toMatch(/min-height:\s*3rem;/);
    expect(compactParent).not.toMatch(/\n\s*height:\s*3rem;/);
    expect(compactParent).toMatch(/align-items:\s*center;/);
    expect(compactParent).toMatch(/flex-direction:\s*row;/);

    expect(globalCss).not.toMatch(
      /\.clash-chat-input-surface\s*>\s*div:has\(\s*\.clash-chat-input-editor--hero\[data-input-state="multiline"\]/,
    );
  });

  it("keeps the composer caret visible with the current content colour", () => {
    const caretRule = globalCss.match(
      /\.milkdown-chat-input \.ProseMirror\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(caretRule).toMatch(/caret-color:\s*var\(--clash-content-primary\);/);
    expect(caretRule).not.toMatch(/--clash-coral/);
    expect(caretRule).not.toMatch(/--clash-blue/);
  });

  it("uses the authenticated product type and readable hint colour in the real editor", () => {
    const editorRule = globalCss.match(
      /\.milkdown-chat-input \.ProseMirror\s*\{[\s\S]*?\}/,
    )?.[0];
    const hintRule = globalCss.match(
      /\.milkdown-chat-input \.ProseMirror p\.is-editor-empty:first-child::before\s*\{[\s\S]*?\}/,
    )?.[0];

    expect(editorRule).toBeTruthy();
    expect(
      sourceMatches(editorRule!, /font-family:\s*var\(--font-product\)/),
    ).toBe(true);
    expect(
      sourceMatches(
        editorRule!,
        /font-size:\s*var\(--clash-chat-body-size,\s*0\.875rem\)/,
      ),
    ).toBe(true);
    expect(hintRule).toBeTruthy();
    expect(
      sourceMatches(hintRule!, /color:\s*var\(--clash-content-secondary\)/),
    ).toBe(true);
  });

  it("starts dashboard text with the shared default editor inset", () => {
    expect(
      sourceMatches(
        globalCss,
        /\.composer-card\s+\.clash-chat-input-editor--default\s+\.milkdown-editor-wrapper\s*\{[^}]*padding:\s*0 !important;/,
      ),
    ).toBe(true);
    expect(
      sourceMatches(
        globalCss,
        /\.clash-dashboard-composer-dock \.clash-chat-input-editor--hero/,
      ),
    ).toBe(false);
  });

  it("uses opaque neutral tokens and a restrained shadow for composer focus", () => {
    const composerRules = [
      /(?:^|\n)\.clash-chat-input-surface\s*\{[\s\S]*?\}/,
      /(?:^|\n)\.clash-chat-input-surface:hover\s*\{[\s\S]*?\}/,
      /(?:^|\n)\.clash-chat-input-surface:has\(\.clash-chat-input-editor:focus-within\)\s*\{[\s\S]*?\}/,
      /\.clash-home-hero\s*\.clash-chat-input-surface:has\(\.clash-chat-input-editor:focus-within\)\s*\{[\s\S]*?\}/,
      /\.dark \.clash-chat-input-surface,\s*\.dark \.clash-chat-input-surface:hover,\s*\.dark \.clash-chat-input-surface:has\(\.clash-chat-input-editor:focus-within\)\s*\{[\s\S]*?\}/,
    ].map((pattern) => {
      const rule = globalCss.match(pattern)?.[0];
      expect(rule).toBeTruthy();
      return rule!;
    });

    for (const rule of composerRules) {
      // No focus halo ring in any theme or override.
      expect(rule).not.toMatch(/box-shadow:[\s\S]*?0 0 0 \d/);
      // No brown gradient or raw brown border.
      expect(rule).not.toMatch(/linear-gradient/);
      expect(rule).not.toMatch(/rgba\(225, 221, 213/);
      expect(rule).not.toMatch(/rgba\(210, 204, 194/);
      expect(rule).not.toMatch(/rgba\(255, 107, 80/);
      expect(rule).not.toMatch(/--clash-blue/);
    }

    const [base, , focus] = composerRules;
    expect(base).toMatch(/background:\s*var\(--clash-warm-surface\);/);
    expect(focus).toMatch(
      /box-shadow:\s*var\(--clash-workspace-surface-shadow\);/,
    );
  });

  it("starts the default composer caret at Backchat's shared body inset", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    const editorArea = container.querySelector(".clash-chat-input-editor");
    expect(editorArea?.className).toContain("clash-chat-input-editor--default");
    expect(
      sourceMatches(
        globalCss,
        /\.composer-card\s+\.clash-chat-input-editor--default\s+\.milkdown-editor-wrapper\s*\{[^}]*padding:\s*0 !important;/,
      ),
    ).toBe(true);
  });

  it("anchors text at the top of the compact three-row composer without losing balanced outer insets", () => {
    expect(
      sourceMatches(
        globalCss,
        /\[data-chat-density="compact"\]\s+\.composer-card\s+\.clash-chat-input-editor--default\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*flex-start;[^}]*padding-block-start:\s*0\.3125rem;/,
      ),
    ).toBe(true);
    expect(
      sourceMatches(
        globalCss,
        /\[data-chat-density="compact"\][\s\S]*?\.clash-chat-input-editor--default[\s\S]*?\.ProseMirror\s*\{[^}]*min-height:\s*1\.25rem;[^}]*line-height:\s*1\.25rem;/,
      ),
    ).toBe(true);
  });

  it("left-aligns the hero editor instead of centering the caret", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    const editorArea = container.querySelector(".clash-chat-input-editor");
    expect(editorArea).toBeTruthy();
    expect(editorArea?.className).toContain("text-left");
    expect(editorArea?.className).toContain("w-full");
    expect(editorArea?.className).toContain("clash-chat-input-editor--hero");
    expect(globalCss).toMatch(
      /\.milkdown-chat-input \.ProseMirror\s*\{[\s\S]*text-align:\s*left;/,
    );
    // The hero host owns the inset, so the wrapper contributes no padding.
    expect(globalCss).toMatch(
      /\.clash-chat-input-editor--hero \.milkdown-editor-wrapper\s*\{\s*padding:\s*0 !important;\s*\}/,
    );
  });

  it("homages Backchat run-action chrome (CornerDownLeft send, ghost action)", async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input="hello"
          onInputChange={() => undefined}
          onSubmit={() => undefined}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    const send = screen.getByRole("button", {
      name: "copilot.chatInput.send",
    });
    expect(send.className).toContain("clash-composer-action");
    expect(send.className).toContain("clash-composer-action--ready");
    expect(send).toHaveAttribute("data-composer-submit", "true");
    expect(send.querySelector("svg")).toBeTruthy();
    expect(globalCss).toMatch(/\.clash-composer-action\s*\{/);
    expect(globalCss).toMatch(
      /--composer-control-height:\s*var\(--control-height-compact/,
    );
  });

  it("keeps runtime queued send available without hiding stop", async () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input="follow up"
          onInputChange={() => undefined}
          onSubmit={onSubmit}
          onStop={onStop}
          isProcessing
          allowSubmitWhileProcessing
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    const sendButton = screen.getByRole("button", {
      name: "copilot.chatInput.send",
    }) as HTMLButtonElement;
    const stopButton = screen.getByRole("button", {
      name: "copilot.chatInput.stop",
    }) as HTMLButtonElement;

    expect(sendButton.disabled).toBe(false);
    expect(stopButton.disabled).toBe(false);
    expect(sendButton.className).toContain("clash-composer-action");
    expect(sendButton).toHaveAttribute("data-composer-submit", "true");
    expect(stopButton.className).toContain("clash-chat-input-icon-control");
    expect(stopButton.className).toContain("clash-composer-action");
    expect(stopButton).toHaveAttribute("data-composer-stop", "true");
    expect(stopButton.className).not.toContain("clash-chat-input-stop");
    expect(document.querySelector(".clash-chat-input-editor")).toHaveAttribute(
      "data-chat-typography",
      "body",
    );
  });

  it("does not expose a bare connection status dot in the composer toolbar", async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          connected={false}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    expect(screen.queryByLabelText("copilot.status.connected")).toBeNull();
    expect(screen.queryByLabelText("copilot.status.disconnected")).toBeNull();
  });

  it("does not submit when disabled even if the editor emits submit", async () => {
    const onSubmit = vi.fn();
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input="blocked room message"
          onInputChange={() => undefined}
          onSubmit={onSubmit}
          disabled
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    fireEvent.click(screen.getByTestId("milkdown-submit"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "copilot.chatInput.send",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen
        .getByTestId("milkdown-editor")
        .closest(".clash-chat-input-editor")
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByTestId("milkdown-editor").closest(".clash-chat-input-editor")
        ?.className,
    ).toContain("pointer-events-none");
  });

  it("passes a disabled composer hint to the editor without an overlay", async () => {
    const { container } = render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          placeholder="Cloud room is unavailable in this local project"
          disabled
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    expect(screen.getByTestId("milkdown-editor")).toHaveAttribute(
      "data-placeholder",
      "Cloud room is unavailable in this local project",
    );
    expect(container.querySelector(".clash-chat-input-placeholder")).toBeNull();
  });

  it("exposes focus through an explicit handle instead of requiring DOM queries", async () => {
    const inputRef = createRef<{ focus: () => void }>();
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          ref={inputRef}
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          variant="hero"
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    inputRef.current?.focus();

    expect(milkdownFocus).toHaveBeenCalledTimes(1);
  });

  it("allows every canvas media type in the mention picker", async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input="@"
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          mentionableNodes={[
            { id: "image", type: "image", label: "Image" },
            { id: "video", type: "video", label: "Video" },
            { id: "audio", type: "audio", label: "Audio" },
            { id: "text", type: "text", label: "Text" },
          ]}
        />
      </Suspense>,
    );

    const editor = await screen.findByTestId("milkdown-editor");
    expect(editor.getAttribute("data-prompt-modalities")).toBe(
      "text,image,video,audio",
    );
  });

  it("uses Backchat's compact annotation strip instead of a thumbnail and count capsule", async () => {
    const onAnnotationRemove = vi.fn();
    const annotation: AgentAnnotationDraft = {
      id: "annotation-canvas-1",
      kind: "agent-annotation" as const,
      note: "Use the wider crop.",
      target: {
        projectId: "project-1",
        surface: "canvas" as const,
        surfaceId: "canvas-main",
        surfaceLabel: "Main",
        objectId: "image-1",
        objectType: "image",
        objectLabel: "Hero still",
        objectPath: "canvases/canvas-main/nodes/image-1",
        capabilities: ["read", "modify"],
      },
    };

    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          annotationBlocks={[annotation]}
          onAnnotationRemove={onAnnotationRemove}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    const tray = screen.getByTestId("agent-annotation-tray");
    expect(tray.textContent).toBe("1 annotation");
    expect(screen.queryByAltText("Hero still")).toBeNull();
    expect(tray.parentElement).toBe(
      tray.closest('[data-slot="composer-inline-content"]'),
    );

    fireEvent.click(screen.getByRole("button", { name: "1 annotation" }));

    const item = screen.getByTestId("agent-annotation-item");
    expect(item.textContent).toContain("Main");
    expect(item.textContent).toContain("Hero still");
    expect(item.textContent).toContain("Use the wider crop.");
    expect(
      screen.getByRole("button", { name: "Remove annotation 1" }),
    ).toBeTruthy();
  });

  it("opens the annotation list only when clicked", async () => {
    const annotation: AgentAnnotationDraft = {
      id: "annotation-hover-1",
      kind: "agent-annotation" as const,
      note: "",
      target: {
        projectId: "project-1",
        surface: "canvas" as const,
        surfaceId: "canvas-main",
        surfaceLabel: "Main",
        objectId: "image-1",
        objectType: "canvas-image",
        objectLabel: "Hero still",
        objectPath: "canvases/canvas-main/nodes/image-1",
        capabilities: ["read", "modify"],
      },
    };

    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          annotationBlocks={[annotation]}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    const tray = screen.getByTestId("agent-annotation-tray");
    expect(tray.dataset.open).toBe("false");

    fireEvent.mouseEnter(tray);
    expect(screen.getByTestId("agent-annotation-tray").dataset.open).toBe(
      "false",
    );
    expect(screen.queryByTestId("agent-annotation-item")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "1 annotation" }));
    fireEvent.mouseLeave(tray);
    expect(screen.getByTestId("agent-annotation-tray").dataset.open).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "1 annotation" }));
    expect(screen.getByTestId("agent-annotation-tray").dataset.open).toBe(
      "false",
    );
  });

  it("numbers listed annotations to match the surface pins", async () => {
    const makeAnnotation = (
      id: string,
      objectLabel: string,
    ): AgentAnnotationDraft => ({
      id,
      kind: "agent-annotation" as const,
      note: "",
      target: {
        projectId: "project-1",
        surface: "timeline" as const,
        surfaceId: "timeline-1",
        surfaceLabel: "Final cut",
        objectId: id,
        objectType: "timeline-track",
        objectLabel,
        objectPath: `timelines/timeline-1/tracks/${id}`,
        capabilities: ["read", "modify"],
      },
    });

    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={() => undefined}
          annotationBlocks={[
            makeAnnotation("track-sfx", "Sound Design"),
            makeAnnotation("track-music", "Music"),
          ]}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    fireEvent.click(screen.getByRole("button", { name: "2 annotations" }));

    // Order in the tray is the pin numbering used on the creative surfaces.
    expect(
      screen.getAllByTestId("agent-annotation-number").map((item) => item.textContent),
    ).toEqual(["1.", "2."]);
    expect(screen.getByText("Sound Design")).toBeTruthy();
    expect(screen.getByText("Music")).toBeTruthy();
  });

  it("submits an annotation block without requiring duplicate prose in the editor", async () => {
    const onSubmit = vi.fn();
    const annotation: AgentAnnotationDraft = {
      id: "annotation-director-1",
      kind: "agent-annotation" as const,
      note: "Rotate the key light toward the actor.",
      target: {
        projectId: "project-1",
        surface: "director-stage" as const,
        surfaceId: "stage-1",
        surfaceLabel: "Courtyard blocking",
        revisionId: "director-revision-2",
        objectId: "key-light",
        objectType: "light",
        objectLabel: "Key light",
        objectPath: "director-stages/stage-1/objects/key-light",
        capabilities: ["read", "modify"],
      },
    };

    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={onSubmit}
          annotationBlocks={[annotation]}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");
    const sendButton = screen.getByRole("button", {
      name: "copilot.chatInput.send",
    }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);

    fireEvent.click(screen.getByTestId("milkdown-submit"));

    expect(onSubmit).toHaveBeenCalledWith("", [], [annotation]);
  });

  it("renders a quoted selection and submits it without requiring an extra comment", async () => {
    const onSubmit = vi.fn();
    const annotation = {
      id: "annotation-selection-1",
      kind: "agent-annotation" as const,
      note: "",
      target: {
        projectId: "project-1",
        surface: "timeline" as const,
        surfaceId: "timeline-1",
        surfaceLabel: "Final cut",
        objectId: "timeline-1",
        objectType: "timeline",
        objectLabel: "Final cut",
        objectPath: "timelines/timeline-1",
        capabilities: ["read", "modify"] as const,
        selection: {
          kind: "text-quote" as const,
          exact: "Director：14 tests Web 相关回归：62 tests",
          prefix: "Timeline：215 tests ",
          suffix: " 三个相关包类型检查通过",
          visualRects: [{ x: 0.12, y: 0.42, width: 0.3, height: 0.04 }],
        },
      },
    } as unknown as AgentAnnotationDraft;

    render(
      <Suspense fallback={<div>Loading</div>}>
        <ChatInput
          input=""
          onInputChange={() => undefined}
          onSubmit={onSubmit}
          annotationBlocks={[annotation]}
        />
      </Suspense>,
    );

    await screen.findByTestId("milkdown-editor");

    fireEvent.click(screen.getByRole("button", { name: "1 annotation" }));

    expect(
      screen.getByText("Director：14 tests Web 相关回归：62 tests"),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();

    const sendButton = screen.getByRole("button", {
      name: "copilot.chatInput.send",
    }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);

    fireEvent.click(screen.getByTestId("milkdown-submit"));
    expect(onSubmit).toHaveBeenCalledWith("", [], [annotation]);
  });

  it("does not enter recording and points the microphone to Audio when voice input is disabled", async () => {
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/audio")) {
        return new Response(
          JSON.stringify({
            asr: {
              enabled: false,
              provider: "builtin-funasr",
              base_url: null,
              model: "iic/SenseVoiceSmall",
              has_api_key: false,
              ready: false,
              setup: {
                provider: "funasr",
                runtime: "builtin-rpc",
                status: "disabled",
                default_base_url: null,
                commands: [],
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input=""
            onInputChange={() => undefined}
            onSubmit={() => undefined}
          />
        </Suspense>
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByTestId("milkdown-editor");
    fireEvent.click(
      screen.getByRole("button", { name: "copilot.chatInput.voice" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/audio"),
        expect.objectContaining({ credentials: "include" }),
      ),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Enable voice input in Voice input settings first.",
    );
    expect(
      screen
        .getByRole("link", { name: "Open Voice input" })
        .getAttribute("href"),
    ).toBe("/settings?section=audio");
    fireEvent.click(screen.getByRole("link", { name: "Open Voice input" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe").textContent).toBe(
        "/settings?section=audio",
      ),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "copilot.chatInput.voice" }),
    ).toBeNull();

    if (mediaDevicesDescriptor) {
      Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  it("anchors homepage voice setup beside the microphone and shows immediate progress", async () => {
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    const stopTracks = vi.fn();
    const getUserMedia = vi.fn(
      async () =>
        ({
          getTracks: () => [{ stop: stopTracks }],
        }) as unknown as MediaStream,
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class ImmediateMediaRecorder {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      static isTypeSupported() {
        return true;
      }

      constructor(_stream: MediaStream) {}

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["voice"], { type: this.mimeType }),
        } as BlobEvent);
        this.onstop?.();
      }
    }

    class ImmediateAudioContext {
      createMediaStreamSource() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as MediaStreamAudioSourceNode;
      }

      createAnalyser() {
        return {
          fftSize: 0,
          frequencyBinCount: 16,
          getFloatTimeDomainData: vi.fn((values: Float32Array) =>
            values.fill(0),
          ),
        } as unknown as AnalyserNode;
      }

      close() {
        return Promise.resolve();
      }
    }

    vi.stubGlobal("MediaRecorder", ImmediateMediaRecorder);
    vi.stubGlobal("AudioContext", ImmediateAudioContext);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 0),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    let resolveAudioConfig!: (response: Response) => void;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL) =>
        new Promise<Response>((resolveFetch) => {
          resolveAudioConfig = resolveFetch;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input=""
            onInputChange={() => undefined}
            onSubmit={() => undefined}
            variant="hero"
          />
        </Suspense>
      </MemoryRouter>,
    );

    await screen.findByTestId("milkdown-editor");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/v1/audio/voice-input",
    );
    const voiceButton = screen.getByRole("button", {
      name: "copilot.chatInput.voice",
    });
    fireEvent.click(voiceButton);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const recording = await screen.findByRole("region", {
      name: "copilot.chatInput.voice",
    });
    expect(
      recording.querySelector('[data-waveform-engine="wavesurfer-record"]'),
    ).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(
      screen.queryByRole("dialog", { name: "Voice input setup" }),
    ).toBeNull();

    resolveAudioConfig(
      new Response(
        JSON.stringify({
          asr: {
            enabled: false,
            provider: "builtin-funasr",
            base_url: null,
            model: "iic/SenseVoiceSmall",
            ready: false,
            setup: {
              provider: "funasr",
              runtime: "builtin-rpc",
              status: "disabled",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const setup = await screen.findByRole("dialog", {
      name: "Voice input setup",
    });
    expect(setup.textContent).toContain(
      "Enable voice input in Voice input settings first.",
    );
    expect(
      screen.queryByRole("region", { name: "copilot.chatInput.voice" }),
    ).toBeNull();
    expect(stopTracks).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("link", { name: "Open Voice input" })
        .getAttribute("href"),
    ).toBe("/settings?section=audio");

    fireEvent.click(
      screen.getByRole("button", { name: "copilot.chatInput.voice" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Voice input setup" }),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (mediaDevicesDescriptor) {
      Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  it("prefetches voice readiness for project composers and reuses the home snapshot", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            asr: {
              enabled: false,
              provider: "builtin-funasr",
              base_url: null,
              model: "iic/SenseVoiceSmall",
              ready: false,
              setup: {
                provider: "funasr",
                runtime: "builtin-rpc",
                status: "disabled",
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const home = render(
      <MemoryRouter initialEntries={["/"]}>
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input=""
            onInputChange={() => undefined}
            onSubmit={() => undefined}
            variant="hero"
          />
        </Suspense>
      </MemoryRouter>,
    );

    await screen.findByTestId("milkdown-editor");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    home.unmount();

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input=""
            onInputChange={() => undefined}
            onSubmit={() => undefined}
          />
        </Suspense>
      </MemoryRouter>,
    );

    await screen.findByTestId("milkdown-editor");
    fireEvent.click(
      screen.getByRole("button", { name: "copilot.chatInput.voice" }),
    );
    await screen.findByRole("alert");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rechecks an unavailable shared voice snapshot after its short cache window", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            asr: {
              enabled: false,
              provider: "builtin-funasr",
              base_url: null,
              model: "iic/SenseVoiceSmall",
              ready: false,
              setup: {
                provider: "funasr",
                runtime: "builtin-rpc",
                status: "disabled",
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const home = render(
      <MemoryRouter initialEntries={["/"]}>
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input=""
            onInputChange={() => undefined}
            onSubmit={() => undefined}
            variant="hero"
          />
        </Suspense>
      </MemoryRouter>,
    );

    await screen.findByTestId("milkdown-editor");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    home.unmount();

    now += 1_001;
    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input=""
            onInputChange={() => undefined}
            onSubmit={() => undefined}
          />
        </Suspense>
      </MemoryRouter>,
    );

    await screen.findByTestId("milkdown-editor");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("points an enabled voice input with an undeployed ASR model to Models", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            asr: {
              enabled: true,
              provider: "builtin-funasr",
              base_url: null,
              model: "iic/SenseVoiceSmall",
              ready: false,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Suspense fallback={<div>Loading</div>}>
          <ChatInput
            input=""
            onInputChange={() => undefined}
            onSubmit={() => undefined}
          />
        </Suspense>
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByTestId("milkdown-editor");
    fireEvent.click(
      screen.getByRole("button", { name: "copilot.chatInput.voice" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Deploy the selected ASR model in Models first.",
    );
    fireEvent.click(screen.getByRole("link", { name: "Open Models" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe").textContent).toBe(
        "/settings?section=models",
      ),
    );
  });

  it("keeps recording in the composer toolbar and supports transcribe-only or transcribe-and-send", async () => {
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    const stopTracks = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTracks }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class TestMediaRecorder {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;
      private readonly listeners = new Map<string, Array<() => void>>();

      constructor(_stream: MediaStream) {}

      static isTypeSupported() {
        return true;
      }

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["voice"], { type: this.mimeType }),
        } as BlobEvent);
        this.onstop?.();
        this.listeners.get("stop")?.forEach((listener) => listener());
      }

      addEventListener(name: string, listener: () => void) {
        this.listeners.set(name, [
          ...(this.listeners.get(name) ?? []),
          listener,
        ]);
      }
    }

    const getByteFrequencyData = vi.fn((values: Uint8Array) => values.fill(0));
    const getByteTimeDomainData = vi.fn((values: Uint8Array) => {
      values.fill(128);
      values[0] = 196;
    });

    class TestAudioContext {
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 24,
          getByteFrequencyData,
          getByteTimeDomainData,
          getFloatTimeDomainData: vi.fn((values: Float32Array) =>
            values.fill(0.25),
          ),
        } as unknown as AnalyserNode;
      }

      createMediaStreamSource() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as MediaStreamAudioSourceNode;
      }

      close() {
        return Promise.resolve();
      }
    }

    vi.stubGlobal("MediaRecorder", TestMediaRecorder);
    vi.stubGlobal("AudioContext", TestAudioContext);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 0),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onInputChange = vi.fn();
    const onSubmit = vi.fn();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/v1/audio/voice-input/warmup")) {
          expect(init?.method).toBe("POST");
          return Response.json({ warmed: true, runtime: "builtin-rpc" });
        }
        if (String(input).includes("/api/v1/audio/transcriptions")) {
          expect(init?.method).toBe("POST");
          expect(init?.body).toBeInstanceOf(FormData);
          return new Response(JSON.stringify({ text: "hello from ASR" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (String(input).includes("/api/v1/audio")) {
          return new Response(
            JSON.stringify({
              asr: {
                enabled: true,
                ready: true,
                provider: "builtin-funasr",
                base_url: null,
                model: "iic/SenseVoiceSmall",
                setup: { runtime: "builtin-rpc" },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(
        <MemoryRouter>
          <Suspense fallback={<div>Loading</div>}>
            <ChatInput
              input="existing"
              onInputChange={onInputChange}
              onSubmit={onSubmit}
              variant="hero"
            />
          </Suspense>
        </MemoryRouter>,
      );

      await screen.findByTestId("milkdown-editor");
      fireEvent.click(
        screen.getByRole("button", { name: "copilot.chatInput.voice" }),
      );
      const recording = await screen.findByRole("region", {
        name: "copilot.chatInput.voice",
      });
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(
        recording.classList.contains("clash-voice-recording-toolbar"),
      ).toBe(true);
      const waveform = recording.querySelector(
        ".clash-voice-recording-waveform",
      );
      expect(waveform).toBeTruthy();
      expect(
        waveform?.querySelector('[data-waveform-engine="wavesurfer-record"]'),
      ).toBeTruthy();
      expect(waveform?.querySelector("svg")).toBeNull();
      expect(screen.getByText("0:00")).toBeTruthy();
      expect(recording.querySelector(".animate-spin")).toBeNull();
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/v1/audio/voice-input/warmup"),
          expect.objectContaining({ method: "POST" }),
        ),
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: "copilot.chatInput.stopAndTranscribe",
        }),
      );

      await waitFor(() =>
        expect(onInputChange).toHaveBeenCalledWith("existing hello from ASR"),
      );
      expect(onSubmit).not.toHaveBeenCalled();
      expect(stopTracks).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/audio/transcriptions"),
        expect.objectContaining({ method: "POST" }),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "copilot.chatInput.voice" }),
      );
      await screen.findByRole("region", { name: "copilot.chatInput.voice" });
      fireEvent.click(
        screen.getByRole("button", {
          name: "copilot.chatInput.stopTranscribeAndSend",
        }),
      );

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          "existing hello from ASR",
          [],
          [],
        ),
      );
      expect(onInputChange).toHaveBeenLastCalledWith("");
      expect(stopTracks).toHaveBeenCalledTimes(2);
    } finally {
      if (mediaDevicesDescriptor) {
        Object.defineProperty(
          navigator,
          "mediaDevices",
          mediaDevicesDescriptor,
        );
      } else {
        Reflect.deleteProperty(navigator, "mediaDevices");
      }
    }
  });
});
