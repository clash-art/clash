import { describe, expect, it, vi } from "vitest";

import {
  createPikaMediaJob,
  getPikaMediaJob,
  getPikaMediaContent,
  uploadPikaMedia,
} from "./pika-media.js";

describe("Pika media API", () => {
  it("submits with the API key and a stable idempotency key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      id: "media-1",
      status: "queued",
    }));

    const job = await createPikaMediaJob({
      apiKey: "pk_live_test",
      operation: "pika/pika-2.5/text-to-video",
      input: { prompt: "paper birds taking flight", resolution: "720p", duration_s: 5 },
      idempotencyKey: "clash-task-1",
      fetch,
    });

    expect(job).toMatchObject({ id: "media-1", status: "queued" });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.dev.pika.art/v1/media/pika/pika-2.5/text-to-video",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "clash-task-1",
          "x-api-key": "pk_live_test",
        },
        body: JSON.stringify({ prompt: "paper birds taking flight", resolution: "720p", duration_s: 5 }),
      }),
    );
  });

  it("exposes individual status checks and content retrieval", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: "media-2", status: "running" }))
      .mockResolvedValueOnce(Response.json({
        id: "media-2",
        status: "completed",
        output: { media_type: "video", video: { url: "https://pika.test/output.mp4" } },
      }))
      .mockResolvedValueOnce(Response.json({ url: "https://pika.test/output.mp4" }));

    expect((await getPikaMediaJob({ apiKey: "pk_live_test", jobId: "media-2", fetch })).status).toBe("running");
    const job = await getPikaMediaJob({
      apiKey: "pk_live_test",
      jobId: "media-2",
      fetch,
    });
    const content = await getPikaMediaContent({
      apiKey: "pk_live_test",
      jobId: job.id,
      fetch,
    });

    expect(job.status).toBe("completed");
    expect(content).toEqual({ url: "https://pika.test/output.mp4" });
    expect(fetch).toHaveBeenNthCalledWith(1,
      "https://api.dev.pika.art/v1/media/jobs/media-2",
      { headers: { "x-api-key": "pk_live_test" } },
    );
    expect(fetch).toHaveBeenNthCalledWith(3,
      "https://api.dev.pika.art/v1/media/jobs/media-2/content",
      { headers: { "x-api-key": "pk_live_test" } },
    );
  });

  it("checks one job state without owning the poll schedule", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        id: "media-one-check",
        status: "running",
      }),
    );

    await expect(
      getPikaMediaJob({
        apiKey: "pk_live_test",
        jobId: "media-one-check",
        fetch,
      }),
    ).resolves.toEqual({ id: "media-one-check", status: "running" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("surfaces failed jobs without retrying the paid submission", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      id: "media-3",
      status: "failed",
      error: { code: "insufficient_balance", message: "Insufficient org balance" },
    }));

    await expect(getPikaMediaJob({
      apiKey: "pk_live_test",
      jobId: "media-3",
      fetch,
    })).rejects.toThrow("Pika media job failed (insufficient_balance): Insufficient org balance");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uploads reference bytes with the exact signed headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({
        upload_url: "https://storage.pika.test/upload",
        headers: { "Content-Type": "image/png", "Content-Length": "4", "x-signed": "yes" },
        url: "https://cdn.pika.test/reference.png",
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const url = await uploadPikaMedia({
      apiKey: "pk_live_test",
      bytes,
      contentType: "image/png",
      fetch,
    });

    expect(url).toBe("https://cdn.pika.test/reference.png");
    expect(fetch).toHaveBeenNthCalledWith(1,
      "https://api.dev.pika.art/v1/media/uploads",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "pk_live_test" },
        body: JSON.stringify({ content_type: "image/png", size_bytes: 4 }),
      },
    );
    expect(fetch).toHaveBeenNthCalledWith(2,
      "https://storage.pika.test/upload",
      { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": "4", "x-signed": "yes" }, body: bytes },
    );
  });
});
