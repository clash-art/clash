/**
 * REST API client for project CRUD (non-Loro operations).
 */

import { getServerUrl, requireApiKey } from "./config";

function parseJsonBody(body: string): unknown | undefined {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export class ApiJsonError extends Error {
  readonly status: number;
  readonly body: string;
  readonly jsonBody: unknown | undefined;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiJsonError";
    this.status = status;
    this.body = body;
    this.jsonBody = parseJsonBody(body);
  }
}

export async function apiFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const serverUrl = getServerUrl();
  const apiKey = requireApiKey(serverUrl);
  const url = `${serverUrl}${path}`;

  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return fetch(url, { ...options, headers });
}

export async function apiJson<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    const body = await res.text();
    throw new ApiJsonError(res.status, body);
  }
  return res.json() as Promise<T>;
}
