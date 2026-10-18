// Crash-path fixture: writes structured and unstructured records, then dies
// with an uncaught exception before any explicit close().
import { createBoundedJsonlLogSink, installProcessStdioCapture } from "./observability.js";

const directory = process.argv[2];
if (!directory) throw new Error("usage: observability-crash.fixture.ts <dir>");

const sink = createBoundedJsonlLogSink({
  directory,
  filePrefix: "crash",
  maxBytes: 1024 * 1024,
  component: "test",
});
installProcessStdioCapture({
  component: "test",
  sink,
  maxEventsPerWindow: 100,
  windowMs: 1_000,
});

process.stderr.write("unstructured before crash\n");
const { createStructuredLogger } = await import("./logging.js");
createStructuredLogger({ component: "test", module: "fixture" }).info(
  "before.crash",
  { sequence: 1 },
);
throw new Error("simulated crash");
