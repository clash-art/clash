import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { test, expect } from "vitest";

test("daemon serves the project SPA and assets without a frontend server or ACP config", async () => {
  const module = await import("./project-renderer").catch(() => ({}));
  expect(module).toHaveProperty("registerProjectRenderer");
  const { registerProjectRenderer } =
    module as typeof import("./project-renderer");
  const root = await mkdtemp(join(tmpdir(), "clash-project-renderer-"));
  try {
    await mkdir(join(root, "_app"));
    await writeFile(
      join(root, "index.html"),
      '<html><head></head><body><div id="root"></div><script src="/_app/main.js"></script></body></html>',
    );
    await writeFile(join(root, "_app/main.js"), "/* rendered app */");
    await mkdir(join(root, "brand/providers"), { recursive: true });
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>';
    await writeFile(join(root, "brand/providers/provider.svg"), icon);
    const app = new Hono();
    registerProjectRenderer(app, root);
    const iconResponse = await app.request("/brand/providers/provider.svg");
    expect(iconResponse.status).toBe(200);
    expect(iconResponse.headers.get("content-type")).toContain("image/svg+xml");
    expect(await iconResponse.text()).toBe(icon);
    const response = await app.request("/projects/test-project");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('"mode":"local"');
    expect(html).toContain("__CLASH_MCP_APP__");
    expect(html.indexOf("__CLASH_RUNTIME_CONFIG__")).toBeLessThan(
      html.indexOf("/_app/main.js"),
    );
    expect(await (await app.request("/_app/main.js")).text()).toBe(
      "/* rendered app */",
    );
    expect((await app.request("/api/v1/missing")).status).toBe(404);
    expect(
      (await app.request("/projects/test-project", { method: "POST" })).status,
    ).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
