import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readWebAsset } from "./web-asset-protocol";

const roots: string[] = [];

async function distRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clash-web-assets-"));
  roots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<html>shell</html>");
  await writeFile(join(root, "assets", "app-1234abcd.js"), "console.log('app')");
  return root;
}

function request(pathname: string, headers: Record<string, string> = {}): Request {
  return new Request(`clash://app${pathname}`, { headers });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop clash:// renderer protocol", () => {
  it("serves the SPA shell for a navigation with a no-cache policy", async () => {
    const dist = await distRoot();
    const response = await readWebAsset(dist, request("/", { accept: "text/html" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe("<html>shell</html>");
  });

  it("serves build assets directly with an immutable cache policy", async () => {
    const dist = await distRoot();
    const response = await readWebAsset(dist, request("/assets/app-1234abcd.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await response.text()).toBe("console.log('app')");
  });

  it("returns 404 for a missing hashed chunk instead of an HTML 200", async () => {
    const dist = await distRoot();
    const response = await readWebAsset(
      dist,
      request("/assets/missing-9999ffff.js", { "sec-fetch-mode": "no-cors" }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Not found");
  });

  it("keeps the SPA fallback for in-app navigations only", async () => {
    const dist = await distRoot();
    const navigation = await readWebAsset(
      dist,
      request("/projects/42", { accept: "text/html", "sec-fetch-mode": "navigate" }),
    );
    const assetLike = await readWebAsset(
      dist,
      request("/projects/42.js", { accept: "*/*" }),
    );

    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toBe("<html>shell</html>");
    expect(assetLike.status).toBe(404);
  });

  it("does not escape the renderer dist directory", async () => {
    const dist = await distRoot();
    const response = await readWebAsset(
      dist,
      request("/../outside.txt", { "sec-fetch-mode": "no-cors" }),
    );

    expect(response.status).toBe(404);
  });
});
