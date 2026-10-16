import type { ClientType } from "@clash/shared-types";

/** Display metadata only: identity and kind still come from authentication. */
export function presenceDevice(
  headers: Headers,
  clientType: ClientType,
): string {
  if (clientType !== "browser") {
    const declared = headers
      .get("x-device-name")
      ?.replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim();
    return (
      declared?.slice(0, 80) || (clientType === "cli" ? "Clash CLI" : "Agent")
    );
  }
  const ua = headers.get("user-agent") ?? "";
  const browser = /Edg\//u.test(ua)
    ? "Edge"
    : /OPR\//u.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//u.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//u.test(ua)
          ? "Chrome"
          : /Safari\//u.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad|iPod/u.test(ua)
    ? "iOS"
    : /Android/u.test(ua)
      ? "Android"
      : /Macintosh|Mac OS X/u.test(ua)
        ? "macOS"
        : /Windows/u.test(ua)
          ? "Windows"
          : /Linux/u.test(ua)
            ? "Linux"
            : undefined;
  return os ? `${browser} · ${os}` : browser;
}
