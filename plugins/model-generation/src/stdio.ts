import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assemblePluginModule } from "@clash/action-sdk/browser";
import { servePluginStdio } from "@clash/action-sdk";

// Definitions delegate model execution to the Host; there is no wrapper Action.
export const plugin = assemblePluginModule({
  pluginId: "clash.model-generation",
  functions: [],
  contributes: {},
});

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void servePluginStdio(plugin).done;
}
