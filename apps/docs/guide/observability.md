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

  Writes are asynchronous and batched through one open fd; retention scans
  happen in the background on segment rotation, not per record. The queue is
  flushed on `close()` and on the process `exit` event (crash path). A write
  failure keeps a bounded retry tail, reopens with backoff, and recovers
  automatically; while degraded `/health` returns `logSink: "degraded"` and
  `logSinkCode: "LOG_SINK_WRITE_FAILED"`, and recovery emits
  `log.sink_recovered {dropped}`. Process-wide capture admits at most 50
  records/s (two-second burst) and reports `log.suppressed {count}`; plugin
  stderr is batched with a 200-line / 250 ms bounded window.
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
- `apps/api-cf/wrangler.toml` and `apps/web/wrangler.toml` enable
  `[observability.logs]` and `[observability.traces]` with
  logs at `head_sampling_rate = 1` everywhere, and traces at `0.1`
  (10% of requests) in production and `1` in `[env.staging]`. Head
  sampling is decided before the request runs, so sampling logs would drop
  the same share of error-request logs; logs therefore stay complete.
  Tradeoff: ~90% of production requests have no trace (an error is still
  visible in its logs, but may lack a trace), in exchange for bounded
  Traces volume and cost.
  To override, edit `head_sampling_rate` (0 to 1; `1` is every request) in
  the tables of the Worker concerned — `[observability.logs]`,
  `[observability.traces]` and their `[env.staging.observability.*]`
  counterparts are independent — and redeploy. There is no environment
  variable or dashboard switch for it; the value in `wrangler.toml` at
  deploy time is what runs.
- OTLP export targets are **destinations** created in the Cloudflare
  dashboard (Workers & Pages → Observability → Destinations). Add their
  names under `destinations = [...]` in the matching wrangler section.
  Workers metrics cannot be exported over OTLP.

#### Manual deploy steps

Nothing in the repository creates destinations or deploys the Workers; both
are done by hand:

1. In the Cloudflare dashboard (Workers & Pages → Observability →
   Destinations) create an OTLP destination per signal you want exported
   (traces, logs), with the backend's OTLP endpoint and auth headers. The
   credentials live in the dashboard only.
2. Add the destination names to the matching wrangler tables, for example
   `destinations = ["<traces-destination>"]` under `[observability.traces]`
   and `[env.staging.observability.traces]`, likewise for logs, in both
   `apps/api-cf/wrangler.toml` and `apps/web/wrangler.toml`. Until a table
   lists a destination, its data stays in the Workers dashboard only.
3. Deploy each Worker with wrangler: `pnpm run deploy` in `apps/web` and
   `apps/api-cf` (`wrangler deploy`; add `--env staging` for staging).
   Sampling and destination changes take effect only after this deploy.
4. For api-node, the outbox worker and render-server, set
   `OTEL_EXPORTER_OTLP_ENDPOINT` (and headers) in each service's deployment
   environment — see below. Without it they export nothing.

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

Export is **off until an OTLP endpoint is configured**. The SDK's own
default would send all three signals to `http://localhost:4318`, which in a
deployment without a collector means failed exports and retries forever, so
`startNodeTelemetry` (`resolveNodeTelemetrySignals`) decides per signal:

- A signal whose exporter is `otlp` (the default) is on only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` or its own
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `..._METRICS_ENDPOINT` /
  `..._LOGS_ENDPOINT` is set. A signal-specific endpoint enables that
  signal alone.
- An exporter that does not use OTLP (`console`, and `prometheus` for
  metrics) needs no endpoint. An exporter list that includes `otlp` still
  needs one, and `none` is always off.
- With no signal on, the SDK is not constructed: no exporters, no loader
  hook, no instrumentation, nothing sent anywhere. `OTEL_SDK_DISABLED=true`
  does the same regardless of endpoints.

The stdout JSON lines from `createServerLogger` do not depend on the SDK and
are written in every case; without a tracer provider they carry no
`trace_id`/`span_id`.

Everything else is the standard SDK environment:

| Variable | Meaning |
| --- | --- |
| `OTEL_SDK_DISABLED` | `true` turns the SDK off, even with an endpoint set |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL; enables all three signals. Unset = no export |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `..._METRICS_ENDPOINT` / `..._LOGS_ENDPOINT` | Full per-signal URL; enables that signal |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | `otlp` (default), `console` or `none` |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS` | Protocol and auth headers |
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
