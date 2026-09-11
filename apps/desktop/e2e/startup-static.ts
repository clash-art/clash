import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KNOWN_ACP_AGENTS } from "../../local-api/src/runtime/host/_acp-runtime/registry.js";
import { sourceContains } from "../../../packages/gui/test-support/source-match.js";
import { BUILTIN_ACP_WRAPPERS } from "../scripts/prepare-acp-harnesses.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const acpBinDirectory = path.join(desktopDirectory, "build", "acp-bin");
const acpNodeDirectory = path.join(desktopDirectory, "build", "acp-node");
const clashRuntimeDirectory = path.join(
  desktopDirectory,
  "build",
  "clash-runtime",
);

const failures: string[] = [];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

async function assertExecutable(file: string): Promise<void> {
  try {
    const info = await stat(file);
    assert(info.isFile(), `${file} is not a file`);
    await access(file, constants.X_OK);
  } catch (error) {
    failures.push(`${file} is not executable: ${errorMessage(error)}`);
  }
}

for (const wrapper of BUILTIN_ACP_WRAPPERS) {
  await assertExecutable(path.join(acpBinDirectory, wrapper));
}

const acpBinEntries = await readdir(acpBinDirectory).catch(() => []);
assert(
  !acpBinEntries.includes("claude-code-acp"),
  "legacy claude-code-acp wrapper is present",
);
const claudeWrapper = await readFile(
  path.join(acpBinDirectory, "claude-agent-acp"),
  "utf8",
).catch((error: unknown) => {
  failures.push(
    `cannot read claude-agent-acp wrapper: ${errorMessage(error)}`,
  );
  return "";
});
assert(
  !claudeWrapper.includes(
    "app.asar/node_modules/@agentclientprotocol/claude-agent-acp",
  ),
  "claude-agent-acp wrapper still points into app.asar node_modules",
);
await access(
  path.join(
    acpNodeDirectory,
    "codex-acp",
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
    "dist",
    "index.js",
  ),
  constants.R_OK,
).catch((error: unknown) => {
  failures.push(
    `packaged Codex agent bundle is missing dist/index.js: ${errorMessage(error)}`,
  );
});
await access(
  path.join(
    acpNodeDirectory,
    "claude-agent-acp",
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
    "dist",
    "index.js",
  ),
  constants.R_OK,
).catch((error: unknown) => {
  failures.push(
    `packaged Claude agent bundle is missing dist/index.js: ${errorMessage(error)}`,
  );
});
const runtimeManifest = JSON.parse(
  await readFile(path.join(clashRuntimeDirectory, "runtime-manifest.json"), "utf8"),
) as { artifacts?: Record<string, string> };
for (const [name, relativePath] of Object.entries(
  runtimeManifest.artifacts ?? {},
)) {
  const artifactPath = path.join(clashRuntimeDirectory, relativePath);
  await access(artifactPath, constants.R_OK).catch((error: unknown) => {
    failures.push(
      `packaged Clash runtime is missing ${name}: ${errorMessage(error)}`,
    );
  });
}
await assertExecutable(path.join(clashRuntimeDirectory, "dispatcher.js"));
await access(
  path.join(clashRuntimeDirectory, "node_modules", "loro-crdt"),
  constants.R_OK,
).catch((error: unknown) => {
  failures.push(
    `packaged Clash CLI is missing loro-crdt dependency: ${errorMessage(error)}`,
  );
});

assert(
  !KNOWN_ACP_AGENTS.some((agent) => agent.id === "claude-code-acp"),
  "registry still contains claude-code-acp",
);
assert(
  KNOWN_ACP_AGENTS.some(
    (agent) =>
      agent.id === "claude-acp" &&
      agent.spec.command === "claude-agent-acp",
  ),
  "registry does not contain the managed Claude ACP launch",
);
assert(
  KNOWN_ACP_AGENTS.some(
    (agent) =>
      agent.id === "gemini" &&
      agent.spec.command === "clash-acp-gemini" &&
      agent.spec.args?.includes("--acp"),
  ),
  "registry is missing Gemini managed ACP launch",
);
for (const retiredAgentId of ["hermes", "openclaw"]) {
  assert(
    !KNOWN_ACP_AGENTS.some((agent) => agent.id === retiredAgentId),
    `registry still contains retired ${retiredAgentId} harness`,
  );
}
const packagedLocalApi = await readFile(
  path.join(clashRuntimeDirectory, "local-api.cjs"),
  "utf8",
);
for (const retiredAgentId of ["hermes", "openclaw"]) {
  assert(
    !sourceContains(packagedLocalApi, `id: "${retiredAgentId}"`),
    `packaged local host still contains retired ${retiredAgentId} harness`,
  );
}

if (failures.length > 0) {
  console.error("[startup-static] failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "[startup-static] ok",
  JSON.stringify({
    acpBinDirectory,
    clashRuntimeDirectory,
    builtIn: BUILTIN_ACP_WRAPPERS,
  }),
);
