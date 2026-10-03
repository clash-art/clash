import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, dialog } from "electron";

import { startDesktopAppUpdater } from "./app-updater";
import { configureDesktopHost } from "./controller/host";
import { createDesktopRuntimeController } from "./controller/runtime";
import { createDesktopWindowController } from "./controller/windows";
import { ownDesktopInstance } from "./single-instance";
import { startDesktopWithRecovery } from "./startup-recovery";
import { createDesktopFileLogSink, createDesktopLogger } from "./stdio-logger";
import { createUpdateQuitGate } from "./update-quit";

const moduleDir = dirname(fileURLToPath(import.meta.url));
let recoverOwnedWindow = () => undefined;
const ownsDesktopInstance = ownDesktopInstance(app, () => recoverOwnedWindow());

if (ownsDesktopInstance) {
  const { dataDir } = configureDesktopHost();
  const hostDiagnosticLogPath = join(app.getPath("logs"), "host-startup.log");
  const fileSink = createDesktopFileLogSink({
    directory: app.getPath("logs"),
    maxBytes: 5 * 1024 * 1024,
    maxFiles: 5,
  });
  const desktopLog = createDesktopLogger(process.stdout, process.stderr, {
    fileSink,
  });
  const updateQuitGate = createUpdateQuitGate();
  app.on("will-quit", () => desktopLog.close());
  const runtimeController = createDesktopRuntimeController({
    moduleDir,
    hostDiagnosticLogPath,
    log: desktopLog,
  });
  const windowController = createDesktopWindowController({
    moduleDir,
    dataDir,
    currentRuntime: runtimeController.current,
    refreshRuntime: () => runtimeController.initialize(dataDir),
    log: desktopLog,
  });
  recoverOwnedWindow = () => {
    void app
      .whenReady()
      .then(() => windowController.recoverWindow())
      .catch((error) =>
        desktopLog.error("[desktop] failed to recover window", error),
      );
  };

  void app
    .whenReady()
    .then(async () => {
      windowController.registerHostBindings();
      const outcome = await startDesktopWithRecovery({
        start: async () => {
          await runtimeController.initialize(dataDir);
          await windowController.createWindow();
        },
        decide: async (error) => {
          const detail = error instanceof Error ? error.message : String(error);
          desktopLog.error("[desktop] startup attempt failed", error);
          const { response } = await dialog.showMessageBox({
            type: "error",
            title: "Clash could not start",
            message: "Clash could not finish starting its local Host.",
            detail: `${detail}\n\nDiagnostics: ${hostDiagnosticLogPath}`,
            buttons: ["Retry", "Quit"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          });
          return response === 0 ? "retry" : "quit";
        },
        quit: () => app.quit(),
      });
      if (outcome === "started") {
        app.on("activate", windowController.activate);
        void startDesktopAppUpdater({ log: desktopLog, quitGate: updateQuitGate });
      }
    })
    .catch((error) => {
      desktopLog.error("[desktop] unrecoverable startup failure", error);
      dialog.showErrorBox(
        "Clash could not start",
        `${error instanceof Error ? error.message : String(error)}\n\nDiagnostics: ${hostDiagnosticLogPath}`,
      );
      app.quit();
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
