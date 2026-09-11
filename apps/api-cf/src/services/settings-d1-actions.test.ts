import { expect, it, vi } from "vitest";
import { installAction } from "./settings-d1";

it("rejects legacy Worker manifest installation without touching D1", async () => {
  const prepare = vi.fn(() => {
    throw new Error("D1 write must not occur");
  });
  const result = await installAction(
    { DB: { prepare }, ENVIRONMENT: "test" } as never,
    "user",
    {
      id: "legacy-worker",
      name: "Legacy",
      runtime: "worker",
      outputType: "image",
      workerUrl: "https://example.invalid/worker",
      parameters: [],
    },
  ).catch((error) => error);
  expect(result).toBeInstanceOf(Response);
  expect(result.status).toBe(410);
  expect(await result.json()).toMatchObject({
    code: "LEGACY_ACTION_INSTALL_RETIRED",
  });
  expect(prepare).not.toHaveBeenCalled();
});
