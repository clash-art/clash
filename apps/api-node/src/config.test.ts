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
it("accepts only an http(s) render-server origin and requires the media signing secret", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/clash",
    CLOUD_PUBLIC_URL: "https://cloud.example.com",
  };
  expect(readConfig(base).renderServerUrl).toBeUndefined();
  for (const RENDER_SERVER_URL of [
    "ftp://render.internal",
    "http://user:secret@render.internal",
    "http://render.internal/render",
    "http://render.internal/?token=1",
    "http://render.internal/#frag",
    "not a url",
  ])
    expect(() =>
      readConfig({ ...base, RENDER_SERVER_URL, BETTER_AUTH_SECRET: "s" }),
    ).toThrow("RENDER_SERVER_URL must be an HTTP origin");
  expect(() =>
    readConfig({ ...base, RENDER_SERVER_URL: "http://render.internal:8080" }),
  ).toThrow("BETTER_AUTH_SECRET");
  expect(
    readConfig({
      ...base,
      RENDER_SERVER_URL: "http://render.internal:8080/",
      BETTER_AUTH_SECRET: "s",
    }).renderServerUrl,
  ).toBe("http://render.internal:8080");
});
