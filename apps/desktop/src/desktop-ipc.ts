export type DesktopIpcErrorInfo = {
  code: string;
  message: string;
};

export type DesktopIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopIpcErrorInfo };

/**
 * An error whose machine-readable code is part of the renderer contract.
 * IPC handlers return it inside a {@link DesktopIpcResult} so the code survives
 * the structured-clone boundary instead of only the message surviving it.
 */
export class CodedError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CodedError";
    this.code = code;
  }
}

export function codedError(
  code: string,
  message: string,
  cause?: unknown,
): CodedError {
  return new CodedError(code, message, cause);
}

export function toDesktopIpcError(
  error: unknown,
  fallbackCode: string,
): DesktopIpcErrorInfo {
  if (error instanceof CodedError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return {
      code: typeof (error as Error & { code?: unknown }).code === "string"
        ? (error as Error & { code: string }).code
        : fallbackCode,
      message: error.message,
    };
  }
  return { code: fallbackCode, message: String(error) };
}

export async function desktopIpcResult<T>(
  run: () => Promise<T> | T,
): Promise<DesktopIpcResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: toDesktopIpcError(error, "DESKTOP_IPC_FAILED") };
  }
}
