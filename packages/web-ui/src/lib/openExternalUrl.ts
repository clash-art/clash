/**
 * Open an http(s) URL in the system browser on Clash desktop, or fall back
 * to a normal browser tab/window on web.
 *
 * Matches CloudConnection / ChatbotCopilot / BrowserSurface: prefer
 * `__CLASH_DESKTOP__.openExternal` (Electron shell.openExternal via
 * openExternalHttpUrl). Do not invent a parallel auth or checkout bridge.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const desktopOpen = (
    globalThis as typeof globalThis & {
      __CLASH_DESKTOP__?: { openExternal?: (href: string) => Promise<void> };
    }
  ).__CLASH_DESKTOP__?.openExternal;
  if (desktopOpen) {
    await desktopOpen(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** True when the desktop bridge can hand URLs to the system browser. */
export function canOpenExternalUrl(): boolean {
  return typeof (
    globalThis as typeof globalThis & {
      __CLASH_DESKTOP__?: { openExternal?: (href: string) => Promise<void> };
    }
  ).__CLASH_DESKTOP__?.openExternal === "function";
}
