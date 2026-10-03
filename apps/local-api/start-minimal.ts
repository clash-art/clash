import { startLocalApiServer } from "./src/server.js";

await startLocalApiServer({
  port: Number(process.env.PORT ?? 49321),
  dataDir: process.env.CLASH_DATA_DIR ?? "/tmp/clash-dev-data",
});
