import { ProviderExecutionError, providerHttpError } from "@clash/action-sdk/executable-failure";

/**
 * MiniMax's generation APIs, as two translations.
 *
 * MiniMax answers in two different ways depending on what is being made. Video goes on a queue and
 * comes back as a task id to ask about; audio comes back in the same call with the bytes inline.
 * Both shapes live here, and neither waits — `minimaxSubmit` sends the work and reports whichever
 * answer MiniMax gave, `minimaxPoll` asks once about a queued task. The host decides how often to
 * ask and for how long.
 *
 * That decision used to live in the host as a loop of 180 attempts five seconds apart. Fifteen
 * minutes was the most generous of seven hand-written ceilings, none of them derived from anything,
 * and the task id lived in a local variable, so a host that stopped mid-loop lost a generation that
 * had already been billed.
 */

/**
 * MiniMax addresses a task by id and nothing else.
 *
 * No endpoint travels alongside it, as fal's does, and no model: the query path is the same for
 * every video model. Adding the model here because it happens to be available would be a second
 * copy of something the node already records, free to disagree with the first.
 */
export interface MinimaxPollState {
  taskId: string;
}

export interface MinimaxVideoMedia {
  url: string;
  durationMs?: number;
}

export interface MinimaxAudioMedia {
  bytes: Uint8Array;
  contentType: string;
  durationMs?: number;
}

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

/**
 * MiniMax answers on two hosts and an account works on exactly one of them: `minimax.io` for the
 * international service, `minimaxi.com` for the domestic one. The host is chosen by whoever holds
 * the account and arrives as `baseUrl`; this constant is only the fallback for accounts recorded
 * before that choice existed.
 */
const DEFAULT_BASE_URL = "https://api.minimax.io";

function apiUrl(baseUrl: string | undefined, path: string): string {
  return `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}${path}`;
}

/**
 * Reads a MiniMax response, keeping a non-JSON body visible.
 *
 * A gateway between here and MiniMax will answer with HTML, and folding that into an empty object
 * leaves only the status line to go on. Surfacing the text is the difference between diagnosing a
 * proxy and staring at "Bad Gateway".
 */
async function readBody(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: { message: raw } };
  }
}

function nested(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageFrom(body: Record<string, unknown>, fallback: string): string {
  const error = nested(body, "error");
  const nestedMessage = error?.message;
  if (typeof nestedMessage === "string" && nestedMessage) return nestedMessage;
  if (typeof body.message === "string" && body.message) return body.message;
  return fallback;
}

/**
 * MiniMax answers 200 and puts the verdict in an envelope.
 *
 * A non-zero `status_code` alongside a successful HTTP status is how a refused key or a rejected
 * prompt arrives. Verified against the live API: a key the service does not accept returns HTTP 200
 * with `{"base_resp":{"status_code":1004,"status_msg":"login fail: Please carry the API secret
 * key ..."}}`.
 *
 * This was called `assertAudioOk` and used only on the audio path -- so a refused key on the video
 * path read as an accepted submission with no `task_id`, and the host was told "returned no
 * task_id": a statement about our own parsing, for something the vendor had described precisely.
 *
 * Trusting the transport alone hands the host an empty result as though it worked, so both are
 * checked together -- a transport failure carrying a zeroed envelope is still a failure.
 */
function assertEnvelopeOk(
  response: Awaited<ReturnType<FetchLike>>,
  body: Record<string, unknown>,
  what: string,
): void {
  const baseResp = nested(body, "base_resp");
  // Only an explicit non-zero code is a verdict. An absent envelope, or one that does not state a
  // code, is not the vendor refusing anything -- and treating either as failure would mask the more
  // precise error the caller is about to raise, such as a submission that came back with no task id.
  const code = baseResp?.status_code;
  if (response.ok && (code === undefined || code === 0)) return;
  const statusMsg = baseResp?.status_msg;
  const message =
    `MiniMax ${what} request failed: ` +
    // The envelope's own words when it has any, and otherwise whatever the body actually said. A
    // gateway between here and MiniMax answers with HTML, and passing that through is the
    // difference between diagnosing a proxy and staring at "Bad Gateway".
    (typeof statusMsg === "string" && statusMsg
      ? statusMsg
      : messageFrom(body, response.statusText));
  if (!response.ok) {
    throw providerHttpError({
      status: response.status,
      message,
      operation: "submit",
      ...(code === undefined ? {} : { providerCode: String(code) }),
    });
  }
  throw new ProviderExecutionError({
    code: code === 1004 ? "authentication_failed" : "provider_failed",
    message,
    retryable: false,
    requestState: "rejected",
    ...(code === undefined ? {} : { providerCode: String(code) }),
  });
}

function hexToBytes(data: string): Uint8Array {
  const clean = data.trim();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    // An odd length means the payload was truncated in transit. Decoding it leniently would store a
    // corrupt asset that only fails later, when someone tries to play it.
    throw new ProviderExecutionError({
      code: "invalid_response",
      message: "MiniMax response returned invalid hex media.",
      retryable: false,
      requestState: "accepted",
    });
  }
  return Uint8Array.from({ length: clean.length / 2 }, (_, index) =>
    Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16),
  );
}

/**
 * Names the media type after the format MiniMax was told to produce.
 *
 * Read back out of the request body rather than passed alongside it, so the declared type cannot
 * drift from what was actually asked for. `pcm` is the trap: its registered type is `audio/L16`,
 * which shares no substring with the format name.
 */
function audioContentType(body: Record<string, unknown>): string {
  const format = nested(body, "audio_setting")?.format;
  if (format === "wav") return "audio/wav";
  if (format === "pcm") return "audio/L16";
  return "audio/mpeg";
}

export type MinimaxSubmitResult =
  | { status: "accepted"; pollState: MinimaxPollState }
  | { status: "completed"; media: MinimaxAudioMedia }
  | { status: "completed"; text: string };

type MinimaxSubmitOptions = {
  kind: "audio" | "video" | "text";
  apiKey: string;
  body: Record<string, unknown>;
  fetch: FetchLike;
  baseUrl?: string;
  /** Music and speech share a shape but not an endpoint. */
  musicEndpoint?: boolean;
};

export function minimaxSubmit(
  options: MinimaxSubmitOptions & { kind: "audio" },
): Promise<
  | { status: "accepted"; pollState: MinimaxPollState }
  | { status: "completed"; media: MinimaxAudioMedia }
>;
export function minimaxSubmit(
  options: MinimaxSubmitOptions & { kind: "video" },
): Promise<{ status: "accepted"; pollState: MinimaxPollState }>;
export function minimaxSubmit(
  options: MinimaxSubmitOptions & { kind: "text" },
): Promise<{ status: "completed"; text: string }>;
export function minimaxSubmit(
  options: MinimaxSubmitOptions,
): Promise<MinimaxSubmitResult>;
export async function minimaxSubmit(
  options: MinimaxSubmitOptions,
): Promise<MinimaxSubmitResult> {
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
  };

  if (options.kind === "text") {
    const response = await options.fetch(
      apiUrl(options.baseUrl, "/v1/chat/completions"),
      {
        method: "POST",
        headers,
        body: JSON.stringify(options.body),
      },
    );
    const body = await readBody(response);
    assertEnvelopeOk(response, body, "text");
    const firstChoice = Array.isArray(body.choices)
      ? body.choices[0]
      : undefined;
    const message =
      firstChoice &&
      typeof firstChoice === "object" &&
      !Array.isArray(firstChoice)
        ? nested(firstChoice as Record<string, unknown>, "message")
        : undefined;
    if (typeof message?.content !== "string" || !message.content.trim()) {
      throw new ProviderExecutionError({
        code: "invalid_response",
        message:
          "MiniMax text response returned no choices[0].message.content.",
        retryable: false,
        requestState: "accepted",
      });
    }
    return { status: "completed", text: message.content };
  }

  if (options.kind === "audio") {
    const what = options.musicEndpoint ? "music" : "TTS";
    const path = options.musicEndpoint ? "/v1/music_generation" : "/v1/t2a_v2";
    const response = await options.fetch(apiUrl(options.baseUrl, path), {
      method: "POST",
      headers,
      body: JSON.stringify(options.body),
    });
    const body = await readBody(response);
    assertEnvelopeOk(response, body, what);

    const audio = nested(body, "data")?.audio;
    if (typeof audio !== "string" || !audio) {
      throw new ProviderExecutionError({
        code: "invalid_response",
        message: `MiniMax ${what} response returned no audio.`,
        retryable: false,
        requestState: "accepted",
      });
    }
    // `music_duration` is already milliseconds, unlike the video task's whole seconds. Scaling it
    // here as well would report every track a thousand times too long.
    const musicDuration = nested(body, "extra_info")?.music_duration;
    return {
      status: "completed",
      media: {
        bytes: hexToBytes(audio),
        contentType: audioContentType(options.body),
        ...(typeof musicDuration === "number"
          ? { durationMs: musicDuration }
          : {}),
      },
    };
  }

  const response = await options.fetch(
    apiUrl(options.baseUrl, "/v2/video_generation"),
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body),
    },
  );
  const created = await readBody(response);
  assertEnvelopeOk(response, created, "video");
  const rawTaskId = created.task_id;
  const taskId =
    typeof rawTaskId === "string"
      ? rawTaskId
      : typeof rawTaskId === "number" &&
          Number.isSafeInteger(rawTaskId) &&
          rawTaskId > 0
        ? String(rawTaskId)
        : "";
  if (!taskId) {
    // Nothing to poll. Reporting success would leave the host waiting on work it can never ask
    // about, while the job may well be running and billable upstream.
    throw new ProviderExecutionError({
      code: "invalid_response",
      message: "MiniMax video response returned no task_id.",
      retryable: false,
      requestState: "unknown",
    });
  }
  return { status: "accepted", pollState: { taskId } };
}

/**
 * The states MiniMax uses while a task is still alive.
 *
 * Named positively, because the alternative — accept anything that is not `succeeded` — hands every
 * word nobody has thought about yet to another poll. A state MiniMax adds later, or spells
 * differently for a new model family, would then be asked about until the host's own budget ran out,
 * with nothing to show for it: the node sits at `generating` and no error is ever raised.
 *
 * Three names, each with evidence. `queued` is what a missing status already defaults to, in the
 * moments after submission before MiniMax fills the field in. `processing` and `running` are both
 * observed intermediate states — the second from the sibling H3 implementation in api-cf, which
 * polls through it on the way to `succeeded`.
 *
 * Deliberately short. A state that is really still running costs one loud error on a run someone
 * can fix; the same state assumed to be running costs an indefinite wait that says nothing.
 */
const RUNNING_STATUSES = new Set(["queued", "processing", "running"]);

// MiniMax answers `Success`; `succeeded` is what this executor was written against and what other
// vendors use. Accepting only the latter reported a finished task as a state "this executor does
// not recognise" -- after the work was done and billed. The failed branch already carried a note
// about `cancelled` versus Replicate's `canceled`; the same care was missing on the way out.
const SUCCEEDED_STATUSES = new Set(["succeeded", "success"]);

export type MinimaxPollResult =
  | { status: "accepted"; pollState: MinimaxPollState }
  | { status: "completed"; media: MinimaxVideoMedia; taskId: string };

export async function minimaxPoll(options: {
  state: MinimaxPollState;
  apiKey: string;
  fetch: FetchLike;
  baseUrl?: string;
}): Promise<MinimaxPollResult> {
  const { taskId } = options.state;
  const response = await options.fetch(
    apiUrl(
      options.baseUrl,
      `/v2/query/video_generation/${encodeURIComponent(taskId)}`,
    ),
    { headers: { authorization: `Bearer ${options.apiKey}` } },
  );
  const body = await readBody(response);
  if (!response.ok) {
    throw providerHttpError({
      status: response.status,
      message: `MiniMax video status failed: ${messageFrom(body, response.statusText)}`,
      operation: "poll",
    });
  }

  const task = nested(body, "task") ?? {};
  // MiniMax omits the field entirely in the moments after submission, and varies its casing.
  // Treating a missing status as terminal would abandon work that is merely young.
  const status = String(task.status ?? "queued").toLowerCase();

  // Two Ls. Replicate's equivalent state has one, and reusing a spelling across providers would
  // leave a dead job being polled until the host's own budget ran out.
  if (status === "failed" || status === "cancelled") {
    const taskError = nested(task, "error");
    const detail =
      typeof taskError?.message === "string" && taskError.message
        ? taskError.message
        : typeof task.message === "string" && task.message
          ? task.message
          : status;
    throw new ProviderExecutionError({
      code: status === "cancelled" ? "cancelled" : "provider_failed",
      message: `MiniMax video generation failed: ${detail}`,
      retryable: false,
      requestState: "accepted",
      providerCode: status,
    });
  }
  if (RUNNING_STATUSES.has(status)) {
    // Unchanged state: MiniMax identifies the task the same way for as long as it exists.
    return { status: "accepted", pollState: options.state };
  }
  if (!SUCCEEDED_STATUSES.has(status)) {
    // Neither finished, nor failed, nor a state this executor can vouch for as still running. The
    // quoted spelling is what MiniMax actually sent, so whoever reads this can add it here or find
    // out what it means.
    throw new ProviderExecutionError({
      code: "invalid_response",
      message:
        `MiniMax reported status "${String(task.status)}" for task ${taskId}, which this executor ` +
        "does not recognise. Refusing to keep waiting on a task whose state is unknown.",
      retryable: false,
      requestState: "accepted",
      providerCode: status,
    });
  }

  const url = nested(task, "content")?.url;
  if (typeof url !== "string" || !url) {
    // A succeeded task with no url is not a result. Passing it on would store an asset pointing
    // nowhere, which reads as success everywhere except when someone opens it.
    throw new ProviderExecutionError({
      code: "invalid_response",
      message: `MiniMax video response returned no video URL for ${taskId}`,
      retryable: false,
      requestState: "accepted",
    });
  }
  return {
    status: "completed",
    media: {
      url,
      ...(typeof task.duration === "number"
        ? { durationMs: task.duration * 1000 }
        : {}),
    },
    taskId,
  };
}
