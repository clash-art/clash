/** Shared helpers for the admin console component tests. */
import { fireEvent, screen, within } from "@testing-library/react";
import { vi } from "vitest";

/** Pick `option` in the shared SelectMenu labelled `label` (inside `container` when given). */
export function chooseOption(label: string, option: string, container?: HTMLElement) {
  fireEvent.click((container ? within(container) : screen).getByRole("combobox", { name: label }));
  // The option list renders in a portal, outside any container.
  fireEvent.click(screen.getByRole("option", { name: option }));
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Stub `fetch` for the admin API: `respond` answers each call (default 200
 * `{}`); every call is recorded with its parsed JSON body.
 */
export function stubAdminFetch(respond: (call: RecordedCall) => Response = () => Response.json({})) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://clash.test");
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

/** A coded gateway error response, as api-cf sends it. */
export function gatewayError(status: number, code: string, message = code) {
  return new Response(JSON.stringify({ error: { code, message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json", "x-clash-error-code": code },
  });
}
