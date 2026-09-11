// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MarketplacePluginDeclarations } from "./MarketplaceItemCard";

afterEach(cleanup);

it("shows official curation separately from clickable upstream authorship and license", () => {
  const attribution = {
    sourceUrl:
      "https://github.com/example/skills/blob/reviewed/example/SKILL.md",
    license: "MIT",
    licenseUrl: "https://github.com/example/skills/blob/reviewed/LICENSE",
    repositoryStars: 1234,
    checkedAt: "2026-09-10",
  };
  render(
    <MarketplacePluginDeclarations
      item={{
        id: "clash.community.example",
        name: "Example",
        type: "skill",
        source: "community",
        author: "Original author",
        sourceVersion: "reviewed",
        curation: { collection: "official-picks", curator: "Clash" },
        attribution,
      }}
    />,
  );
  expect(screen.getByText("Original author")).toBeTruthy();
  expect(screen.getByText("community")).toBeTruthy();
  expect(screen.getByText("Clash Official Picks")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Original skill" }).getAttribute("href"),
  ).toBe(attribution.sourceUrl);
  expect(
    screen
      .getByRole("link", { name: attribution.license })
      .getAttribute("href"),
  ).toBe(attribution.licenseUrl);
  expect(screen.getByText(/repository stars/i)).toBeTruthy();
  expect(screen.getByText(new RegExp(attribution.checkedAt))).toBeTruthy();
});
