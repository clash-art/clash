# Gateway image: dependency & SBOM notes (#385)

How to inventory and audit the **self-host gateway-node** image built from
[`../Dockerfile`](../Dockerfile). Staging only — never point scanners at
production credentials or registries that hold production digests unless that
is an explicit ops drill.

## What the image contains

| Layer concern | Practice in this repo |
| --- | --- |
| Base | `node:24-slim` **pinned by digest** (`ARG NODE_IMAGE=…@sha256:…`). Bump deliberately. |
| Build | Stage 1: `pnpm install --frozen-lockfile --filter-prod "@clash/api-node..."` then `pnpm deploy --prod`. |
| Runtime | Stage 2 copies the deploy tree only; **no secrets in `ENV`/`ARG`**. Compose injects `POSTGRES_PASSWORD`, `GATEWAY_ENCRYPTION_*`, `ADMIN_AUTH_SECRET`, etc. at run time. |
| User | `USER node` (non-root). |
| Init | `tini` as PID 1; compose also sets `init: true` where useful. |
| Filesystem | Compose `read_only: true` + tmpfs `/tmp`; `/data` on a volume. |
| Ports | Image `EXPOSE 8080` only (public data plane / healthz). Admin is `GATEWAY_ADMIN_PORT` and is **not** exposed by the Dockerfile. |

There is no gateway `worker` role in the image entrypoint matrix
(`api` \| `admin` \| `all` \| `migrate`). Outbox is a command override.

## SBOM generation (operator)

Produce a Software Bill of Materials from a locally built image (or the
staging tag). Prefer [Syft](https://github.com/anchore/syft) SPDX/CycloneDX:

```bash
# From the repository root. Staging build only.
docker build -f apps/api-node/deploy/Dockerfile -t clash-gateway-node:local .
syft clash-gateway-node:local -o spdx-json > gateway-node.spdx.json
syft clash-gateway-node:local -o cyclonedx-json > gateway-node.cdx.json
```

Attach the JSON to the staging change ticket; do not commit huge SBOMs to
git unless a release process explicitly asks for one.

## Vulnerability / license audit

```bash
# Lockfile (workspace), before image build:
pnpm audit --prod
# Optional image scan (Grype or equivalent):
grype clash-gateway-node:local
```

Treat critical/high findings in **runtime** dependencies
(`apps/api-node` production graph + base image) as release blockers for a
staging cut. DevDependencies are not copied by `pnpm deploy --prod`.

## Deliberate tsx ship

api-node currently runs TypeScript via `tsx` in the image (no `dist/` yet).
That keeps `tsx` on the runtime graph until a production compile step
lands. Documented in the Dockerfile so operators do not assume a compiled
entry. When a `dist/` entry exists, re-run SBOM + audit — the graph will
shrink.

## Related checks

- Threat model: [gateway-node-threat-model.md](../../../docs/guide/gateway-node-threat-model.md)
- Mechanical CI: `scripts/check-gateway-security.ts` (secrets + structural defaults)
- Flash-only / anti-patterns: `scripts/check-anti-patterns.ts`
