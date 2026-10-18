import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

import { authorizationUrl, createPkcePair } from "@clash/shared-runtime/provider-oauth-flow";
import { runLoopbackFlow } from "./auth-flow.js";
import { completeDeclaredFlow } from "./oauth-client.js";

const raw = JSON.parse(readFileSync(
  "/Users/minimax/Downloads/client_secret_13184380140-ltprrcgtocff3hgou7v33ev3sa1493sf.apps.googleusercontent.com.json",
  "utf8",
)) as { installed: { client_id: string; client_secret: string } };
const client = { clientId: raw.installed.client_id, clientSecret: raw.installed.client_secret };

const flow = {
  open: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  callback: { type: "loopback" as const },
  params: {
    scope: "https://www.googleapis.com/auth/cloud-platform",
    access_type: "offline",
    prompt: "consent",
  },
};

const pkce = await createPkcePair();
const loopback = runLoopbackFlow({
  open: (url) => { spawn("open", [url], { detached: true, stdio: "ignore" }).unref(); },
  timeoutMs: 180_000,
});
const started = await loopback.started;

const url = authorizationUrl({
  open: flow.open,
  clientId: client.clientId,
  redirectUri: started.redirectUri,
  state: started.state,
  challenge: pkce.challenge,
  params: flow.params,
});

console.log("回调端口:", started.port);
console.log("正在打开浏览器，请在浏览器里完成授权...\n");
spawn("open", [url], { detached: true, stdio: "ignore" }).unref();

const params = await loopback.result;
console.log("回调收到:", Object.keys(params).join(", "));
if (params.error) { console.log("Google 拒绝:", params.error); process.exit(1); }

const stored: Record<string, string> = {};
await completeDeclaredFlow({
  flow,
  client,
  code: params.code!,
  verifier: pkce.verifier,
  redirectUri: started.redirectUri,
  put: async (key, value) => { stored[key] = value; },
});

console.log("\n--- 写入插件 store 的内容 ---");
for (const [k, v] of Object.entries(stored)) {
  console.log(`  ${k} = ${k === "expiresAt" ? v : v.slice(0, 12) + "..." + ` (${v.length} 字符)`}`);
}
console.log("\nclient secret 是否进了 store:", Object.values(stored).includes(client.clientSecret));

// 用拿到的 token 真调一次 Google
const probe = await fetch(
  "https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=3",
  { headers: { Authorization: `Bearer ${stored.accessToken}` } },
);
const body = await probe.json() as { projects?: { projectId: string }[]; error?: { message: string } };
console.log("\n用 token 调 Google:", probe.status);
if (body.projects) console.log("可见项目:", body.projects.map((p) => p.projectId).join(", "));
else console.log("响应:", JSON.stringify(body).slice(0, 200));
