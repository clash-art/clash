/**
 * Open an http(s) URL in the system browser on Clash desktop, or fall back
 * to a normal browser tab/window on web.
 *
 * Matches CloudConnection / ChatbotCopilot / BrowserSurface: prefer the
 * desktop bridge openExternal (Electron shell.openExternal via
 * openExternalHttpUrl). Do not invent a parallel auth or checkout bridge.
 */

type DesktopOpenExternal = (href: string) => Promise<void>;

function desktopOpenExternal(): DesktopOpenExternal | undefined {
  return (
    globalThis as typeof globalThis & {
      __CLASH_DESKTOP__?: { openExternal?: DesktopOpenExternal };
    }
  ).__CLASH_DESKTOP__?.openExternal;
}

export async function openExternalUrl(url: string): Promise<void> {
  const open = desktopOpenExternal();
  if (open) {
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** True when the desktop bridge can hand URLs to the system browser. */
export function canOpenExternalUrl(): boolean {
  return typeof desktopOpenExternal() === "function";
}
