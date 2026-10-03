import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  app,
  autoUpdater as nativeAutoUpdater,
  dialog,
} from "electron";
import { autoUpdater } from "electron-updater";

import {
  UPDATE_CHECK_INTERVAL_MS,
  appBundlePathFromExecutable,
  buildFromVersion,
  canInstallUpdate,
  feedForChannel,
  parseUpdateIdentity,
  shouldAutoAcceptUpdate,
  updateErrorCode,
  updateStartupDelayMs,
  type AppUpdateState,
  type AvailableUpdate,
  type UpdateIdentity,
} from "./app-update.js";
import type { DesktopControllerLogger } from "./controller/types.js";
import { recordUpdateEvidence } from "./update-evidence.js";
import type { createUpdateQuitGate } from "./update-quit.js";

export async function startDesktopAppUpdater({
  log,
  quitGate,
}: {
  log: DesktopControllerLogger;
  quitGate: ReturnType<typeof createUpdateQuitGate>;
}): Promise<() => void> {
  const version = app.getVersion();
  const identity = await readIdentity(version);
  const install = canInstallUpdate({
    platform: process.platform,
    packaged: app.isPackaged,
    signed: identity.signed,
    appBundlePath: appBundlePathFromExecutable(
      app.getPath("exe"),
      process.platform,
    ),
  });
  let state = initialState(version, identity, install);
  let prompted: string | null = null;
  let checking = false;

  const publish = (patch: Partial<AppUpdateState>): AppUpdateState => {
    state = { ...state, ...patch };
    log.info(
      `[desktop:update] status=${state.status} version=${state.version} available=${state.available?.version ?? ""} block=${state.installBlock}`,
    );
    recordUpdateEvidence("update-state", {
      status: state.status,
      installBlock: state.installBlock,
      canInstall: state.canInstall,
      version: state.version,
      available: state.available?.version ?? "",
      errorCode: state.errorCode ?? "",
    });
    return state;
  };

  const feed = feedForChannel(identity.channel, process.env);
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  if (process.env.CLASH_UPDATE_E2E === "1") {
    autoUpdater.logger = {
      info: (message?: unknown) => log.info(`[desktop:updater] ${String(message)}`),
      warn: (message?: unknown) => log.warn(`[desktop:updater] ${String(message)}`),
      error: (message?: unknown) =>
        log.error(`[desktop:updater] ${String(message)}`),
      debug: (message?: string) => log.info(`[desktop:updater] ${message ?? ""}`),
    };
  }
  if (feed) {
    autoUpdater.setFeedURL({ provider: "generic", url: feed.url });
    autoUpdater.channel = feed.channel;
    autoUpdater.allowPrerelease = feed.allowPrerelease;
  }

  autoUpdater.on("checking-for-update", () => {
    publish({ status: "checking", errorCode: null });
  });
  autoUpdater.on("update-available", (info) => {
    const available = availableFrom(info.version);
    publish({
      status: install.ok ? "downloading" : "available",
      available,
      errorCode: null,
      checkedAt: new Date().toISOString(),
    });
    if (install.ok) void autoUpdater.downloadUpdate();
  });
  autoUpdater.on("update-not-available", () => {
    publish({
      status: "upToDate",
      available: null,
      errorCode: null,
      checkedAt: new Date().toISOString(),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    const available = availableFrom(info.version);
    publish({ status: "ready", available, errorCode: null });
    if (!install.ok) return;
    const key = available.version;
    if (prompted === key) return;
    prompted = key;
    void promptAndInstall();
  });
  autoUpdater.on("error", (error) => {
    checking = false;
    publish({
      status: "error",
      errorCode: updateErrorCode(error),
      checkedAt: new Date().toISOString(),
    });
  });

  nativeAutoUpdater.on("before-quit-for-update", () => {
    quitGate.approveQuitForUpdate();
  });

  async function check(): Promise<AppUpdateState> {
    if (!feed || identity.channel === "dev") return state;
    if (checking) return state;
    checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      publish({ status: "error", errorCode: updateErrorCode(error) });
    } finally {
      checking = false;
    }
    return state;
  }

  async function promptAndInstall(): Promise<AppUpdateState> {
    if (!install.ok || state.status !== "ready") return state;
    if (!(await confirmUpdate(state))) return state;
    publish({ status: "installing", errorCode: null });
    recordUpdateEvidence("quit-and-install", {
      version: state.available?.version ?? "",
    });
    quitGate.approveQuitForUpdate();
    autoUpdater.quitAndInstall();
    return state;
  }

  const timers: NodeJS.Timeout[] = [];
  const automatic =
    Boolean(feed) && app.isPackaged && process.env.CLASH_DISABLE_UPDATE !== "1";
  if (automatic) {
    const startup = setTimeout(() => void check(), updateStartupDelayMs(process.env));
    startup.unref();
    const interval = setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS);
    interval.unref();
    timers.push(startup, interval);
  }

  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}

async function readIdentity(version: string): Promise<UpdateIdentity> {
  try {
    const text = await readFile(metadataPath(), "utf8");
    return parseUpdateIdentity(JSON.parse(text) as unknown, version);
  } catch {
    return parseUpdateIdentity(undefined, version);
  }
}

function metadataPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "update-metadata.json");
  }
  return join(app.getAppPath(), "build", "update-metadata.json");
}

function initialState(
  version: string,
  identity: UpdateIdentity,
  install: ReturnType<typeof canInstallUpdate>,
): AppUpdateState {
  return {
    version,
    channel: identity.channel,
    build: identity.build || buildFromVersion(version),
    commit: identity.commit,
    signed: identity.signed,
    status: "idle",
    canInstall: install.ok,
    installBlock: install.ok ? "none" : install.reason,
    available: null,
    errorCode: null,
    checkedAt: null,
  };
}

function availableFrom(version: string): AvailableUpdate {
  return { version, build: buildFromVersion(version), commit: "" };
}

async function confirmUpdate(state: AppUpdateState): Promise<boolean> {
  const version = state.available?.version ?? state.version;
  if (shouldAutoAcceptUpdate(process.env)) {
    recordUpdateEvidence("update-accepted", { version, mode: "test-hook" });
    return true;
  }
  const result = await dialog.showMessageBox({
    type: "info",
    title: "Restart and update",
    message: `Update to ${version}?`,
    detail:
      "Clash will quit and replace Clash.app in /Applications. The local Host will stop during the update.",
    buttons: ["Later", "Restart and update"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (result.response === 1) {
    recordUpdateEvidence("update-accepted", { version, mode: "dialog" });
    return true;
  }
  return false;
}
