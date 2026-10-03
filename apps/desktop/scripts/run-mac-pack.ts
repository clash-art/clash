import { spawn } from "node:child_process";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildNumberFromEnv,
  channelFromEnv,
  packagedAppVersion,
  writeUpdateMetadata,
} from "./write-update-metadata.ts";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(desktopRoot, "package.json");

function signingPlan(env: NodeJS.ProcessEnv): {
  mode: "developer-id" | "ad-hoc";
  missing: string[];
} {
  const link = env.MAC_CSC_LINK?.trim() || env.CSC_LINK?.trim();
  const password =
    env.MAC_CSC_KEY_PASSWORD?.trim() || env.CSC_KEY_PASSWORD?.trim();
  const missing: string[] = [];
  if (!link) missing.push("MAC_CSC_LINK");
  if (!password) missing.push("MAC_CSC_KEY_PASSWORD");
  if (!env.APPLE_API_KEY_BASE64?.trim()) missing.push("APPLE_API_KEY_BASE64");
  if (!env.APPLE_API_KEY_ID?.trim()) missing.push("APPLE_API_KEY_ID");
  if (!env.APPLE_API_ISSUER?.trim()) missing.push("APPLE_API_ISSUER");
  if (missing.length === 0) {
    return { mode: "developer-id", missing: [] };
  }
  return { mode: "ad-hoc", missing };
}

function builderEnv(
  base: NodeJS.ProcessEnv,
  plan: ReturnType<typeof signingPlan>,
  apiKeyPath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.APPLE_API_KEY_BASE64;
  if (plan.mode === "developer-id") {
    env.CSC_LINK = (base.MAC_CSC_LINK ?? base.CSC_LINK ?? "").trim();
    env.MAC_CSC_LINK = env.CSC_LINK;
    env.CSC_KEY_PASSWORD = (
      base.MAC_CSC_KEY_PASSWORD ??
      base.CSC_KEY_PASSWORD ??
      ""
    ).trim();
    env.MAC_CSC_KEY_PASSWORD = env.CSC_KEY_PASSWORD;
    env.APPLE_API_KEY = apiKeyPath;
    env.APPLE_API_KEY_ID = (base.APPLE_API_KEY_ID ?? "").trim();
    env.APPLE_API_ISSUER = (base.APPLE_API_ISSUER ?? "").trim();
    env.APPLE_TEAM_ID = (base.APPLE_TEAM_ID ?? "962863MJ5J").trim();
    env.CLASH_DESKTOP_MAC_SIGN_MODE = "developer-id";
    env.CLASH_MAC_SIGNING = "developer-id";
    env.CSC_IDENTITY_AUTO_DISCOVERY = "true";
    if (base.GITHUB_EVENT_NAME === "pull_request") {
      env.CSC_FOR_PULL_REQUEST = "true";
    }
    return env;
  }
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  env.CSC_FOR_PULL_REQUEST = "true";
  env.CLASH_DESKTOP_MAC_SIGN_MODE = "ad-hoc";
  env.CLASH_MAC_SIGNING = "ad-hoc";
  env.CLASH_ELECTRON_BUILDER_EXTRA_ARGS =
    '--config.mac.identity=- --config.mac.notarize=false';
  for (const name of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "MAC_CSC_LINK",
    "MAC_CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ]) {
    delete env[name];
  }
  return env;
}

async function apiKeyPath(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.APPLE_API_KEY?.trim() && !env.APPLE_API_KEY_BASE64?.trim()) {
    return env.APPLE_API_KEY.trim();
  }
  const dir = await mkdtemp(resolve(tmpdir(), "clash-notarize-"));
  const path = resolve(dir, "AuthKey.p8");
  await writeFile(
    path,
    Buffer.from((env.APPLE_API_KEY_BASE64 ?? "").trim(), "base64"),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

function runBuilder(env: NodeJS.ProcessEnv, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "electron-builder", "--publish", "never", ...args],
      {
        cwd: desktopRoot,
        env,
        stdio: "inherit",
        shell: true,
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`electron-builder exited ${String(code)}`));
    });
  });
}

async function main(): Promise<void> {
  const original = await readFile(packageJsonPath, "utf8");
  const plan = signingPlan(process.env);
  const channel = channelFromEnv(process.env);
  const build = buildNumberFromEnv(process.env);
  const missing =
    plan.missing.length === 0 ? "" : ` (missing ${plan.missing.join(", ")})`;
  console.log(`mac signing: ${plan.mode}${missing}`);
  if (process.env.GITHUB_ENV) {
    await appendFile(
      process.env.GITHUB_ENV,
      `CLASH_DESKTOP_MAC_SIGN_MODE=${plan.mode}\n`,
    );
  }

  let keyPath = "";
  try {
    const pkg = JSON.parse(original) as { version: string };
    const baseVersion = pkg.version.replace(/-preview\.\d+$/, "");
    const packaged = packagedAppVersion(baseVersion, channel, build);
    const edited = { ...pkg, version: packaged };
    await writeFile(packageJsonPath, `${JSON.stringify(edited, null, 2)}\n`);
    const env = builderEnv(
      process.env,
      plan,
      plan.mode === "developer-id" ? await apiKeyPath(process.env) : "",
    );
    keyPath = env.APPLE_API_KEY ?? "";
    env.CLASH_UPDATE_CHANNEL = channel;
    await writeUpdateMetadata({
      packageJsonPath,
      outputPath: resolve(desktopRoot, "build/update-metadata.json"),
      env,
      cwd: desktopRoot,
    });
    const publishChannel =
      channel === "preview" ? "preview" : channel === "stable" ? "latest" : "latest";
    const extra = process.argv.slice(2);
    const extraArgs = (env.CLASH_ELECTRON_BUILDER_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);
    await runBuilder(env, [
      ...extraArgs,
      `--config.publish.channel=${publishChannel}`,
      ...extra,
    ]);
  } finally {
    await writeFile(packageJsonPath, original);
    if (keyPath.startsWith(tmpdir())) {
      await rm(dirname(keyPath), { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
