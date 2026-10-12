# Observability & Telemetry

How logging, tracing, metrics and OTLP export work in the local product and
the hosted services, and how to instrument new code.

## What exists

- **Local JSONL logs.** Host and Desktop write structured `LogRecord` lines
  through `createBoundedJsonlLogSink`
  (`packages/shared-runtime/src/observability.ts`). Files live under the
  machine log directory (`logs/<component>/`), rotate when they grow past
  `maxBytes` or the day changes, and are deleted only inside the retention
  bounds the caller passes (product default
  `DEFAULT_JSONL_LOG_RETENTION`: 25 MB total, 7 days). A caller that cannot
  read its retention configuration deletes nothing. Read logs with
  `clash logs` (see `packages/cli/src/commands/logs.ts`).
- **Traces on the official OTel SDK.** Spans are created through
  `@opentelemetry/api` only; only the pipeline modules own SDK dependencies:
  - Host: `apps/local-api/src/telemetry/` — `pipeline.ts` installs the
    process-wide `NodeTracerProvider` (`service.name = "clash-host"`).
  - GUI shell: `apps/web/app/lib/telemetry.ts` — `WebTracerProvider`
    (`service.name = "clash-web"`), installed in local and Desktop runtimes
    only, never hosted Web.
- **Local span summaries.** Every finished Host span is written as a
  `span.end` `LogRecord` (`SpanLogProcessor`) even with export off, so
  `clash logs --event span.end` works with no collector.
- **Client span ingest.** The GUI exports OTLP/HTTP JSON to
  `POST /api/v1/local/otlp/v1/traces` (`LOCAL_OTLP_TRACES_PATH`). The Host
  decodes spans back into `ReadableSpan` (`telemetry/otlp-ingest.ts`) and
  feeds its own processors — same local summary, same configured exporter,
  same batching. Exporter endpoint and credentials never reach the browser.
- **Trace propagation GUI → Host.** `withActionTrace`
  (`packages/web-ui/src/lib/uiTrace.ts`) wraps a user action in a span and
  hands out its W3C `traceparent`; the prompt WebSocket frame carries it and
  `sharedAcpSessionTracing().linkTurn` in `local-acp.ts` parents the
  resulting `invoke_agent` span under the GUI action, surviving the client-
  and Host-side prompt queues.

## Span content rules

Spans carry ids, counts, durations and status only — never prompts, tool
arguments, tool output, file names, paths or free-form messages:

- GUI actions are a closed typed table (`UiActionAttributes` in
  `uiTrace.ts`); errors record `exception.type` only.
- ACP tracing (`apps/local-api/src/runtime/host/lib/session-tracing.ts`)
  records GenAI semantic-convention attributes (`GEN_AI` in
  `shared-runtime/tracing.ts`), tool names/kinds, usage counters, and
  diagnostic severity — not the raw text.
- OTEL configuration is resolved in memory only and never written to
  `process.env`, so agent processes started by the Host cannot inherit
  endpoint or header credentials.

## Enabling OTLP export

Export is off by default. It follows Claude Code's model: a master switch
plus standard `OTEL_*` variables, from either the environment or the
Settings page (**Settings → Telemetry**), Settings winning per key and an
empty Settings value cancelling the environment value.

| Key | Meaning |
| --- | --- |
| `CLASH_ENABLE_TELEMETRY` | Master switch (`1`/`true`) |
| `OTEL_SDK_DISABLED` | `true` kills the SDK even when enabled |
| `OTEL_TRACES_EXPORTER` | `otlp` (default) or `none` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` / `..._TRACES_PROTOCOL` | `http/protobuf` (default) or `http/json` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `..._TRACES_ENDPOINT` | Collector URL (default `http://localhost:4318`, `/v1/traces` appended to the generic form) |
| `OTEL_EXPORTER_OTLP_HEADERS` / `..._TRACES_HEADERS` | Comma-separated `key=value`; stored as credentials, never shown in Settings |

Changing Settings re-targets the running pipeline (`HostTelemetry.applyExport`
). `GET /api/v1/local/telemetry` returns the public view with per-key value
sources; `PATCH` follows the shared local-config CAS/read-receipt flow
(`local-config-routes.ts`).

## Hosted services

The hosted backends share `@clash/shared-telemetry`
(`packages/shared-telemetry`). They are independent of the local Host's
Settings model: configuration is deployment environment only.

| Service | Runtime | Traces | Metrics | Logs |
| --- | --- | --- | --- | --- |
| api-cf | Cloudflare Worker | Platform tracing + `WorkersTracerProvider` | Workers dashboard; `generation_event` log lines | JSON lines → Workers Logs |
| Web gateway (`apps/web/workers/app.ts`) | Cloudflare Worker | Same as api-cf | Workers dashboard | JSON lines → Workers Logs |
| api-node (`clash-api-node`, outbox worker `clash-api-node-outbox`) | Node | NodeSDK: http, fetch (undici), pg | NodeSDK: runtime + business | JSON lines on stdout + OTel Logs |
| render-server (`clash-render-server`) | Node container | NodeSDK: http, fetch (undici) | NodeSDK: runtime + business | JSON lines on stdout + OTel Logs |

### Logs

Every service logs through `createServerLogger`
(`@clash/shared-telemetry/log`): one `LogRecord` JSON line per call (the
same envelope as local JSONL logs), with `trace_id`/`span_id` of the active
span when there is one, and the same record emitted to the OTel Logs API.
api-cf keeps its `log.*(message, ...args)` call sites; `src/logger.ts`
adapts them. The `generation_event` lines from
`apps/api-cf/src/observability/events.ts` are a separate, frozen format that
operations dashboards query; do not change their fields.

Never log prompts, tool payloads, credentials or signed URLs. api-node logs
only error class and code (`errorFacts`) because PostgreSQL errors can echo
connection strings; render-server logs source URLs without their query
string (`sourceTag`).

### Cloudflare Workers

Workers cannot run the Node SDK (no long-lived process, no metric export,
timers frozen between I/O). Instead:

- `installWorkersTracing(workers.tracing)` registers an OTel
  `TracerProvider` backed by the platform's `cloudflare:workers` tracing, so
  `@opentelemetry/api` spans become platform spans. It returns `false` and
  leaves the no-op provider when the runtime has no native tracing. The
  platform does not expose span ids, so span events, links and
  `trace_id` correlation in log lines are unavailable; Workers attaches
  console output to the active span itself.
- `wrangler.toml` enables `[observability.logs]` and
  `[observability.traces]` with `head_sampling_rate = 1` (every request) for
  production and `[env.staging]`.
- OTLP export targets are **destinations** created in the Cloudflare
  dashboard (Workers & Pages → Observability → Destinations). Add their
  names under `destinations = [...]` in the matching wrangler section.
  Workers metrics cannot be exported over OTLP.

### Node services

`startNodeTelemetry` (`@clash/shared-telemetry/node`) runs the official
NodeSDK with the http, undici, pg and Node runtime instrumentations. It must
load before application code, so each entry point has a bootstrap module
passed with `--import`:

- api-node: `--import ./src/telemetry.ts` (server) and
  `--import ./src/telemetry-outbox.ts` (outbox worker) in `package.json`.
- render-server: tsup builds `dist/telemetry.js`; `start` and the
  Dockerfile `CMD` run `node --import ./dist/telemetry.js dist/index.js`.
  The OTel packages are runtime `dependencies` (kept external so the
  instrumentations patch the real modules); `@clash/shared-telemetry` is a
  dev dependency bundled into `dist`.

Bootstraps `await startNodeTelemetry(...)`: the ESM loader hook is limited
to modules an instrumentation hooks (import-in-the-middle's
`createAddHookMessageChannel`), and the await lets the loader learn them
before application imports run. Business instruments are created on first
use, because the metrics API has no proxy provider and a meter taken before
the bootstrap stays a no-op.

Shutdown handlers use `process.on`, not `process.once`: tsx (api-node
`start`, render-server `dev`) adds a hidden signal handler that exits as soon
as no application listener remains, which would cut off the final flush.

Export uses only the standard SDK environment. All three signals default to
OTLP at `http://localhost:4318`:

| Variable | Meaning |
| --- | --- |
| `OTEL_SDK_DISABLED` | `true` turns the SDK off |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | `otlp` (default), `console` or `none` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `..._PROTOCOL`, `..._HEADERS` | Collector address, protocol, auth headers |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Override the default service name and add attributes (e.g. `deployment.environment.name`) |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export period in ms (default 60000) |

Logs reach the backend twice when both stdout is collected and
`OTEL_LOGS_EXPORTER` is `otlp`. Pick one: set `OTEL_LOGS_EXPORTER=none`
when a log agent already ships stdout.

### Business metrics

Attributes are bounded enums; never project, run or user ids.

| Metric | Type | Attributes | Source |
| --- | --- | --- | --- |
| `clash.generation.duration` (s) | Histogram | `clash.generation.outcome` = `succeeded`/`failed` | api-node durable-run journal, recorded once on the terminal CAS write |
| `clash.outbox.dispatched` ({item}) | Counter | `clash.outbox.queue`, `clash.outbox.outcome` = `published`/`failed`/`stale` | api-node outbox worker |
| `clash.outbox.backlog` ({item}) | Gauge | `clash.outbox.queue` | `project_replica_outbox` row count per export interval |
| `clash.render.duration` (s) | Histogram | `clash.render.operation` = `render`/`thumbnail`/`probe_audio`, `clash.render.outcome` | render-server |

Hosted generation on api-cf continues to report through `generation_event`
log lines.

## Adding instrumentation

- Call `trace.getTracer("<component>")` and create spans; use
  `withActionTrace` for GUI actions and extend `UiActionAttributes` when
  adding a new action type.
- Server code logs through `createServerLogger` and records metrics with
  `metrics.getMeter("<package>")`; keep SDK imports inside
  `packages/shared-telemetry` and the bootstrap modules.
- Host ingest of other signals (metrics, logs) is not wired — the local
  pipeline is traces only.
- Product analytics is out of scope.
