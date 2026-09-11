import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiFetch } from "./api";

test("loopback local-api requests work without a cloud Authorization header", async () => {
  const originalHome = process.env.CLASH_HOME;
  const originalKey = process.env.CLASH_API_KEY;
  const originalUrl = process.env.CLASH_API_URL;
  const originalFetch = globalThis.fetch;
  process.env.CLASH_HOME = await mkdtemp(join(tmpdir(), "clash-api-local-"));
  process.env.CLASH_API_URL = "http://127.0.0.1:49321";
  delete process.env.CLASH_API_KEY;
  let request: Request | undefined;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    request = new Request(input, init);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await apiFetch("/api/v1/projects");
    assert.equal(response.status, 200);
    assert.equal(request?.headers.get("authorization"), null);
    for (const headers of [
      new Headers({
        "x-clash-if-match": "observation",
        "x-clash-client-type": "agent",
      }),
      [
        ["x-clash-if-match", "observation"],
        ["x-clash-client-type", "agent"],
      ],
      { "x-clash-if-match": "observation", "x-clash-client-type": "agent" },
    ] as HeadersInit[]) {
      await apiFetch("/api/v1/projects", { headers });
      assert.equal(request?.headers.get("x-clash-if-match"), "observation");
      assert.equal(request?.headers.get("x-clash-client-type"), "agent");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalHome;
    if (originalKey === undefined) delete process.env.CLASH_API_KEY;
    else process.env.CLASH_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.CLASH_API_URL;
    else process.env.CLASH_API_URL = originalUrl;
  }
});
