import { describe, expect, it } from "vitest";
import { machineName, probePrettyMachineName } from "./platform.js";

type ExecCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;
type ProbeOptions = NonNullable<
  Parameters<typeof probePrettyMachineName>[0]
>;
type FakeExecFile = NonNullable<ProbeOptions["execFile"]>;

function fakeExecFile(
  handler: (file: string, args: string[], callback: ExecCallback) => void,
): FakeExecFile {
  return ((file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    handler(file, args, callback);
    return {} as never;
  }) as unknown as FakeExecFile;
}

describe("probePrettyMachineName", () => {
  it("asks hostnamectl off the request path and trims its answer", async () => {
    const seen: Array<{ file: string; args: string[] }> = [];
    const result = await probePrettyMachineName({
      platform: "linux",
      execFile: fakeExecFile((file, args, callback) => {
        seen.push({ file, args });
        callback(null, "  Studio Linux  \n", "");
      }),
    });
    expect(seen).toEqual([{ file: "hostnamectl", args: ["--pretty"] }]);
    expect(result).toEqual({ ok: true, name: "Studio Linux" });
  });

  it("uses scutil on macOS", async () => {
    const seen: string[] = [];
    const result = await probePrettyMachineName({
      platform: "darwin",
      execFile: fakeExecFile((file, _args, callback) => {
        seen.push(file);
        callback(null, "Studio Mac\n", "");
      }),
    });
    expect(seen).toEqual(["scutil"]);
    expect(result).toEqual({ ok: true, name: "Studio Mac" });
  });

  it("reports a coded failure instead of throwing when the platform tool fails", async () => {
    const result = await probePrettyMachineName({
      platform: "linux",
      execFile: fakeExecFile((_file, _args, callback) => {
        callback(new Error("spawn hostnamectl ENOENT"), "", "");
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "HOST_MACHINE_NAME_UNAVAILABLE",
    });
    expect((result as { error: string }).error).toContain("hostnamectl");
  });

  it("treats a localhost answer as unavailable so the fallback hostname is used", async () => {
    const result = await probePrettyMachineName({
      platform: "linux",
      execFile: fakeExecFile((_file, _args, callback) => {
        callback(null, "localhost\n", "");
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "HOST_MACHINE_NAME_UNAVAILABLE",
    });
    expect(machineName()).not.toBe("");
  });
});
