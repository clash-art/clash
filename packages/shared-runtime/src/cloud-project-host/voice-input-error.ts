/** Voice-input failure carried to the HTTP layer as `{ error, code }` and shown in the UI. */
/** Stable, user-visible failure codes; every voice-input failure carries one. */
export type VoiceInputErrorCode =
  | "VOICE_INPUT_DISABLED"
  | "VOICE_INPUT_NOT_CONFIGURED"
  | "VOICE_INPUT_EMPTY_TRANSCRIPT"
  | "VOICE_INPUT_MISSING_FILE"
  | "VOICE_INPUT_AUDIO_TOO_LARGE"
  | "VOICE_INPUT_PROVIDER_FAILED"
  | "VOICE_INPUT_USAGE_AUDIT_FAILED";

const DEFAULT_CODE: Record<400 | 409 | 413 | 502, VoiceInputErrorCode> = {
  400: "VOICE_INPUT_MISSING_FILE",
  409: "VOICE_INPUT_NOT_CONFIGURED",
  413: "VOICE_INPUT_AUDIO_TOO_LARGE",
  502: "VOICE_INPUT_PROVIDER_FAILED",
};

export class VoiceInputError extends Error {
  readonly code: VoiceInputErrorCode;
  constructor(
    message: string,
    readonly status: 400 | 409 | 413 | 502,
    code?: VoiceInputErrorCode,
  ) {
    super(message);
    this.name = "VoiceInputError";
    this.code = code ?? DEFAULT_CODE[status];
  }
}
