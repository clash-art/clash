# Spike: Codex / Pi / dsh-acp gateway runtime adapters (#358)

**Date:** 2026-10-27 (America/Detroit)  
**Parent:** Epic A #343 · depends on #357  
**REPORT:** §8 / phase 15 (`.gateway/REPORT.md` via `/workspace/perf/gateway/runs/REPORT.md`)

## Goal

Point non-Claude ACP harnesses at the Clash official gateway (`sk_gw_` +
`baseUrl`) when the harness has **no** ACP `_meta.gateway` auth method.
Claude keeps the #357 ACP handoff path unchanged.

## Verified injection surfaces (installed packages on the shared box)

| Runtime | Package / binary | ACP gateway method? | Chosen adapter | Evidence |
| --- | --- | --- | --- | --- |
| **Codex** | `codex-acp` / Codex CLI | Not observed on this box; #357 ACP path is opportunistic | **config** under Clash-owned `CODEX_HOME` + `OPENAI_API_KEY` env | Daemon smoke writes `config.toml` with `model_providers.*.base_url` + `env_key` (`apps/local-api/e2e/daemon-smoke.ts`). Codex reads the secret from the env named by `env_key`, so the Host never writes the token into the file. |
| **Pi** | `@openma/pi-acp` 0.1.8-beta.0 | **Yes** when the client advertises `auth._meta.gateway` (`GATEWAY_METHOD_ID = "gateway"`) | Prefer **ACP gateway** (#357). Fallback: **config** — Clash-owned `PI_CODING_AGENT_DIR/models.json` provider entry (same shape `gatewayAuthenticate` writes) | `pi-acp` `chunk-5IXHVFXW.js` `gatewayAuthenticate` / `writeModelsJsonProvider`. |
| **dsh-acp** | `@openma` DeepSeek harness ACP 0.4.38-beta.1 | No `_meta.gateway` method in the installed bridge | **env** — `DEEPSEEK_API_KEY` + `DEEPSEEK_BASE_URL` | `credentialEnvNames()` returns those two for the DeepSeek route; default `DSH_ACP_MODELS` includes a non-Flash DeepSeek tier and must be overridden to Flash only. |

## Clash-owned paths (no collision with user configs)

| Runtime | Adapter path | User path left alone |
| --- | --- | --- |
| Codex | `{dataDir}/official-gateway/codex-home/config.toml` + spawn `CODEX_HOME` | `~/.codex` / user `CODEX_HOME` |
| Pi (fallback) | `{dataDir}/official-gateway/pi-agent/models.json` + spawn `PI_CODING_AGENT_DIR` | `~/.pi/agent` |
| dsh | (none on disk for the token) | `~/.dsh` credential store |

Raw `sk_gw_` tokens stay in Host memory for the handoff / session spawn env.
Codex config and dsh env never persist the token. Pi fallback may write the
token into the **Clash-owned** `models.json` (same as Pi’s own ACP gateway
handler would write into its agent dir); sign-out / forget-handoff scrubs it.
User-owned `~/.codex` and `~/.pi/agent` are never opened by these adapters.

## dsh DeepSeek Flash-only

- Default / allowlist: `deepseek-flash` only (`DSH_ACP_MODELS=deepseek-flash`,
  `DSH_MODEL=deepseek-flash`).
- Block: any DeepSeek model id that is not Flash (same rule as
  `packages/gateway-core` catalog policy — Pro/Reasoner tiers included).
- Gateway catalog policy already refuses non-Flash DeepSeek at publish/route
  time; this adapter stops the harness from advertising or defaulting to them.

## Host integration

1. `#357` ACP handoff when `isOfficialGatewayAuthMethod(method)` is true.
2. Else, if `resolveGatewayRuntimeAdapter(harnessId)` is non-null and credential
   decision says hand off → mint token, `applyGatewayRuntimeAdapter`, record
   handoff with synthetic `methodId` (`adapter:codex-config` /
   `adapter:pi-config` / `adapter:dsh-env`), return `spawnEnv` for the session.
3. `LocalAcpAdapter` merges that `spawnEnv` into the session manager env and
   does not treat `needs-auth` as fatal when an adapter handoff is active.

## Explicit non-goals

- Claude / `claude-acp` (already on ACP gateway).
- Cloud-hosted coding agents.
- Touching production.
- Changing gateway settlement / catalog publish.
