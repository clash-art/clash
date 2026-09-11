// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import MarketplaceClient from "./MarketplaceClient";
import {
  DashboardComposerProvider,
  useDashboardComposer,
} from "./DashboardComposerContext";

const marketplaceApi = vi.hoisted(() => ({
  installAction: vi.fn(),
  installPlugin: vi.fn(),
  installSkill: vi.fn(),
  uninstallAction: vi.fn(),
  uninstallSkill: vi.fn(),
}));

vi.mock("@clash/web-ui/lib/clientActions", () => ({
  marketplaceInstallAction: marketplaceApi.installAction,
  marketplaceInstallPlugin: marketplaceApi.installPlugin,
  marketplaceInstallSkill: marketplaceApi.installSkill,
  marketplaceUninstallAction: marketplaceApi.uninstallAction,
  marketplaceUninstallSkill: marketplaceApi.uninstallSkill,
}));

const items = [
  {
    id: "codex-imagegen",
    type: "action" as const,
    name: "Codex ImageGen",
    description: "Generate images.",
  },
  {
    id: "sd25-pe",
    type: "skill" as const,
    name: "Seedance guide",
    description: "Improve video prompts.",
  },
];

function MarketplaceComposerProbe() {
  const composer = useDashboardComposer();
  return (
    <>
      <output aria-label="Composer skills">
        {composer.references.skills.map((skill) => skill.name).join(",")}
      </output>
      <button
        type="button"
        onClick={() => composer.removeSkillReference("sd25-pe")}
      >
        Remove Composer skill
      </button>
    </>
  );
}

function MarketplaceLocationProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}

function render(ui: ReactElement) {
  return testingRender(
    <MemoryRouter initialEntries={["/marketplace/manage"]}>{ui}</MemoryRouter>,
  );
}

describe("MarketplaceClient interactions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lets users discover and install an official pick while filtering uncurated skills", async () => {
    marketplaceApi.installSkill.mockResolvedValue({ installed: true });
    const picked = {
      id: "example.curated",
      name: "Multiview workflow",
      type: "skill" as const,
      source: "community",
      author: "Original author",
      curation: { collection: "official-picks" as const, curator: "Clash" },
    };
    render(
      <MarketplaceClient
        items={[...items, picked]}
        installedActionIds={[]}
        installedSkillIds={[]}
        catalogScope="official-picks"
      />,
    );
    expect(screen.getByRole("heading", { name: "Official Picks" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Seedance guide" })).toBeNull();
    const card = screen.getByRole("heading", { name: picked.name }).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(marketplaceApi.installSkill).toHaveBeenCalledWith(picked),
    );
    expect(within(card).getByText("Installed")).toBeTruthy();
  });

  it("shows Clash plugins and actions without mixing generic agent skills into the Store", async () => {
    marketplaceApi.installPlugin.mockResolvedValue({ installed: true });
    render(
      <MarketplaceClient
        items={[
          ...items,
          {
            id: "clash.storyboard",
            packageId: "clash.storyboard",
            type: "plugin",
            name: "Storyboard",
            author: "Clash",
            description: "Draft a structured storyboard.",
          },
        ]}
        installedActionIds={[]}
        installedSkillIds={[]}
        installedPluginIds={[]}
        catalogScope="plugins-and-actions"
      />,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search plugins and actions" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Storyboard" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Codex ImageGen" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Seedance guide" }),
    ).toBeNull();

    const storyboard = screen
      .getByRole("heading", { name: "Storyboard" })
      .closest('[data-slot="marketplace-item"]') as HTMLElement;
    fireEvent.click(within(storyboard).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(marketplaceApi.installPlugin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "clash.storyboard" }),
      ),
    );
  });

  it("combines full-text search with independent AND filter chips", () => {
    const { container } = render(
      <MarketplaceClient
        items={items}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const toolbar = container.querySelector(
      '[data-slot="search-filter-toolbar"]',
    );
    expect(toolbar).toBeTruthy();
    expect(toolbar).toContainElement(
      screen.getByRole("searchbox", { name: "Search actions and skills" }),
    );
    const filter = within(toolbar as HTMLElement).getByRole("button", {
      name: "Filter",
    });
    fireEvent.pointerDown(filter, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Type" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Actions" }));
    expect(
      screen.getByRole("heading", { name: "Codex ImageGen" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Seedance guide" }),
    ).toBeNull();
    expect(screen.getByText("Type · Actions")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Skills" }));
    expect(
      screen.queryByRole("heading", { name: "Codex ImageGen" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Seedance guide" }),
    ).toBeNull();
    expect(screen.getByText("Type · Actions")).toBeTruthy();
    expect(screen.getByText("Type · Skills")).toBeTruthy();
    expect(
      screen.getByRole("status", {
        name: "No items match the selected filters",
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Type filter: Actions" }),
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search actions and skills" }),
      { target: { value: "video" } },
    );
    expect(
      screen.queryByRole("heading", { name: "Codex ImageGen" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Seedance guide" }),
    ).toBeTruthy();
  });

  it("uses the Clash search artwork when Marketplace has no matching items", () => {
    const { container } = render(
      <MarketplaceClient
        items={[]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const emptyState = screen.getByRole("status", {
      name: "No items available yet",
    });
    expect(emptyState).toBeTruthy();
    const emptyArtwork = emptyState.querySelector("img");
    expect(emptyArtwork).toHaveAttribute(
      "src",
      "/brand/avatar-empty-search.png",
    );
    expect(emptyArtwork).toHaveAttribute("data-ui", "brand-asset");
    expect(emptyArtwork).toHaveAttribute("data-asset-role", "state");
    expect(
      container.querySelector('[data-slot="marketplace-empty-artwork"]'),
    ).toHaveAttribute("data-ui", "artwork-slot");
  });

  it("uses real publisher marks before the custom Clash fallback artwork", () => {
    const { container } = render(
      <MarketplaceClient
        items={[
          {
            ...items[0],
            author: "Clash",
            icon: "✨",
          },
          {
            ...items[1],
            id: "clash.video.sd25-pe",
            tags: ["volcengine", "video"],
          },
          {
            id: "community-storyboard",
            type: "skill",
            name: "Storyboard helper",
            description: "Plan a shot list.",
          },
        ]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const cards = container.querySelectorAll('[data-slot="marketplace-item"]');
    expect(cards[0]).toHaveAttribute("data-layout", "model-card");
    expect(cards[1]).toHaveAttribute("data-layout", "model-card");
    expect(cards[2]).toHaveAttribute("data-layout", "model-card");
    expect(cards[0]?.querySelector("img")).toHaveAttribute(
      "src",
      "/brand/avatar-plugins.png",
    );
    expect(cards[0]?.querySelector("img")).toHaveAttribute(
      "data-asset-role",
      "feature",
    );
    expect(cards[1]?.querySelector("img")).toHaveAttribute(
      "src",
      "/brand/providers/volcengine.svg",
    );
    expect(
      cards[0]?.querySelector('[data-slot="publisher-artwork"]')?.className,
    ).not.toMatch(/\b(?:rounded|border|bg-)/);
    expect(
      cards[0]?.querySelector('[data-slot="publisher-artwork"]'),
    ).toHaveAttribute("data-ui", "artwork-slot");
    expect(
      cards[1]?.querySelector('[data-slot="publisher-artwork"]')?.className,
    ).not.toMatch(/\b(?:rounded|border|bg-)/);
    expect(
      cards[1]?.querySelector('[data-slot="clash-signature-stroke"]'),
    ).toBeNull();
    expect(
      cards[2]?.querySelector('[data-slot="clash-artwork"][data-kind="skill"]'),
    ).toBeTruthy();
    expect(
      cards[2]?.querySelector('[data-slot="clash-artwork"]')?.className,
    ).not.toMatch(/\b(?:rounded|border|bg-)/);
    expect(
      cards[2]?.querySelector('[data-slot="clash-artwork"]'),
    ).toHaveAttribute("data-ui", "artwork-slot");
    expect(
      cards[2]?.querySelector('[data-slot="clash-signature-stroke"]'),
    ).toBeNull();
  });

  it("uses the OpenAI publisher mark for skills from the official OpenAI registry", () => {
    const { container } = render(
      <MarketplaceClient
        items={[
          {
            id: "clash.openai.define-goal",
            type: "skill",
            name: "Define goal",
            author: "OpenAI",
            description: "Turn a fuzzy intention into a measurable goal.",
            tags: ["planning"],
          },
        ]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    expect(
      container.querySelector('[data-slot="publisher-artwork"] img'),
    ).toHaveAttribute("src", "/brand/providers/openai.svg");
  });

  it("uses an optional plugin cover as editorial media instead of forcing it into a square logo", () => {
    const { container } = render(
      <MarketplaceClient
        items={[
          {
            id: "community-storyboard",
            type: "skill",
            name: "Storyboard helper",
            description: "Plan a shot list.",
            cover: {
              src: "https://cdn.example.com/storyboard-cover.webp",
              alt: "Storyboard frames on a canvas",
            },
          },
        ]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const cover = container.querySelector('[data-slot="marketplace-cover"]');
    expect(cover).toHaveAttribute(
      "src",
      "https://cdn.example.com/storyboard-cover.webp",
    );
    expect(cover).toHaveAttribute("alt", "Storyboard frames on a canvas");
    expect(cover).toHaveClass("aspect-[3/2]", "object-cover");
    expect(container.querySelector('[data-slot="clash-artwork"]')).toBeNull();
  });

  it("uses plugin-specific square artwork without treating it as an editorial cover", () => {
    const { container } = render(
      <MarketplaceClient
        items={[
          {
            id: "clash.storyboard",
            type: "plugin",
            name: "Storyboard",
            description: "Plan key elements and shots.",
            author: "Clash",
            artwork: {
              src: "/brand/avatar-storyboard.png",
              alt: "Clash Storyboard plugin",
            },
          },
        ]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const artwork = container.querySelector(
      '[data-slot="publisher-artwork"] img',
    );
    expect(artwork).toHaveAttribute("src", "/brand/avatar-storyboard.png");
    expect(artwork).toHaveAttribute("alt", "Clash Storyboard plugin mark");
    expect(container.querySelector('[data-slot="marketplace-cover"]')).toBeNull();
  });

  it("navigates each plugin card to its canonical detail route", () => {
    render(
      <Routes>
        <Route
          path="*"
          element={
            <>
              <MarketplaceClient
                items={[
                  {
                    id: "clash.openai.workflow",
                    type: "skill",
                    name: "Workflow skill",
                    description: "Turns a brief into an executable workflow.",
                  },
                ]}
                installedActionIds={[]}
                installedSkillIds={[]}
              />
              <MarketplaceLocationProbe />
            </>
          }
        />
      </Routes>,
    );

    fireEvent.click(
      screen.getByRole("link", { name: "View Workflow skill details" }),
    );
    expect(screen.getByLabelText("Current route")).toHaveTextContent(
      "/marketplace/skill/clash.openai.workflow",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders installed as status and keeps install as a compact real action", () => {
    render(
      <MarketplaceClient
        items={items}
        installedActionIds={["codex-imagegen"]}
        installedSkillIds={[]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Installed" })).toBeNull();
    const installed = screen
      .getByText("Installed")
      .closest('[data-slot="badge"]');
    expect(installed).toHaveAttribute("data-tone", "sage");
    expect(installed).toHaveAttribute("data-variant", "secondary");
    const install = screen.getByRole("button", { name: "Install" });
    expect(install).toHaveAttribute("data-size", "sm");
    expect(install.className).not.toMatch(/w-full|clash-marketplace-primary/);
  });

  it("moves a successful install into the non-interactive installed state", async () => {
    marketplaceApi.installSkill.mockResolvedValue({ installed: true });
    render(
      <MarketplaceClient
        items={[items[1]]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(await screen.findByText("Installed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Installed" })).toBeNull();
  });

  it("disables the compact action while installation is pending", async () => {
    let finish!: (value: unknown) => void;
    marketplaceApi.installSkill.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <MarketplaceClient
        items={[items[1]]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(
      await screen.findByRole("button", { name: "Installing…" }),
    ).toBeDisabled();
    finish({ installed: true });
    expect(await screen.findByText("Installed")).toBeTruthy();
  });

  it("offers a retry after an installation error", async () => {
    marketplaceApi.installSkill.mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <MarketplaceClient
        items={[items[1]]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Install failed");
    expect(status).toHaveAttribute("data-tone", "coral");
    expect(status).toHaveAttribute("data-variant", "secondary");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("adds an installed skill to Composer once without reinstalling it", async () => {
    const onAddReference = vi.fn();
    render(
      <MarketplaceClient
        items={[items[1]]}
        installedActionIds={[]}
        installedSkillIds={[items[1].id]}
        canAddReference
        onAddReference={onAddReference}
      />,
    );

    const add = screen.getByRole("button", { name: "Add to Composer" });
    fireEvent.click(add);
    fireEvent.click(add);

    await waitFor(() => expect(onAddReference).toHaveBeenCalledOnce());
    expect(marketplaceApi.installSkill).not.toHaveBeenCalled();
    expect(onAddReference).toHaveBeenCalledOnce();
    expect(onAddReference).toHaveBeenCalledWith({
      id: "sd25-pe",
      name: "Seedance guide",
    });
  });

  it("derives Added from Composer state so a removed skill can be added again", async () => {
    render(
      <DashboardComposerProvider>
        <MarketplaceClient
          items={[items[1]]}
          installedActionIds={[]}
          installedSkillIds={[items[1].id]}
        />
        <MarketplaceComposerProbe />
      </DashboardComposerProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to Composer" }));
    expect(await screen.findByText("Added to Composer")).toBeTruthy();
    expect(screen.getByLabelText("Composer skills")).toHaveTextContent(
      "Seedance guide",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Composer skill" }),
    );
    expect(
      await screen.findByRole("button", { name: "Add to Composer" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add to Composer" }));
    expect(await screen.findByText("Added to Composer")).toBeTruthy();
  });

  it("installs an unavailable skill before emitting its Composer reference", async () => {
    const order: string[] = [];
    marketplaceApi.installSkill.mockImplementation(async () => {
      order.push("install");
    });
    const onAddReference = vi.fn(() => {
      order.push("reference");
    });
    render(
      <MarketplaceClient
        items={[items[1]]}
        installedActionIds={[]}
        installedSkillIds={[]}
        canAddReference
        onAddReference={onAddReference}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to Composer" }));

    await waitFor(() => expect(onAddReference).toHaveBeenCalledOnce());
    expect(order).toEqual(["install", "reference"]);
    expect(screen.getByText("Installed")).toBeTruthy();
  });

  it("shows the Host install error and never emits a phantom skill reference", async () => {
    marketplaceApi.installSkill.mockRejectedValue(
      new Error("Host could not install this skill"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onAddReference = vi.fn();
    render(
      <MarketplaceClient
        items={[items[1]]}
        installedActionIds={[]}
        installedSkillIds={[]}
        canAddReference
        onAddReference={onAddReference}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to Composer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Host could not install this skill",
    );
    expect(onAddReference).not.toHaveBeenCalled();
    expect(screen.queryByText("Added to Composer")).toBeNull();
  });

  it("maps marketplace metadata to deterministic icon and tag tones", () => {
    const colorfulItems = [
      {
        id: "workflow-action",
        type: "action" as const,
        name: "Workflow action",
        tags: ["workflow"],
      },
      {
        id: "video-skill",
        type: "skill" as const,
        name: "Video skill",
        tags: ["video"],
      },
      {
        id: "voice-skill",
        type: "skill" as const,
        name: "Voice skill",
        outputType: "audio",
        tags: ["voice"],
      },
      {
        id: "asset-action",
        type: "action" as const,
        name: "Asset action",
        outputType: "image",
        tags: ["media"],
      },
    ];
    const { container } = render(
      <MarketplaceClient
        items={colorfulItems}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const cardFor = (name: string) =>
      screen
        .getByRole("heading", { name })
        .closest('[data-slot="marketplace-item"]') as HTMLElement;
    const toneFor = (name: string) =>
      cardFor(name)
        .querySelector(
          '[data-slot="clash-artwork"], [data-slot="publisher-artwork"]',
        )
        ?.getAttribute("data-tone");

    expect(toneFor("Workflow action")).toBe("lilac");
    expect(toneFor("Video skill")).toBe("blue");
    expect(toneFor("Voice skill")).toBe("amber");
    expect(toneFor("Asset action")).toBe("teal");

    const marketplaceCards = container.querySelectorAll(
      '[data-slot="marketplace-item"]',
    );
    expect(marketplaceCards).toHaveLength(4);
    for (const card of marketplaceCards) {
      expect(card).toHaveAttribute("data-layout", "model-card");
      expect(card.className).not.toContain("bg-warm-surface");
      const iconTone = card
        .querySelector(
          '[data-slot="clash-artwork"], [data-slot="publisher-artwork"]',
        )
        ?.getAttribute("data-tone");
      expect(iconTone).toBeTruthy();
      const tag = card.querySelector('[data-slot="badge"][data-tag]');
      expect(tag).not.toHaveAttribute("data-tone");
      expect(tag).toHaveAttribute("data-variant", "secondary");
    }
  });

  it("keeps plugin details clickable without nesting card actions", () => {
    const { container } = render(
      <MarketplaceClient
        items={[items[1]]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const card = container.querySelector('[data-slot="marketplace-item"]');
    const details = screen.getByRole("link", {
      name: "View Seedance guide details",
    });
    const install = screen.getByRole("button", { name: "Install" });
    expect(card).toBeTruthy();
    expect(details).toHaveAttribute("href", "/marketplace/skill/sd25-pe");
    expect(details.contains(install)).toBe(false);
  });
});
