import { describe, expect, it } from "vitest";

import { minimaxPoll, minimaxSubmit } from "@clash/shared-runtime/minimax-executor";

/**
 * MiniMax puts the verdict in the body, not in the HTTP status.
 *
 * Verified against the live API: a request carrying a key the service does not accept answers
 * **HTTP 200** with
 *
 *   {"base_resp":{"status_code":1004,"status_msg":"login fail: Please carry the API secret key ..."}}
 *
 * `assertAudioOk` already checks this envelope -- and its name says where it is used. The video
 * path checks `response.ok` alone, so a rejected key reads as an accepted submission with no
 * `task_id`, and the error the host reports is "returned no task_id": a statement about our
 * parsing, for what is actually a login failure the vendor described precisely.
 */
const response = (body: unknown) => async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => JSON.stringify(body),
});

const submit = (body: unknown) => minimaxSubmit({
  apiKey: "sk-whatever",
  fetch: response(body) as never,
  kind: "video",
  body: { model: "video-01", prompt: "a leaf" },
} as never);

describe("a verdict carried in the envelope", () => {
  it("reports the vendor's own words when a key is refused", async () => {
    // The exact envelope the live API returned.
    await expect(submit({
      base_resp: {
        status_code: 1004,
        status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
      },
    })).rejects.toThrow(/login fail/i);
  });

  it("does not mistake a refusal for a submission it failed to parse", async () => {
    // What it said before: an error about our own reading of the response.
    await expect(submit({
      base_resp: { status_code: 1004, status_msg: "login fail" },
    })).rejects.not.toThrow(/no task_id/i);
  });

  it("accepts a submission the envelope calls successful", async () => {
    await expect(submit({
      base_resp: { status_code: 0, status_msg: "success" },
      task_id: "t-1",
    })).resolves.toMatchObject({ status: "accepted", pollState: { taskId: "t-1" } });
  });
});

/**
 * MiniMax spells its terminal state `Success`.
 *
 * The poll accepted only `succeeded`, so a task that had finished was reported as a status "this
 * executor does not recognise" -- and the work was done and billed upstream. The two spellings are
 * not interchangeable across vendors, which is why the failed branch already carries a note about
 * `cancelled` versus Replicate's `canceled`; the same care was missing on the way out.
 */
describe("a finished video task", () => {
  const poll = (status: string) => minimaxPoll({
    apiKey: "sk-whatever",
    kind: "video",
    state: { taskId: "t-1" },
    fetch: (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        base_resp: { status_code: 0, status_msg: "success" },
        task: { task_id: "t-1", status, content: { url: "https://cdn.example.test/a.mp4" } },
      }),
    })) as never,
  } as never);

  it("accepts the spelling the vendor actually returns", async () => {
    await expect(poll("Success")).resolves.toMatchObject({ status: "completed" });
  });

  it("still accepts the spelling that was already handled", async () => {
    await expect(poll("succeeded")).resolves.toMatchObject({ status: "completed" });
  });

  it("still refuses a state it has no meaning for", async () => {
    // Not a licence to treat anything terminal-looking as done: an unknown state means the executor
    // cannot tell whether waiting longer would help.
    await expect(poll("banana")).rejects.toThrow(/does not recognise/i);
  });
});
