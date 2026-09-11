import {
  ProviderExecutionError,
  providerHttpError,
  type Executor,
  type ExecutorContext,
  type ExecutorStep,
} from "@clash/action-sdk";
import {
  resolveGptImageSize,
  formatGptImageSize,
} from "@clash/shared-types/gpt-image-size";

type Invocation = Parameters<Executor["submit"]>[0];
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function failure(
  message: string,
  requestState: "rejected" | "unknown" | "accepted" = "rejected",
) {
  return new ProviderExecutionError({
    code: requestState === "rejected" ? "invalid_request" : "invalid_response",
    message,
    retryable: false,
    requestState,
  });
}
async function apiKey(context: ExecutorContext, operation: "submit" | "poll") {
  const key = (await context.store.get("apiKey"))?.trim();
  if (!key)
    throw new ProviderExecutionError({
      code: "authentication_failed",
      message: "This image provider account has no apiKey stored.",
      retryable: false,
      requestState: operation === "submit" ? "rejected" : "accepted",
    });
  return key;
}
function controls(invocation: Invocation) {
  const values = invocation.input.values;
  const model = String(values.upstreamModel ?? "").replace(/^openai\//, "");
  if (!["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(model))
    throw failure("Unsupported GPT Image model.");
  const params = record(values.modelParams);
  if (typeof values.prompt !== "string" || !values.prompt.trim())
    throw failure("Image generation requires a prompt.");
  const format = String(params.output_format ?? "png");
  if (!["png", "webp", "jpeg"].includes(format))
    throw failure("Unsupported image output format.");
  if (params.background === "transparent" && format === "jpeg")
    throw failure("A transparent background requires PNG or WebP.");
  if (params.count !== undefined && params.count !== 1)
    throw failure("This image executor publishes one image per run.");
  const dimensions = resolveGptImageSize(
    params,
    typeof values.aspectRatio === "string" ? values.aspectRatio : undefined,
  );
  return {
    model,
    prompt: values.prompt,
    size: dimensions === "auto" ? "auto" : formatGptImageSize(dimensions),
    quality: params.quality ?? "auto",
    background: params.background ?? "auto",
    output_format: format,
    moderation: params.moderation ?? "auto",
  };
}
function mediaType(invocation: Invocation) {
  const format = record(invocation.input.values.modelParams).output_format;
  return format === "jpeg"
    ? "image/jpeg"
    : format === "webp"
      ? "image/webp"
      : "image/png";
}
async function request(
  url: string,
  key: string,
  operation: "submit" | "poll",
  body?: Record<string, unknown> | FormData,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(body
        ? { body: body instanceof FormData ? body : JSON.stringify(body) }
        : {}),
    });
  } catch {
    throw new ProviderExecutionError({
      code: "provider_unavailable",
      message: "Image provider connection failed.",
      retryable: operation === "poll",
      requestState: operation === "poll" ? "accepted" : "unknown",
    });
  }
  const raw = await response.text();
  let json: Record<string, unknown>;
  try {
    json = record(JSON.parse(raw));
  } catch {
    json = {};
  }
  if (!response.ok)
    throw providerHttpError({
      status: response.status,
      message: String(
        record(json.error).message ?? json.detail ?? response.statusText,
      ),
      operation,
    });
  return json;
}
async function references(invocation: Invocation, context: ExecutorContext) {
  return Promise.all(
    [...invocation.input.references]
      .sort((a, b) => a.index - b.index)
      .map(async (ref) => {
        const media = await context.reference(ref);
        if (media.form !== "bytes" && media.form !== "provider-url")
          throw failure("Image references require bytes or a provider URL.");
        return media;
      }),
  );
}

export const openaiAdapter: Executor = {
  async submit(invocation, context) {
    const input = controls(invocation);
    const key = await apiKey(context, "submit");
    const base = (
      (await context.store.get("baseUrl")) || "https://api.openai.com/v1"
    ).replace(/\/$/, "");
    const images = await references(invocation, context);
    let body: Record<string, unknown> | FormData = { ...input, n: 1 };
    if (images.length) {
      const form = new FormData();
      for (const [name, value] of Object.entries(input))
        form.append(name, String(value));
      form.append("n", "1");
      for (const [index, image] of images.entries()) {
        let blob: Blob;
        if (image.form === "bytes")
          blob = new Blob([new Uint8Array(image.bytes)], {
            type: image.mediaType || "image/png",
          });
        else {
          const response = await fetch(image.providerUrl);
          if (!response.ok) throw failure("Could not load an image reference.");
          blob = await response.blob();
        }
        const extension =
          blob.type === "image/jpeg"
            ? "jpg"
            : blob.type === "image/webp"
              ? "webp"
              : "png";
        form.append("image[]", blob, `reference-${index + 1}.${extension}`);
      }
      body = form;
    }
    const result = await request(
      `${base}/images/${images.length ? "edits" : "generations"}`,
      key,
      "submit",
      body,
    );
    const image = Array.isArray(result.data)
      ? record(result.data[0]).b64_json
      : undefined;
    if (typeof image !== "string" || !image)
      throw failure("OpenAI returned no image bytes.", "accepted");
    return {
      status: "completed",
      media: { media: { base64: image, mediaType: mediaType(invocation) } },
    };
  },
};

function prediction(
  result: Record<string, unknown>,
  invocation: Invocation,
): ExecutorStep {
  if (result.status === "succeeded") {
    const url = Array.isArray(result.output) ? result.output[0] : result.output;
    if (typeof url !== "string" || !/^https:\/\//.test(url))
      throw failure("Replicate returned no image URL.", "accepted");
    return {
      status: "completed",
      media: { media: { url, mediaType: mediaType(invocation) } },
    };
  }
  if (result.status === "failed" || result.status === "canceled")
    throw failure(
      String(result.error ?? "Replicate prediction failed."),
      "accepted",
    );
  if (
    typeof result.id !== "string" ||
    !result.id ||
    !["starting", "processing"].includes(String(result.status))
  )
    throw failure(
      "Replicate returned an invalid prediction receipt.",
      "unknown",
    );
  return {
    status: "accepted",
    pollState: { id: result.id },
    retryAfterMs: 1000,
  };
}
export const replicateAdapter: Executor = {
  async submit(invocation, context) {
    const { model, size, ...input } = controls(invocation);
    const key = await apiKey(context, "submit");
    const images = await references(invocation, context);
    const inputImages = images.map((image) =>
      image.form === "provider-url"
        ? image.providerUrl
        : `data:${image.mediaType || "image/png"};base64,${Buffer.from(image.bytes).toString("base64")}`,
    );
    return prediction(
      await request(
        `https://api.replicate.com/v1/models/openai/${model}/predictions`,
        key,
        "submit",
        {
          input: {
            ...input,
            aspect_ratio: size,
            ...(inputImages.length ? { input_images: inputImages } : {}),
          },
        },
      ),
      invocation,
    );
  },
  async poll(invocation, context) {
    const id = record(invocation.pollState).id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
      throw new ProviderExecutionError({
        code: "contract_violation",
        message: "Replicate poll state is missing its prediction id.",
        retryable: false,
        requestState: "accepted",
      });
    return prediction(
      await request(
        `https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`,
        await apiKey(context, "poll"),
        "poll",
      ),
      invocation,
    );
  },
};
