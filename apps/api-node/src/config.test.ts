import { expect, it } from "vitest";
import { readConfig } from "./config.ts";
it("requires explicit cloud origin/database and rejects invalid listener ports", () => {
  expect(() => readConfig({})).toThrow();
  expect(() =>
    readConfig({
      DATABASE_URL: "postgres://localhost/clash",
      CLOUD_PUBLIC_URL: "https://cloud.example.com",
      PORT: "broken",
    }),
  ).toThrow();
  expect(() =>
    readConfig({
      DATABASE_URL: "postgres://localhost/clash",
      CLOUD_PUBLIC_URL: "https://user:secret@example.com",
    }),
  ).toThrow();
  expect(
    readConfig({
      DATABASE_URL: "postgres://localhost/clash",
      CLOUD_PUBLIC_URL: "https://cloud.example.com/",
      PORT: "8081",
    }),
  ).toMatchObject({ port: 8081, publicUrl: "https://cloud.example.com" });
});
