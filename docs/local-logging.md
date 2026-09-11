# Local diagnostics

Desktop, renderer and Host diagnostics use the same versioned JSON record. Runtime logs stay local; they are not project files or sync payloads.

## Read logs

```sh
clash logs --since 2h
clash --profile dev logs --level info --event sync. --since 30m
clash logs --project <project-id> --asset <asset-id> --json
clash logs --component local-api --event plugin. --level info
clash logs --run <run-id> --level debug --json
```

During source development, use `pnpm clash:dev logs ...` from the repository root. Both source and packaged launchers skip Host startup for this command, so a broken Host does not block its own diagnosis. Queries do not need a project marker, credentials or a running GUI.

The default query shows warnings/errors from the last day. Results include event counts across all matches, the latest 50 records in chronological order, and each record's original file and line number. `--limit` supports 1–1000 records. `--event` matches an event prefix. `--json` includes the process run ID for a narrower follow-up query. Older unstructured records remain readable and are marked `legacy`; they cannot provide context that was never recorded. Incomplete lines from an active writer are counted and skipped.

## Directories and retention

| Profile     | Desktop and renderer                  | Host                                    |
| ----------- | ------------------------------------- | --------------------------------------- |
| Production  | `~/.clash/logs/desktop/`              | `~/.clash/logs/local-api/`              |
| Development | `~/.clash/profiles/dev/logs/desktop/` | `~/.clash/profiles/dev/logs/local-api/` |

`CLASH_HOME` selects an explicit profile root. `CLASH_LOCAL_DATA_DIR` also affects the shared diagnostic root, including custom data directory names; `clash logs` prints the resolved diagnostic directory. Each process family retains five JSONL segments, rotating at 5 MiB. One bounded record may cross the segment threshold. The sink creates directories with mode 0700 and files with mode 0600. Directory retention scans run on segment creation rather than every log write.

`desktop/host-startup.log` is the detached launcher's current startup fallback, including failures before the Host's logger can initialize. It is truncated at the next launch. Once the managed Host reaches readiness, its stdout/stderr no longer duplicate runtime output into that file; JSONL remains the runtime source. A source watch supervisor may still append its own restart diagnostics. Existing log files are not migrated or rewritten.

## Record contract

Every new application record has `schemaVersion`, UTC `timestamp`, `level`, `component`, `module`, `event` and `context`. File sinks attach `pid` and `runId`; all segments from one sink share the run ID. Renderer records retain their own event/module and gain `windowId`, `sourceId` and `lineNumber` at the Electron boundary.

Use stable event names and structured identities, for example:

```ts
log.error("asset.hydration_failed", { projectId, assetId, error });
log.debug("canvas.auto_layout", () => ({ projectId, nodeCount }));
```

- `debug`: per-node layout, transport attempts and watcher setup. Default off, including source development.
- `info`: connections, process readiness, plugin lifecycle and duplicate summaries.
- `warn`: recoverable disconnects, unavailable previews, rejected mutations and degraded optional services.
- `error`: failed operations, rejected sync updates, process crashes and disabled failing plugins.

Supply the original Error object. Normalization retains its name, message, code, status, stack and cause. Include project/node/asset/plugin IDs as relevant; do not attach whole documents, request bodies, prompts or media bytes. Known credential/payload fields and URL credentials/query/fragment are removed, with bounded traversal and strings. This is a diagnostic safeguard, not a reason to log arbitrary private data.

The shared application logger coalesces repeated records for 10 seconds, flushing a counted event summary at the next eligible log or explicit close/pagehide. A quiet interval does not create a polling timer. Distinct failures are retained. Process/renderer capture limits ordinary bursts; warnings and errors bypass the ordinary event budget. Fingerprint memory is bounded; a capped distinct count is explicitly marked. Third-party stdout/stderr is line-framed; console calls keep multiline errors together with their Error fields and preserve method severity; unclassified raw stderr is a warning, not automatically an application error. Original stdio behavior is preserved except for the detached Host's post-readiness startup mirror described above.

Frontend diagnostic detail can be enabled with `localStorage.setItem("clash.logLevel", "debug")` followed by reload; remove the key to restore the default. `CLASH_LOG_LEVEL=debug` enables Host watcher and desktop inspection detail. Normal desktop operation does not inspect/log page body text or runtime configuration. Vite HMR console chatter is omitted from files unless desktop debug logging is enabled.

The shared implementation lives in `packages/shared-runtime/src/logging.ts` (browser safe), `observability.ts` (Node sinks/capture) and `log-reader.ts` (offline queries). `packages/web-ui/src/lib/logger.ts` is the browser adapter. The retired duplicate Next.js file logger now re-exports this adapter; it no longer creates a separate `.log/web.log`.
