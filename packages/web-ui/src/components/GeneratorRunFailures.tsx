import type { GeneratorRunDiagnostics } from "@clash/shared-types";

/** The Host exposes safe diagnostics; raw provider journals are never rendered here. */
export function GeneratorRunFailures({
  diagnostics,
  outputSlot,
}: {
  diagnostics?: GeneratorRunDiagnostics;
  outputSlot?: string;
}) {
  const failures =
    diagnostics?.failures.filter(
      (failure) =>
        outputSlot === undefined || failure.outputSlot === outputSlot,
    ) ?? [];
  return (
    <>
      {failures.map((failure, index) => (
        <div
          key={`${failure.outputSlot}:${failure.code}:${index}`}
          className="mt-2 max-w-lg text-xs text-red-700"
        >
          <p className="break-words">{failure.message}</p>
          <p className="mt-1 break-all text-[10px] opacity-75">
            {failure.outputSlot} · {failure.phase} · {failure.code}
          </p>
        </div>
      ))}
    </>
  );
}
