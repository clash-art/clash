export type DesktopIpcErrorInfo = {
  code: string;
  message: string;
};

export type DesktopIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopIpcErrorInfo };

export class DesktopIpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "DesktopIpcError";
    this.code = code;
  }
}

function isDesktopIpcResult<T>(value: unknown): value is DesktopIpcResult<T> {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const result = value as {
    ok: boolean;
    value?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (result.ok) return "value" in result;
  return (
    typeof result.error?.code === "string" &&
    typeof result.error.message === "string"
  );
}

export function unwrapDesktopIpcResult<T>(result: unknown): T {
  if (!isDesktopIpcResult<T>(result)) {
    throw new DesktopIpcError(
      "DESKTOP_IPC_MALFORMED_RESULT",
      "The desktop app returned an unexpected IPC response.",
    );
  }
  if (!result.ok) {
    throw new DesktopIpcError(result.error.code, result.error.message);
  }
  return result.value;
}
