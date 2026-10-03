#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const outDir =
  process.env.CLASH_INTERACTIVE_STATE_CAPTURE_DIR ??
  "/cursor/stores/bc-8af30c89-1c8d-5944-9e50-08179bf783ab/media/interactive-state-styling";
mkdirSync(outDir, { recursive: true });

const fixtureUrl = `file://${join(process.cwd(), "apps/web/interactive-state-tab-fixture.html")}`;

async function shot(page, name, selector = "#capture-root") {
  const path = join(outDir, name);
  await page.locator(selector).screenshot({ path });
  console.log(path);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
await page.goto(fixtureUrl);

await shot(page, "tabs-01-selected.png");
await page.locator("#prev-tab").click();
await page.mouse.move(0, 0);
await shot(page, "tabs-02-previous-after-switch.png");
await page.locator("#hover-tab").hover();
await shot(page, "tabs-03-hover-inactive.png");
await page.locator("#focus-tab").focus();
await page.keyboard.press("Tab");
await shot(page, "tabs-04-keyboard-focus.png");

await browser.close();
