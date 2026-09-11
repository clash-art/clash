import { describe, it, expect, vi } from "vitest";
import { listAcpRegistryCatalog } from "./acp-registry-installer.js";

describe("ACP registry download recovery", () => {
  it("recovers from a transient connection failure", async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(new Response(JSON.stringify({ agents: [] })));
    expect(await listAcpRegistryCatalog({ fetchImpl: request })).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("reports the failed service after bounded retries", async () => {
    const request = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(listAcpRegistryCatalog({ fetchImpl: request })).rejects.toThrow("无法连接更新服务 cdn.agentclientprotocol.com");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("does not retry a permanent HTTP error", async () => {
    const request = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    await expect(listAcpRegistryCatalog({ fetchImpl: request })).rejects.toThrow("HTTP 403");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
