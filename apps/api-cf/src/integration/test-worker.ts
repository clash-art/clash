/**
 * Lean Worker entrypoint for integration tests.
 *
 * The full src/index.ts pulls in every API route and hosted service. Integration
 * tests mount only the boundaries under exercise, while exporting the real
 * ProjectRoom so Miniflare covers its WebSockets, storage, alarms, and Loro WASM.
 *
 * Re-exports unrelated durable object / workflow stubs so the other bindings
 * declared in wrangler.toml still resolve.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Env } from "../config";
export { ProjectRoom } from "../agents/project-room";

// Minimal Hono integration harness. Tests may mount a narrow route above when
// one is needed without importing the complete production router tree.
const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;

// ─── Stub bindings declared in wrangler.toml ────────────────
// The harness does not instantiate these unrelated services.
class StubDO {
  constructor(_state: unknown, _env: unknown) {}
  async fetch(_req: Request): Promise<Response> {
    return new Response("stub", { status: 501 });
  }
}
export const SupervisorAgent = StubDO;
export const RenderContainer = StubDO;
export { GenerationWorkflow } from "../agents/generation";
