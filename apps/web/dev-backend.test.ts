import { expect, it } from "vitest";
import { nodeBackendProxy } from "./dev-backend";
it("routes the shared Web API to an explicitly configured Node backend", () => {
  expect(nodeBackendProxy(undefined)).toBeUndefined();
  const proxy = nodeBackendProxy("http://127.0.0.1:64701")!;
  expect(proxy["/api"].target).toBe("http://127.0.0.1:64701");
  expect(proxy["/api"].changeOrigin).toBe(false);
  expect(() => nodeBackendProxy("https://user:secret@example.com")).toThrow();
});

it("keeps the Assets page in the SPA while proxying asset delivery", () => {
  const proxy = nodeBackendProxy("http://127.0.0.1:64701")!;
  const matches = (url: string) =>
    Object.keys(proxy).some((key) =>
      key.startsWith("^") ? new RegExp(key).test(url) : url.startsWith(key),
    );
  expect(matches("/assets")).toBe(false);
  expect(matches("/assets?view=trash")).toBe(false);
  expect(matches("/assets/delivery-capability")).toBe(true);
});
