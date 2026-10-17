export type TextProviderKind = "openai-compatible" | "anthropic-compatible";

export type TextContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: Uint8Array | ArrayBuffer | string; mediaType: string }
  | { type: "audio"; data: Uint8Array | ArrayBuffer | string; mediaType: string };

export interface TextGenerationMessage {
  role: "user" | "assistant";
  content: string | TextContentPart[];
}

export interface TextGenerationInput {
  provider: TextProviderKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
  systemPrompt?: string;
  messages: TextGenerationMessage[];
  fetch?: typeof fetch;
}

export interface TextGenerationResult {
  text: string;
  provider: TextProviderKind;
  model: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function bytesToBase64(value: Uint8Array | ArrayBuffer | string): string {
  if (typeof value === "string") return value;
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function textFromContent(content: TextGenerationMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<TextContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function openAiContent(content: TextGenerationMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "audio") {
      return {
        type: "input_audio",
        input_audio: {
          data: bytesToBase64(part.data),
          format:
            part.mediaType.split("/")[1]?.split(";")[0]?.toLowerCase() ??
            "wav",
        },
      };
    }
    return {
      type: "image_url",
      image_url: {
        url: `data:${part.mediaType};base64,${bytesToBase64(part.data)}`,
      },
    };
  });
}

function anthropicContent(content: TextGenerationMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "audio") {
      throw new Error(
        "Anthropic-compatible text generation does not accept inline audio.",
      );
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mediaType,
        data: bytesToBase64(part.data),
      },
    };
  });
}

async function parseJsonResponse(response: Response): Promise<any> {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { error: { message: raw } };
  }
}

async function generateOpenAiCompatibleText(input: TextGenerationInput): Promise<TextGenerationResult> {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = trimTrailingSlash(input.baseUrl || "https://api.openai.com/v1");
  const messages = [
    ...(input.systemPrompt ? [{ role: "system", content: input.systemPrompt }] : []),
    ...input.messages.map((message) => ({
      role: message.role,
      content: openAiContent(message.content),
    })),
  ];
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages,
    }),
  });
  const json = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`OpenAI-compatible text request failed: ${json?.error?.message ?? response.statusText}`);
  }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`OpenAI-compatible text response returned no content for ${input.model}`);
  }
  return { text, provider: "openai-compatible", model: input.model };
}

async function generateAnthropicCompatibleText(input: TextGenerationInput): Promise<TextGenerationResult> {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = trimTrailingSlash(input.baseUrl || "https://api.anthropic.com");
  const messages = input.messages.map((message) => ({
    role: message.role,
    content: anthropicContent(message.content),
  }));
  const response = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 4096,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages,
    }),
  });
  const json = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Anthropic-compatible text request failed: ${json?.error?.message ?? response.statusText}`);
  }
  const text = Array.isArray(json?.content)
    ? json.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("")
    : "";
  if (!text.trim()) {
    throw new Error(`Anthropic-compatible text response returned no content for ${input.model}`);
  }
  return { text, provider: "anthropic-compatible", model: input.model };
}

export async function generateTextCompletion(input: TextGenerationInput): Promise<TextGenerationResult> {
  const userText = input.messages.map((message) => textFromContent(message.content)).join("\n").trim();
  if (!userText && input.messages.every((message) => typeof message.content === "string")) {
    throw new Error("Text generation prompt is empty.");
  }
  if (!input.apiKey.trim()) throw new Error("Text generation API key is required.");
  if (!input.model.trim()) throw new Error("Text generation model is required.");
  return input.provider === "anthropic-compatible"
    ? generateAnthropicCompatibleText(input)
    : generateOpenAiCompatibleText(input);
}
