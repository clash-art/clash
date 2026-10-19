import { lazySchema } from "./lazy-schema.js";
import { z } from 'zod';

/**
 * The two Google surfaces a key can be spent on.
 *
 * `ai-studio` is the Gemini Developer API, keyed from aistudio.google.com. `agent-platform` is
 * Gemini Enterprise Agent Platform — the product formerly called Vertex AI — which now accepts an
 * API key as well, rather than only a service-account JSON signed into a scoped token.
 *
 * Because both take the same kind of credential, the credential can no longer tell them apart. The
 * account has to say, exactly as a MiniMax account says which service issued its key. Getting it
 * wrong is not a degraded result: the hosts are unrelated and the request comes back as an
 * authentication failure naming neither the surface nor the host.
 */
export const GOOGLE_PLATFORMS = {
  'ai-studio': 'https://generativelanguage.googleapis.com',
  'agent-platform': 'https://aiplatform.googleapis.com',
} as const;

export type GooglePlatform = keyof typeof GOOGLE_PLATFORMS;


export let GooglePlatformSchema = lazySchema(() => (
z.enum(
  Object.keys(GOOGLE_PLATFORMS) as [GooglePlatform, ...GooglePlatform[]],
)
), (real) => { GooglePlatformSchema = real; });

export interface GoogleApiBaseUrlOptions {
  /** A proxy or gateway in front of Google. Wins over the platform's own host. */
  baseUrl?: string;
  /** Agent Platform serves per-region hosts; `global` is the unprefixed one. */
  location?: string;
}

/**
 * Where to send this account's requests.
 *
 * The endpoint hostname kept `aiplatform` through the rename, and it should: an endpoint is a fact
 * about a protocol rather than a product name, and renaming it would break every request.
 */
export function googleApiBaseUrl(
  platform: GooglePlatform,
  options: GoogleApiBaseUrlOptions = {},
): string {
  if (options.baseUrl && options.baseUrl.trim()) {
    return options.baseUrl.trim().replace(/\/+$/, '');
  }
  const host = GOOGLE_PLATFORMS[platform];
  if (!host) {
    // Guessing would send a key somewhere it is unknown, and the refusal would name neither the
    // surface asked for nor the host tried.
    throw new Error(
      `Google has no surface named "${platform}". Known surfaces: `
      + `${Object.keys(GOOGLE_PLATFORMS).join(', ')}.`,
    );
  }
  if (platform === 'agent-platform' && options.location && options.location !== 'global') {
    return `https://${options.location}-aiplatform.googleapis.com`;
  }
  return host;
}
