import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { sourceContains } from "../test-support/source-match";

it("mounts live presence beside the project title in the shared editor header", () => {
  const source = readFileSync(resolve(__dirname, "ProjectEditor.tsx"), "utf8");
  const start = source.indexOf('id="editor-header"');
  const header = source.slice(start, source.indexOf("footer={", start));
  expect(
    sourceContains(header, "<PresenceBar clients={presenceClients} />"),
  ).toBe(true);
  expect(
    sourceContains(
      source,
      "setPresenceClients(visiblePresenceClients(clients, selfClientId))",
    ),
  ).toBe(true);
});
