/**
 * Synchronous SHA-256 of UTF-8 text, as lowercase hex, on every runtime the
 * shared modules run in (browser, Node, workerd). Deliberately not
 * `node:crypto`: shared Project Host code must not depend on a platform.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}
