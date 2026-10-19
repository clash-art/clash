import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCliLocalDaemon } from "./lib/local-daemon-bootstrap";
import { runCli } from "./program";

const cliEntryPath = fileURLToPath(import.meta.url);
const runtimeDir = dirname(cliEntryPath);

runCli({
  beforeAction: async (program) => {
    await ensureCliLocalDaemon({
      daemonEntryPath: join(runtimeDir, "local-api.cjs"),
      cliEntryPath,
      agentBundleRoot: join(runtimeDir, "agents"),
      builtinPluginRoot: dirname(runtimeDir),
      replaceForeignHost:
        program.opts<{ replaceHost?: boolean }>().replaceHost === true,
    });
  },
});
