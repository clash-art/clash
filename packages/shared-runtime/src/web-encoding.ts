/**
 * Byte encodings and comparisons over Web Crypto primitives only, so the same
 * code runs on workerd, browsers and Node without `Buffer`.
 */

const encoder = new TextEncoder();

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Equal-length comparison whose time does not depend on where values differ. */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1)
    difference |= a[index]! ^ b[index]!;
  return difference === 0;
}
