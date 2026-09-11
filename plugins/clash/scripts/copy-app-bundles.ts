import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");
const runtime = resolve(pluginRoot, "runtime");

await mkdir(runtime, { recursive: true });
for (const [source, target] of [
  ["packages/mcp-server/dist/project-app-client.js", "project-app-client.js"],
  ["packages/mcp-server/dist/studio-app-client.js", "studio-app-client.js"],
  ["packages/mcp-server/dist/canvas-app-client.js", "canvas-app-client.js"],
  ["plugins/clash-timeline/runtime/app-client.js", "timeline-app-client.js"],
  ["plugins/clash-director/runtime/app-client.js", "director-app-client.js"],
] as const) {
  await copyFile(resolve(repoRoot, source), resolve(runtime, target));
}
