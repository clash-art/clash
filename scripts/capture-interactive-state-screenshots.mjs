#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultOut =
  "/cursor/stores/bc-8af30c89-1c8d-5944-9e50-08179bf783ab/media/interactive-state-styling";

const outDir = process.env.CLASH_INTERACTIVE_STATE_CAPTURE_DIR ?? defaultOut;
mkdirSync(outDir, { recursive: true });

const fixtureUrl = `file://${join(repoRoot, "apps/web/interactive-state-fixture.html")}`;

async function capture(page, name, action) {
  if (action) {
    await action(page);
  }
  const path = join(outDir, `${name}.png`);
  await page.locator("#capture-root").screenshot({ path });
  console.log(path);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
await page.goto(fixtureUrl);

await capture(page, "01-rest");
await capture(page, "02-hover", async (p) => {
  await p.locator("#rest-button").hover();
});
await capture(page, "03-click-mouse-away", async (p) => {
  await p.locator("#rest-button").click({ force: true });
  await p.mouse.move(0, 0);
});
await capture(page, "04-keyboard-focus", async (p) => {
  await p.keyboard.press("Tab");
});
await capture(page, "05-expanded-open", async (p) => {
  await p.locator("#open-trigger").click({ force: true });
});

await browser.close();
