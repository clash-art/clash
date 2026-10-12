import { createServer } from "node:http";
import { shutdownNodeTelemetry } from "../../src/node.ts";
import { createServerLogger } from "../../src/log.ts";

const log = createServerLogger({ component: "fixture" });
const server = createServer((_request, response) => {
  log.info("fixture.request");
  response.end("ok");
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await fetch(`http://127.0.0.1:${address.port}/probe`);
  server.close();
  await shutdownNodeTelemetry();
});
