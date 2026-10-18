import { mkdirSync } from "node:fs";

import { app, protocol } from "electron";
import { defaultLocalApiDataDir } from "@clash/shared-runtime/local-paths";

import { resolveDesktopStatePaths } from "../paths";
import { hydrateMacGuiPathAsync } from "../shell-path";

export interface DesktopHostConfiguration {
  dataDir: string;
  /** Resolves once the macOS GUI PATH has been hydrated (immediately elsewhere). */
  pathReady: Promise<void>;
}

export function configureDesktopHost(): DesktopHostConfiguration {
  const remoteDebuggingPort = process.env.CLASH_DESKTOP_REMOTE_DEBUGGING_PORT;
  if (remoteDebuggingPort) {
    app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
  }

  const pathReady = hydrateMacGuiPathAsync();
  const runtimeAppName = process.env.CLASH_APP_NAME?.trim();
  if (runtimeAppName) app.setName(runtimeAppName);

  protocol.registerSchemesAsPrivileged([
    {
      scheme: "clash",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);

  const dataDir = defaultLocalApiDataDir(process.env);
  const state = resolveDesktopStatePaths(dataDir);
  for (const directory of Object.values(state)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  app.setPath("userData", state.userData);
  app.setPath("sessionData", state.sessionData);
  app.setPath("logs", state.logs);
  app.setPath("crashDumps", state.crashDumps);

  return { dataDir, pathReady };
}
